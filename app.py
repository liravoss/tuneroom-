from flask import Flask, render_template, request, jsonify, Response
from flask_socketio import SocketIO, emit, join_room, leave_room
from flask_compress import Compress
import os, time, json, requests
from dotenv import load_dotenv
load_dotenv()

app = Flask(__name__)
_secret = os.environ.get('SECRET_KEY', '')
if not _secret:
    import secrets
    _secret = secrets.token_hex(32)
    print('  ⚠ SECRET_KEY not set — using random key (sessions will reset on restart)')
app.config['SECRET_KEY'] = _secret
app.config['COMPRESS_ALGORITHM'] = 'gzip'
app.config['COMPRESS_LEVEL']     = 6
app.config['COMPRESS_MIN_SIZE']  = 500
Compress(app)
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='gevent')

# ─────────────────────────────────────────────────────────────
#  UPSTASH REDIS — queue + search cache (persists forever)
#  Chat stays in RAM only (intentional)
# ─────────────────────────────────────────────────────────────
REDIS_URL   = os.environ.get('UPSTASH_REDIS_REST_URL', '').rstrip('/')
REDIS_TOKEN = os.environ.get('UPSTASH_REDIS_REST_TOKEN', '')
CACHE_TTL   = 6 * 3600   # search cache expires after 6 hours

def redis_cmd(*args):
    """Send a command to Upstash Redis REST API using JSON body."""
    if not REDIS_URL or not REDIS_TOKEN:
        return None
    try:
        resp = requests.post(
            f'{REDIS_URL}',
            headers={
                'Authorization': f'Bearer {REDIS_TOKEN}',
                'Content-Type':  'application/json'
            },
            json=list(args),
            timeout=5
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

def sanitize_room_id(rid):
    """Allow only safe room IDs — letters, numbers, hyphens, underscores. Max 40 chars."""
    import re
    rid = str(rid or 'main').strip()
    rid = re.sub(r'[^a-zA-Z0-9_-]', '', rid)  # strip unsafe chars
    rid = rid[:40]                               # limit length
    return rid or 'main'

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

def cleanup_dead_rooms():
    """Remove rooms from RAM that have 0 users — runs every 30 minutes."""
    dead = [rid for rid, r in rooms.items() if len(r.get('users', {})) == 0]
    for rid in dead:
        del rooms[rid]
    if dead:
        print(f'  ❄ Cleaned {len(dead)} empty room(s) from RAM')

def _start_cleanup_timer():
    """Run dead room cleanup every 30 minutes using gevent (compatible with async_mode=gevent)."""
    import gevent
    def _loop():
        while True:
            gevent.sleep(1800)  # 30 minutes
            cleanup_dead_rooms()
    gevent.spawn(_loop)

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

@app.route('/sw.js')
def service_worker():
    from flask import send_from_directory
    resp = send_from_directory('.', 'sw.js')
    resp.headers['Cache-Control'] = 'no-cache'
    resp.headers['Content-Type']  = 'application/javascript'
    return resp

@app.route('/manifest.json')
def manifest():
    return app.send_static_file('manifest.json')

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
    'https://inv.nadeko.net',
    'https://yewtu.be',
    'https://invidious.nerdvpn.de',
    'https://invidious.privacyredirect.com',
    'https://iv.melmac.space',
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
            timeout=5  # reduced from 8 — fail fast, try next
        )
        data = resp.json()

        if 'error' in data:
            code = data['error'].get('code', 0)
            if code in (403, 429):
                return None   # quota hit
            return None       # any error — try next key

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
        return results if results else None

    except Exception:
        return None


def _search_youtube_parallel(q, keys):
    """Try all YouTube API keys simultaneously — returns first successful result."""
    if not keys:
        return None
    import gevent.pool
    pool = gevent.pool.Pool(size=min(len(keys), 5))
    results_box = [None]
    def _try(k):
        if results_box[0]: return
        r = _search_youtube_key(q, k)
        if r and not results_box[0]:
            results_box[0] = r
    jobs = [pool.spawn(_try, k) for k in keys]
    # Wait up to 6s for any job to succeed
    import gevent
    gevent.joinall(jobs, timeout=6)
    return results_box[0]


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


