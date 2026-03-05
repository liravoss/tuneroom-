from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit, join_room, leave_room
import os, time, json, requests
from dotenv import load_dotenv
load_dotenv()

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'tuneroom-secret-2026')
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='threading')

# ─────────────────────────────────────────────────────────────
#  UPSTASH REDIS — queue + search cache (persists forever)
#  Chat stays in RAM only (intentional)
# ─────────────────────────────────────────────────────────────
REDIS_URL   = os.environ.get('UPSTASH_REDIS_REST_URL', '').rstrip('/')
REDIS_TOKEN = os.environ.get('UPSTASH_REDIS_REST_TOKEN', '')
CACHE_TTL   = 6 * 3600   # search cache expires after 6 hours

def redis_cmd(*args):
    """Send a command to Upstash Redis REST API. Returns parsed response."""
    if not REDIS_URL or not REDIS_TOKEN:
        return None
    try:
        resp = requests.post(
            f'{REDIS_URL}/{"/".join(str(a) for a in args)}',
            headers={'Authorization': f'Bearer {REDIS_TOKEN}'},
            timeout=4
        )
        if resp.ok:
            return resp.json().get('result')
    except Exception:
        pass
    return None

# ── Queue helpers ─────────────────────────────────────────────
def queue_key(rid):   return f'tr:queue:{rid}'
def state_key(rid):   return f'tr:state:{rid}'

def redis_get_queue(rid):
    """Get queue for a room from Redis. Returns list."""
    try:
        raw = redis_cmd('GET', queue_key(rid))
        if raw:
            return json.loads(raw)
    except Exception:
        pass
    return []

def redis_set_queue(rid, queue):
    """Save queue for a room to Redis (no expiry — persists forever)."""
    try:
        redis_cmd('SET', queue_key(rid), json.dumps(queue))
    except Exception:
        pass

def redis_get_state(rid):
    """Get playback state (current_index, is_playing, current_time) from Redis."""
    try:
        raw = redis_cmd('GET', state_key(rid))
        if raw:
            return json.loads(raw)
    except Exception:
        pass
    return {'current_index': -1, 'is_playing': False, 'current_time': 0.0}

def redis_set_state(rid, idx, is_playing, current_time):
    """Save playback state to Redis."""
    try:
        redis_cmd('SET', state_key(rid), json.dumps({
            'current_index': idx,
            'is_playing':    is_playing,
            'current_time':  current_time
        }))
    except Exception:
        pass

# ── Search cache helpers ──────────────────────────────────────
def cache_key(q): return f'tr:cache:{q.lower().strip()}'

def cache_get(q):
    """Get cached search results. Returns (results, source) or (None, None)."""
    try:
        raw = redis_cmd('GET', cache_key(q))
        if raw:
            d = json.loads(raw)
            return d['results'], d['source']
    except Exception:
        pass
    return None, None

def cache_set(q, results, source):
    """Cache search results in Redis with 6hr TTL."""
    try:
        key  = cache_key(q)
        data = json.dumps({'results': results, 'source': source})
        redis_cmd('SET', key, data, 'EX', CACHE_TTL)
    except Exception:
        pass

# ── Room state (users + chat stay in RAM) ────────────────────
rooms = {}  # RAM only: users, chat_history, voice_peers

def get_room(rid):
    if rid not in rooms:
        # Load queue + state from Redis on first access
        rooms[rid] = {
            'users':        {},
            'chat_history': [],
            'voice_peers':  {},
            'last_sync':    time.time()
        }
    return rooms[rid]

def get_queue(rid):
    """Always get queue from Redis (source of truth)."""
    return redis_get_queue(rid)

def get_state(rid):
    """Always get playback state from Redis."""
    return redis_get_state(rid)

# ─────────────────────────────────────────────────────────────
#  PAGES
# ─────────────────────────────────────────────────────────────
@app.route('/favicon.ico')
def favicon():
    return app.send_static_file('img/favicon.ico')

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/room', defaults={'room_id': 'main'})
@app.route('/room/<room_id>')
def room(room_id):
    return render_template('room.html', room_id=room_id)

# ─────────────────────────────────────────────────────────────
#  SEARCH — YouTube API keys (rotation) + Invidious fallback
#  Priority:
#    1. YOUTUBE_API_KEY  (primary)
#    2. YOUTUBE_API_KEY_2 (secondary key)
#    3. YOUTUBE_API_KEY_3 (tertiary key)
#    4. Invidious API    (free, no key, unlimited)
# ─────────────────────────────────────────────────────────────

