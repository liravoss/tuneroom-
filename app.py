from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit, join_room, leave_room
import os, time, json, requests
from dotenv import load_dotenv
load_dotenv()

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'tuneroom-secret-2026')
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='threading')

rooms = {}

def get_room(rid):
    if rid not in rooms:
        rooms[rid] = {
            'queue': [], 'users': {}, 'chat_history': [],
            'voice_peers': {}, 'current_index': -1,
            'is_playing': False, 'current_time': 0.0, 'last_sync': time.time()
        }
    return rooms[rid]

# ─────────────────────────────────────────────────────────────
#  PAGES
# ─────────────────────────────────────────────────────────────
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/room', defaults={'room_id': 'main'})
@app.route('/room/<room_id>')
def room(room_id):
    return render_template('room.html', room_id=room_id)

# ─────────────────────────────────────────────────────────────
#  YOUTUBE DATA API SEARCH
# ─────────────────────────────────────────────────────────────
@app.route('/api/search')
def api_search():
    q = request.args.get('q', '').strip()
    if not q:
        return jsonify({'error': 'empty query'}), 400

    yt_key = os.environ.get('YOUTUBE_API_KEY', '')
    if not yt_key:
        return jsonify({
            'error': 'YOUTUBE_API_KEY not set in .env file',
            'results': []
        }), 200

    try:
        resp = requests.get(
            'https://www.googleapis.com/youtube/v3/search',
            params={
                'part':            'snippet',
                'q':               q,
                'type':            'video',
                'videoCategoryId': '10',
                'maxResults':      10,
                'key':             yt_key
            },
            timeout=8
        )
        data = resp.json()

        if 'error' in data:
            return jsonify({'error': data['error']['message'], 'results': []}), 200

        results = []
        for item in data.get('items', []):
            vid = item['id']['videoId']
            sn  = item['snippet']
            results.append({
                'id':        vid,
                'title':     sn['title'],
                'channel':   sn['channelTitle'],
                'thumbnail': f'https://img.youtube.com/vi/{vid}/mqdefault.jpg'
            })

        return jsonify({'source': 'youtube', 'results': results})

    except requests.Timeout:
        return jsonify({'error': 'Search timed out', 'results': []}), 200
    except Exception as e:
        return jsonify({'error': str(e), 'results': []}), 500


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
    rid = data.get('room', 'main')
    username = data.get('username', 'Anonymous')
    color    = data.get('color', '#60a5fa')
    join_room(rid)
    r = get_room(rid)
    r['users'][request.sid] = {'username': username, 'color': color, 'sid': request.sid}
    emit('room_state', {
        'queue':         r['queue'],
        'chat_history':  r['chat_history'][-40:],
        'users':         list(r['users'].values()),
        'current_index': r['current_index'],
        'is_playing':    r['is_playing'],
        'current_time':  r['current_time'],
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
    rid  = data.get('room', 'main')
    r    = get_room(rid)
    song = {
        'id':        data.get('id', ''),
        'title':     data.get('title', ''),
        'channel':   data.get('channel', ''),
        'thumbnail': data.get('thumbnail', ''),
        'added_by':  data.get('username', '?'),
        'qid':       f"{data.get('id','')}_{time.time()}"
    }
    r['queue'].append(song)
    emit('queue_updated', {'queue': r['queue']}, to=rid)


@socketio.on('remove_from_queue')
def on_remove(data):
    rid = data.get('room', 'main')
    r   = get_room(rid)
    r['queue'] = [s for s in r['queue'] if s.get('qid') != data.get('qid')]
    emit('queue_updated', {'queue': r['queue']}, to=rid)


@socketio.on('reorder_queue')
def on_reorder(data):
    rid = data.get('room', 'main')
    r   = get_room(rid)
    r['queue'] = data.get('queue', r['queue'])
    emit('queue_updated', {'queue': r['queue']}, to=rid, include_self=False)


@socketio.on('play_song')
def on_play(data):
    rid = data.get('room', 'main')
    r   = get_room(rid)
    r['current_index'] = data.get('index', 0)
    r['is_playing']    = True
    r['current_time']  = 0
    r['last_sync']     = time.time()
    emit('play_song', {'index': r['current_index']}, to=rid)


@socketio.on('player_sync')
def on_sync(data):
    rid = data.get('room', 'main')
    r   = get_room(rid)
    r['is_playing']   = data.get('is_playing', False)
    r['current_time'] = data.get('current_time', 0)
    r['last_sync']    = time.time()
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
    port   = int(os.environ.get('PORT', 5000))
    has_yt = bool(os.environ.get('YOUTUBE_API_KEY'))
    print(f'\n  ❄️  TuneRoom → http://localhost:{port}')
    print(f'  YouTube search : {"✓ ON" if has_yt else "✗ set YOUTUBE_API_KEY in .env"}')
    print(f'  Lyrics         : ✓ ON (5 sources)')
    print()
    socketio.run(app, host='0.0.0.0', port=port, debug=False, allow_unsafe_werkzeug=True)