def _get_piped_instances():
    """Fetch live Piped instance list — cached 6 hours."""
    now = time.time()
    if hasattr(_get_piped_instances, '_cache'):
        cached, ts = _get_piped_instances._cache
        if now - ts < 21600:
            return cached
    try:
        r = requests.get('https://piped-instances-api.vercel.app/api/instances', timeout=8)
        if r.ok:
            data = r.json()
            instances = [inst['api'] for inst in data
                         if inst.get('api') and not inst.get('down', False)]
            if instances:
                _get_piped_instances._cache = (instances, now)
                return instances
    except Exception:
        pass
    return []

PIPED_INSTANCES_FALLBACK = [
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.tokhmi.xyz',
    'https://pipedapi.moomoo.me',
    'https://pipedapi.leptons.xyz',
    'https://pipedapi.nosebs.ru',
]

# Multiple Piped instances
PIPED_INSTANCES = PIPED_INSTANCES_FALLBACK

# Set ENABLE_PUBLIC_PROXIES=false in env to skip Invidious/Piped (reduces noise)
ENABLE_PUBLIC_PROXIES = os.environ.get('ENABLE_PUBLIC_PROXIES', 'true').lower() != 'false'

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

    # ── Try all YouTube API keys simultaneously ─────────────────
    # All keys tried in parallel — returns fastest successful result
    yt_keys = []
    base = os.environ.get('YOUTUBE_API_KEY', '').strip()
    if base: yt_keys.append(base)
    for i in range(2, 31):
        k = os.environ.get(f'YOUTUBE_API_KEY_{i}', '').strip()
        if k: yt_keys.append(k)

    if yt_keys:
        results = _search_youtube_parallel(q, yt_keys)
        if results:
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
@app.route('/api/rooms/stats')
def rooms_stats():
    # Require secret key to view stats — prevents public snooping
    secret = os.environ.get('STATS_KEY', '')
    if secret and request.args.get('key') != secret:
        return jsonify({'error': 'unauthorized'}), 403
    stats = []
    for rid, r in rooms.items():
        state = get_state(rid)
        queue = get_queue(rid)
        stats.append({
            'room':          rid,
            'users':         len(r.get('users', {})),
            'queue_length':  len(queue),
            'is_playing':    state['is_playing'],
            'current_index': state['current_index'],
        })
    return jsonify({
        'active_rooms': len(rooms),
        'rooms':        stats
    })

@app.route('/api/cache/stats')
def cache_stats():
    try:
        # Use SCAN instead of KEYS — safer in production
        keys = []
        cursor = 0
        while True:
            result = redis_cmd('SCAN', cursor, 'MATCH', 'tr:cache:*', 'COUNT', 100)
            if not result:
                break
            cursor = int(result[0])
            keys.extend(result[1] if result[1] else [])
            if cursor == 0:
                break
        queries = [k.replace('tr:cache:', '') for k in keys]
        return jsonify({
            'cached_queries': len(queries),
            'ttl_hours':      CACHE_TTL // 3600,
            'redis':          bool(REDIS_URL),
            'queries':        queries
        })
    except Exception as e:
        return jsonify({'error': str(e), 'cached_queries': 0})

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
            headers={'User-Agent': 'TuneRoom/1.0'},
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
            'https://api.chartlyrics.com/apiv1.asmx/SearchLyricDirect',
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

    # Collect all available YouTube keys (same rotation as search)
    yt_keys = []
    base = os.environ.get('YOUTUBE_API_KEY', '').strip()
    if base: yt_keys.append(base)
    for i in range(2, 31):
        k = os.environ.get(f'YOUTUBE_API_KEY_{i}', '').strip()
        if k: yt_keys.append(k)

    if not url:
        return jsonify({'error': 'No URL provided'}), 400
    if not yt_keys:
        return jsonify({'error': 'No YOUTUBE_API_KEY set'}), 400

    yt_key = yt_keys[0]  # start with primary; rotate on quota error below

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
                code = data['error'].get('code', 0)
                # Rotate to next key on quota error
                if code in (403, 429) and len(yt_keys) > 1:
                    yt_keys.pop(0)
                    yt_key = yt_keys[0]
                    continue
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
#  SANITIZE HELPERS  — used by Socket.IO handlers below
# ─────────────────────────────────────────────────────────────
def sanitize_color(c):
    """Allow only valid hex colors — prevents CSS injection via color field."""
    import re
    c = str(c or '#60a5fa').strip()
    if re.match(r'^#[0-9a-fA-F]{3,6}$', c):
        return c
    return '#60a5fa'  # default ice blue