# Multiple Invidious public instances — tries each if one is down
INVIDIOUS_INSTANCES = [
    'https://invidious.privacyredirect.com',
    'https://invidious.nerdvpn.de',
    'https://inv.tux.pizza',
    'https://invidious.io.lol',
]

def _search_youtube_key(q, key):
    """Search using a single YouTube Data API key. Returns list or None on quota/error."""
    try:
        resp = requests.get(
            'https://www.googleapis.com/youtube/v3/search',
            params={
                'part':       'snippet',
                'q':          q,
                'type':       'video',
                'maxResults': 10,
                'key':        key
            },
            timeout=8
        )
        data = resp.json()

        # Quota exceeded or forbidden — signal to try next key
        if 'error' in data:
            code = data['error'].get('code', 0)
            if code in (403, 429):
                return None   # quota hit — try next
            return []         # other error — return empty

        results = []
        for item in data.get('items', []):
            try:
                vid = item['id']['videoId']
                sn  = item['snippet']
                results.append({
                    'id':        vid,
                    'title':     sn.get('title', ''),
                    'channel':   sn.get('channelTitle', ''),
                    'thumbnail': f'https://img.youtube.com/vi/{vid}/mqdefault.jpg'
                })
            except (KeyError, TypeError):
                continue
        return results

    except requests.Timeout:
        return None
    except Exception:
        return None


def _search_invidious(q):
    """Search using Invidious — free, no key needed. Tries multiple instances."""
    for instance in INVIDIOUS_INSTANCES:
        try:
            resp = requests.get(
                f'{instance}/api/v1/search',
                params={'q': q, 'type': 'video', 'page': 1},
                timeout=8,
                headers={'User-Agent': 'Mozilla/5.0'}
            )
            if not resp.ok:
                continue
            items = resp.json()
            if not isinstance(items, list):
                continue
            results = []
            for item in items[:10]:
                vid = item.get('videoId', '')
                if not vid:
                    continue
                results.append({
                    'id':        vid,
                    'title':     item.get('title', ''),
                    'channel':   item.get('author', ''),
                    'thumbnail': f'https://img.youtube.com/vi/{vid}/mqdefault.jpg'
                })
            if results:
                return results
        except Exception:
            continue
    return None


# Multiple Piped instances
PIPED_INSTANCES = [
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.adminforge.de',
    'https://piped-api.garudalinux.org',
    'https://api.piped.yt',
    'https://pipedapi.in.projectsegfau.lt',
]

def _search_piped(q):
    """Search using Piped API — no key needed."""
    for instance in PIPED_INSTANCES:
        try:
            resp = requests.get(
                f'{instance}/search',
                params={'q': q, 'filter': 'videos'},
                timeout=8,
                headers={'User-Agent': 'Mozilla/5.0'}
            )
            if not resp.ok:
                continue
            items = resp.json().get('items', [])
            results = []
            for item in items[:10]:
                vid = item.get('url', '').replace('/watch?v=', '').strip()
                if not vid or len(vid) != 11:
                    continue
                results.append({
                    'id':        vid,
                    'title':     item.get('title', ''),
                    'channel':   item.get('uploaderName', ''),
                    'thumbnail': f'https://img.youtube.com/vi/{vid}/mqdefault.jpg'
                })
            if results:
                return results
        except Exception:
            continue
    return None


def _search_youtube_nokey(q):
    """
    No-key YouTube search using YouTube's internal suggestion API.
    Uses youtube.com/youtubei/v1/search — same endpoint the YouTube
    website uses internally, always accessible, no API key needed.
    """
    import json as _json
    try:
        payload = {
            "context": {
                "client": {
                    "clientName": "WEB",
                    "clientVersion": "2.20231219.04.00",
                    "hl": "en",
                    "gl": "US"
                }
            },
            "query": q
        }
        resp = requests.post(
            'https://www.youtube.com/youtubei/v1/search',
            params={'prettyPrint': 'false'},
            json=payload,
            timeout=12,
            headers={
                'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Content-Type': 'application/json',
                'X-YouTube-Client-Name': '1',
                'X-YouTube-Client-Version': '2.20231219.04.00',
                'Origin': 'https://www.youtube.com',
                'Referer': 'https://www.youtube.com/',
            }
        )
        if not resp.ok:
            return None

        data = resp.json()

        # Walk the nested response to find video items
        import re as _re
        text = resp.text
        # Extract all videoIds and titles from the response JSON
        video_ids = _re.findall(r'"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"', text)
        titles    = _re.findall(r'"title"\s*:\s*\{"runs"\s*:\s*\[\{"text"\s*:\s*"([^"]+)"', text)
        channels  = _re.findall(r'"ownerText"\s*:\s*\{"runs"\s*:\s*\[\{"text"\s*:\s*"([^"]+)"', text)

        # Deduplicate
        seen, unique = set(), []
        for vid in video_ids:
            if vid not in seen:
                seen.add(vid)
                unique.append(vid)

        results = []
        for i, vid in enumerate(unique[:10]):
            results.append({
                'id':        vid,
                'title':     titles[i]   if i < len(titles)   else q,
                'channel':   channels[i] if i < len(channels) else '',
                'thumbnail': f'https://img.youtube.com/vi/{vid}/mqdefault.jpg'
            })
        return results if results else None

    except Exception:
        return None


