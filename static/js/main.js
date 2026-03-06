// TuneRoom — main.js (clean rewrite)
(function () {
'use strict';

// ── State ────────────────────────────────────────────────────
var ME       = { name:'', color:'#60a5fa', room:'main' };
var queue    = [], curIdx = -1;
var ytPlayer = null, ytReady = false;
var socket   = null;
var currentSong = null;
var isJoining   = false;  // true while syncing after join — blocks emits
var retryTimer  = null, retryCount = 0;
var videoMode   = true;
var lyricsOpen  = false;
var voiceOn     = false, muted = false, localStream = null, peers = {};
var sortableInstance = null;
var msgN        = 0;

var COLORS = ['#60a5fa','#34d399','#f472b6','#fb923c','#a78bfa','#facc15','#38bdf8','#f87171'];
var EMOJI  = ['❤️','🔥','😂','👏','❄️','🎵'];
var selCol = COLORS[0];

// ── Helpers ──────────────────────────────────────────────────
function $(id){ return document.getElementById(id); }
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function toast(msg, dur){
  var t = $('toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(function(){ t.classList.remove('on'); }, dur||2800);
}

// ── Color picker ─────────────────────────────────────────────
function initColorPicker(){
  var el = $('m-cols'); if(!el) return;
  COLORS.forEach(function(c){
    var d = document.createElement('div');
    d.className = 'color-dot'+(c===selCol?' on':'');
    d.style.background = c; d.dataset.color = c;
    d.onclick = function(){
      document.querySelectorAll('.color-dot').forEach(function(x){ x.classList.remove('on'); });
      d.classList.add('on'); selCol = c;
    };
    el.appendChild(d);
  });
}

// ── Join modal ───────────────────────────────────────────────
function doJoin(){
  var n = $('m-name').value.trim();
  if(!n){ toast('Enter your name!'); return; }
  ME.name = n; ME.room = $('m-room').value.trim()||'main'; ME.color = selCol;
  var modal=$('modal'), app=$('app');
  modal.classList.add('modal-exit');
  setTimeout(function(){
    modal.style.display='none'; app.style.display='grid'; app.classList.add('app-enter');
    wireButtons(); initSocket(); sysMsg(ME.name+' joined ❄️');
    if(typeof initMobileTabs==='function') initMobileTabs();
  }, 380);
}

// ── Socket.IO ────────────────────────────────────────────────
function initSocket(){
  if(typeof io==='undefined'){ toast('Offline mode'); return; }
  socket = io();

  socket.on('connect', function(){
    socket.emit('join',{ room:ME.room, username:ME.name, color:ME.color });
  });
  socket.on('reconnect', function(){
    if(ME.name) socket.emit('join',{ room:ME.room, username:ME.name, color:ME.color });
  });

  // Received when we join — sync us silently, never emit to room
  socket.on('room_state', function(d){
    queue  = d.queue||[]; curIdx = (d.current_index!=null)?d.current_index:-1;
    renderQueue(); (d.chat_history||[]).forEach(addChatMsg);
    updateUcount(d.users?d.users.length:1);
    if(curIdx>=0 && queue[curIdx]){
      currentSong = queue[curIdx]; updateNowPlaying(currentSong);
      joinSync(queue[curIdx].id, d.current_time||0, d.is_playing||false);
    }
  });

  socket.on('user_joined', function(d){ updateUcount(d.user_count); });
  socket.on('user_left',   function(d){ updateUcount(d.user_count); });

  socket.on('queue_updated', function(d){
    queue=d.queue||[];
    if(d.current_index!==undefined) curIdx=d.current_index;
    renderQueue();
  });

  // Someone else played a song
  socket.on('play_song', function(d){
    isJoining=false; curIdx=d.index;
    if(!queue[curIdx]) return;
    currentSong=queue[curIdx]; updateNowPlaying(currentSong); renderQueue(); applyVideoMode();
    waitForPlayer(function(){ ytPlayer.loadVideoById(currentSong.id); });
  });

  // Periodic sync — only seek if badly out of sync
  socket.on('player_sync', function(d){
    if(isJoining||!ytReady||!ytPlayer) return;
    var st=ytPlayer.getPlayerState(), ct=ytPlayer.getCurrentTime();
    if(Math.abs(ct-(d.current_time||0))>5) ytPlayer.seekTo(d.current_time,true);
    if(d.is_playing  && st!==YT.PlayerState.PLAYING) ytPlayer.playVideo();
    if(!d.is_playing && st===YT.PlayerState.PLAYING)  ytPlayer.pauseVideo();
  });

  socket.on('chat_msg', addChatMsg);
  socket.on('toast',    function(d){ toast(d.msg||''); });
  socket.on('reaction', function(d){ applyReact(d.mid,d.emoji); });

  socket.on('voice_peer_joined', function(d){
    addVoicePeer(d.sid,d.username);
    if(voiceOn && d.sid!==socket.id) createPeer(d.sid,true);
  });
  socket.on('voice_peer_left', function(d){ removePeer(d.sid); removeVoicePeer(d.sid); });
  socket.on('voice_signal', async function(d){
    if(!voiceOn) return;
    if(!peers[d.from]) createPeer(d.from,false);
    var pc=peers[d.from], sig=d.signal;
    try {
      if(sig.type==='offer'){
        await pc.setRemoteDescription(sig); var ans=await pc.createAnswer();
        await pc.setLocalDescription(ans); socket.emit('voice_signal',{ room:ME.room,target:d.from,signal:ans });
      } else if(sig.type==='answer'){ await pc.setRemoteDescription(sig);
      } else if(sig.candidate){ pc.addIceCandidate(sig).catch(function(){}); }
    } catch(e){}
  });
}

function waitForPlayer(fn){
  if(ytReady&&ytPlayer&&ytPlayer.loadVideoById){ fn(); return; }
  setTimeout(function(){ waitForPlayer(fn); },200);
}

function emitSync(){
  if(!socket||!ytReady||!ytPlayer||isJoining) return;
  socket.emit('player_sync',{
    room:ME.room,
    is_playing:   ytPlayer.getPlayerState()===YT.PlayerState.PLAYING,
    current_time: ytPlayer.getCurrentTime()
  });
}

// ── YouTube Player ───────────────────────────────────────────
window.onYouTubeIframeAPIReady = function(){
  ytPlayer = new YT.Player('yt-player',{
    height:'100%', width:'100%',
    playerVars:{ autoplay:0, controls:1, rel:0, modestbranding:1, iv_load_policy:3 },
    events:{
      onReady: function(){ ytReady=true; },
      onStateChange: function(e){
        var S=YT.PlayerState;
        if(e.data===S.PLAYING){
          $('btn-pp').textContent='⏸'; retryCount=0; clearRetry();
          if(!isJoining) emitSync();
        } else if(e.data===S.PAUSED){
          $('btn-pp').textContent='▶';
          // cancel any pending retry when the user (or a sync) pauses playback
          clearRetry();
          if(!isJoining) emitSync();
        } else if(e.data===S.ENDED){
          if(!isJoining) nextSong();
        } else if(e.data===-1){
          if(!isJoining) scheduleRetry();
        }
      },
      onError: function(e){
        if(isJoining) return;
        if(e.data===101||e.data===150){ toast('⚠ Video blocked — skipping'); setTimeout(nextSong,1200); }
        else if(e.data===100){ toast('⚠ Video not found — skipping'); setTimeout(nextSong,1200); }
        else scheduleRetry();
      }
    }
  });
};

// ── Join sync — load at room position, never emit ────────────
function joinSync(videoId, seekSec, roomIsPlaying){
  isJoining = true;
  seekSec = Math.max(0, parseFloat(seekSec)||0);
  waitForPlayer(function(){
    ytPlayer.loadVideoById({ videoId:videoId, startSeconds:Math.floor(seekSec) });
    var done=false;
    var t=setInterval(function(){
      if(done) return;
      var st=ytPlayer.getPlayerState();
      if(st===YT.PlayerState.PLAYING||st===YT.PlayerState.BUFFERING){
        if(!roomIsPlaying){ ytPlayer.pauseVideo(); }
        done=true; clearInterval(t); isJoining=false;
      } else if(st===YT.PlayerState.PAUSED){
        done=true; clearInterval(t); isJoining=false;
      }
    },200);
    // Safety — 2.5s so mobile autoplay block never gets stuck
    setTimeout(function(){ if(!done){ clearInterval(t); isJoining=false; } },2500);
  });
}

// ── Retry on real playback failure ───────────────────────────
function scheduleRetry(){
  if(retryCount>=3){ retryCount=0; toast('⏭ Skipping unplayable video'); nextSong(); return; }
  clearRetry();
  retryTimer=setTimeout(function(){
    // don't retry if we've since paused (manual or via sync)
    if(isJoining||!queue[curIdx]) return;
    if(ytPlayer && ytPlayer.getPlayerState()===YT.PlayerState.PAUSED) return;
    retryCount++; ytPlayer.loadVideoById(queue[curIdx].id);
  },3000);
}
function clearRetry(){ if(retryTimer){ clearTimeout(retryTimer); retryTimer=null; } }

// ── Local play — user action ─────────────────────────────────
function loadAndPlay(idx){
  if(!queue.length||idx<0||idx>=queue.length) return;
  isJoining=false; curIdx=idx; retryCount=0; clearRetry();
  currentSong=queue[idx]; updateNowPlaying(currentSong); renderQueue(); applyVideoMode();
  waitForPlayer(function(){
    ytPlayer.loadVideoById(currentSong.id);
    if(socket) socket.emit('play_song',{ room:ME.room,index:idx });
  });
  if(lyricsOpen) fetchLyrics(currentSong.title,currentSong.channel);
}

function togglePlay(){
  if(!ytReady) return;
  if(curIdx<0&&queue.length>0){ loadAndPlay(0); return; }
  var st=ytPlayer.getPlayerState();
  if(st===YT.PlayerState.PLAYING) ytPlayer.pauseVideo(); else ytPlayer.playVideo();
}
function nextSong(){ if(!queue.length) return; loadAndPlay((curIdx+1)%queue.length); }
function prevSong(){ if(!queue.length) return; loadAndPlay((curIdx-1+queue.length)%queue.length); }
function shuffleQ(){
  if(queue.length<2) return;
  var current=(curIdx>=0&&queue[curIdx])?queue[curIdx]:null;
  var rest=queue.filter(function(_,i){ return i!==curIdx; });
  for(var i=rest.length-1;i>0;i--){ var j=Math.floor(Math.random()*(i+1)),t=rest[i]; rest[i]=rest[j]; rest[j]=t; }
  queue=current?[current].concat(rest):rest; curIdx=current?0:-1;
  renderQueue(); toast('Queue shuffled 🔀');
  if(socket) socket.emit('reorder_queue',{ room:ME.room,queue:queue });
}

// ── Video/Audio mode ─────────────────────────────────────────
function toggleVideoMode(){
  videoMode=!videoMode; applyVideoMode();
  var btn=$('btn-vid-toggle');
  if(videoMode){ btn.textContent='🎬 Video'; btn.classList.remove('audio-mode'); toast('Video mode 🎬'); }
  else { btn.textContent='🎵 Audio'; btn.classList.add('audio-mode'); toast('Audio only 🎵'); }
}
function applyVideoMode(){
  var wrap=$('yt-wrap'); if(!wrap) return;
  if(videoMode){ wrap.style.opacity='1'; wrap.style.height=''; wrap.style.pointerEvents=''; }
  else { wrap.style.opacity='0'; wrap.style.height='0'; wrap.style.overflow='hidden'; wrap.style.pointerEvents='none'; }
}

// ── Background tab ────────────────────────────────────────────
document.addEventListener('visibilitychange',function(){
  if(!ytReady||!ytPlayer) return;
  if(document.hidden){ if(currentSong) document.title='▶ '+currentSong.title+' — TuneRoom'; }
  else { document.title='TuneRoom ❄️'; }
});

// ── Lyrics ────────────────────────────────────────────────────
function toggleLyrics(){
  lyricsOpen=!lyricsOpen;
  var panel=$('lyrics-panel'), btn=$('btn-lyrics');
  if(lyricsOpen){ panel.classList.add('open'); btn.classList.add('active'); if(currentSong) fetchLyrics(currentSong.title,currentSong.channel); else $('lyrics-body').innerHTML='<div class="lyr-msg">Play a song to see lyrics</div>'; }
  else { panel.classList.remove('open'); btn.classList.remove('active'); }
}
async function fetchLyrics(title,artist){
  var body=$('lyrics-body');
  body.innerHTML='<div class="lyr-msg">Fetching lyrics…</div>'; $('lyrics-title').textContent=title||'';
  var ct=title.replace(/\(.*?\)/g,'').replace(/\[.*?\]/g,'').replace(/ft\.?\s+\S+/gi,'').replace(/feat\.?\s+\S+/gi,'').replace(/[-|].*$/,'').replace(/official\s*(video|audio|mv)?/gi,'').trim();
  var ca=(artist||'').replace(/\s*(ft\.?|feat\.?|&|x)\s*.*/i,'').trim();
  try {
    var r=await fetch('/api/lyrics?title='+encodeURIComponent(ct)+'&artist='+encodeURIComponent(ca));
    var d=await r.json();
    body.innerHTML=d.lyrics?'<pre class="lyr-text">'+esc(d.lyrics)+'</pre>':'<div class="lyr-msg">Lyrics not found</div>';
  } catch(e){ body.innerHTML='<div class="lyr-msg">Could not load lyrics</div>'; }
}

// ── Search ────────────────────────────────────────────────────
async function doSearch(){
  var q=$('search-inp').value.trim(); if(!q) return;
  var id=extractYTId(q); if(id){ closeSearch(); addById(id); return; }
  openSearch('<div class="res-msg"><div class="spinner"></div>Searching…</div>');
  try {
    var r=await fetch('/api/search?q='+encodeURIComponent(q),{ signal:AbortSignal.timeout(18000) });
    var d=await r.json();
    if(!r.ok||(d.error&&!d.results?.length)){ openSearch('<div class="res-msg err">'+esc(d.error||'Search failed')+'</div>'); return; }
    renderSearchResults(d.results);
  } catch(e){ openSearch('<div class="res-msg err">Search timed out — paste a YouTube link</div>'); }
}
function renderSearchResults(songs){
  var box=$('search-results');
  if(!songs||!songs.length){ box.innerHTML='<div class="res-msg">No results</div>'; return; }
  box.innerHTML='<div class="res-header">'+songs.length+' results</div>';
  songs.forEach(function(s){
    var d=document.createElement('div'); d.className='res-item';
    d.innerHTML='<img src="'+esc(s.thumbnail)+'" onerror="this.style.background=\'#1e3a8a\'">'+
      '<div class="res-info"><div class="res-title">'+esc(s.title)+'</div><div class="res-chan">'+esc(s.channel)+'</div></div>'+
      '<button class="btn-add-song">+ Add</button>';
    d.querySelector('.btn-add-song').onclick=(function(song){ return function(){ addToQueue(song); }; })(s);
    box.appendChild(d);
  });
}
function openSearch(html){ var b=$('search-results'); b.innerHTML=html||''; b.classList.add('open'); }
function closeSearch(){ $('search-results').classList.remove('open'); }

// ── Paste ─────────────────────────────────────────────────────
function extractYTId(str){
  if(!str) return null; str=str.trim();
  var m=str.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/);
  if(m) return m[1]; if(/^[A-Za-z0-9_-]{11}$/.test(str)) return str; return null;
}
function doPaste(){
  var val=$('paste-inp').value.trim(); if(!val){ toast('Paste a YouTube URL'); return; }
  var id=extractYTId(val); if(!id){ toast('Not a valid YouTube link'); return; }
  $('paste-inp').value=''; addById(id);
}
function addById(id){
  var qid = 'q'+Date.now()+Math.random().toString(36).slice(2,5);
  var song={ id:id, title:'Loading…', channel:'YouTube', thumbnail:'https://img.youtube.com/vi/'+id+'/mqdefault.jpg', qid:qid };
  addToQueue(song);
  fetch('/api/oembed?id='+id).then(function(r){ return r.json(); }).then(function(d){
    if(!d.title) return;
    // Match by qid to correctly handle duplicate songs
    queue.forEach(function(s){ if(s.qid===qid){ s.title=d.title; s.channel=d.channel||'YouTube'; }});
    renderQueue();
    if(currentSong&&currentSong.qid===qid){ currentSong.title=d.title; currentSong.channel=d.channel||'YouTube'; updateNowPlaying(currentSong); }
  }).catch(function(){});
}

// ── Queue ─────────────────────────────────────────────────────
function addToQueue(song){
  var s=Object.assign({},song,{ qid:'q'+Date.now()+Math.random().toString(36).slice(2,5) });
  if(socket) socket.emit('add_to_queue',Object.assign({},s,{ room:ME.room,username:ME.name }));
  else { queue.push(s); renderQueue(); }
  toast('Added: '+song.title.slice(0,28)); closeSearch();
  if(curIdx<0) setTimeout(function(){ if(queue.length>0) loadAndPlay(0); },400);
}
function renderQueue(){
  var el=$('q-list');
  if(!queue.length){ el.innerHTML='<div class="q-empty"><span>🎵</span>Search above or paste a YouTube link</div>'; return; }
  el.innerHTML='';
  queue.forEach(function(s,i){
    var d=document.createElement('div');
    d.className='q-item'+(i===curIdx?' now':''); d.dataset.qid=s.qid;
    d.innerHTML='<span class="q-num">'+(i+1)+'</span>'+
      '<img class="q-thumb" src="'+esc(s.thumbnail)+'" onerror="this.style.background=\'#1e3a8a\'">'+
      '<div class="q-info"><div class="q-title">'+esc(s.title)+'</div><div class="q-chan">'+esc(s.channel||'')+'</div></div>'+
      '<button class="q-del" data-qid="'+esc(s.qid)+'">✕</button>';
    d.ondblclick=(function(idx){ return function(){ loadAndPlay(idx); }; })(i);
    el.appendChild(d);
  });
  el.querySelectorAll('.q-del').forEach(function(btn){
    btn.onclick=function(e){
      e.stopPropagation(); var qid=btn.dataset.qid;
      if(socket) socket.emit('remove_from_queue',{ room:ME.room,qid:qid });
      else { queue=queue.filter(function(s){ return s.qid!==qid; }); renderQueue(); }
    };
  });
  if(window.Sortable){
    if(sortableInstance){ sortableInstance.destroy(); sortableInstance = null; }
    sortableInstance = Sortable.create(el,{ animation:130,onEnd:function(ev){
      var item=queue.splice(ev.oldIndex,1)[0]; queue.splice(ev.newIndex,0,item);
      if(curIdx===ev.oldIndex) curIdx=ev.newIndex; renderQueue();
      if(socket) socket.emit('reorder_queue',{ room:ME.room,queue:queue });
    }});
  }
}
function updateNowPlaying(s){
  $('np-title').textContent=s.title||''; $('np-channel').textContent=s.channel||'';
  if(lyricsOpen) fetchLyrics(s.title,s.channel);
}

// ── Chat ──────────────────────────────────────────────────────
function sendChat(){
  var inp=$('chat-inp'), txt=inp.value.trim(); if(!txt) return; inp.value='';
  if(socket) socket.emit('chat_msg',{ room:ME.room,username:ME.name,color:ME.color,text:txt });
  else addChatMsg({ type:'msg',username:ME.name,color:ME.color,text:txt,ts:Date.now()/1000 });
}
function sysMsg(t){ addChatMsg({ type:'system',text:t }); }
function addChatMsg(m){
  var box=$('chat-msgs'), div=document.createElement('div'), mid='m'+(++msgN);
  if(m.type==='system'){
    div.className='chat-msg'; div.innerHTML='<div class="chat-sys">'+esc(m.text)+'</div>';
  } else {
    div.className='chat-msg'+(m.type==='whisper'?' whisper':''); div.dataset.mid=mid;
    var init=(m.username||'?')[0].toUpperCase();
    var ts=new Date((m.ts||Date.now()/1000)*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    div.innerHTML='<div class="chat-head">'+
      '<div class="chat-av" style="background:'+m.color+'22;border:1px solid '+m.color+'44;color:'+m.color+'">'+init+'</div>'+
      '<span class="chat-name" style="color:'+m.color+'">'+esc(m.username)+'</span>'+
      '<span class="chat-time">'+ts+'</span></div>'+
      '<div class="chat-text">'+esc(m.text)+'</div>'+
      '<div class="react-pick">'+EMOJI.map(function(e){ return '<span class="re" data-mid="'+mid+'" data-e="'+e+'">'+e+'</span>'; }).join('')+'</div>'+
      '<div class="react-bar" id="rx-'+mid+'"></div>';
  }
  box.appendChild(div);
  div.querySelectorAll('.re').forEach(function(el){
    el.onclick=function(){ applyReact(el.dataset.mid,el.dataset.e); if(socket) socket.emit('reaction',{ room:ME.room,mid:el.dataset.mid,emoji:el.dataset.e }); };
  });
  box.scrollTop=box.scrollHeight;
}
function applyReact(mid,emoji){
  var rx=$('rx-'+mid); if(!rx) return;
  var ex=rx.querySelector('[data-e="'+emoji+'"]');
  if(ex){ var c=parseInt(ex.dataset.c)+1; ex.dataset.c=c; ex.textContent=emoji+' '+c; }
  else { var b=document.createElement('button'); b.className='react-btn'; b.dataset.e=emoji; b.dataset.c=1; b.textContent=emoji+' 1'; b.onclick=function(){ applyReact(mid,emoji); }; rx.appendChild(b); }
}



// ── Queue controls ────────────────────────────────────────────
function clearQueue(){
  if(!queue.length){ toast('Queue is empty'); return; }
  if(!confirm('Remove all '+queue.length+' songs?')) return;
  queue=[]; curIdx=-1; currentSong=null; sortableInstance=null; renderQueue();
  if(ytReady&&ytPlayer) ytPlayer.stopVideo();
  $('np-title').textContent='Nothing playing yet'; $('np-channel').textContent='Add songs to get started'; $('btn-pp').textContent='▶';
  if(socket) socket.emit('reorder_queue',{ room:ME.room,queue:[] });
  toast('Queue cleared 🗑');
}
async function loadPlaylist(){
  var inp=$('playlist-inp'), url=inp.value.trim(); if(!url){ toast('Paste a YouTube playlist URL'); return; }
  var btn=$('btn-playlist'); btn.textContent='⏳ Loading…'; btn.disabled=true;
  try {
    var r=await fetch('/api/playlist?url='+encodeURIComponent(url),{ signal:AbortSignal.timeout(30000) });
    var d=await r.json();
    if(d.error){ toast('❌ '+d.error); return; }
    if(!d.songs||!d.songs.length){ toast('No playable songs found'); return; }
    d.songs.forEach(function(s){
      var song={ id:s.id,title:s.title,channel:s.channel,thumbnail:s.thumbnail,qid:'q'+Date.now()+Math.random().toString(36).slice(2,5) };
      if(socket) socket.emit('add_to_queue',Object.assign({},song,{ room:ME.room,username:ME.name }));
      else queue.push(song);
    });
    if(!socket) renderQueue();
    toast('✓ Loaded '+d.songs.length+' songs'); inp.value='';
    if(curIdx<0) setTimeout(function(){ if(queue.length>0) loadAndPlay(0); },800);
  } catch(e){ toast('Failed to load playlist'); }
  finally { btn.textContent='📋 Load'; btn.disabled=false; }
}

// ── Voice ─────────────────────────────────────────────────────
async function toggleVoice(){
  if(!voiceOn){
    try {
      localStream=await navigator.mediaDevices.getUserMedia({ audio:true,video:false });
      voiceOn=true; $('btn-voice').textContent='📴 Leave Voice'; $('btn-voice').classList.add('on');
      $('btn-mute').style.display='flex'; addVoicePeer('me',ME.name);
      if(socket) socket.emit('voice_join',{ room:ME.room,username:ME.name }); toast('Joined voice 🎙');
    } catch(e){ toast('Mic access denied'); }
  } else {
    if(localStream) localStream.getTracks().forEach(function(t){ t.stop(); });
    localStream=null; voiceOn=false; muted=false;
    Object.keys(peers).forEach(removePeer); peers={};
    $('btn-voice').textContent='🎙 Join Voice'; $('btn-voice').classList.remove('on');
    $('btn-mute').style.display='none'; $('btn-mute').classList.remove('muted'); $('btn-mute').textContent='🎤 Mute';
    $('voice-peers').innerHTML='';
    if(socket) socket.emit('voice_leave',{ room:ME.room }); toast('Left voice');
  }
}
function toggleMute(){
  muted=!muted; if(localStream) localStream.getAudioTracks().forEach(function(t){ t.enabled=!muted; });
  var bm=$('btn-mute'); bm.textContent=muted?'🔇 Unmute':'🎤 Mute'; bm.classList.toggle('muted',muted);
}
function createPeer(sid,initiator){
  var pc=new RTCPeerConnection({ iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}]});
  peers[sid]=pc;
  if(localStream) localStream.getTracks().forEach(function(t){ pc.addTrack(t,localStream); });
  pc.ontrack=function(e){ var a=$('au-'+sid)||document.createElement('audio'); a.id='au-'+sid; a.autoplay=true; a.srcObject=e.streams[0]; document.body.appendChild(a); };
  pc.onicecandidate=function(e){ if(e.candidate&&socket) socket.emit('voice_signal',{ room:ME.room,target:sid,signal:e.candidate }); };
  if(initiator){ pc.createOffer().then(function(o){ pc.setLocalDescription(o); if(socket) socket.emit('voice_signal',{ room:ME.room,target:sid,signal:o }); }); }
  return pc;
}
function removePeer(sid){ if(peers[sid]){ peers[sid].close(); delete peers[sid]; } var a=$('au-'+sid); if(a) a.remove(); }
function addVoicePeer(id,name){ if($('vp-'+id)) return; var s=document.createElement('span'); s.className='voice-dot-item'; s.id='vp-'+id; s.innerHTML='<span class="vdot"></span>'+esc(name||'?'); $('voice-peers').appendChild(s); }
function removeVoicePeer(id){ var el=$('vp-'+id); if(el) el.remove(); }
function updateUcount(n){ $('u-count').textContent=n+' jamming ❄️'; }

// ── Wire buttons ──────────────────────────────────────────────
function wireButtons(){
  $('btn-search').onclick=$('btn-search').onclick||doSearch; $('btn-search').onclick=doSearch;
  $('btn-paste').onclick=doPaste; $('btn-playlist').onclick=loadPlaylist;
  $('btn-clear-queue').onclick=clearQueue; $('btn-pp').onclick=togglePlay;
  $('btn-prev').onclick=prevSong; $('btn-next').onclick=nextSong; $('btn-shuf').onclick=shuffleQ;
  $('btn-send').onclick=sendChat; $('btn-voice').onclick=toggleVoice; $('btn-mute').onclick=toggleMute;
  $('btn-vid-toggle').onclick=toggleVideoMode; $('btn-lyrics').onclick=toggleLyrics; $('btn-lyrics-close').onclick=toggleLyrics;
  $('search-inp').onkeydown=function(e){ if(e.key==='Enter') doSearch(); if(e.key==='Escape') closeSearch(); };
  $('paste-inp').onkeydown=function(e){ if(e.key==='Enter') doPaste(); };
  $('playlist-inp').onkeydown=function(e){ if(e.key==='Enter') loadPlaylist(); };
  $('chat-inp').onkeydown=function(e){ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendChat(); } };
  document.addEventListener('click',function(e){ if(!e.target.closest('#search-results')&&!e.target.closest('.search-bar')) closeSearch(); });
}