def sanitize_text(t, maxlen=500):
    """Strip HTML tags and limit length — prevents XSS via chat text."""
    import re
    t = str(t or '').strip()
    t = re.sub(r'<[^>]*>', '', t)   # strip all HTML tags
    t = t[:maxlen]                   # limit length
    return t

# ─────────────────────────────────────────────────────────────
#  SOCKET.IO  — real-time room sync
# ─────────────────────────────────────────────────────────────
@socketio.on('join')
def on_join(data):
    rid      = sanitize_room_id(data.get('room', 'main'))
    username = sanitize_text(data.get('username', 'Anonymous'), maxlen=20)
    color    = sanitize_color(data.get('color', '#60a5fa'))
    uid      = sanitize_text(str(data.get('uid', request.sid)), maxlen=30)
    join_room(rid)
    r     = get_room(rid)
    queue = get_queue(rid)      # from Redis
    state = get_state(rid)      # from Redis
    r['users'][request.sid] = {'username': username, 'color': color, 'sid': request.sid, 'uid': uid}
    # Send room_state ONLY to the joining user — never broadcast to whole room
    # Broadcasting room_state caused song restarts for everyone already in the room
    emit('room_state', {
        'queue':         queue,
        'chat_history':  r['chat_history'][-50:],
        'users':         list(r['users'].values()),
        'current_index': state['current_index'],
        'is_playing':    state['is_playing'],
        'current_time':  state['current_time'],
    }, to=request.sid)
    # If a song is actively playing, ask existing members to report their
    # real current_time — Redis may be stale by several seconds
    if state['is_playing'] and state['current_index'] >= 0:
        emit('request_sync', {'for_sid': request.sid}, to=rid, include_self=False)
    msg = {'type': 'system', 'text': f'{username} joined ❄️', 'ts': time.time()}
    r['chat_history'].append(msg)
    emit('chat_msg', msg, to=rid)
    emit('user_joined', {'username': username, 'color': color,
                         'sid': request.sid, 'user_count': len(r['users'])}, to=rid)


@socketio.on('disconnect')
def on_disconnect():
    for rid, r in list(rooms.items()):
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
    rid   = sanitize_room_id(data.get('room', 'main'))
    raw_id = sanitize_text(str(data.get('id', '')), maxlen=20)
    song  = {
        'id':        raw_id,
        'title':     sanitize_text(data.get('title', ''), maxlen=150),
        'channel':   sanitize_text(data.get('channel', ''), maxlen=80),
        'thumbnail': f'https://img.youtube.com/vi/{raw_id}/mqdefault.jpg',
        'added_by':  sanitize_text(data.get('username', '?'), maxlen=20),
        'qid':       f"{raw_id}_{time.time()}"
    }
    queue = get_queue(rid)
    if len(queue) >= 200:
        emit('toast', {'msg': '⚠ Queue is full (200 songs max)'}, to=request.sid)
        return
    queue.append(song)
    redis_set_queue(rid, queue)
    emit('queue_updated', {'queue': queue}, to=rid)