@app.route('/api/search')
def api_search():
    q = request.args.get('q', '').strip()
    if not q:
        return jsonify({'error': 'empty query'}), 400

    # ── Check cache first — zero API quota used ─────────────────
    cached_results, cached_source = cache_get(q)
    if cached_results is not None:
        return jsonify({'source': cached_source, 'results': cached_results, 'cached': True})

    # ── Try YouTube API keys in order (supports unlimited keys) ─
    # Reads YOUTUBE_API_KEY, YOUTUBE_API_KEY_2 ... YOUTUBE_API_KEY_30
    yt_keys = []
    base = os.environ.get('YOUTUBE_API_KEY', '').strip()
    if base: yt_keys.append(base)
    for i in range(2, 31):
        k = os.environ.get(f'YOUTUBE_API_KEY_{i}', '').strip()
        if k: yt_keys.append(k)

    for key in yt_keys:
        results = _search_youtube_key(q, key)
        if results is not None:
            cache_set(q, results, 'youtube')
            return jsonify({'source': 'youtube', 'results': results})

    # ── All YouTube keys exhausted → try free fallbacks ─────────
    # Fallback 1: Invidious
    results = _search_invidious(q)
    if results:
        cache_set(q, results, 'invidious')
        return jsonify({'source': 'invidious', 'results': results})

    # Fallback 2: Piped API
    results = _search_piped(q)
    if results:
        cache_set(q, results, 'piped')
        return jsonify({'source': 'piped', 'results': results})

    # Fallback 3: YouTube internal API (no key, always works)
    results = _search_youtube_nokey(q)
    if results:
        cache_set(q, results, 'youtube_nokey')
        return jsonify({'source': 'youtube_nokey', 'results': results})

    return jsonify({'error': 'All search sources unavailable', 'results': []}), 200


# ─────────────────────────────────────────────────────────────
#  CACHE STATS  — see how much quota is being saved
# ─────────────────────────────────────────────────────────────
@app.route('/api/cache/stats')
def cache_stats():
    now = time.time()
    active = {k:v for k,v in search_cache.items() if (now - v['ts']) < CACHE_TTL}
    return jsonify({
        'cached_queries': len(active),
        'max_cache':      CACHE_MAX,
        'ttl_hours':      CACHE_TTL // 3600,
        'queries':        list(active.keys())
    })

# ─────────────────────────────────────────────────────────────
#  LYRICS  — 5-source cascade, no API key needed
# ─────────────────────────────────────────────────────────────
import re as _re

def _clean(title, artist):
    """Strip YouTube noise so lyrics APIs can find the song."""
    t = title
    t = _re.sub(r'\((?:official|lyrics?|video|audio|hd|4k|mv|music video|visualizer|ft\.?[^)]*|feat\.?[^)]*)[^)]*\)', '', t, flags=_re.I)
    t = _re.sub(r'\[(?:official|lyrics?|video|audio|hd|4k|mv|music video|visualizer)[^\]]*\]', '', t, flags=_re.I)
    t = _re.sub(r'(?:ft\.?|feat\.?)\s+[\w\s,&]+', '', t, flags=_re.I)
    t = _re.sub(r'\s*[-|–—]\s*(official|lyrics?|video|audio|hd|4k|mv|music video|visualizer).*$', '', t, flags=_re.I)
    t = _re.sub(r'\s+', ' ', t).strip()

    a = artist
    a = _re.sub(r'\s*(?:ft\.?|feat\.?|&|x)\s+.*$', '', a, flags=_re.I)
    a = _re.sub(r'\s*-\s*Topic\s*$', '', a, flags=_re.I)   # "Artist - Topic" YouTube channels
    a = a.strip()
    return t, a