// ── Boot ──────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded',function(){
  initColorPicker();
  $('btn-join').onclick=doJoin;
  $('m-name').onkeydown=function(e){ if(e.key==='Enter') doJoin(); };
  $('m-room').onkeydown=function(e){ if(e.key==='Enter') doJoin(); };
});

})();

// ── Mobile tabs (outside IIFE so globally accessible) ─────────
function isMobile(){ return window.innerWidth<=768; }
function initMobileTabs(){
  if(!isMobile()) return;
  switchMobTab('player');
  document.querySelectorAll('.mob-tab[data-tab]').forEach(function(btn){
    btn.onclick=function(){ switchMobTab(btn.dataset.tab); };
  });
}
function switchMobTab(tab){
  document.querySelectorAll('.mob-tab').forEach(function(b){ b.classList.remove('active'); });
  document.querySelectorAll('#panel-queue,#panel-player,#panel-chat').forEach(function(p){ p.classList.remove('mob-active'); });
  var btn=document.querySelector('.mob-tab[data-tab="'+tab+'"]');
  if(btn) btn.classList.add('active');
  var map={ player:'panel-player',queue:'panel-queue',chat:'panel-chat' };
  var panel=document.getElementById(map[tab]); if(panel) panel.classList.add('mob-active');
}