@socketio.on('remove_from_queue')
def on_remove(data):
    rid      = sanitize_room_id(data.get('room', 'main'))
    old_q    = get_queue(rid)
    rem_qid  = data.get('qid')
    # Find index of removed song to adjust current_index
    rem_pos  = next((i for i,s in enumerate(old_q) if s.get('qid') == rem_qid), -1)
    queue    = [s for s in old_q if s.get('qid') != rem_qid]
    redis_set_queue(rid, queue)
    # Adjust current_index if needed
    state    = get_state(rid)
    cur      = state['current_index']
    if rem_pos >= 0 and rem_pos < cur:
        # Removed song was before current — shift index back
        cur = max(0, cur - 1)
        redis_set_state(rid, cur, state['is_playing'], state['current_time'])
    elif rem_pos == cur:
        # Removed the currently playing song
        cur = min(cur, len(queue) - 1)
        redis_set_state(rid, cur, False, 0)
    emit('queue_updated', {'queue': queue, 'current_index': cur}, to=rid)


@socketio.on('reorder_queue')
def on_reorder(data):
    rid   = sanitize_room_id(data.get('room', 'main'))
    queue = data.get('queue', get_queue(rid))
    redis_set_queue(rid, queue)
    # If queue was cleared, reset playback state in Redis too
    if len(queue) == 0:
        redis_set_state(rid, -1, False, 0)
    emit('queue_updated', {'queue': queue}, to=rid, include_self=False)


@socketio.on('play_song')
def on_play(data):
    rid   = sanitize_room_id(data.get('room', 'main'))
    queue = get_queue(rid)
    try:
        idx = int(data.get('index', 0))
    except (TypeError, ValueError):
        idx = 0
    # Clamp index to valid queue range
    if queue:
        idx = max(0, min(idx, len(queue) - 1))
    else:
        idx = -1
    redis_set_state(rid, idx, True, 0)
    get_room(rid)['last_sync'] = time.time()
    emit('play_song', {'index': idx}, to=rid)


@socketio.on('sync_reply')
def on_sync_reply(data):
    """Existing member reports their real current_time for a joining user."""
    rid        = sanitize_room_id(data.get('room', 'main'))
    target_sid = data.get('for_sid', '')
    r          = get_room(rid)
    # Only forward to the target if they're still in the room
    if target_sid and target_sid in r['users']:
        emit('sync_from_peer', {
            'current_time': float(data.get('current_time', 0)),
            'is_playing':   bool(data.get('is_playing', True)),
        }, to=target_sid)


@socketio.on('player_sync')
def on_sync(data):
    """Position-only heartbeat — does NOT change is_playing state.
    Only updates current_time in Redis so joiners get a fresh position.
    is_playing is only changed by play_song / pause_song / resume_song."""
    rid = sanitize_room_id(data.get('room', 'main'))
    r   = get_room(rid)
    r['last_sync'] = time.time()
    state = get_state(rid)
    # Only save time, keep existing is_playing
    redis_set_state(rid, state['current_index'],
                    state['is_playing'],
                    data.get('current_time', 0))
    # Only broadcast to others — sender already knows their own position
    emit('player_sync', {
        'room':         rid,
        'current_time': float(data.get('current_time', 0)),
        'ts':           data.get('ts', 0),
    }, to=rid, include_self=False)


@socketio.on('pause_song')
def on_pause(data):
    """Authoritative pause — updates server state and tells everyone."""
    rid = sanitize_room_id(data.get('room', 'main'))
    state = get_state(rid)
    redis_set_state(rid, state['current_index'], False,
                    data.get('current_time', state['current_time']))
    emit('pause_song', {
        'current_time': float(data.get('current_time', 0)),
    }, to=rid, include_self=False)


@socketio.on('resume_song')
def on_resume(data):
    """Authoritative resume — updates server state and tells everyone."""
    rid = sanitize_room_id(data.get('room', 'main'))
    state = get_state(rid)
    redis_set_state(rid, state['current_index'], True,
                    data.get('current_time', state['current_time']))
    emit('resume_song', {
        'current_time': float(data.get('current_time', 0)),
        'ts':           data.get('ts', 0),
    }, to=rid, include_self=False)