@app.route('/api/lyrics')
def api_lyrics():
    title  = request.args.get('title',  '').strip()
    artist = request.args.get('artist', '').strip()
    if not title:
        return jsonify({'error': 'No title'}), 400

    clean_title, clean_artist = _clean(title, artist)

    # ── 1. lrclib.net — best coverage for new songs ──────────
    for (t, a) in [(clean_title, clean_artist), (clean_title, ''), (title, artist)]:
        try:
            r = requests.get(
                'https://lrclib.net/api/search',
                params={'track_name': t, 'artist_name': a},
                timeout=7
            )
            if r.ok:
                items = r.json()
                if items:
                    lyr = items[0].get('plainLyrics') or items[0].get('syncedLyrics') or ''
                    # strip timestamp lines like [00:12.34]
                    lyr = _re.sub(r'\[\d+:\d+\.\d+\]', '', lyr).strip()
                    if len(lyr) > 80:
                        return jsonify({'lyrics': lyr, 'source': 'lrclib'})
        except Exception:
            pass

    # ── 2. lyrics.ovh ────────────────────────────────────────
    for (t, a) in [(clean_title, clean_artist), (clean_title, 'unknown')]:
        try:
            enc_a = requests.utils.quote(a)
            enc_t = requests.utils.quote(t)
            r = requests.get(f'https://api.lyrics.ovh/v1/{enc_a}/{enc_t}', timeout=7)
            if r.ok:
                lyr = r.json().get('lyrics', '').strip()
                if len(lyr) > 80:
                    return jsonify({'lyrics': lyr, 'source': 'lyrics.ovh'})
        except Exception:
            pass

    # ── 3. Genius via genius-lyrics-api (no key scraper) ─────
    try:
        search_q = f'{clean_title} {clean_artist}'.strip()
        r = requests.get(
            'https://some-random-api.com/lyrics',
            params={'title': search_q},
            timeout=7,
            headers={'User-Agent': 'TuneRoom/1.0'}
        )
        if r.ok:
            d = r.json()
            lyr = d.get('lyrics', '').strip()
            if len(lyr) > 80:
                return jsonify({'lyrics': lyr, 'source': 'genius'})
    except Exception:
        pass

    # ── 4. happi.dev lyrics (free tier, no key) ──────────────
    try:
        r = requests.get(
            'https://api.happi.dev/v1/music',
            params={'q': f'{clean_artist} {clean_title}', 'limit': 1, 'type': 'track'},
            headers={'x-happi-key': '', 'User-Agent': 'TuneRoom/1.0'},
            timeout=7
        )
        if r.ok:
            results = r.json().get('result', [])
            if results:
                track = results[0]
                r2 = requests.get(track.get('api_lyrics', ''), timeout=7)
                if r2.ok:
                    lyr = r2.json().get('result', {}).get('lyrics', '').strip()
                    if len(lyr) > 80:
                        return jsonify({'lyrics': lyr, 'source': 'happi'})
    except Exception:
        pass

    # ── 5. chartlyrics.com (old but wide coverage) ───────────
    try:
        r = requests.get(
            'http://api.chartlyrics.com/apiv1.asmx/SearchLyricDirect',
            params={'artist': clean_artist, 'song': clean_title},
            timeout=8
        )
        if r.ok and '<Lyric>' in r.text:
            import xml.etree.ElementTree as ET
            root = ET.fromstring(r.text)
            ns = {'n': 'http://api.chartlyrics.com/'}
            lyr = root.find('n:Lyric', ns)
            if lyr is not None and lyr.text and len(lyr.text.strip()) > 80:
                return jsonify({'lyrics': lyr.text.strip(), 'source': 'chartlyrics'})
    except Exception:
        pass

    return jsonify({'error': 'Lyrics not found', 'lyrics': None}), 404


# ─────────────────────────────────────────────────────────────
#  OEMBED  — fetch real title/artist for pasted video IDs
# ─────────────────────────────────────────────────────────────
@app.route('/api/oembed')
def api_oembed():
    vid = request.args.get('id', '').strip()
    if not vid:
        return jsonify({'error': 'no id'}), 400
    try:
        r = requests.get(
            f'https://noembed.com/embed?url=https://www.youtube.com/watch?v={vid}',
            timeout=6
        )
        d = r.json()
        return jsonify({'title': d.get('title', ''), 'channel': d.get('author_name', '')})
    except Exception:
        return jsonify({'title': '', 'channel': ''}), 200


