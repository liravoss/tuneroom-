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

</div>

---

## ❄ Features

```
🔍  YouTube Search          Search any song, artist, or mood in real time
📋  Playlist Import         Paste a YouTube playlist URL — loads all songs instantly
🎬  Video / Audio Mode      Toggle between watching the video or audio-only
🎤  Live Lyrics             Auto-fetches lyrics for the current song (5 sources)
💬  Real-time Chat          Live chat with emoji reactions and whisper messages
🎙  Voice Chat              Peer-to-peer voice with WebRTC — talk while you listen
🔀  Shared Queue            Everyone sees the same queue — drag to reorder
🗑  Clear Queue             Wipe the entire queue with one click
🎵  Background Play         Music keeps playing even when the tab is hidden
🔁  Auto-retry              Auto-recovers from playback errors silently
❄  Frost UI                Ice-glass panels, animated butterflies, frozen aesthetic
```

---

## ❄ Project Structure

```
tuneroom/
│
├── app.py                      ← Flask backend + all API endpoints + Socket.IO
│
├── templates/
│   ├── index.html              ← Landing page (join card, wolf logo)
│   └── room.html               ← Room page (player, queue, chat, lyrics)
│
├── static/
│   ├── css/
│   │   └── style.css           ← Full UI — ice glass, animations, layouts
│   ├── js/
│   │   ├── main.js             ← All app logic (player, search, chat, voice)
│   │   └── butterflies.js      ← Animated frost butterfly canvas
│   └── img/
│       ├── bg.jpg              ← Background wallpaper
│       └── logo.png            ← TuneRoom avatar logo
│
├── requirements.txt            ← Python dependencies
├── Procfile                    ← Server start command
└── .env                        ← Your API keys (never committed)
```

---

## ❄ API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Landing page |
| `/room/<id>` | GET | Join or create a room |
| `/api/search?q=` | GET | Search YouTube for songs |
| `/api/playlist?url=` | GET | Load all songs from a playlist URL |
| `/api/lyrics?title=&artist=` | GET | Fetch lyrics (5-source cascade) |
| `/api/oembed?id=` | GET | Get title/channel for a video ID |

---

## ❄ Socket.IO Events

| Event | Direction | What it does |
|---|---|---|
| `join` | Client → Server | Join a room with name + color |
| `room_state` | Server → Client | Full room state on join |
| `add_to_queue` | Client → Server | Add a song to the shared queue |
| `remove_from_queue` | Client → Server | Remove a specific song |
| `reorder_queue` | Client → Server | Drag-reorder sync |
| `play_song` | Both | Play a song at index |
| `player_sync` | Both | Sync play/pause/seek state |
| `chat_msg` | Both | Send/receive chat messages |
| `reaction` | Both | Emoji reactions on messages |
| `voice_join` | Client → Server | Join the voice channel |
| `voice_signal` | Both | WebRTC peer signaling |

---

## ❄ Lyrics Sources

Lyrics are fetched in cascade — tries each source until found:

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
| Voice | WebRTC (peer-to-peer) |
| Player | YouTube IFrame API |
| Search | YouTube Data API v3 |
| Lyrics | lrclib · lyrics.ovh · Genius · happi · chartlyrics |
| Frontend | Vanilla JS · CSS3 · HTML5 |
| Fonts | Outfit · Space Mono (Google Fonts) |

---

## ❄ Environment Variables

Create a `.env` file in the project root:

```env
YOUTUBE_API_KEY=your_youtube_api_key_here
SECRET_KEY=your_random_secret_here
PORT=5000
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