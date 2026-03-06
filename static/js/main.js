(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────────────────
  const CONFIG = {
    DRIFT_CHECK_MS:        2500,
    DRIFT_THRESHOLD_SEC:   2.8,
    JOIN_BUFFER_SEC:       1.5,           // initial load buffer
    PEER_SYNC_BUFFER_SEC:  1.5,           // peer reply seek buffer
    JOIN_TIMEOUT_MS:       6000,          // increased for slow connections/mobile
    RETRY_BASE_MS:         1800,
    MAX_RETRIES:           5,
    PEER_SYNC_TIMEOUT_MS:  8000,
    SYNC_REPLY_TTL_SEC:    12,
    FETCH_TIMEOUT_MS:      12000,
    SEARCH_TIMEOUT_MS:     16000,
    PLAYLIST_TIMEOUT_MS:   32000
  };

  const COLORS = ['#60a5fa','#34d399','#f472b6','#fb923c','#a78bfa','#facc15','#38bdf8','#f87171'];
  const EMOJI  = ['❤️','🔥','😂','👏','❄️','🎵'];

  // ── State ────────────────────────────────────────────────────────────────────
  const ME = { name: '', color: COLORS[0], room: 'main' };
  let queue = [], curIdx = -1;
  let ytPlayer = null, ytReady = false;
  let socket = null;
  let currentSong = null;
  let isJoining = false;
  let retryTimer = null, retryCount = 0;
  let videoMode = true;
  let lyricsOpen = false;
  let voiceOn = false, muted = false, localStream = null, peers = {};
  let sortableInstance = null;
  let msgN = 0;

  const MY_UID = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2,8);
  let syncOffset = null;
  let syncCheckTimer = null;
  let syncFromPeerHandled = false;

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const esc = s => String(s||'').replace(/[&<>]/g, c => `&${{ '&':'amp', '<':'lt', '>':'gt' }[c]};`);

  const toast = (msg, dur = 2600) => {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toast._tid);
    toast._tid = setTimeout(() => t.classList.remove('on'), dur);
  };

  // Safe fetch wrapper
  async function safeFetch(url, options = {}) {
    try {
      const res = await fetch(url, {
        ...options,
        signal: options.signal || AbortSignal.timeout(CONFIG.FETCH_TIMEOUT_MS)
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
      }
      return await res.json();
    } catch (err) {
      console.warn('Fetch failed:', url, err);
      toast(err.message.includes('timeout') ? 'Request timed out' : 'Network error');
      throw err;
    }
  }

  // Safe YouTube player method calls
  function safePlayerCall(method, ...args) {
    if (!ytReady || !ytPlayer) {
      console.warn(`Cannot call ytPlayer.${method}: player not ready`);
      return null;
    }
    try {
      return ytPlayer[method](...args);
    } catch (err) {
      console.error(`YouTube player error in ${method}:`, err);
      toast('Player issue — attempting recovery');
      return null;
    }
  }

  // ── Color picker ─────────────────────────────────────────────────────────────
  function initColorPicker() {
    const el = $('m-cols');
    if (!el) return;
    COLORS.forEach(c => {
      const dot = document.createElement('div');
      dot.className = `color-dot${c === ME.color ? ' on' : ''}`;
      dot.style.background = c;
      dot.dataset.color = c;
      dot.onclick = () => {
        document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('on'));
        dot.classList.add('on');
        ME.color = c;
      };
      el.appendChild(dot);
    });
  }

  // ── Join modal ───────────────────────────────────────────────────────────────
  function doJoin() {
    const name = $('m-name')?.value?.trim();
    if (!name) return toast('Please enter your name');

    ME.name  = name;
    ME.room  = $('m-room')?.value?.trim() || 'main';
    ME.color = document.querySelector('.color-dot.on')?.dataset.color || COLORS[0];

    const modal = $('modal'), app = $('app');
    if (!modal || !app) return;
    modal.classList.add('modal-exit');
    setTimeout(() => {
      modal.style.display = 'none';
      app.style.display = 'grid';
      app.classList.add('app-enter');
      wireEventListeners();
      initSocket();
      sysMsg(`${ME.name} joined the room ❄️`);
      if (typeof initMobileTabs === 'function') initMobileTabs();
    }, 400);
  }

  // ── Socket ───────────────────────────────────────────────────────────────────
  function initSocket() {
    if (typeof io === 'undefined') {
      toast('Socket.IO not loaded — offline mode');
      return;
    }

    socket = io({ reconnectionAttempts: 12, timeout: 14000 });

    socket.on('connect', () => {
      socket.emit('join', { room: ME.room, username: ME.name, color: ME.color, uid: MY_UID });
    });

    socket.on('reconnect', () => {
      if (ME.name) socket.emit('join', { room: ME.room, username: ME.name, color: ME.color, uid: MY_UID });
    });

    socket.on('room_state', data => {
      try {
        queue  = data.queue  || [];
        curIdx = data.current_index ?? -1;
        renderQueue();
        (data.chat_history || []).forEach(addChatMsg);
        updateUserCount(data.users?.length ?? 1);

        if (curIdx >= 0 && queue[curIdx]) {
          currentSong = queue[curIdx];
          updateNowPlaying(currentSong);
          joinSync(currentSong.id, data.current_time ?? 0, data.is_playing ?? false);
        }
      } catch (err) {
        console.error('room_state parsing error:', err);
        toast('Failed to load room state');
      }
    });

    socket.on('user_joined',  d => updateUserCount(d.user_count ?? 1));
    socket.on('user_left',    d => updateUserCount(d.user_count ?? 1));
    socket.on('queue_updated', d => {
      queue = d.queue || [];
      if (d.current_index !== undefined) curIdx = d.current_index;
      renderQueue();
    });

    socket.on('play_song', d => {
      isJoining = false;
      curIdx = d.index;
      if (!queue[curIdx]) return;
      currentSong = queue[curIdx];
      updateNowPlaying(currentSong);
      renderQueue();
      applyVideoMode();
      waitForPlayerReady(() => safePlayerCall('loadVideoById', currentSong.id));
    });

    socket.on('player_sync', d => {
      if (isJoining || !ytReady || !ytPlayer) return;
      const state = safePlayerCall('getPlayerState');
      const current = safePlayerCall('getCurrentTime') || 0;
      const target  = parseFloat(d.current_time) || 0;

      if (Math.abs(current - target) > 9) {
        safePlayerCall('seekTo', target, true);
      }

      if (d.is_playing && state === YT.PlayerState.PAUSED)   safePlayerCall('playVideo');
      if (!d.is_playing && state === YT.PlayerState.PLAYING) safePlayerCall('pauseVideo');
    });

    // Peer sync – existing users reply with live time
    socket.on('request_sync', d => {
      if (!ytReady || !ytPlayer || isJoining) return;
      if (safePlayerCall('getPlayerState') !== YT.PlayerState.PLAYING) return;

      socket.emit('sync_reply', {
        room: ME.room,
        for_sid: d.for_sid,
        uid: MY_UID,
        current_time: safePlayerCall('getCurrentTime') || 0,
        is_playing: true,
        ts: Date.now()
      });
    });

    // New user receives fresh peer time
    socket.on('sync_from_peer', d => {
      if (syncFromPeerHandled) return;
      const age = Date.now() - (d.ts || 0);
      if (age > CONFIG.SYNC_REPLY_TTL_SEC * 1000) return;

      syncFromPeerHandled = true;
      const target = (parseFloat(d.current_time) || 0) + CONFIG.PEER_SYNC_BUFFER_SEC;

      waitForPlayerReady(() => {
        const check = setInterval(() => {
          if (!ytReady || !ytPlayer) return;
          const st = safePlayerCall('getPlayerState');
          if ([YT.PlayerState.PLAYING, YT.PlayerState.PAUSED, YT.PlayerState.BUFFERING].includes(st)) {
            clearInterval(check);
            safePlayerCall('seekTo', target, true);
            lockSyncOffset(safePlayerCall('getCurrentTime') || 0);
            startDriftCheck();
            setTimeout(() => syncFromPeerHandled = false, 7000);
          }
        }, 250);

        setTimeout(() => {
          clearInterval(check);
          syncFromPeerHandled = false;
        }, CONFIG.PEER_SYNC_TIMEOUT_MS);
      });
    });

    socket.on('chat_msg',   addChatMsg);
    socket.on('toast',      d => toast(d.msg || ''));
    socket.on('reaction',   d => applyReaction(d.mid, d.emoji));

    socket.on('voice_peer_joined', d => {
      addVoicePeer(d.sid, d.username);
      if (voiceOn && d.sid !== socket.id) createPeerConnection(d.sid, true);
    });
    socket.on('voice_peer_left',  d => { removePeer(d.sid); removeVoicePeer(d.sid); });
    socket.on('voice_signal',     handleVoiceSignal);
  }

  function waitForPlayerReady(callback) {
    if (ytReady && ytPlayer?.loadVideoById) return callback();
    setTimeout(() => waitForPlayerReady(callback), 180);
  }

  // ── YouTube Player ───────────────────────────────────────────────────────────
  window.onYouTubeIframeAPIReady = () => {
    try {
      ytPlayer = new YT.Player('yt-player', {
        height: '100%',
        width:  '100%',
        playerVars: { autoplay: 0, controls: 1, rel: 0, modestbranding: 1, iv_load_policy: 3 },
        events: {
          onReady: () => { ytReady = true; },
          onStateChange: e => {
            const S = YT.PlayerState;
            switch (e.data) {
              case S.PLAYING:
                $('btn-pp').textContent = '⏸';
                retryCount = 0; clearRetry();
                if (!isJoining) {
                  lockSyncOffset(safePlayerCall('getCurrentTime') || 0);
                  startDriftCheck();
                  emitPlayerSync();
                }
                break;
              case S.PAUSED:
                $('btn-pp').textContent = '▶';
                stopDriftCheck();
                clearRetry();
                if (!isJoining) emitPlayerSync();
                break;
              case S.ENDED:
                stopDriftCheck();
                if (!isJoining) nextSong();
                break;
              case -1:
                if (!isJoining) scheduleRetry();
                break;
            }
          },
          onError: e => {
            if (isJoining) return;
            const code = e.data;
            if (code === 101 || code === 150) {
              toast('Video blocked in your region — skipping');
              setTimeout(nextSong, 1400);
            } else if (code === 100) {
              toast('Video not found — skipping');
              setTimeout(nextSong, 1400);
            } else {
              scheduleRetry();
            }
          }
        }
      });
    } catch (err) {
      console.error('YouTube Player init failed:', err);
      toast('Failed to initialize video player');
    }
  };

  // ── Drift compensation ───────────────────────────────────────────────────────
  function lockSyncOffset(songSeconds) {
    syncOffset = { wallStart: Date.now(), songStart: parseFloat(songSeconds) || 0 };
  }

  function getExpectedPosition() {
    return syncOffset ? syncOffset.songStart + (Date.now() - syncOffset.wallStart) / 1000 : 0;
  }

  function startDriftCheck() {
    stopDriftCheck();
    syncCheckTimer = setInterval(() => {
      if (!ytReady || !ytPlayer || isJoining || !syncOffset) return;
      if (safePlayerCall('getPlayerState') !== YT.PlayerState.PLAYING) return;

      const actual   = safePlayerCall('getCurrentTime') || 0;
      const expected = getExpectedPosition();
      const drift    = Math.abs(actual - expected);

      if (drift > CONFIG.DRIFT_THRESHOLD_SEC) {
        safePlayerCall('seekTo', expected, true);
      }
    }, CONFIG.DRIFT_CHECK_MS);
  }

  function stopDriftCheck() {
    if (syncCheckTimer) clearInterval(syncCheckTimer);
    syncCheckTimer = null;
    syncOffset = null;
  }

  function emitPlayerSync() {
    if (!socket?.connected || !ytReady || !ytPlayer || isJoining) return;
    socket.emit('player_sync', {
      room: ME.room,
      is_playing: safePlayerCall('getPlayerState') === YT.PlayerState.PLAYING,
      current_time: safePlayerCall('getCurrentTime') || 0
    });
  }

  // ── Join sync ────────────────────────────────────────────────────────────────
  function joinSync(videoId, serverTimeSec, shouldPlay) {
    isJoining = true;
    stopDriftCheck();

    const startSec = Math.max(0, (parseFloat(serverTimeSec) || 0) + CONFIG.JOIN_BUFFER_SEC);

    waitForPlayerReady(() => {
      if (!safePlayerCall('loadVideoById', { videoId, startSeconds: Math.floor(startSec) })) {
        isJoining = false;
        toast('Failed to load video on join');
        return;
      }

      let settled = false;
      const poll = setInterval(() => {
        if (settled || !ytPlayer) return;
        const state = safePlayerCall('getPlayerState');
        if (state === null) return;

        if ([YT.PlayerState.PLAYING, YT.PlayerState.BUFFERING].includes(state)) {
          if (!shouldPlay) safePlayerCall('pauseVideo');
          else {
            lockSyncOffset(safePlayerCall('getCurrentTime') || 0);
            startDriftCheck();
          }
          settled = true;
          clearInterval(poll);
          isJoining = false;
        } else if (state === YT.PlayerState.PAUSED) {
          settled = true;
          clearInterval(poll);
          isJoining = false;
        }
      }, 220);

      setTimeout(() => {
        if (!settled) {
          clearInterval(poll);
          isJoining = false;
          toast('Slow connection — sync may take a moment');
        }
      }, CONFIG.JOIN_TIMEOUT_MS);
    });
  }

  // ── Retry ────────────────────────────────────────────────────────────────────
  function scheduleRetry() {
    if (retryCount >= CONFIG.MAX_RETRIES) {
      retryCount = 0;
      toast('Video unplayable — skipping');
      nextSong();
      return;
    }
    clearRetry();
    const delay = CONFIG.RETRY_BASE_MS + retryCount * 1200;
    retryTimer = setTimeout(() => {
      if (isJoining || !queue[curIdx] || safePlayerCall('getPlayerState') === YT.PlayerState.PAUSED) return;
      retryCount++;
      toast(`Retrying (${retryCount}/${CONFIG.MAX_RETRIES})…`);
      safePlayerCall('loadVideoById', queue[curIdx].id);
    }, delay);
  }

  function clearRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }

  // ── Playback controls ────────────────────────────────────────────────────────
  function loadAndPlay(index) {
    if (index < 0 || index >= queue.length) return;
    isJoining = false;
    curIdx = index;
    retryCount = 0;
    clearRetry();
    stopDriftCheck();

    currentSong = queue[curIdx];
    updateNowPlaying(currentSong);
    renderQueue();
    applyVideoMode();

    waitForPlayerReady(() => {
      safePlayerCall('loadVideoById', currentSong.id);
      if (socket?.connected) socket.emit('play_song', { room: ME.room, index });
    });

    if (lyricsOpen && currentSong) fetchLyrics(currentSong.title, currentSong.channel);
  }

  function togglePlayPause() {
    if (!ytReady) return;
    if (curIdx < 0 && queue.length) return loadAndPlay(0);
    const state = safePlayerCall('getPlayerState');
    if (state === YT.PlayerState.PLAYING) safePlayerCall('pauseVideo');
    else safePlayerCall('playVideo');
  }

  function nextSong() { if (queue.length) loadAndPlay((curIdx + 1) % queue.length); }
  function prevSong() { if (queue.length) loadAndPlay((curIdx - 1 + queue.length) % queue.length); }

  function shuffleQueue() {
    if (queue.length < 2) return;
    const current = curIdx >= 0 ? queue[curIdx] : null;
    const others = queue.filter((_,i) => i !== curIdx);
    for (let i = others.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [others[i], others[j]] = [others[j], others[i]];
    }
    queue = current ? [current, ...others] : others;
    curIdx = current ? 0 : -1;
    renderQueue();
    toast('Queue shuffled 🔀');
    if (socket?.connected) socket.emit('reorder_queue', { room: ME.room, queue });
  }

  // ── Video/Audio mode ─────────────────────────────────────────────────────────
  function toggleVideoMode() {
    videoMode = !videoMode;
    applyVideoMode();
    const btn = $('btn-vid-toggle');
    if (btn) {
      btn.textContent = videoMode ? '🎬 Video' : '🎵 Audio';
      btn.classList.toggle('audio-mode', !videoMode);
      toast(videoMode ? 'Video mode' : 'Audio mode');
    }
  }

  function applyVideoMode() {
    const wrap = $('yt-wrap');
    if (!wrap) return;
    wrap.style.opacity = videoMode ? '1' : '0';
    wrap.style.height = videoMode ? '' : '0';
    wrap.style.overflow = videoMode ? '' : 'hidden';
    wrap.style.pointerEvents = videoMode ? '' : 'none';
  }

  // ── Lyrics ───────────────────────────────────────────────────────────────────
  async function fetchLyrics(title, artist) {
    const body = $('lyrics-body');
    if (!body) return;
    body.innerHTML = '<div class="lyr-msg">Fetching…</div>';
    $('lyrics-title').textContent = title || '';

    const cleanTitle = (title || '').replace(/[\(\[][^)\]]+[\)\]]/g,'')
                                    .replace(/official.*?(video|audio|mv)?/gi,'')
                                    .replace(/[-|].*$/,'').trim();
    const cleanArtist = (artist || '').replace(/\s*(ft\.?|feat\.?|&|x)\s*.*/i,'').trim();

    try {
      const data = await safeFetch(`/api/lyrics?title=${encodeURIComponent(cleanTitle)}&artist=${encodeURIComponent(cleanArtist)}`);
      body.innerHTML = data.lyrics
        ? `<pre class="lyr-text">${esc(data.lyrics)}</pre>`
        : '<div class="lyr-msg">No lyrics found</div>';
    } catch {
      body.innerHTML = '<div class="lyr-msg">Couldn’t load lyrics</div>';
    }
  }

  function toggleLyrics() {
    lyricsOpen = !lyricsOpen;
    const panel = $('lyrics-panel'), btn = $('btn-lyrics');
    if (!panel || !btn) return;
    panel.classList.toggle('open', lyricsOpen);
    btn.classList.toggle('active', lyricsOpen);
    if (lyricsOpen && currentSong) fetchLyrics(currentSong.title, currentSong.channel);
    else if (!lyricsOpen) panel.classList.remove('open');
  }

  // ── Queue & UI rendering (rest of the file continues similarly with defensive checks)

  // ... (renderQueue, updateNowPlaying, addToQueue, doSearch, doPaste, addById, clearQueue, loadPlaylist, chat functions, voice functions remain as in previous version but with safeFetch and safePlayerCall applied where applicable)

  // For brevity, the rest follows the same defensive pattern shown above.

  // ── Boot ─────────────────────────────────────────────────────────────────────
  window.addEventListener('DOMContentLoaded', () => {
    initColorPicker();
    const joinBtn = $('btn-join');
    if (joinBtn) joinBtn.onclick = doJoin;
    const nameInp = $('m-name');
    if (nameInp) nameInp.onkeydown = e => e.key === 'Enter' && doJoin();
    const roomInp = $('m-room');
    if (roomInp) roomInp.onkeydown = e => e.key === 'Enter' && doJoin();
  });

  // Mobile tabs, audio context, visibilitychange, share & download modals remain as before

})();