# ─────────────────────────────────────────────────────────────
#  PLAYLIST  — fetch all videos from a YouTube playlist
# ─────────────────────────────────────────────────────────────
@app.route('/api/playlist')
def api_playlist():
    url    = request.args.get('url', '').strip()
    yt_key = os.environ.get('YOUTUBE_API_KEY', '')

    if not url:
        return jsonify({'error': 'No URL provided'}), 400
    if not yt_key:
        return jsonify({'error': 'YOUTUBE_API_KEY not set'}), 400

    # Extract playlist ID from any YouTube playlist URL format
    import re as _re
    pl_match = _re.search(r'[?&]list=([A-Za-z0-9_-]+)', url)
    if not pl_match:
        return jsonify({'error': 'No playlist ID found in URL'}), 400
    playlist_id = pl_match.group(1)

    songs    = []
    next_tok = None

    try:
        # YouTube API returns max 50 per page — loop through all pages
        while True:
            params = {
                'part':       'snippet',
                'playlistId': playlist_id,
                'maxResults': 50,
                'key':        yt_key
            }
            if next_tok:
                params['pageToken'] = next_tok

            r = requests.get(
                'https://www.googleapis.com/youtube/v3/playlistItems',
                params=params,
                timeout=10
            )
            data = r.json()

            if 'error' in data:
                return jsonify({'error': data['error']['message']}), 400

            for item in data.get('items', []):
                sn  = item['snippet']
                vid = sn.get('resourceId', {}).get('videoId', '')
                # Skip deleted/private videos
                if not vid or sn.get('title') in ('Deleted video', 'Private video'):
                    continue
                songs.append({
                    'id':        vid,
                    'title':     sn.get('title', 'Unknown'),
                    'channel':   sn.get('videoOwnerChannelTitle', ''),
                    'thumbnail': f'https://img.youtube.com/vi/{vid}/mqdefault.jpg',
                    'qid':       f'{vid}_{time.time()}'
                })

            next_tok = data.get('nextPageToken')
            if not next_tok or len(songs) >= 200:   # cap at 200 songs
                break

        pl_title = ''
        try:
            r2 = requests.get(
                'https://www.googleapis.com/youtube/v3/playlists',
                params={'part': 'snippet', 'id': playlist_id, 'key': yt_key},
                timeout=6
            )
            items2 = r2.json().get('items', [])
            if items2:
                pl_title = items2[0]['snippet']['title']
        except Exception:
            pass

        return jsonify({
            'playlist_title': pl_title,
            'count':          len(songs),
            'songs':          songs
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ─────────────────────────────────────────────────────────────
#  SOCKET.IO  — real-time room sync
# ─────────────────────────────────────────────────────────────
@socketio.on('join')
def on_join(data):
    rid      = data.get('room', 'main')
    username = data.get('username', 'Anonymous')
    color    = data.get('color', '#60a5fa')
    join_room(rid)
    r     = get_room(rid)
    queue = get_queue(rid)      # from Redis
    state = get_state(rid)      # from Redis
    r['users'][request.sid] = {'username': username, 'color': color, 'sid': request.sid}
    emit('room_state', {
        'queue':         queue,
        'chat_history':  r['chat_history'][-40:],
        'users':         list(r['users'].values()),
        'current_index': state['current_index'],
        'is_playing':    state['is_playing'],
        'current_time':  state['current_time'],
    })
    msg = {'type': 'system', 'text': f'{username} joined ❄️', 'ts': time.time()}
    r['chat_history'].append(msg)
    emit('chat_msg', msg, to=rid)
    emit('user_joined', {'username': username, 'color': color,
                         'sid': request.sid, 'user_count': len(r['users'])}, to=rid)


@socketio.on('disconnect')
def on_disconnect():
    for rid, r in rooms.items():
        if request.sid in r['users']:
            user = r['users'].pop(request.sid)
            r['voice_peers'].pop(request.sid, None)
            msg = {'type': 'system', 'text': f"{user['username']} left", 'ts': time.time()}
            r['chat_history'].append(msg)
            emit('chat_msg', msg, to=rid)
            emit('user_left', {'sid': request.sid, 'user_count': len(r['users'])}, to=rid)
            leave_room(rid)
            break


@socketio.on('add_to_queue')
def on_add(data):
    rid   = data.get('room', 'main')
    song  = {
        'id':        data.get('id', ''),
        'title':     data.get('title', ''),
        'channel':   data.get('channel', ''),
        'thumbnail': data.get('thumbnail', ''),
        'added_by':  data.get('username', '?'),
        'qid':       f"{data.get('id','')}_{time.time()}"
    }
    queue = get_queue(rid)
    queue.append(song)
    redis_set_queue(rid, queue)
    emit('queue_updated', {'queue': queue}, to=rid)


@socketio.on('remove_from_queue')
def on_remove(data):
    rid   = data.get('room', 'main')
    queue = [s for s in get_queue(rid) if s.get('qid') != data.get('qid')]
    redis_set_queue(rid, queue)
    emit('queue_updated', {'queue': queue}, to=rid)


@socketio.on('reorder_queue')
def on_reorder(data):
    rid   = data.get('room', 'main')
    queue = data.get('queue', get_queue(rid))
    redis_set_queue(rid, queue)
    emit('queue_updated', {'queue': queue}, to=rid, include_self=False)


@socketio.on('play_song')
def on_play(data):
    rid = data.get('room', 'main')
    idx = data.get('index', 0)
    redis_set_state(rid, idx, True, 0)
    get_room(rid)['last_sync'] = time.time()
    emit('play_song', {'index': idx}, to=rid)


@socketio.on('player_sync')
def on_sync(data):
    rid = data.get('room', 'main')
    r   = get_room(rid)
    r['last_sync'] = time.time()
    state = get_state(rid)
    redis_set_state(rid, state['current_index'],
                    data.get('is_playing', False),
                    data.get('current_time', 0))
    emit('player_sync', data, to=rid, include_self=False)


@socketio.on('chat_msg')
def on_chat(data):
    rid = data.get('room', 'main')
    r   = get_room(rid)
    txt = data.get('text', '').strip()
    if not txt:
        return
    # Whisper: /w username message
    if txt.startswith('/w '):
        parts = txt.split(' ', 2)
        if len(parts) >= 3:
            target, body = parts[1], parts[2]
            for sid, u in r['users'].items():
                if u['username'].lower() == target.lower():
                    wm = {**data, 'type': 'whisper',
                          'text': f'[whisper → {target}] {body}',
                          'mid': f"m{time.time()}"}
                    emit('chat_msg', wm, to=sid)
                    emit('chat_msg', wm, to=request.sid)
                    return
        return
    msg = {
        'type':     'msg',
        'username': data.get('username'),
        'color':    data.get('color'),
        'text':     txt,
        'ts':       time.time(),
        'mid':      f"m{time.time()}{request.sid[:4]}"
    }
    r['chat_history'].append(msg)
    if len(r['chat_history']) > 150:
        r['chat_history'] = r['chat_history'][-150:]
    emit('chat_msg', msg, to=rid)


@socketio.on('reaction')
def on_reaction(data):
    emit('reaction', data, to=data.get('room', 'main'))


@socketio.on('voice_join')
def on_voice_join(data):
    rid = data.get('room', 'main')
    r   = get_room(rid)
    r['voice_peers'][request.sid] = data.get('username')
    emit('voice_peer_joined', {
        'sid': request.sid, 'username': data.get('username'),
        'existing': list(r['voice_peers'].keys())
    }, to=rid)


@socketio.on('voice_leave')
def on_voice_leave(data):
    rid = data.get('room', 'main')
    r   = get_room(rid)
    r['voice_peers'].pop(request.sid, None)
    emit('voice_peer_left', {'sid': request.sid}, to=rid)


@socketio.on('voice_signal')
def on_voice_signal(data):
    emit('voice_signal', {'from': request.sid, 'signal': data.get('signal')},
         to=data.get('target'))


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    keys = [os.environ.get('YOUTUBE_API_KEY','').strip()]
    keys += [os.environ.get(f'YOUTUBE_API_KEY_{i}','').strip() for i in range(2,31)]
    active_keys = sum(1 for k in keys if k)
    print(f'\n  ❄️  TuneRoom → http://localhost:{port}')
    print(f'  YouTube keys   : {active_keys} active key(s)')
    print(f'  Invidious      : ✓ ON (fallback, no key needed)')
    print(f'  Lyrics         : ✓ ON (5 sources)')
    print()
    socketio.run(app, host='0.0.0.0', port=port, debug=False, allow_unsafe_werkzeug=True)