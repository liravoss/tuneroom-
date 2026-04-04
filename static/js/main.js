// TuneRoom — main.js  (definitive sync rewrite)
// Sync model:
//   play_song   → change song (server authoritative, broadcast all)
//   pause_song  → pause        (emitter only, server stores, broadcast others)
//   resume_song → resume       (emitter only, server stores, broadcast others)
//   player_sync → position heartbeat ONLY, no play/pause, no state change
//   All guards are event-driven (onStateChange promise), never setTimeout

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────────
  const CONFIG = {
    DRIFT_THRESHOLD_SEC : 2.5,   // seek if >2.5s off
    HEARTBEAT_MS        : 5000,  // position heartbeat interval while playing
    JOIN_TIMEOUT_MS     : 8000,  // give up waiting for player to settle
    FETCH_TIMEOUT_MS    : 12000,
  };

  const COLORS = ['#60a5fa','#34d399','#f472b6','#fb923c','#a78bfa','#facc15','#38bdf8','#f87171'];
  const EMOJI  = ['❤️','🔥','😂','👏','❄️','🎵'];

  // ── State ─────────────────────────────────────────────────────────────────────
  const ME = { name:'', color:COLORS[0], room:'main' };
  let queue=[], curIdx=-1, currentSong=null;
  let ytPlayer=null, ytReady=false;
  let socket=null;

  // Single source-of-truth guard:
  // When WE are the cause of a player state change (load, remote-applied pause/resume),
  // we hold a resolver that gets called from onStateChange.
  // While it's set, onStateChange will NOT emit anything back to the server.
  let _stateGuard = null;   // { resolve, timer }

  // Ignore own broadcast flag — prevents double-loading when we emit then receive our own broadcast
  // Tracks timestamps of our own emissions for a short window (~500ms)
  const _ownEmissions = {
    play_song:    null,
    pause_song:   null,
    resume_song:  null
  };
  const OWN_EMIT_IGNORE_MS = 500;   // ignore own broadcast within 500ms window

  // Heartbeat
  let _heartbeatTimer = null;

  // Retry
  let retryTimer=null, retryCount=0;

  // UI state
  let videoMode=true, lyricsOpen=false;
  let voiceOn=false, muted=false, localStream=null, peers={};
  let sortableInstance=null;
  let msgN=0;

  const MY_UID = 'u'+Date.now().toString(36)+Math.random().toString(36).slice(2,8);

  // ── Core guard: event-driven, not timeout-driven ──────────────────────────────
  // Returns a Promise that resolves when the YouTube player reaches `targetState`.
  // While the promise is pending, onStateChange will not emit to server.
  function guardUntilState(targetState, timeoutMs = CONFIG.JOIN_TIMEOUT_MS) {
    // Cancel any existing guard
    if (_stateGuard) {
      clearTimeout(_stateGuard.timer);
      _stateGuard.resolve();
      _stateGuard = null;
    }
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (_stateGuard?.resolve === resolve) _stateGuard = null;
        resolve();
      }, timeoutMs);
      _stateGuard = { resolve, timer };
    });
  }

  function clearGuard() {
    if (_stateGuard) {
      clearTimeout(_stateGuard.timer);
      _stateGuard.resolve();
      _stateGuard = null;
    }
  }

  // ── Own broadcast ignoring ─────────────────────────────────────────────────────
  // Record that we just emitted this event with a timestamp
  function recordOwnEmission(eventType) {
    _ownEmissions[eventType] = Date.now();
  }

  // Check if an incoming broadcast matches our own recent emission (within ignore window)
  function isOwnBroadcast(eventType, incomingTs) {
    const ownTs = _ownEmissions[eventType];
    if (!ownTs) return false;
    const diff = Math.abs(Date.now() - incomingTs);
    return diff < OWN_EMIT_IGNORE_MS;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const esc = s => String(s||'').replace(/[&<>"']/g,
    c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const toast = (msg, dur=2600) => {
    const t=$('toast'); if(!t) return;
    t.textContent=msg; t.classList.add('on');
    clearTimeout(toast._t);
    toast._t=setTimeout(()=>t.classList.remove('on'),dur);
  };

  function pc(method,...args) {
    if(!ytReady||!ytPlayer) return null;
    try { return ytPlayer[method](...args); }
    catch(e){ console.warn('YT.'+method,e); return null; }
  }

  function on(id,fn){ const e=$(id); if(e) e.onclick=fn; }

  function waitReady(cb){
    if(ytReady&&ytPlayer) return cb();
    setTimeout(()=>waitReady(cb),150);
  }

  // ── Heartbeat — position only, no state ───────────────────────────────────────
  function startHeartbeat(){
    stopHeartbeat();
    _heartbeatTimer = setInterval(()=>{
      if(!socket?.connected||!ytReady||_stateGuard) return;
      if(pc('getPlayerState')!==YT.PlayerState.PLAYING) return;
      socket.emit('player_sync',{
        room: ME.room,
        current_time: pc('getCurrentTime')||0,
        ts: Date.now()
      });
    }, CONFIG.HEARTBEAT_MS);
  }

  function stopHeartbeat(){
    clearInterval(_heartbeatTimer);
    _heartbeatTimer=null;
  }

  // ── Color picker ──────────────────────────────────────────────────────────────
  function initColorPicker(){
    const el=$('m-cols'); if(!el) return;
    COLORS.forEach(c=>{
      const d=document.createElement('div');
      d.className='color-dot'+(c===ME.color?' on':'');
      d.style.background=c; d.dataset.color=c;
      d.onclick=()=>{
        document.querySelectorAll('.color-dot').forEach(x=>x.classList.remove('on'));
        d.classList.add('on'); ME.color=c;
      };
      el.appendChild(d);
    });
  }

  // ── Join modal ────────────────────────────────────────────────────────────────
  function doJoin(){
    const name=$('m-name')?.value?.trim();
    if(!name) return toast('Enter your name');
    ME.name=name;
    ME.room=$('m-room')?.value?.trim()||'main';
    ME.color=document.querySelector('.color-dot.on')?.dataset.color||COLORS[0];
    const modal=$('modal'),app=$('app');
    if(!modal||!app) return;
    modal.classList.add('modal-exit');
    setTimeout(()=>{
      modal.style.display='none';
      app.style.display='grid';
      app.classList.add('app-enter');
      wireEventListeners();
      initSocket();
      initMobileTabs();
      sysMsg(ME.name+' joined ❄️');
    },400);
  }

  // ── Socket ────────────────────────────────────────────────────────────────────
  function initSocket(){
    if(typeof io==='undefined') return toast('Offline mode');
    socket=io({
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    });

    socket.on('connect',()=>{
      socket.emit('join',{room:ME.room,username:ME.name,color:ME.color,uid:MY_UID});
    });

    socket.on('room_state',data=>{
      queue  = data.queue||[];
      curIdx = data.current_index??-1;
      renderQueue();
      (data.chat_history||[]).forEach(addChatMsg);
      updateUserCount(data.users?.length??1);
      if(curIdx>=0 && queue[curIdx]){
        currentSong=queue[curIdx];
        updateNowPlaying(currentSong);
        applyJoinSync(currentSong.id, data.current_time??0, data.is_playing??false);
      }
    });

    socket.on('user_joined', d=>updateUserCount(d.user_count));
    socket.on('user_left',   d=>updateUserCount(d.user_count));

    socket.on('queue_updated',d=>{
      queue=d.queue||[];
      if(d.current_index!==undefined) curIdx=d.current_index;
      renderQueue();
    });

    // ── Another user changed song ─────────────────────────────────────────────
    socket.on('play_song',d=>{
      // Ignore if this is our own broadcast (sent less than 500ms ago)
      if(isOwnBroadcast('play_song', d.ts)) return;
      curIdx=d.index;
      if(!queue[curIdx]) return;
      currentSong=queue[curIdx];
      updateNowPlaying(currentSong);
      renderQueue();
      applyVideoMode();
      stopHeartbeat();
      // Guard until PLAYING fires — any state change during this is internal
      const p=guardUntilState(YT.PlayerState.PLAYING, 8000);
      waitReady(()=>{ pc('unMute'); pc('setVolume',100); pc('loadVideoById',currentSong.id); });
      p.then(()=>{}); // guard auto-clears when PLAYING fires via onStateChange
    });

    // ── Position-only heartbeat — NEVER play/pause ────────────────────────────
    socket.on('player_sync',d=>{
      if(_stateGuard||!ytReady) return;
      const state=pc('getPlayerState');
      if(state!==YT.PlayerState.PLAYING&&state!==YT.PlayerState.PAUSED) return;
      const lat=d.ts?Math.max(0,(Date.now()-d.ts)/1000):0;
      const target=(parseFloat(d.current_time)||0)+lat;
      const actual=pc('getCurrentTime')||0;
      if(Math.abs(actual-target)>CONFIG.DRIFT_THRESHOLD_SEC){
        pc('seekTo',target,true);
      }
    });

    // ── Remote pause — apply locally, never re-emit ───────────────────────────
    socket.on('pause_song',d=>{
      // Ignore if this is our own broadcast (sent less than 500ms ago)
      if(isOwnBroadcast('pause_song', d.ts)) return;
      if(!ytReady) return;
      stopHeartbeat();
      const p=guardUntilState(YT.PlayerState.PAUSED, 3000);
      const t=parseFloat(d.current_time)||0;
      pc('seekTo',t,true);
      pc('pauseVideo');
      $('btn-pp').textContent='▶';
      p.then(()=>{}); // clears when PAUSED fires
    });

    // ── Remote resume — apply locally, never re-emit ──────────────────────────
    socket.on('resume_song',d=>{
      // Ignore if this is our own broadcast (sent less than 500ms ago)
      if(isOwnBroadcast('resume_song', d.ts)) return;
      if(!ytReady) return;
      const lat=d.ts?Math.max(0,(Date.now()-d.ts)/1000):0;
      const t=(parseFloat(d.current_time)||0)+lat;
      const p=guardUntilState(YT.PlayerState.PLAYING, 5000);
      pc('seekTo',t,true);
      pc('playVideo');
      p.then(()=>{}); // clears when PLAYING fires
    });

    // ── Peer position reply for joiners ───────────────────────────────────────
    socket.on('request_sync',d=>{
      if(!ytReady||_stateGuard) return;
      const state=pc('getPlayerState');
      if(state!==YT.PlayerState.PLAYING&&state!==YT.PlayerState.PAUSED) return;
      socket.emit('sync_reply',{
        room:ME.room, for_sid:d.for_sid, uid:MY_UID,
        current_time:pc('getCurrentTime')||0,
        is_playing:state===YT.PlayerState.PLAYING,
        ts:Date.now()
      });
    });

    socket.on('sync_from_peer',d=>{
      // Only used on join — finer position than stale Redis value
      const age=d.ts?(Date.now()-d.ts)/1000:99;
      if(age>10||!_stateGuard) return; // only apply if we're in a join guard
      const lat=age/2;
      const t=(parseFloat(d.current_time)||0)+lat+0.3;
      pc('seekTo',t,true);
    });

    socket.on('chat_msg',  addChatMsg);
    socket.on('toast',     d=>toast(d.msg||''));
    socket.on('reaction',  d=>applyReaction(d.mid,d.emoji));

    socket.on('voice_peer_joined',d=>{
      addVoicePeer(d.sid,d.username);
      if(voiceOn&&d.sid!==socket.id) createPeerConnection(d.sid,true);
    });
    socket.on('voice_peer_left',d=>{ hangupPeer(d.sid); removeVoicePeer(d.sid); });
    socket.on('voice_signal',handleVoiceSignal);

    socket.on('reconnect',()=>{
      socket.emit('join',{room:ME.room,username:ME.name,color:ME.color,uid:MY_UID});
      toast('Reconnected ❄️');
    });
    socket.on('disconnect',()=>{ toast('Connection lost — reconnecting…'); });
    socket.on('connect_error',()=>{ /* silent — disconnect toast covers it */ });
  }

  // ── YouTube Player ────────────────────────────────────────────────────────────
  window.onYouTubeIframeAPIReady=()=>{
    ytPlayer=new YT.Player('yt-player',{
      height:'100%', width:'100%',
      playerVars:{autoplay:0,controls:1,rel:0,modestbranding:1,iv_load_policy:3},
      events:{
        onReady:()=>{ ytReady=true; pc('unMute'); pc('setVolume',100); },
        onStateChange:e=>{
          const S=YT.PlayerState;

          // If a guard is waiting for this exact state, resolve it and block emission
          if(_stateGuard){
            clearTimeout(_stateGuard.timer);
            const res=_stateGuard.resolve;
            _stateGuard=null;
            res();
            // Still update button UI but DO NOT emit anything
            if(e.data===S.PLAYING) $('btn-pp').textContent='⏸';
            if(e.data===S.PAUSED)  $('btn-pp').textContent='▶';
            if(e.data===S.PLAYING) startHeartbeat();
            if(e.data===S.PAUSED)  stopHeartbeat();
            if(e.data===S.ENDED)   { stopHeartbeat(); nextSong(); }
            return; // ← critical: no server emission
          }

          // No guard — this is a genuine user-initiated state change
          if(e.data===S.PLAYING){
            $('btn-pp').textContent='⏸';
            retryCount=0; clearRetry();
            startHeartbeat();
            // Emit current position as heartbeat (not a play command)
            if(socket?.connected) socket.emit('player_sync',{
              room:ME.room, current_time:pc('getCurrentTime')||0, ts:Date.now()
            });
          } else if(e.data===S.PAUSED){
            $('btn-pp').textContent='▶';
            stopHeartbeat(); clearRetry();
          } else if(e.data===S.ENDED){
            stopHeartbeat(); nextSong();
          } else if(e.data===-1){
            scheduleRetry();
          }
        },
        onError:e=>{
          clearGuard();
          if(e.data===101||e.data===150){ toast('⚠ Blocked — skipping'); clearRetry(); setTimeout(nextSong,800); }
          else if(e.data===100){ toast('⚠ Not found — skipping'); clearRetry(); setTimeout(nextSong,800); }
          else scheduleRetry();
        }
      }
    });
  };

  // ── Retry ─────────────────────────────────────────────────────────────────────
  function scheduleRetry(){
    if(retryCount>=2){ retryCount=0; clearRetry(); toast('⚠ Skipping…'); setTimeout(nextSong,800); return; }
    clearRetry();
    retryTimer=setTimeout(()=>{
      if(!queue[curIdx]) return;
      if(pc('getPlayerState')===YT.PlayerState.PLAYING) return;
      retryCount++;
      toast('⟳ Retry '+retryCount+'…');
      pc('loadVideoById',queue[curIdx].id);
    }, 2000+retryCount*2000);
  }
  function clearRetry(){ clearTimeout(retryTimer); retryTimer=null; }

  // ── Join sync — loads video at correct position ───────────────────────────────
  function applyJoinSync(videoId, serverTime, shouldPlay){
    const startSec=Math.max(0,(parseFloat(serverTime)||0)+1.2);
    // Guard blocks all emissions until player settles
    guardUntilState(shouldPlay?YT.PlayerState.PLAYING:YT.PlayerState.PAUSED, CONFIG.JOIN_TIMEOUT_MS);
    waitReady(()=>{
      pc('unMute'); pc('setVolume',100);
      pc('loadVideoById',{videoId, startSeconds:Math.floor(startSec)});
      if(!shouldPlay){
        // Poll until buffered, then pause
        const poll=setInterval(()=>{
          const st=pc('getPlayerState');
          if(st===YT.PlayerState.PLAYING||st===YT.PlayerState.BUFFERING){
            clearInterval(poll);
            pc('pauseVideo');
          }
        },200);
        setTimeout(()=>clearInterval(poll),8000);
      }
    });
  }

  // ── Playback controls ─────────────────────────────────────────────────────────
  function loadAndPlay(idx){
    if(idx<0||idx>=queue.length) return;
    curIdx=idx; retryCount=0; clearRetry(); stopHeartbeat();
    currentSong=queue[idx];
    updateNowPlaying(currentSong);
    renderQueue();
    applyVideoMode();
    // Guard until PLAYING — blocks re-emit during load
    guardUntilState(YT.PlayerState.PLAYING, 8000);
    recordOwnEmission('play_song');
    waitReady(()=>{
      pc('unMute'); pc('setVolume', 100);
      pc('loadVideoById',currentSong.id);
      socket?.emit('play_song',{room:ME.room,index:idx,ts:Date.now()});
    });
    if(lyricsOpen) fetchLyrics(currentSong.title,currentSong.channel);
  }

  function togglePlayPause(){
    if(!ytReady) return;
    if(curIdx<0&&queue.length) return loadAndPlay(0);
    const st=pc('getPlayerState');
    if(st===YT.PlayerState.PLAYING){
      // Guard for PAUSED — blocks re-emit when our own pause lands
      guardUntilState(YT.PlayerState.PAUSED, 3000);
      recordOwnEmission('pause_song');
      pc('pauseVideo');
      socket?.emit('pause_song',{
        room:ME.room,
        current_time:pc('getCurrentTime')||0,
        ts:Date.now()
      });
    } else {
      // Guard for PLAYING — blocks re-emit when our own resume lands
      guardUntilState(YT.PlayerState.PLAYING, 5000);
      recordOwnEmission('resume_song');
      pc('playVideo');
      socket?.emit('resume_song',{
        room:ME.room,
        current_time:pc('getCurrentTime')||0,
        ts:Date.now()
      });
    }
  }

  function nextSong(){ if(queue.length) loadAndPlay((curIdx+1)%queue.length); }
  function prevSong(){ if(queue.length) loadAndPlay((curIdx-1+queue.length)%queue.length); }

  function shuffleQueue(){
    if(queue.length<2) return;
    const cur=curIdx>=0?queue[curIdx]:null;
    let rest=queue.filter((_,i)=>i!==curIdx);
    for(let i=rest.length-1;i>0;i--){
      const j=Math.floor(Math.random()*(i+1));
      [rest[i],rest[j]]=[rest[j],rest[i]];
    }
    queue=cur?[cur,...rest]:rest;
    curIdx=cur?0:-1;
    renderQueue();
    toast('Shuffled 🔀');
    socket?.emit('reorder_queue',{room:ME.room,queue});
  }

  function applyVideoMode(){
    const w=$('yt-wrap'); if(!w) return;
    w.style.opacity      =videoMode?'1':'0';
    w.style.height       =videoMode?'':'0';
    w.style.pointerEvents=videoMode?'':'none';
  }
  function toggleVideoMode(){ videoMode=!videoMode; applyVideoMode(); toast(videoMode?'Video mode':'Audio mode'); }

  // ── Lyrics ────────────────────────────────────────────────────────────────────
  // ── Spotify-style animated lyrics ────────────────────────────────────────────
  let _lyrScrollTimer = null;

  function _renderLyrics(text){
    const body=$('lyrics-body'); if(!body) return;
    // Normalise — collapse 3+ blank lines to 1, trim edges
    const raw = text.replace(/\r\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
    const lines = raw.split('\n');
    body.innerHTML = '';
    body.scrollTop = 0;

    lines.forEach((line, i) => {
      const div = document.createElement('div');
      const isEmpty = !line.trim();
      div.className = 'lyr-line' + (isEmpty ? ' lyr-spacer' : '');
      div.textContent = isEmpty ? '' : line.trim();
      // Stagger: first 20 lines animate fast, rest appear quickly after
      const delay = i < 20 ? i * 30 : 600 + (i - 20) * 5;
      div.style.animationDelay = delay + 'ms';
      body.appendChild(div);
    });

    _trackActiveLyricsLine(body);
  }

  function _trackActiveLyricsLine(body){
    const lines = Array.from(body.querySelectorAll('.lyr-line:not(.lyr-spacer)'));
    if(!lines.length) return;

    // Highlight first line right away
    lines[0].classList.add('lyr-active');

    function updateActive(){
      const mid = body.scrollTop + body.clientHeight * 0.35;
      let closest = lines[0], closestDist = Infinity;
      for(const l of lines){
        const dist = Math.abs(l.offsetTop - mid);
        if(dist < closestDist){ closestDist = dist; closest = l; }
      }
      lines.forEach(l => l.classList.remove('lyr-active'));
      closest.classList.add('lyr-active');
    }

    body.onscroll = updateActive;
  }

  async function fetchLyrics(title,artist){
    const body=$('lyrics-body'); if(!body) return;
    body.innerHTML='<div class="lyr-msg"><span class="lyr-loading-dots">Fetching lyrics</span></div>';
    const t=(title||'').replace(/[\(\[].*?[\)\]]/g,'').replace(/official.*?(video|audio)?/gi,'').trim();
    const a=(artist||'').replace(/\s*(ft\.?|feat\.?|&).*/i,'').trim();
    try{
      const d=await fetch('/api/lyrics?title='+encodeURIComponent(t)+'&artist='+encodeURIComponent(a),
        {signal:AbortSignal.timeout(CONFIG.FETCH_TIMEOUT_MS)}).then(r=>r.json());
      if(d.lyrics) _renderLyrics(d.lyrics);
      else body.innerHTML='<div class="lyr-msg">No lyrics found for this song</div>';
    }catch{ body.innerHTML='<div class="lyr-msg">Lyrics unavailable</div>'; }
  }
  function closeLyrics(){
    if(!lyricsOpen) return;
    lyricsOpen=false;
    $('lyrics-panel')?.classList.remove('open');
    $('btn-lyrics')?.classList.remove('active');
    // Pop the history entry we pushed on open (handles Android back)
    if(history.state && history.state.lyrics) history.back();
  }

  function toggleLyrics(){
    if(lyricsOpen){ closeLyrics(); return; }
    lyricsOpen=true;
    $('lyrics-panel')?.classList.add('open');
    $('btn-lyrics')?.classList.add('active');
    if(currentSong) fetchLyrics(currentSong.title,currentSong.channel);
    // Push history state so Android back button can close the panel
    history.pushState({lyrics:true},'');
  }

  // ── Queue ─────────────────────────────────────────────────────────────────────
  function renderQueue(){
    const el=$('q-list'); if(!el) return;
    if(!queue.length){ el.innerHTML='<div class="q-empty">Add songs to queue</div>'; return; }
    el.innerHTML='';
    queue.forEach((s,i)=>{
      const item=document.createElement('div');
      item.className='q-item'+(i===curIdx?' now':'');
      item.dataset.qid=s.qid;
      item.innerHTML=
        '<span class="q-num">'+(i+1)+'</span>'+
        '<img src="'+esc(s.thumbnail)+'" loading="lazy" onerror="this.style.background=\'#1e3a8a\'">'+
        '<div class="q-info"><div class="q-title">'+esc(s.title)+'</div><div class="q-chan">'+esc(s.channel||'')+'</div></div>'+
        '<button class="q-del" data-qid="'+esc(s.qid)+'">✕</button>';
      item.ondblclick=()=>loadAndPlay(i);
      el.appendChild(item);
    });
    el.querySelectorAll('.q-del').forEach(btn=>{
      btn.onclick=e=>{ 
        e.stopPropagation(); 
        const qid=btn.dataset.qid;
        // Optimistic remove — instant UI feedback
        const idx=queue.findIndex(s=>s.qid===qid);
        if(idx>=0){
          queue.splice(idx,1);
          if(curIdx>idx) curIdx--;
          else if(curIdx===idx) curIdx=Math.min(curIdx,queue.length-1);
          renderQueue();
        }
        socket?.emit('remove_from_queue',{room:ME.room,qid}); 
      };
    });
    if(window.Sortable){
      if(sortableInstance) sortableInstance.destroy();
      sortableInstance=Sortable.create(el,{
        animation:130,
        onEnd:ev=>{
          const item=queue.splice(ev.oldIndex,1)[0];
          queue.splice(ev.newIndex,0,item);
          if(curIdx===ev.oldIndex) curIdx=ev.newIndex;
          renderQueue();
          socket?.emit('reorder_queue',{room:ME.room,queue});
        }
      });
    }
  }

  function updateNowPlaying(s){
    const t=$('np-title'),c=$('np-channel');
    if(t) t.textContent=s?.title||'';
    if(c) c.textContent=s?.channel||'';
  }
  function updateUserCount(n){ const e=$('u-count'); if(e) e.textContent=n+' online ❄️'; }
  function sysMsg(t){
    const box=$('chat-msgs'); if(!box) return;
    const div=document.createElement('div');
    div.className='chat-msg';
    div.innerHTML='<div class="chat-sys">'+esc(t)+'</div>';
    box.appendChild(div); box.scrollTop=box.scrollHeight;
  }

  // ── Chat ──────────────────────────────────────────────────────────────────────
  function sendChat(){
    const inp=$('chat-inp');
    const txt=inp?.value?.trim(); if(!txt||!socket?.connected) return;
    inp.value='';
    socket.emit('chat_msg',{room:ME.room,username:ME.name,color:ME.color,text:txt});
  }

  function addChatMsg(m){
    const box=$('chat-msgs'); if(!box) return;
    const div=document.createElement('div');
    div.className='chat-msg';
    const mid='m'+(++msgN);
    if(m.type==='system'){
      div.innerHTML='<div class="chat-sys">'+esc(m.text)+'</div>';
    } else {
      const ts=new Date((m.ts||Date.now()/1000)*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
      div.innerHTML=
        '<div class="chat-head">'+
          '<div class="chat-av" style="background:'+m.color+'22;color:'+m.color+'">'+
            (m.username||'?')[0].toUpperCase()+
          '</div>'+
          '<span class="chat-name" style="color:'+m.color+'">'+esc(m.username)+'</span>'+
          '<span class="chat-time">'+ts+'</span>'+
        '</div>'+
        '<div class="chat-text">'+esc(m.text)+'</div>'+
        '<div class="react-pick">'+EMOJI.map(e=>'<span class="re" data-mid="'+mid+'" data-e="'+e+'">'+e+'</span>').join('')+'</div>'+
        '<div class="react-bar" id="rx-'+mid+'"></div>';
      div.querySelectorAll('.re').forEach(el=>{
        el.onclick=()=>{ applyReaction(mid,el.dataset.e); socket?.emit('reaction',{room:ME.room,mid,emoji:el.dataset.e}); };
      });
    }
    box.appendChild(div); box.scrollTop=box.scrollHeight;
  }

  function applyReaction(mid,emoji){
    const bar=$('rx-'+mid); if(!bar) return;
    let ex=bar.querySelector('[data-e="'+emoji+'"]');
    if(ex){ ex.dataset.c=+ex.dataset.c+1; ex.textContent=emoji+' '+ex.dataset.c; }
    else{
      const b=document.createElement('button');
      b.className='react-btn'; b.dataset.e=emoji; b.dataset.c=1; b.textContent=emoji+' 1';
      b.onclick=()=>applyReaction(mid,emoji);
      bar.appendChild(b);
    }
  }

  // ── Search ────────────────────────────────────────────────────────────────────
  let _searchTimer = null;
  function doSearch(){
    const q=$('search-inp')?.value?.trim(); if(!q) return;
    const btn=$('btn-search'); if(btn){ btn.textContent='…'; btn.disabled=true; }
    clearTimeout(_searchTimer);
    fetch('/api/search?q='+encodeURIComponent(q))
      .then(r=>r.json())
      .then(data=>{
        if(btn){ btn.textContent='Search'; btn.disabled=false; }
        const box=$('search-results'); if(!box) return;
        if(!data.results?.length){ box.innerHTML='<div class="sr-empty">No results</div>'; return; }
        box.innerHTML=data.results.map(v=>
          '<div class="sr-item" data-id="'+esc(v.id)+'" data-title="'+esc(v.title)+'" data-channel="'+esc(v.channel||'')+'">'+
          '<img src="'+esc(v.thumbnail)+'" loading="lazy">'+
          '<div class="sr-info"><div class="sr-title">'+esc(v.title)+'</div><div class="sr-chan">'+esc(v.channel||'')+'</div></div>'+
          '<button class="sr-add" tabindex="-1">＋</button></div>').join('');
        // Whole card is clickable — no need to click just the + button
        box.querySelectorAll('.sr-item').forEach(it=>{
          it.onclick=e=>{ 
            e.stopPropagation();
            if(it.dataset._adding) return;
            it.dataset._adding='1';
            socket?.emit('add_to_queue',{room:ME.room,id:it.dataset.id,title:it.dataset.title,channel:it.dataset.channel,username:ME.name});
            // Visual feedback
            const addBtn=it.querySelector('.sr-add');
            if(addBtn){ addBtn.textContent='✓'; addBtn.style.background='#34d399'; }
            toast('Added ❄️');
            setTimeout(()=>{ delete it.dataset._adding; if(addBtn){ addBtn.textContent='＋'; addBtn.style.background=''; } },1500);
          };
        });
      })
      .catch(()=>{ if(btn){ btn.textContent='Search'; btn.disabled=false; } toast('Search failed'); });
  }

  function doPaste(){
    const inp=$('paste-inp'); const val=inp?.value?.trim(); if(!val) return;
    const m=val.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
    const vid=m?m[1]:(val.length===11?val:null);
    if(!vid) return toast('Invalid YouTube link');
    fetch('/api/oembed?id='+vid).then(r=>r.json()).then(d=>{
      socket?.emit('add_to_queue',{room:ME.room,id:vid,title:d.title||val,channel:d.channel||'',username:ME.name});
      inp.value=''; toast('Added ❄️');
    }).catch(()=>{ socket?.emit('add_to_queue',{room:ME.room,id:vid,title:val,channel:'',username:ME.name}); inp.value=''; toast('Added ❄️'); });
  }

  // ── Chunked playlist sender — 8 songs every 400ms so server never gets slammed ─
  function _sendChunked(songs){
    const CHUNK = 8;
    let i = 0;
    const total = songs.length;
    const btn = $('btn-playlist');

    function sendNext(){
      if(i >= total){
        if(btn){ btn.textContent='📋 Load'; btn.disabled=false; }
        toast('✓ All '+total+' songs loaded ❄️');
        return;
      }
      const chunk = songs.slice(i, i+CHUNK);
      i += CHUNK;
      socket?.emit('add_playlist',{room:ME.room, songs:chunk, username:ME.name});
      if(btn) btn.textContent='Loading '+Math.min(i,total)+'/'+total+'…';
      setTimeout(sendNext, 400);
    }
    sendNext();
  }

  function doPlaylist(){
    const inp=$('playlist-inp'); const url=inp?.value?.trim(); if(!url) return toast('Paste a playlist URL');
    const btn=$('btn-playlist');
    if(btn){ btn.textContent='⏳ Fetching…'; btn.disabled=true; }
    inp.value='';

    // ── Spotify playlist detection ──────────────────────────────────────────────
    const spotifyMatch = url.match(/spotify\.com\/playlist\/([a-zA-Z0-9]+)/);
    if(spotifyMatch){
      fetch('/api/spotify-playlist?url='+encodeURIComponent(url)).then(r=>r.json()).then(d=>{
        if(d.error){ if(btn){btn.textContent='📋 Load';btn.disabled=false;} return toast('Spotify: '+d.error); }
        const songs=(d.songs||[]);
        if(!songs.length){ if(btn){btn.textContent='📋 Load';btn.disabled=false;} return toast('No songs found'); }
        toast('Found '+songs.length+' Spotify songs — loading…');
        _sendChunked(songs);
      }).catch(()=>{ if(btn){btn.textContent='📋 Load';btn.disabled=false;} toast('Spotify playlist failed'); });
      return;
    }

    // ── YouTube playlist ────────────────────────────────────────────────────────
    fetch('/api/playlist?url='+encodeURIComponent(url)).then(r=>r.json()).then(d=>{
      if(d.error){ if(btn){btn.textContent='📋 Load';btn.disabled=false;} return toast('Error: '+d.error); }
      const songs=(d.songs||[]).map(s=>({
        id:s.id, title:s.title, channel:s.channel||'',
        thumbnail:'https://img.youtube.com/vi/'+s.id+'/mqdefault.jpg',
        added_by:ME.name,
        qid:s.id+'_'+Date.now()+'_'+Math.random().toString(36).slice(2,5)
      }));
      if(!songs.length){ if(btn){btn.textContent='📋 Load';btn.disabled=false;} return toast('No songs found'); }
      toast('Found '+songs.length+' songs — loading…');
      _sendChunked(songs);
    }).catch(()=>{ if(btn){btn.textContent='📋 Load';btn.disabled=false;} toast('Playlist failed'); });
  }

  // ── Voice (WebRTC) ────────────────────────────────────────────────────────────
  const ICE={iceServers:[{urls:'stun:stun.l.google.com:19302'}]};

  async function joinVoice(){
    if(voiceOn) return leaveVoice();
    try{
      localStream=await navigator.mediaDevices.getUserMedia({audio:true,video:false});
      voiceOn=true; muted=false;
      const vb=$('btn-voice'),mb=$('btn-mute');
      if(vb) vb.textContent='🔴 Leave Voice';
      if(mb) mb.textContent='🎤 Mute';
      socket?.emit('voice_join',{room:ME.room,username:ME.name});
      toast('Joined voice ❄️');
    }catch(e){ toast('Mic access denied'); }
  }

  function leaveVoice(){
    voiceOn=false;
    if(localStream){ localStream.getTracks().forEach(t=>t.stop()); localStream=null; }
    Object.keys(peers).forEach(hangupPeer); peers={};
    const vb=$('btn-voice'),mb=$('btn-mute');
    if(vb) vb.textContent='🎙 Join Voice';
    if(mb) mb.textContent='🎤 Mute';
    const vp=$('voice-peers'); if(vp) vp.innerHTML='';
    socket?.emit('voice_leave',{room:ME.room});
  }

  function toggleMute(){
    if(!localStream) return;
    muted=!muted;
    localStream.getAudioTracks().forEach(t=>{ t.enabled=!muted; });
    const mb=$('btn-mute'); if(mb) mb.textContent=muted?'🔇 Unmute':'🎤 Mute';
    toast(muted?'Muted':'Unmuted');
  }

  function createPeerConnection(sid,initiator){
    if(!voiceOn||!localStream||peers[sid]) return;
    const p=new RTCPeerConnection(ICE); peers[sid]=p;
    localStream.getTracks().forEach(t=>p.addTrack(t,localStream));
    p.onicecandidate=e=>{ if(e.candidate) socket?.emit('voice_signal',{room:ME.room,target:sid,signal:{type:'candidate',candidate:e.candidate}}); };
    p.ontrack=e=>attachAudio(sid,e.streams[0]);
    if(initiator) p.createOffer().then(o=>{ p.setLocalDescription(o); socket?.emit('voice_signal',{room:ME.room,target:sid,signal:{type:'offer',sdp:o}}); });
  }

  async function handleVoiceSignal(d){
    if(!voiceOn||!localStream) return;
    const {from,signal}=d;
    if(signal.type==='offer'){
      createPeerConnection(from,false);
      const p=peers[from]; if(!p) return;
      await p.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      const ans=await p.createAnswer();
      await p.setLocalDescription(ans);
      socket?.emit('voice_signal',{room:ME.room,target:from,signal:{type:'answer',sdp:ans}});
    } else if(signal.type==='answer'){
      peers[from]?.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    } else if(signal.type==='candidate'){
      peers[from]?.addIceCandidate(new RTCIceCandidate(signal.candidate));
    }
  }

  function hangupPeer(sid){ peers[sid]?.close(); delete peers[sid]; $('audio-'+sid)?.remove(); }
  function attachAudio(sid,stream){
    let el=$('audio-'+sid);
    if(!el){ el=document.createElement('audio'); el.id='audio-'+sid; el.autoplay=true; document.body.appendChild(el); }
    el.srcObject=stream;
  }
  function addVoicePeer(sid,username){
    const box=$('voice-peers'); if(!box) return;
    const el=document.createElement('span');
    el.className='voice-peer'; el.id='vp-'+sid; el.textContent='🎙 '+username;
    box.appendChild(el);
  }
  function removeVoicePeer(sid){ $('vp-'+sid)?.remove(); }

  // ── Share ─────────────────────────────────────────────────────────────────────
  function openShare(){
    const m=$('share-modal'); if(!m) return;
    const roomUrl=location.origin+'/room/'+encodeURIComponent(ME.room);
    const rn=$('share-room-name'); if(rn) rn.textContent=ME.room;
    const rv=$('share-room-id-val'); if(rv) rv.textContent=ME.room;
    const rl=$('share-link-text'); if(rl) rl.textContent=roomUrl;
    m.style.display='flex';
  }

  // ── Mobile tabs ───────────────────────────────────────────────────────────────
function initMobileTabs(){
  const tabs = document.querySelectorAll('.mob-tab');
  if (!tabs.length) return;

  function showPanel(panelId) {
    const panels = document.querySelectorAll('#panel-player, #panel-queue, #panel-chat');
    panels.forEach(el => {
      el.classList.remove('mob-active');
      // also clear inline display so CSS class takes over cleanly
      el.style.display = '';
    });
    const target = document.getElementById(panelId);
    if (target) {
      target.classList.add('mob-active');
      setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
      }, 80);
    }
  }

  tabs.forEach(tab => {
    tab.onclick = () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const which = tab.dataset.tab;
      showPanel('panel-' + which);
    };
  });

  if (window.innerWidth <= 768) {
    const playerTab = document.querySelector('.mob-tab[data-tab="player"]');
    if (playerTab) {
      playerTab.classList.add('active');
      showPanel('panel-player');
    }
  }
}

  // Clean up mobile classes when resizing to desktop
  window.addEventListener('resize', () => {
    if(window.innerWidth > 768){
      ['panel-queue','panel-player','panel-chat'].forEach(id => {
        const el = document.getElementById(id);
        if(el){ el.classList.remove('mob-active'); el.style.display = ''; }
      });
    }
  });

  // ── Wire buttons ──────────────────────────────────────────────────────────────
  function wireEventListeners(){
    on('btn-search',     doSearch);
    on('btn-paste',      doPaste);
    on('btn-pp',         togglePlayPause);
    on('btn-next',       nextSong);
    on('btn-prev',       prevSong);
    on('btn-shuf',       shuffleQueue);
    on('btn-send',       sendChat);
    on('btn-vid-toggle', toggleVideoMode);
    on('btn-lyrics',       toggleLyrics);
    on('btn-lyrics-close', closeLyrics);

    // Escape key closes lyrics (desktop)
    document.addEventListener('keydown', e=>{
      if(e.key==='Escape' && lyricsOpen) closeLyrics();
    });

    // Android/iOS back button closes lyrics via History API
    window.addEventListener('popstate', e=>{
      if(lyricsOpen && !(e.state && e.state.lyrics)){
        lyricsOpen=false;
        $('lyrics-panel')?.classList.remove('open');
        $('btn-lyrics')?.classList.remove('active');
      }
    });
    on('btn-voice',      joinVoice);
    on('btn-mute',       toggleMute);
    on('btn-share',      openShare);
    on('share-close',    ()=>{ const m=$('share-modal'); if(m) m.style.display='none'; });
    on('share-copy-btn', ()=>{
      const link=$('share-link-text')?.textContent||location.href;
      navigator.clipboard?.writeText(link).then(()=>toast('Link copied!'));
    });
    on('btn-clear-queue',()=>{ if(confirm('Clear queue?')) socket?.emit('reorder_queue',{room:ME.room,queue:[]}); });
    on('btn-playlist',   doPlaylist);
    const ci=$('chat-inp');   if(ci) ci.onkeydown=e=>{ if(e.key==='Enter') sendChat(); };
    const si=$('search-inp'); if(si){
      si.onkeydown=e=>{ if(e.key==='Enter') doSearch(); };
      // Live search after 400ms pause
      si.oninput=()=>{
        clearTimeout(_searchTimer);
        const q=si.value.trim();
        if(q.length>=3) _searchTimer=setTimeout(doSearch,400);
        else if(!q) $('search-results').innerHTML='';
      };
    }
    const pi=$('paste-inp');  if(pi) pi.onkeydown=e=>{ if(e.key==='Enter') doPaste(); };
    document.querySelectorAll('.share-app').forEach(btn=>{
      btn.onclick=()=>{
        const roomUrl=location.origin+'/room/'+encodeURIComponent(ME.room);
        const url=encodeURIComponent(roomUrl), txt=encodeURIComponent('Join me on TuneRoom!');
        const app=btn.dataset.app;
        if(app==='native'&&navigator.share) navigator.share({title:'TuneRoom',url:roomUrl});
        else if(app==='whatsapp') window.open('https://wa.me/?text='+txt+'%20'+url,'_blank');
        else if(app==='telegram') window.open('https://t.me/share/url?url='+url+'&text='+txt,'_blank');
        else if(app==='twitter')  window.open('https://twitter.com/intent/tweet?text='+txt+'&url='+url,'_blank');
        else if(app==='facebook') window.open('https://facebook.com/sharer/sharer.php?u='+url,'_blank');
        else if(app==='instagram') navigator.clipboard?.writeText(roomUrl).then(()=>toast('Link copied!'));
        else if(app==='email') window.open('mailto:?subject=Join TuneRoom&body='+txt+'%20'+url);
      };
    });
    // Close search results when clicking outside
    document.addEventListener('click',e=>{
      const box=$('search-results'),bar=document.querySelector('.search-bar');
      if(box&&bar&&!bar.contains(e.target)) box.innerHTML='';
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────────
  window.addEventListener('DOMContentLoaded',()=>{
    initColorPicker();
    const bj=$('btn-join'); if(bj) bj.onclick=doJoin;
    const mn=$('m-name');   if(mn) mn.onkeydown=e=>{ if(e.key==='Enter') doJoin(); };
    const mr=$('m-room');   if(mr) mr.onkeydown=e=>{ if(e.key==='Enter') doJoin(); };
  });

})();