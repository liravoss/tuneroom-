# ❄️ TuneRoom

Collaborative music listening room with real-time sync, chat, voice, and ice-glass UI.

## Project Structure

```
tuneroom/
├── app.py                  ← Flask backend (Socket.IO, rooms, API)
├── requirements.txt        ← Python dependencies
├── static/
│   ├── css/
│   │   └── style.css       ← All styles (landing + room)
│   ├── js/
│   │   ├── songs.js        ← 200+ song database
│   │   ├── search.js       ← Search engine (local + YouTube API)
│   │   ├── butterflies.js  ← Animated canvas background
│   │   └── main.js         ← All app logic (socket, player, chat, voice)
│   └── img/
│       └── bg.jpg          ← Background wallpaper
└── templates/
    ├── index.html          ← Landing / join page
    └── room.html           ← Music room page
```

## Features
- 🎵 Synchronized YouTube playback across all users
- 💬 Real-time chat with emoji reactions + whispers (/w name msg)  
- 🎙 Group voice chat (WebRTC P2P)
- 🔀 Shared drag-to-reorder queue
- 🔍 Instant offline search (200+ songs) + YouTube API when available
- ❄️ Animated blue butterfly background
- 📱 Responsive (mobile + desktop)
