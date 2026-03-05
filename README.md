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

## Open in VS Code

```bash
# 1. Open folder
code tuneroom/

# 2. Install Python deps (in terminal inside VS Code)
pip install -r requirements.txt

# 3. Run
python app.py
```

Open **http://localhost:5000** in your browser.

**Recommended VS Code extensions:**
- Python (Microsoft)
- Pylance
- Live Server (for static preview)

## Free Hosting Options

### Railway (easiest — 3 commands)
```bash
npm i -g @railway/cli
railway login
railway init && railway up
```

### Render.com (Mumbai = low ping India)
1. Push to GitHub
2. render.com → New Web Service
3. Build: `pip install -r requirements.txt`
4. Start: `python app.py`
5. Region: Singapore

### Replit (browser-only, zero install)
1. replit.com → New Python Repl
2. Upload all files
3. Click Run

## YouTube Search (optional)
Without an API key, search uses the built-in 200+ song database.
For unlimited real YouTube search:

1. https://console.cloud.google.com → Enable "YouTube Data API v3"
2. Create API Key
3. Set env var:
   ```bash
   export YOUTUBE_API_KEY=your_key_here
   ```

## Features
- 🎵 Synchronized YouTube playback across all users
- 💬 Real-time chat with emoji reactions + whispers (/w name msg)  
- 🎙 Group voice chat (WebRTC P2P)
- 🔀 Shared drag-to-reorder queue
- 🔍 Instant offline search (200+ songs) + YouTube API when available
- ❄️ Animated blue butterfly background
- 📱 Responsive (mobile + desktop)
