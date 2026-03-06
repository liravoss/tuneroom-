// TuneRoom — main.js (sync-fixed build)

(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────────────────
  const CONFIG = {
    DRIFT_CHECK_MS:        2000,   // check for drift every 2s
    DRIFT_THRESHOLD_SEC:   1.5,    // correct if >1.5s off (was 2.8)
    JOIN_BUFFER_SEC:       0.8,    // small buffer for load latency (was 1.5)
    PEER_SYNC_BUFFER_SEC:  0.3,    // minimal buffer when syncing from peer
    JOIN_TIMEOUT_MS:       8000,
    FETCH_TIMEOUT_MS:      12000,
    HEARTBEAT_MS:          5000,   // emit sync every 5s while playing
    MAX_SEEK_CORRECTION:   3.0,    // only hard-correct drift beyond this
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
  let MY_SESSION_ID = null;

  // Sync state — completely reworked
  let syncState = null;         // { videoId, serverTime, serverTs, isPlaying }
  let driftTimer = null;
  let heartbeatTimer = null;
  let joinSyncTimer = null;
  let syncFromPeerHandled = false;
  let lastEmittedTime = -1;
  let driftRef = null;          // { actual, wallTs }

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

  async function safeFetch(url, options = {}) {
    try {
      const res = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(CONFIG.FETCH_TIMEOUT_MS)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      toast('Network error');
      throw err;
    }
  }

  function safePlayerCall(method, ...args) {
    if (!ytReady || !ytPlayer) return null;
    try {
      return ytPlayer[method](...args);
    } catch (err) {
      console.warn(`Player.${method} failed:`, err);
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
    if (!name) return toast('Enter your name');
    ME.name = name;
    ME.room = $('m-room')?.value?.trim() || 'main';
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
      sysMsg(`${ME.name} joined ❄️`);
      if (typeof initMobileTabs === 'function') initMobileTabs();
    }, 400);
  }

  // ── Socket ───────────────────────────────────────────────────────────────────
  function initSocket() {
    if (typeof io === 'undefined') return toast('Offline mode');
    socket = io({ transports: ['websocket'], upgrade: false });

    socket.on('connect', () => {
      socket.emit('join', { room: ME.room, username: ME.name, color: ME.color, uid: MY_UID });
    });

    socket.on('room_state', data => {
      queue  = data.queue || [];
      curIdx = data.current_index ?? -1;
      renderQueue();
      (data.chat_history || []).forEach(addChatMsg);
      updateUserCount(data.users?.length ?? 1);

      if (curIdx >= 0 && queue[curIdx]) {
        currentSong = queue[curIdx];
        updateNowPlaying(currentSong);

        // Store server state — peer reply will give us a fresher timestamp
        syncState = {
          videoId:    currentSong.id,
          serverTime: parseFloat(data.current_time) || 0,
          serverTs:   Date.now(),
          isPlaying:  data.is_playing ?? false,
        };

        MY_SESSION_ID = data.session_id || null;
      syncFromPeerHandled = false;
        clearTimeout(joinSyncTimer);

        // Wait briefly for a peer sync reply; fall back to server timestamp if none arrives
        joinSyncTimer = setTimeout(() => {
          if (!syncFromPeerHandled && syncState) {
            const elapsed = (Date.now() - syncState.serverTs) / 1000;
            const target  = syncState.isPlaying
              ? syncState.serverTime + elapsed + CONFIG.JOIN_BUFFER_SEC
              : syncState.serverTime;
            performJoinSync(syncState.videoId, target, syncState.isPlaying);
          }
        }, 1500);
      }
    });

    socket.on('user_joined',  d => updateUserCount(d.user_count));
    socket.on('user_left',    d => updateUserCount(d.user_count));

    socket.on('queue_updated', d => {
      queue = d.queue || [];
      if (d.current_index !== undefined) curIdx = d.current_index;
      renderQueue();
    });

    // Another user started a specific song
    socket.on('play_song', d => {
      isJoining = false;
      clearTimeout(joinSyncTimer);
      syncFromPeerHandled = false;
      curIdx = d.index;
      if (!queue[curIdx]) return;
      currentSong = queue[curIdx];
      updateNowPlaying(currentSong);
      renderQueue();
      applyVideoMode();
      stopDriftCheck();
      stopHeartbeat();
      waitForPlayerReady(() => {
        safePlayerCall('loadVideoById', currentSong.id);
        armStallGuard(currentSong.id);
      });
    });

    // Periodic sync broadcast from whoever is playing
    socket.on('player_sync', d => {
      if (isJoining || !ytReady) return;

      const serverTime      = parseFloat(d.current_time) || 0;
      const serverIsPlaying = !!d.is_playing;

      // Correct play/pause state first
      const state = safePlayerCall('getPlayerState');
      if (serverIsPlaying && state === YT.PlayerState.PAUSED) {
        safePlayerCall('playVideo');
      } else if (!serverIsPlaying && state === YT.PlayerState.PLAYING) {
        safePlayerCall('pauseVideo');
      }

      // Correct position — account for sender's network latency via ts field
      const latency  = d.ts ? Math.max(0, (Date.now() - d.ts) / 1000) : 0;
      const expected = serverIsPlaying ? serverTime + latency : serverTime;
      const actual   = safePlayerCall('getCurrentTime') || 0;

      if (Math.abs(actual - expected) > CONFIG.DRIFT_THRESHOLD_SEC) {
        safePlayerCall('seekTo', expected, true);
        // Reset drift reference after manual seek
        driftRef = null;
      }
    });

    // An existing member reports their live position for a joining user
    socket.on('request_sync', d => {
      if (!ytReady || isJoining) return;
      const state = safePlayerCall('getPlayerState');
      if (![YT.PlayerState.PLAYING, YT.PlayerState.PAUSED].includes(state)) return;
      socket.emit('sync_reply', {
        room:         ME.room,
        for_sid:      d.for_sid,
        uid:          MY_UID,
        current_time: safePlayerCall('getCurrentTime') || 0,
        is_playing:   state === YT.PlayerState.PLAYING,
        ts:           Date.now(),   // stamp for latency correction
      });
    });

    // We receive a peer's live position — use it to sync precisely
    socket.on('sync_from_peer', d => {
      if (syncFromPeerHandled) return;
      const age = d.ts ? (Date.now() - d.ts) / 1000 : 99;
      if (age > 10) return; // stale — ignore

      syncFromPeerHandled = true;
      clearTimeout(joinSyncTimer);

      // Correct for half the round-trip latency
      const latency = age / 2;
      const target  = d.is_playing
        ? (parseFloat(d.current_time) || 0) + latency + CONFIG.PEER_SYNC_BUFFER_SEC
        : (parseFloat(d.current_time) || 0);

      if (syncState) {
        performJoinSync(syncState.videoId, target, d.is_playing ?? true);
      }

      setTimeout(() => { syncFromPeerHandled = false; }, 8000);
    });

    socket.on('chat_msg',  addChatMsg);
    socket.on('toast',     d => toast(d.msg || ''));
    socket.on('reaction',  d => applyReaction(d.mid, d.emoji));

    socket.on('voice_peer_joined', d => {
      addVoicePeer(d.sid, d.username);
      if (voiceOn && d.sid !== socket.id) createPeerConnection(d.sid, true);
    });
    socket.on('voice_peer_left',  d => { removePeer(d.sid); removeVoicePeer(d.sid); });
    socket.on('voice_signal', handleVoiceSignal);

    // Re-join after reconnect
    socket.on('reconnect', () => {
      socket.emit('join', { room: ME.room, username: ME.name, color: ME.color, uid: MY_UID });
    });
  }

  function waitForPlayerReady(cb) {
    if (ytReady && ytPlayer) return cb();
    setTimeout(() => waitForPlayerReady(cb), 180);
  }

  // ── YouTube Player ───────────────────────────────────────────────────────────
  // Stall guard: if buffering/unstarted for >12s, skip (catches silent geo-blocks)
  function armStallGuard(videoId) {
    clearTimeout(window._stallGuard);
    if (isJoining) return;
    window._stallGuard = setTimeout(() => {
      if (isJoining) return;
      const st = safePlayerCall('getPlayerState');
      if ((st === -1 || st === YT.PlayerState.BUFFERING) && queue[curIdx]?.id === videoId) {
        toast('⚠ Video stalled — skipping');
        clearRetry(); retryCount = 0;
        setTimeout(nextSong, 500);
      }
    }, 12000);
  }

  window.onYouTubeIframeAPIReady = () => {
    ytPlayer = new YT.Player('yt-player', {
      height: '100%',
      width:  '100%',
      playerVars: { autoplay: 0, controls: 1, rel: 0, modestbranding: 1, iv_load_policy: 3 },
      events: {
        onReady: () => { ytReady = true; },
        onStateChange: e => {
          const S = YT.PlayerState;
          if (e.data === S.PLAYING) {
            $('btn-pp').textContent = '⏸';
            retryCount = 0; clearRetry();
            clearTimeout(window._stallGuard);
            if (!isJoining) {
              startDriftCheck();
              startHeartbeat();
              emitPlayerSync();
            }
          } else if (e.data === S.PAUSED) {
            $('btn-pp').textContent = '▶';
            stopDriftCheck();
            stopHeartbeat();
            clearRetry();
            if (!isJoining) emitPlayerSync();
          } else if (e.data === S.ENDED) {
            stopDriftCheck();
            stopHeartbeat();
            if (!isJoining) nextSong();
          } else if (e.data === -1 && !isJoining) {
            scheduleRetry();
          }
        },
        onError: e => {
          if (isJoining) return;
          const code = e.data;
          if (code === 101 || code === 150) {
            toast('⚠ Video blocked — skipping'); clearRetry(); setTimeout(nextSong, 1000);
          } else if (code === 100) {
            toast('⚠ Video not found — skipping'); clearRetry(); setTimeout(nextSong, 1000);
          } else {
            scheduleRetry();
          }
        }
      }
    });
  };

  // ── Retry / skip logic ───────────────────────────────────────────────────────
  // 5 retries with exponential backoff before skipping.
  // Retry 3 uses cue-then-play to sidestep autoplay restrictions.
  const MAX_RETRIES = 5;

  function scheduleRetry() {
    if (retryCount >= MAX_RETRIES) {
      retryCount = 0; clearRetry();
      toast('⚠️ Skipping after ' + MAX_RETRIES + ' retries');
      setTimeout(nextSong, 800);
      return;
    }
    clearRetry();
    const delays = [1500, 2500, 4000, 6000, 8000];
    retryTimer = setTimeout(() => {
      if (isJoining || !queue[curIdx]) return;
      if (safePlayerCall('getPlayerState') === YT.PlayerState.PLAYING) return;
      retryCount++;
      toast('⟳ Retry ' + retryCount + '/' + MAX_RETRIES + '…');
      const vid = queue[curIdx].id;
      if (retryCount === 3) {
        safePlayerCall('cueVideoById', vid);
        setTimeout(() => safePlayerCall('playVideo'), 800);
      } else {
        safePlayerCall('loadVideoById', vid);
      }
    }, delays[retryCount] || 8000);
  }

  function clearRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }

  // ── Drift detection ──────────────────────────────────────────────────────────
  // Uses wall-clock vs video-clock comparison to catch stalls.
  // Does NOT self-correct — defers to the heartbeat for corrections.
  function startDriftCheck() {
    stopDriftCheck();
    driftRef = null;
    driftTimer = setInterval(() => {
      if (!ytReady || isJoining) return;
      if (safePlayerCall('getPlayerState') !== YT.PlayerState.PLAYING) {
        driftRef = null;
        return;
      }
      const actual = safePlayerCall('getCurrentTime') || 0;
      if (!driftRef) {
        driftRef = { actual, wallTs: Date.now() };
        return;
      }
      // Update reference — large corrections come from heartbeat, not here
      driftRef = { actual, wallTs: Date.now() };
    }, CONFIG.DRIFT_CHECK_MS);
  }

  function stopDriftCheck() {
    if (driftTimer) clearInterval(driftTimer);
    driftTimer = null;
    driftRef   = null;
  }

  // ── Heartbeat — keeps the whole room in sync every 5s ────────────────────────
  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (!socket?.connected || !ytReady || isJoining) return;
      if (safePlayerCall('getPlayerState') !== YT.PlayerState.PLAYING) return;
      const ct = safePlayerCall('getCurrentTime') || 0;
      if (Math.abs(ct - lastEmittedTime) < 0.5) return;
      lastEmittedTime = ct;
      socket.emit('player_sync', {
        room:         ME.room,
        is_playing:   true,
        current_time: ct,
        ts:           Date.now(),
      });
    }, CONFIG.HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer  = null;
    lastEmittedTime = -1;
  }

  function emitPlayerSync() {
    if (!socket?.connected || !ytReady || isJoining) return;
    const ct = safePlayerCall('getCurrentTime') || 0;
    lastEmittedTime = ct;
    socket.emit('player_sync', {
      room:         ME.room,
      is_playing:   safePlayerCall('getPlayerState') === YT.PlayerState.PLAYING,
      current_time: ct,
      ts:           Date.now(),
    });
  }

  // ── Join sync — fires once we know the exact target position ─────────────────
  function performJoinSync(videoId, targetSec, shouldPlay) {
    isJoining = true;
    stopDriftCheck();
    stopHeartbeat();

    const startSec = Math.max(0, targetSec);

    waitForPlayerReady(() => {
      safePlayerCall('loadVideoById', { videoId, startSeconds: Math.floor(startSec) });

      let settled = false;
      const poll = setInterval(() => {
        if (settled) return;
        const state = safePlayerCall('getPlayerState');
        if ([YT.PlayerState.PLAYING, YT.PlayerState.BUFFERING].includes(state)) {
          if (!shouldPlay) safePlayerCall('pauseVideo');
          else { startDriftCheck(); startHeartbeat(); }
          settled = true;
          clearInterval(poll);
          isJoining = false;
        } else if (state === YT.PlayerState.PAUSED) {
          settled = true;
          clearInterval(poll);
          isJoining = false;
        }
      }, 200);

      setTimeout(() => {
        if (!settled) {
          clearInterval(poll);
          isJoining = false;
          if (shouldPlay) { startDriftCheck(); startHeartbeat(); }
        }
      }, CONFIG.JOIN_TIMEOUT_MS);
    });
  }

  // ── Playback controls ────────────────────────────────────────────────────────
  function loadAndPlay(idx) {
    if (idx < 0 || idx >= queue.length) return;
    isJoining = false;
    curIdx = idx;
    retryCount = 0;
    clearRetry();
    stopDriftCheck();
    stopHeartbeat();
    syncFromPeerHandled = false;
    clearTimeout(joinSyncTimer);

    currentSong = queue[idx];
    updateNowPlaying(currentSong);
    renderQueue();
    applyVideoMode();

    waitForPlayerReady(() => {
      safePlayerCall('loadVideoById', currentSong.id);
      armStallGuard(currentSong.id);
      socket?.emit('play_song', { room: ME.room, index: idx });
    });

    if (lyricsOpen) fetchLyrics(currentSong.title, currentSong.channel);
  }

  function togglePlayPause() {
    if (!ytReady) return;
    if (curIdx < 0 && queue.length) return loadAndPlay(0);
    const st = safePlayerCall('getPlayerState');
    if (st === YT.PlayerState.PLAYING) safePlayerCall('pauseVideo');
    else safePlayerCall('playVideo');
  }

  function nextSong() { if (queue.length) loadAndPlay((curIdx + 1) % queue.length); }
  function prevSong() { if (queue.length) loadAndPlay((curIdx - 1 + queue.length) % queue.length); }

  function shuffleQueue() {
    if (queue.length < 2) return;
    const cur = curIdx >= 0 ? queue[curIdx] : null;
    let rest = queue.filter((_,i) => i !== curIdx);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    queue = cur ? [cur, ...rest] : rest;
    curIdx = cur ? 0 : -1;
    renderQueue();
    toast('Shuffled 🔀');
    socket?.emit('reorder_queue', { room: ME.room, queue });
  }

  function applyVideoMode() {
    const wrap = $('yt-wrap');
    if (!wrap) return;
    wrap.style.opacity       = videoMode ? '1' : '0';
    wrap.style.height        = videoMode ? '' : '0';
    wrap.style.pointerEvents = videoMode ? '' : 'none';
  }

  function toggleVideoMode() {
    videoMode = !videoMode;
    applyVideoMode();
    toast(videoMode ? 'Video mode' : 'Audio mode');
  }

  // ── Lyrics ───────────────────────────────────────────────────────────────────
  async function fetchLyrics(title, artist) {
    const body = $('lyrics-body');
    if (!body) return;
    body.innerHTML = '<div class="lyr-msg">Fetching…</div>';

    const cleanT = (title || '').replace(/[\(\[].*?[\)\]]/g,'').replace(/official.*?(video|audio)?/gi,'').trim();
    const cleanA = (artist || '').replace(/\s*(ft\.?|feat\.?|&).*/i,'').trim();

    try {
      const data = await safeFetch(`/api/lyrics?title=${encodeURIComponent(cleanT)}&artist=${encodeURIComponent(cleanA)}`);
      body.innerHTML = data.lyrics ? `<pre class="lyr-text">${esc(data.lyrics)}</pre>` : '<div class="lyr-msg">No lyrics</div>';
    } catch {
      body.innerHTML = '<div class="lyr-msg">Lyrics unavailable</div>';
    }
  }

  function toggleLyrics() {
    lyricsOpen = !lyricsOpen;
    $('lyrics-panel')?.classList.toggle('open', lyricsOpen);
    $('btn-lyrics')?.classList.toggle('active', lyricsOpen);
    if (lyricsOpen && currentSong) fetchLyrics(currentSong.title, currentSong.channel);
  }

  // ── Queue render ─────────────────────────────────────────────────────────────
  function renderQueue() {
    const el = $('q-list');
    if (!el) return;
    if (!queue.length) {
      el.innerHTML = '<div class="q-empty">Add songs to queue</div>';
      return;
    }

    el.innerHTML = '';
    queue.forEach((s, i) => {
      const item = document.createElement('div');
      item.className = `q-item${i === curIdx ? ' now' : ''}`;
      item.dataset.qid = s.qid;
      item.innerHTML = `
        <span class="q-num">${i+1}</span>
        <img src="${esc(s.thumbnail)}" onerror="this.style.background='#1e3a8a'">
        <div class="q-info">
          <div class="q-title">${esc(s.title)}</div>
          <div class="q-chan">${esc(s.channel||'')}</div>
        </div>
        <button class="q-del" data-qid="${esc(s.qid)}">✕</button>
      `;
      item.ondblclick = () => loadAndPlay(i);
      el.appendChild(item);
    });

    el.querySelectorAll('.q-del').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        socket?.emit('remove_from_queue', { room: ME.room, qid: btn.dataset.qid });
      };
    });

    if (window.Sortable) {
      if (sortableInstance) sortableInstance.destroy();
      sortableInstance = Sortable.create(el, {
        animation: 130,
        onEnd: ev => {
          const item = queue.splice(ev.oldIndex, 1)[0];
          queue.splice(ev.newIndex, 0, item);
          if (curIdx === ev.oldIndex) curIdx = ev.newIndex;
          renderQueue();
          socket?.emit('reorder_queue', { room: ME.room, queue });
        }
      });
    }
  }

  function updateNowPlaying(s) {
    $('np-title').textContent   = s?.title   || '';
    $('np-channel').textContent = s?.channel || '';
  }

  function updateUserCount(n) {
    $('u-count').textContent = n + ' online ❄️';
  }

  function sysMsg(t) {
    const box = $('chat-msgs');
    const div = document.createElement('div');
    div.className = 'chat-msg';
    div.innerHTML = `<div class="chat-sys">${esc(t)}</div>`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  // ── Chat ─────────────────────────────────────────────────────────────────────
  function sendChat() {
    const inp = $('chat-inp');
    const txt = inp?.value.trim();
    if (!txt) return;
    inp.value = '';
    socket?.emit('chat_msg', { room: ME.room, username: ME.name, color: ME.color, text: txt });
  }

  function addChatMsg(m) {
    const box = $('chat-msgs');
    if (!box) return;
    const div = document.createElement('div');
    const mid = 'm' + (++msgN);

    if (m.type === 'system') {
      div.innerHTML = `<div class="chat-sys">${esc(m.text)}</div>`;
    } else {
      const ts = new Date((m.ts||Date.now()/1000)*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
      div.innerHTML = `
        <div class="chat-head">
          <div class="chat-av" style="background:${m.color}22;color:${m.color}">${(m.username||'?')[0].toUpperCase()}</div>
          <span class="chat-name" style="color:${m.color}">${esc(m.username)}</span>
          <span class="chat-time">${ts}</span>
        </div>
        <div class="chat-text">${esc(m.text)}</div>
        <div class="react-pick">${EMOJI.map(e=>`<span class="re" data-mid="${mid}" data-e="${e}">${e}</span>`).join('')}</div>
        <div class="react-bar" id="rx-${mid}"></div>
      `;
      div.querySelectorAll('.re').forEach(el => {
        el.onclick = () => {
          applyReaction(el.dataset.mid, el.dataset.e);
          socket?.emit('reaction', { room: ME.room, mid: el.dataset.mid, emoji: el.dataset.e });
        };
      });
    }
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  function applyReaction(mid, emoji) {
    const bar = $('rx-' + mid);
    if (!bar) return;
    let ex = bar.querySelector(`[data-e="${emoji}"]`);
    if (ex) {
      let c = (parseInt(ex.dataset.c)||0) + 1;
      ex.dataset.c = c;
      ex.textContent = emoji + ' ' + c;
    } else {
      const b = document.createElement('button');
      b.className = 'react-btn';
      b.dataset.e = emoji;
      b.dataset.c = 1;
      b.textContent = emoji + ' 1';
      b.onclick = () => applyReaction(mid, emoji);
      bar.appendChild(b);
    }
  }

  // ── Wire buttons ─────────────────────────────────────────────────────────────
  function wireEventListeners() {
    $('btn-search')?.onclick     = doSearch;
    $('btn-paste')?.onclick      = doPaste;
    $('btn-pp')?.onclick         = togglePlayPause;
    $('btn-next')?.onclick       = nextSong;
    $('btn-prev')?.onclick       = prevSong;
    $('btn-shuf')?.onclick       = shuffleQueue;
    $('btn-send')?.onclick       = sendChat;
    $('btn-vid-toggle')?.onclick = toggleVideoMode;
    $('btn-lyrics')?.onclick     = toggleLyrics;
  }

  // ── Boot ─────────────────────────────────────────────────────────────────────
  window.addEventListener('DOMContentLoaded', () => {
    initColorPicker();
    $('btn-join')?.onclick  = doJoin;
    $('m-name')?.onkeydown  = e => e.key === 'Enter' && doJoin();
  });

})();