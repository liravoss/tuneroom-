// TuneRoom — main.js (final version with fast skipping on errors)

(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────────────────
  const CONFIG = {
    DRIFT_CHECK_MS:        2500,
    DRIFT_THRESHOLD_SEC:   2.8,
    JOIN_BUFFER_SEC:       1.5,
    PEER_SYNC_BUFFER_SEC:  1.5,
    JOIN_TIMEOUT_MS:       6000,
    FETCH_TIMEOUT_MS:      12000,
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
    socket = io();

    socket.on('connect', () => {
      socket.emit('join', { room: ME.room, username: ME.name, color: ME.color, uid: MY_UID });
    });

    socket.on('room_state', data => {
      queue = data.queue || [];
      curIdx = data.current_index ?? -1;
      renderQueue();
      (data.chat_history || []).forEach(addChatMsg);
      updateUserCount(data.users?.length ?? 1);

      if (curIdx >= 0 && queue[curIdx]) {
        currentSong = queue[curIdx];
        updateNowPlaying(currentSong);
        joinSync(currentSong.id, data.current_time ?? 0, data.is_playing ?? false);
      }
    });

    socket.on('user_joined',  d => updateUserCount(d.user_count));
    socket.on('user_left',    d => updateUserCount(d.user_count));
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
      if (isJoining || !ytReady) return;
      const state = safePlayerCall('getPlayerState');
      const ct = safePlayerCall('getCurrentTime') || 0;
      const target = parseFloat(d.current_time) || 0;

      if (Math.abs(ct - target) > 9) safePlayerCall('seekTo', target, true);
      if (d.is_playing && state === YT.PlayerState.PAUSED) safePlayerCall('playVideo');
      if (!d.is_playing && state === YT.PlayerState.PLAYING) safePlayerCall('pauseVideo');
    });

    socket.on('request_sync', d => {
      if (!ytReady || isJoining) return;
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

    socket.on('sync_from_peer', d => {
      if (syncFromPeerHandled) return;
      const age = Date.now() - (d.ts || 0);
      if (age > 12000) return;
      syncFromPeerHandled = true;

      const target = (parseFloat(d.current_time) || 0) + CONFIG.PEER_SYNC_BUFFER_SEC;
      waitForPlayerReady(() => {
        const check = setInterval(() => {
          const st = safePlayerCall('getPlayerState');
          if ([YT.PlayerState.PLAYING, YT.PlayerState.PAUSED, YT.PlayerState.BUFFERING].includes(st)) {
            clearInterval(check);
            safePlayerCall('seekTo', target, true);
            lockSyncOffset(safePlayerCall('getCurrentTime') || 0);
            startDriftCheck();
            setTimeout(() => syncFromPeerHandled = false, 7000);
          }
        }, 250);
        setTimeout(() => { clearInterval(check); syncFromPeerHandled = false; }, 8000);
      });
    });

    socket.on('chat_msg', addChatMsg);
    socket.on('toast', d => toast(d.msg || ''));
    socket.on('reaction', d => applyReaction(d.mid, d.emoji));

    socket.on('voice_peer_joined', d => {
      addVoicePeer(d.sid, d.username);
      if (voiceOn && d.sid !== socket.id) createPeerConnection(d.sid, true);
    });
    socket.on('voice_peer_left', d => { removePeer(d.sid); removeVoicePeer(d.sid); });
    socket.on('voice_signal', handleVoiceSignal);
  }

  function waitForPlayerReady(cb) {
    if (ytReady && ytPlayer) return cb();
    setTimeout(() => waitForPlayerReady(cb), 180);
  }

  // ── YouTube Player ───────────────────────────────────────────────────────────
  window.onYouTubeIframeAPIReady = () => {
    ytPlayer = new YT.Player('yt-player', {
      height: '100%',
      width: '100%',
      playerVars: { autoplay: 0, controls: 1, rel: 0, modestbranding: 1, iv_load_policy: 3 },
      events: {
        onReady: () => { ytReady = true; },
        onStateChange: e => {
          const S = YT.PlayerState;
          if (e.data === S.PLAYING) {
            $('btn-pp').textContent = '⏸';
            retryCount = 0; clearRetry();
            if (!isJoining) {
              lockSyncOffset(safePlayerCall('getCurrentTime') || 0);
              startDriftCheck();
              emitPlayerSync();
            }
          } else if (e.data === S.PAUSED) {
            $('btn-pp').textContent = '▶';
            stopDriftCheck();
            clearRetry();
            if (!isJoining) emitPlayerSync();
          } else if (e.data === S.ENDED) {
            stopDriftCheck();
            if (!isJoining) nextSong();
          } else if (e.data === -1 && !isJoining) {
            scheduleRetry();
          }
        },
        onError: e => {
          if (isJoining) return;
          const code = e.data;
          let skipImmediately = false;

          if (code === 101 || code === 150) {
            toast('⚠ Video blocked — skipping');
            skipImmediately = true;
          } else if (code === 100) {
            toast('⚠ Video not found — skipping');
            skipImmediately = true;
          }

          if (skipImmediately) {
            clearRetry();
            setTimeout(nextSong, 1000);
          } else {
            scheduleRetry();
          }
        }
      }
    });
  };

  // ── Fast retry / skip logic ─────────────────────────────────────────────────
  function scheduleRetry() {
    if (retryCount >= 1) {
      retryCount = 0;
      clearRetry();
      toast('⚠️ Unplayable — skipping');
      setTimeout(nextSong, 800);
      return;
    }

    clearRetry();
    const delay = 1500 + retryCount * 1000;
    retryTimer = setTimeout(() => {
      if (isJoining || !queue[curIdx]) return;
      if (safePlayerCall('getPlayerState') === YT.PlayerState.PAUSED) return;
      retryCount++;
      if (retryCount === 1) toast('⟳ Retrying…');
      safePlayerCall('loadVideoById', queue[curIdx].id);
    }, delay);
  }

  function clearRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }

  // ── Drift & Sync helpers ─────────────────────────────────────────────────────
  function lockSyncOffset(sec) {
    syncOffset = { wallStart: Date.now(), songStart: parseFloat(sec) || 0 };
  }

  function getExpectedPosition() {
    return syncOffset ? syncOffset.songStart + (Date.now() - syncOffset.wallStart) / 1000 : 0;
  }

  function startDriftCheck() {
    stopDriftCheck();
    syncCheckTimer = setInterval(() => {
      if (!ytReady || isJoining || !syncOffset) return;
      if (safePlayerCall('getPlayerState') !== YT.PlayerState.PLAYING) return;
      const actual = safePlayerCall('getCurrentTime') || 0;
      const expected = getExpectedPosition();
      if (Math.abs(actual - expected) > CONFIG.DRIFT_THRESHOLD_SEC) {
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
    if (!socket?.connected || !ytReady || isJoining) return;
    socket.emit('player_sync', {
      room: ME.room,
      is_playing: safePlayerCall('getPlayerState') === YT.PlayerState.PLAYING,
      current_time: safePlayerCall('getCurrentTime') || 0
    });
  }

  function joinSync(videoId, serverTime, shouldPlay) {
    isJoining = true;
    stopDriftCheck();
    const startSec = Math.max(0, (parseFloat(serverTime) || 0) + CONFIG.JOIN_BUFFER_SEC);

    waitForPlayerReady(() => {
      safePlayerCall('loadVideoById', { videoId, startSeconds: Math.floor(startSec) });

      let settled = false;
      const poll = setInterval(() => {
        if (settled) return;
        const state = safePlayerCall('getPlayerState');
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

    currentSong = queue[idx];
    updateNowPlaying(currentSong);
    renderQueue();
    applyVideoMode();

    waitForPlayerReady(() => {
      safePlayerCall('loadVideoById', currentSong.id);
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

  function toggleVideoMode() {
    videoMode = !videoMode;
    const wrap = $('yt-wrap');
    if (wrap) {
      wrap.style.opacity = videoMode ? '1' : '0';
      wrap.style.height = videoMode ? '' : '0';
      wrap.style.pointerEvents = videoMode ? '' : 'none';
    }
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
        const qid = btn.dataset.qid;
        socket?.emit('remove_from_queue', { room: ME.room, qid });
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
    $('np-title').textContent = s?.title || '';
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
    $('btn-search')?.onclick = doSearch;
    $('btn-paste')?.onclick = doPaste;
    $('btn-pp')?.onclick = togglePlayPause;
    $('btn-next')?.onclick = nextSong;
    $('btn-prev')?.onclick = prevSong;
    $('btn-shuf')?.onclick = shuffleQueue;
    $('btn-send')?.onclick = sendChat;
    $('btn-vid-toggle')?.onclick = toggleVideoMode;
    $('btn-lyrics')?.onclick = toggleLyrics;
  }

  // ── Boot ─────────────────────────────────────────────────────────────────────
  window.addEventListener('DOMContentLoaded', () => {
    initColorPicker();
    $('btn-join')?.onclick = doJoin;
    $('m-name')?.onkeydown = e => e.key === 'Enter' && doJoin();
  });

})();