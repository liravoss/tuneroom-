<div align="center">

```
╔════════════════════════════════════════╗
║                                        ║
║        ❄  T U N E R O O M  ❄          ║
║                                        ║
║      Listen Together. Feel the         ║
║           Frost.                       ║
╚════════════════════════════════════════╝
```

**A real-time collaborative music room.**  
Search, queue, listen, and chat — all in sync with your friends.

![Python](https://img.shields.io/badge/Python-3.11-3b82f6?style=flat-square&logo=python&logoColor=white)
![Flask](https://img.shields.io/badge/Flask-3.0-60a5fa?style=flat-square&logo=flask&logoColor=white)
![Socket.IO](https://img.shields.io/badge/Socket.IO-4.7-38bdf8?style=flat-square&logo=socket.io&logoColor=white)
![YouTube](https://img.shields.io/badge/YouTube_API-v3-93c5fd?style=flat-square&logo=youtube&logoColor=white)
![Redis](https://img.shields.io/badge/Upstash_Redis-∞-38bdf8?style=flat-square&logo=redis&logoColor=white)

🌐 **Live → [tuneroom-h40l.onrender.com](https://tuneroom-h40l.onrender.com)**

</div>

---

## ❄ Features

```
🔍  Smart Search            YouTube API with 30-key rotation + 3 free fallbacks
📋  Playlist Import         Paste any YouTube playlist URL — loads all songs instantly
🎬  Video / Audio Mode      Toggle between video or audio-only
🎤  Live Lyrics             Auto-fetches lyrics (5-source cascade)
💬  Real-time Chat          Live chat with emoji reactions and whisper messages
🎙  Voice Chat              Peer-to-peer voice with WebRTC — talk while you listen
🔀  Shared Queue            Persistent queue — drag to reorder, survives restarts
🗑  Clear Queue             Wipe the entire queue with one click
💾  Redis Persistence       Queue and search cache stored forever in Upstash Redis
🧠  Search Cache            Repeated searches served instantly — zero API quota used
📱  Mobile Ready            Responsive 3-tab layout for phones and tablets
🎵  Background Play         Audio keeps playing when you switch apps
🔁  Auto-retry              Recovers from playback errors silently
❄   Frost UI               Ice-glass panels, animated butterflies, frozen aesthetic
```

---

## ❄ Project Structure

```
tuneroom/
│
├── app.py                      ← Flask backend + Socket.IO + Redis + all APIs
│
├── templates/
│   ├── index.html              ← Landing page (join card, logo, butterflies)
│   └── room.html               ← Room page (player, queue, chat, lyrics, mobile nav)
│
├── static/
│   ├── css/
│   │   └── style.css           ← Full UI — ice glass, animations, mobile layout
│   ├── js/
│   │   ├── main.js             ← All app logic (player, search, chat, voice, tabs)
│   │   └── butterflies.js      ← Animated frost butterfly canvas
│   └── img/
│       ├── bg.jpg              ← Background wallpaper
│       ├── logo.png            ← TuneRoom avatar logo
│       └── favicon.ico         ← Ice blue favicon
│
├── requirements.txt            ← Python dependencies
├── Procfile                    ← Server start command
└── .env                        ← Your API keys (never committed)
```

---

## ❄ Search System

Search never fails — tries each source in order until results are found:

```
1. YOUTUBE_API_KEY        (10,000/day) ─┐
2. YOUTUBE_API_KEY_2      (10,000/day)  │  up to 30 keys = 300,000/day
3. YOUTUBE_API_KEY_3 ...  (10,000/day) ─┘
         ↓ all quota hit
4. Invidious API          (free, no key — 4 servers)
         ↓ all down
5. Piped API              (free, no key — 5 servers)
         ↓ all down
6. YouTube Internal API   (no key, always works — same server as youtube.com)
```

Repeated searches are served from **Upstash Redis cache** (6hr TTL) — zero API units used.

---

## ❄ Storage

```
Upstash Redis (permanent — never lost)
  ├── Queue per room       survives restarts, sleeps, redeploys
  ├── Playback state       current song index, playing/paused
  └── Search cache         6hr TTL, saves API quota

RAM (intentionally temporary)
  ├── Chat history         resets on restart — keeps it light
  ├── Active users list    resets when people rejoin naturally
  └── Voice peers          resets naturally with WebRTC
```

---

## ❄ API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Landing page |
| `/room/<id>` | GET | Join or create a room |
| `/api/search?q=` | GET | Smart search (30 keys + 3 fallbacks + cache) |
| `/api/playlist?url=` | GET | Load all songs from a playlist URL |
| `/api/lyrics?title=&artist=` | GET | Fetch lyrics (5-source cascade) |
| `/api/oembed?id=` | GET | Get title/channel for a video ID |
| `/api/cache/stats` | GET | View cached searches and quota savings |

---

## ❄ Socket.IO Events

| Event | Direction | What it does |
|---|---|---|
| `join` | Client → Server | Join a room with name + color |
| `room_state` | Server → Client | Full room state on join (from Redis) |
| `add_to_queue` | Client → Server | Add a song — saved to Redis |
| `remove_from_queue` | Client → Server | Remove a song — saved to Redis |
| `reorder_queue` | Client → Server | Drag-reorder — saved to Redis |
| `play_song` | Both | Play song at index — state saved to Redis |
| `player_sync` | Both | Sync play/pause/seek across all users |
| `chat_msg` | Both | Send/receive chat messages |
| `reaction` | Both | Emoji reactions on messages |
| `voice_join` | Client → Server | Join the voice channel |
| `voice_signal` | Both | WebRTC peer signaling |

---

## ❄ Lyrics Sources

Fetched in cascade — tries each source until lyrics are found:

```
1. lrclib.net        — Best for new releases (2022–2024)
2. lyrics.ovh        — Great for popular / classic songs
3. some-random-api   — Genius-backed, wide coverage
4. happi.dev         — Additional fallback
5. chartlyrics.com   — Deep catalogue, older songs
```

---

## ❄ Tech Stack

| Layer | Tech |
|---|---|
| Backend | Python · Flask · Flask-SocketIO |
| Realtime | Socket.IO · WebSockets |
| Voice | WebRTC (peer-to-peer, no server load) |
| Player | YouTube IFrame API |
| Search | YouTube Data API v3 · Invidious · Piped · YouTubei |
| Lyrics | lrclib · lyrics.ovh · Genius · happi · chartlyrics |
| Cache + Queue | Upstash Redis (permanent storage) |
| Frontend | Vanilla JS · CSS3 · HTML5 |
| Fonts | Outfit · Space Mono (Google Fonts) |

---

## ❄ Environment Variables

```env
# YouTube API — add up to 30 keys for rotation
YOUTUBE_API_KEY    = your_primary_key
YOUTUBE_API_KEY_2  = your_second_key
YOUTUBE_API_KEY_3  = your_third_key

# Upstash Redis — queue + cache persistence
UPSTASH_REDIS_REST_URL   = https://your-db.upstash.io
UPSTASH_REDIS_REST_TOKEN = your_token

# App
SECRET_KEY = your_random_secret
PORT       = 5000
```

> `.env` is protected by `.gitignore` — never committed to GitHub.

---

## ❄ Run Locally

```bash
# Install dependencies
pip install -r requirements.txt

# Start the server
python app.py
```

Then open **http://localhost:5000**

---

<div align="center">

```
❄ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ ❄
```

*Built with frost and good music in mind.*

</div>