@socketio.on('chat_msg')
def on_chat(data):
    rid  = sanitize_room_id(data.get('room', 'main'))
    r    = get_room(rid)
    # ── Sanitize all inputs before broadcasting ──────────────
    txt      = sanitize_text(data.get('text', ''))
    username = sanitize_text(data.get('username', 'Anonymous'), maxlen=20)
    color    = sanitize_color(data.get('color', '#60a5fa'))
    if not txt:
        return
    # Whisper: /w username message
    if txt.startswith('/w '):
        parts = txt.split(' ', 2)
        if len(parts) >= 3:
            target = sanitize_text(parts[1], maxlen=20)
            body   = sanitize_text(parts[2])
            for sid, u in r['users'].items():
                if u['username'].lower() == target.lower():
                    wm = {'type': 'whisper', 'username': username,
                          'color': color,
                          'text': f'[whisper → {target}] {body}',
                          'ts': time.time(),
                          'mid': f"m{time.time()}"}
                    emit('chat_msg', wm, to=sid)
                    emit('chat_msg', wm, to=request.sid)
                    return
        return
    msg = {
        'type':     'msg',
        'username': username,
        'color':    color,
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
    rid = sanitize_room_id(data.get('room', 'main'))
    # Only forward safe fields — never raw data
    emit('reaction', {
        'mid':   sanitize_text(str(data.get('mid', '')), maxlen=40),
        'emoji': sanitize_text(str(data.get('emoji', '')), maxlen=10),
    }, to=rid)


@socketio.on('voice_join')
def on_voice_join(data):
    rid = sanitize_room_id(data.get('room', 'main'))
    r   = get_room(rid)
    clean_username = sanitize_text(data.get('username', 'Anonymous'), maxlen=20)
    r['voice_peers'][request.sid] = clean_username
    emit('voice_peer_joined', {
        'sid': request.sid, 'username': clean_username,
        'existing': list(r['voice_peers'].keys())
    }, to=rid)


@socketio.on('voice_leave')
def on_voice_leave(data):
    rid = sanitize_room_id(data.get('room', 'main'))
    r   = get_room(rid)
    r['voice_peers'].pop(request.sid, None)
    emit('voice_peer_left', {'sid': request.sid}, to=rid)


@socketio.on('voice_signal')
def on_voice_signal(data):
    rid    = sanitize_room_id(data.get('room', 'main'))
    target = data.get('target')
    r      = get_room(rid)
    # Only forward to targets that are actually in the same room
    if target and (target in r['users'] or target in r.get('voice_peers', {})):
        emit('voice_signal', {'from': request.sid, 'signal': data.get('signal')},
             to=target)


def _check_ytdlp():
    """Check if yt-dlp is installed and return version string or None."""
    import subprocess
    try:
        r = subprocess.run(['yt-dlp', '--version'],
                           capture_output=True, text=True, timeout=5)
        if r.returncode == 0:
            return r.stdout.strip()
    except FileNotFoundError:
        pass
    except Exception:
        pass
    return None


def _get_stream_ytdlp(video_id, fmt, qual):
    """
    Primary download method — yt-dlp subprocess.
    Handles ciphers, throttling, client rotation automatically.
    Returns (stream_url, title, error_msg) — error_msg is None on success.
    """
    import subprocess

    ytdlp_version = _check_ytdlp()
    if not ytdlp_version:
        return None, None, 'yt-dlp not installed on server (run: pip install yt-dlp)'

    print(f'[yt-dlp] version {ytdlp_version}', flush=True)

    yt_url = f'https://www.youtube.com/watch?v={video_id}'

    # Format selector with multiple fallbacks
    if fmt == 'mp3':
        format_str = 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best'
    else:
        format_str = (
            f'bestvideo[height<={qual}][ext=mp4]+bestaudio[ext=m4a]'
            f'/bestvideo[height<={qual}]+bestaudio'
            f'/best[height<={qual}]'
            f'/best'
        )

    import pathlib
    cookies_path = pathlib.Path('/etc/secrets/cookies.txt')
    base_cmd = ['yt-dlp', '--no-playlist', '--no-warnings']
    if cookies_path.exists():
        base_cmd += ['--cookies', str(cookies_path)]
        print('[yt-dlp] using cookies.txt', flush=True)
    else:
        print('[yt-dlp] no cookies.txt found — may fail on Render', flush=True)

    # Get title
    try:
        title_r = subprocess.run(
            base_cmd + ['--get-title', yt_url],
            capture_output=True, text=True, timeout=15
        )
        title = title_r.stdout.strip() or video_id
    except Exception:
        title = video_id

    # Get stream URL
    try:
        url_r = subprocess.run(
            base_cmd + ['--get-url', '-f', format_str, yt_url],
            capture_output=True, text=True, timeout=25
        )
        if url_r.returncode != 0:
            err = url_r.stderr.strip()[:300]
            print(f'[yt-dlp] failed (rc={url_r.returncode}): {err}', flush=True)
            return None, None, f'yt-dlp error: {err}'

        # May return multiple lines (video URL + audio URL for merged formats)
        # Take the first — we proxy it as-is (pre-muxed or audio-only)
        stream_url = url_r.stdout.strip().split('\n')[0].strip()
        if stream_url:
            print(f'[yt-dlp] OK for {video_id} fmt={fmt} qual={qual}', flush=True)
            return stream_url, title, None

        return None, None, 'yt-dlp returned empty URL'

    except subprocess.TimeoutExpired:
        return None, None, 'yt-dlp timed out (>25s)'
    except Exception as e:
        return None, None, f'yt-dlp exception: {e}'


def _get_stream_youtube_internal(video_id, fmt, qual):
    """Try multiple YouTube innertube clients to get a direct stream URL."""
    CLIENTS = [
        {
            'clientName': 'ANDROID',
            'clientVersion': '19.49.37',
            'client_name_id': '3',
            'androidSdkVersion': 34,
            'userAgent': 'com.google.android.youtube/19.49.37 (Linux; U; Android 14) gzip',
        },
        {
            'clientName': 'ANDROID',
            'clientVersion': '19.09.37',
            'client_name_id': '3',
            'androidSdkVersion': 30,
            'userAgent': 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
        },
        {
            'clientName': 'TVHTML5',
            'clientVersion': '7.20250303.08.00',
            'client_name_id': '85',
            'userAgent': 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/538.1',
        },
        {
            'clientName': 'WEB',
            'clientVersion': '2.20250303.01.00',
            'client_name_id': '1',
            'userAgent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        {
            'clientName': 'WEB_EMBEDDED_PLAYER',
            'clientVersion': '2.20250225.01.00',
            'client_name_id': '56',
            'userAgent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
    ]

    for client in CLIENTS:
        try:
            ctx = {
                'clientName': client['clientName'],
                'clientVersion': client['clientVersion'],
                'hl': 'en', 'gl': 'US',
            }
            if 'androidSdkVersion' in client:
                ctx['androidSdkVersion'] = client['androidSdkVersion']

            payload = {
                'context': {'client': ctx},
                'videoId': video_id,
                'racyCheckOk': True,
                'contentCheckOk': True,
            }
            resp = requests.post(
                'https://www.youtube.com/youtubei/v1/player',
                params={'prettyPrint': 'false'},
                json=payload, timeout=12,
                headers={
                    'User-Agent': client['userAgent'],
                    'Content-Type': 'application/json',
                    'X-YouTube-Client-Name': client['client_name_id'],
                    'X-YouTube-Client-Version': client['clientVersion'],
                    'Origin': 'https://www.youtube.com',
                }
            )
            if not resp.ok:
                print(f'[yt-internal] {client["clientName"]} HTTP {resp.status_code}', flush=True)
                continue

            data = resp.json()
            title = data.get('videoDetails', {}).get('title', video_id)
            streaming = data.get('streamingData', {})

            all_streams = streaming.get('formats', []) + streaming.get('adaptiveFormats', [])
            sample = all_streams[0] if all_streams else {}
            has_url    = bool(sample.get('url'))
            has_cipher = bool(sample.get('signatureCipher') or sample.get('cipher'))
            print(f'[yt-internal] {client["clientName"]} — url:{has_url} cipher:{has_cipher}', flush=True)

            if has_cipher:
                continue  # Can't decode without yt-dlp

            if fmt == 'mp3':
                streams = [s for s in streaming.get('adaptiveFormats', [])
                           if s.get('mimeType', '').startswith('audio/') and s.get('url')]
                streams.sort(key=lambda s: s.get('averageBitrate', s.get('bitrate', 0)), reverse=True)
                idx = min({'320': 0, '192': 1, '128': 2}.get(qual, 0), max(len(streams) - 1, 0))
                if streams:
                    print(f'[yt-internal] {client["clientName"]} OK (audio)', flush=True)
                    return streams[idx].get('url'), title
            else:
                streams = [s for s in streaming.get('formats', []) if s.get('url')]
                qual_int = int(qual)
                best = None
                for s in streams:
                    h = s.get('height', 0) or 0
                    if h <= qual_int:
                        if best is None or h > (best.get('height') or 0):
                            best = s
                if not best and streams:
                    best = max(streams, key=lambda s: s.get('height', 0) or 0)
                if best:
                    print(f'[yt-internal] {client["clientName"]} OK ({best.get("qualityLabel")})', flush=True)
                    return best.get('url'), title

            print(f'[yt-internal] {client["clientName"]} — no usable direct URL', flush=True)

        except Exception as e:
            print(f'[yt-internal] {client["clientName"]} error: {e}', flush=True)

    return None, None


@app.route('/api/download')
def api_download():
    from flask import stream_with_context
    video_id = request.args.get('id', '').strip()
    fmt      = request.args.get('fmt', 'mp4').strip()
    qual     = request.args.get('qual', '720').strip()

    if not video_id:
        return jsonify({'error': 'No video ID'}), 400

    stream_url  = None
    video_title = video_id
    errors      = []

    # ── 1. yt-dlp (primary — handles ciphers automatically) ──────
    stream_url, video_title, ytdlp_err = _get_stream_ytdlp(video_id, fmt, qual)
    if not stream_url:
        errors.append(f'yt-dlp: {ytdlp_err}')

    # ── 2. YouTube internal innertube clients ─────────────────────
    if not stream_url:
        stream_url, video_title = _get_stream_youtube_internal(video_id, fmt, qual)
        if not stream_url:
            errors.append('YouTube internal: all clients returned cipher or no direct URL')

    # ── 3. Invidious + Piped (optional, env-controlled) ───────────
    if not stream_url and ENABLE_PUBLIC_PROXIES:
        for instance in INVIDIOUS_INSTANCES:
            try:
                resp = requests.get(
                    f'{instance.rstrip("/")}/api/v1/videos/{video_id}',
                    timeout=8, headers={'User-Agent': 'Mozilla/5.0'}
                )
                if not resp.ok:
                    errors.append(f'Invidious {instance}: HTTP {resp.status_code}')
                    continue
                data = resp.json()
                if 'error' in data:
                    errors.append(f'Invidious {instance}: {data["error"]}')
                    continue
                video_title = data.get('title', video_id)
                if fmt == 'mp3':
                    streams = [s for s in data.get('adaptiveFormats', [])
                               if s.get('type', '').startswith('audio/')]
                    streams.sort(key=lambda s: s.get('bitrate', 0), reverse=True)
                    idx = min({'320': 0, '192': 1, '128': 2}.get(qual, 0), max(len(streams) - 1, 0))
                    if streams:
                        stream_url = streams[idx].get('url')
                else:
                    combined = data.get('formatStreams', [])
                    qual_int = int(qual)
                    best = None
                    for s in combined:
                        h = int(s.get('resolution', '0p').replace('p', '') or 0)
                        if h <= qual_int:
                            if best is None or h > int(best.get('resolution', '0p').replace('p', '') or 0):
                                best = s
                    if not best and combined:
                        best = combined[0]
                    if best:
                        stream_url = best.get('url')
                if stream_url:
                    print(f'[download] Invidious OK: {instance}', flush=True)
                    break
                errors.append(f'Invidious {instance}: no stream in response')
            except Exception as e:
                errors.append(f'Invidious {instance}: {e}')

    if not stream_url and ENABLE_PUBLIC_PROXIES:
        piped_list = _get_piped_instances() or PIPED_INSTANCES_FALLBACK
        for instance in piped_list:
            try:
                resp = requests.get(
                    f'{instance.rstrip("/")}/streams/{video_id}',
                    timeout=8, headers={'User-Agent': 'Mozilla/5.0'}
                )
                if not resp.ok:
                    errors.append(f'Piped {instance}: HTTP {resp.status_code}')
                    continue
                data = resp.json()
                if 'error' in data:
                    errors.append(f'Piped {instance}: {data["error"]}')
                    continue
                video_title = data.get('title', video_id)
                if fmt == 'mp3':
                    streams = data.get('audioStreams', [])
                    streams.sort(key=lambda s: s.get('bitrate', 0), reverse=True)
                    idx = min({'320': 0, '192': 1, '128': 2}.get(qual, 0), max(len(streams) - 1, 0))
                    if streams:
                        stream_url = streams[idx].get('url')
                else:
                    streams = [s for s in data.get('videoStreams', [])
                               if not s.get('videoOnly', True)]
                    qual_int = int(qual)
                    best = None
                    for s in streams:
                        h = s.get('height', 0) or 0
                        if h <= qual_int:
                            if best is None or h > (best.get('height') or 0):
                                best = s
                    if not best and streams:
                        best = streams[0]
                    if best:
                        stream_url = best.get('url')
                if stream_url:
                    print(f'[download] Piped OK: {instance}', flush=True)
                    break
                errors.append(f'Piped {instance}: no stream in response')
            except Exception as e:
                errors.append(f'Piped {instance}: {e}')

    if not stream_url:
        print(f'[download] All sources failed for {video_id} | {fmt}/{qual}', flush=True)
        print(f'          Errors: {errors}', flush=True)
        return jsonify({
            'error': 'Could not get any playable stream URL',
            'message': 'YouTube is actively blocking most public proxies right now (March 2026). Try again in a few hours or use a different video.',
            'hint': 'yt-dlp is having temporary issues with YouTube (March 2026). Try again soon or check https://github.com/yt-dlp/yt-dlp/issues',
            'details': errors[-3:]
        }), 503

    safe_title = ''.join(c if c.isalnum() or c in ' _-' else '_' for c in video_title)
    ext  = 'webm' if fmt == 'mp3' else 'mp4'
    mime = 'audio/webm' if fmt == 'mp3' else 'video/mp4'
    filename = f'{safe_title}.{ext}'

    try:
        upstream = requests.get(
            stream_url, stream=True, timeout=30,
            headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.youtube.com/'}
        )
        if not upstream.ok:
            return jsonify({'error': f'Stream fetch failed: HTTP {upstream.status_code}'}), 502

        def generate():
            for chunk in upstream.iter_content(chunk_size=65536):
                if chunk:
                    yield chunk

        resp_headers = {
            'Content-Disposition': f'attachment; filename="{filename}"',
            'Content-Type': mime,
        }
        cl = upstream.headers.get('Content-Length')
        if cl:
            resp_headers['Content-Length'] = cl

        return Response(stream_with_context(generate()), headers=resp_headers, status=200)

    except Exception as e:
        return jsonify({'error': f'Stream proxy failed: {e}'}), 502


if __name__ == '__main__':
    _start_cleanup_timer()
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