// ── iOS audio keep-alive ──────────────────────────────────────
var audioCtx=null;
function initAudioContext(){
  try {
    audioCtx=new(window.AudioContext||window.webkitAudioContext)();
    var n=audioCtx.createOscillator(), g=audioCtx.createGain(); g.gain.value=0.00001;
    n.connect(g); g.connect(audioCtx.destination); n.start();
  } catch(e){}
}
function resumeAudio(){ if(audioCtx&&audioCtx.state==='suspended') audioCtx.resume(); }
document.addEventListener('touchstart',resumeAudio,{passive:true});
document.addEventListener('touchend',  resumeAudio,{passive:true});
document.addEventListener('click',     resumeAudio,{passive:true});

// Re-trigger play when coming back from background
document.addEventListener('visibilitychange',function(){
  if(typeof ytPlayer==='undefined'||!ytPlayer) return;
  if(!document.hidden){
    setTimeout(function(){
      try { if(ytPlayer.getPlayerState()===YT.PlayerState.PAUSED&&typeof currentSong!=='undefined'&&currentSong) ytPlayer.playVideo(); } catch(e){}
    },500);
    document.title='TuneRoom ❄️';
  } else {
    if(typeof currentSong!=='undefined'&&currentSong) document.title='▶ '+currentSong.title+' — TuneRoom';
  }
});

window.addEventListener('load',function(){ initAudioContext(); initMobileTabs(); });
window.addEventListener('resize',function(){ if(isMobile()){ var a=document.querySelector('.mob-tab.active'); if(!a) switchMobTab('player'); } });