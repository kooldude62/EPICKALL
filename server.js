<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Epick Chat</title>
<script src="/socket.io/socket.io.js"></script>
<style>
:root{ --bg:#0f1114; --panel:rgba(255,255,255,0.04); --muted:rgba(255,255,255,0.6); --accent:#6b8cff; --glass:rgba(255,255,255,0.03); --glass-2:rgba(255,255,255,0.02) }
*{box-sizing:border-box;} 
body{margin:0;font-family:Inter,system-ui,Segoe UI,Roboto,Arial;background:linear-gradient(180deg,#071021,#0f1114);color:#e8eefc;min-height:100vh} 
.navbar{display:flex;justify-content:space-between;padding:12px 20px;background:var(--glass-2);border-bottom:1px solid rgba(255,255,255,0.02)} 
.tabs{display:flex;gap:8px;margin:16px;padding:0 12px} 
.tab{padding:10px 12px;border-radius:10px;background:var(--glass-2);cursor:pointer;color:var(--muted)} 
.tab.active{background:linear-gradient(90deg, rgba(107,140,255,0.12), rgba(107,140,255,0.06));color:#fff} 
main{display:grid;grid-template-columns:360px 1fr;gap:16px;padding:18px} 
.panel{background:var(--panel);border-radius:12px;padding:12px;min-height:60vh;display:none;flex-direction:column;gap:12px} 
.panel.active{display:flex} 
.list{display:flex;flex-direction:column;gap:6px;max-height:56vh;overflow:auto;padding-right:6px} 
.list-item{display:flex;align-items:center;justify-content:space-between;padding:8px;border-radius:8px;background:linear-gradient(180deg, rgba(255,255,255,0.01), rgba(255,255,255,0.005));cursor:pointer} 
.pfp{width:36px;height:36px;border-radius:50%;object-fit:cover;border:1px solid rgba(255,255,255,0.04)} 
.unread-dot{width:10px;height:10px;border-radius:50%;background:#6b8cff;display:inline-block;margin-left:6px} 
.chat-overlay{position:fixed;inset:0;background:linear-gradient(180deg, rgba(1,4,8,0.85), rgba(1,4,8,0.95));display:flex;flex-direction:column;z-index:1200;opacity:1;transition:opacity .12s} 
.chat-overlay.hidden{display:none} 
.chat-messages{flex:1;padding:18px;overflow:auto;display:flex;flex-direction:column;gap:10px} 
.chat-input{display:flex;gap:8px;padding:14px;border-top:1px solid rgba(255,255,255,0.02)} 
.chat-input input{flex:1;padding:12px;border-radius:10px;background:rgba(255,255,255,0.02);color:#fff;border:1px solid rgba(255,255,255,0.03)} 
.chat-message{display:flex;gap:10px;align-items:flex-start} 
.chat-message .bubble{background:linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01));padding:10px;border-radius:10px;max-width:72%} 
.chat-message.me .bubble{background:linear-gradient(180deg, rgba(107,140,255,0.14), rgba(107,140,255,0.08));align-self:flex-end} 
.btn{padding:8px 10px;border-radius:8px;border:none;background:var(--accent);color:#05102a;cursor:pointer} 
.btn.secondary{background:transparent;border:1px solid rgba(255,255,255,0.04);color:var(--muted)} 
.small{font-size:13px;color:var(--muted)} 
</style>
</head>
<body>
<div class="navbar">
  <div class="brand">Epick Chat</div>
  <div style="display:flex;gap:8px">
    <button id="accountBtn" class="btn secondary">Account</button>
    <button id="logoutBtn" class="btn secondary">Logout</button>
  </div>
</div>
<div class="tabs">
  <div class="tab active" data-tab="friends">Friends</div>
  <div class="tab" data-tab="rooms">Rooms</div>
  <div class="tab" data-tab="dms">DMs</div>
</div>
<main>
  <section id="friends" class="panel active">
    <div style="display:flex;gap:8px">
      <input id="searchUser" placeholder="Search username">
      <button id="searchBtn" class="btn secondary">Search</button>
    </div>
    <h4>Recently Registered</h4>
    <div id="recentUsers" class="list"></div>
    <h4>Requests</h4>
    <div id="friendRequests" class="list"></div>
    <h4>Your Friends</h4>
    <div id="friendsList" class="list"></div>
  </section>
  <section id="rooms" class="panel">
    <div style="display:flex;gap:8px">
      <input id="roomName" placeholder="Room name">
      <button id="createRoomBtn" class="btn">Create Room</button>
    </div>
    <h4>Available Rooms</h4>
    <div id="roomsList" class="list"></div>
  </section>
  <section id="dms" class="panel">
    <h4>Direct Messages</h4>
    <div id="dmList" class="list"></div>
  </section>
</main>
<div id="chatOverlay" class="chat-overlay hidden" aria-hidden="true">
  <div style="display:flex;align-items:center;justify-content:space-between;padding:12px;border-bottom:1px solid rgba(255,255,255,0.02)">
    <div id="chatTitle">Chat</div>
    <div style="display:flex;gap:8px;align-items:center">
      <button id="closeChat" class="btn secondary">Close</button>
    </div>
  </div>
  <div id="chatMessages" class="chat-messages" aria-live="polite"></div>
  <div class="chat-input">
    <input id="chatInput" maxlength="300" placeholder="Type a message (Enter to send)">
    <button id="sendBtn" class="btn">Send</button>
  </div>
</div>
<script>
(async function(){
const socket = io();
let me = null, isAdmin = false, current = null, unreadDMs = new Set();
const tabs = document.querySelectorAll('.tab');
const panels = document.querySelectorAll('.panel');
const dmListDiv = document.getElementById('dmList');
const chatOverlay = document.getElementById('chatOverlay');
const chatTitle = document.getElementById('chatTitle');
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const closeChatBtn = document.getElementById('closeChat');

tabs.forEach(tab=>tab.addEventListener('click', ()=>{
  tabs.forEach(t=>t.classList.remove('active'));
  panels.forEach(p=>p.classList.remove('active'));
  tab.classList.add('active');
  document.getElementById(tab.dataset.tab).classList.add('active');
}));

function rebuildDMList(friends){
  dmListDiv.innerHTML = '';
  friends.sort((a,b)=>{
    const au = unreadDMs.has(a.username);
    const bu = unreadDMs.has(b.username);
    if(au && !bu) return -1;
    if(bu && !au) return 1;
    return a.username.localeCompare(b.username);
  });
  friends.forEach(f=>{
    const el = document.createElement('div');
    el.className='list-item';
    el.innerHTML = `<div>@ ${f.username}${unreadDMs.has(f.username)?'<span class="unread-dot"></span>':''}</div>`;
    el.onclick = ()=>{ unreadDMs.delete(f.username); openDM(f.username); rebuildDMList(friends); };
    dmListDiv.appendChild(el);
  });
}

function openDM(username){
  current={type:'dm',id:username};
  chatTitle.textContent = `@ ${username}`;
  chatMessages.innerHTML='';
  fetch(`/dm/${username}`).then(r=>r.json()).then(r=>{
    if(r.success) (r.messages||[]).forEach(m=>appendMessage(m));
  });
  chatOverlay.classList.remove('hidden');
  chatOverlay.setAttribute('aria-hidden','false');
}

function createMessageElement(m){
  const el = document.createElement('div'); 
  el.className = 'chat-message' + (m.sender===me ? ' me' : ''); 
  el.dataset.msgid = m.id;
  const bubble = document.createElement('div'); 
  bubble.className='bubble';
  bubble.innerHTML = `<div style="font-size:12px;color:var(--muted)">${m.sender} • ${new Date(m.time||Date.now()).toLocaleString()}</div><div style="margin-top:6px">${m.message||''}</div>`;
  el.appendChild(bubble); 
  return el;
}

function appendMessage(m){
  if(!m || !m.id) return;
  if(document.querySelector(`[data-msgid="${m.id}"]`)) return;
  const el = createMessageElement(m);
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function sendMessage(){
  const txt = chatInput.value.trim(); 
  if(!txt) return; 
  if(txt.length>300) return alert('Message length max 300'); 
  if(!current) return alert('Open a room or DM first');
  if(current.type==='dm') socket.emit('dmMessage',{to:current.id,message:txt});
  chatInput.value='';
}

sendBtn.onclick = sendMessage;
chatInput.addEventListener('keydown', e=>{ if(e.key==='Enter') sendMessage(); });

socket.on('dmMessage', m => {
  if(current?.type==='dm' && (current.id===m.sender || current.id===m.to)) {
    appendMessage(m);
  } else {
    unreadDMs.add(m.sender);
    loadDMList();
  }
});

async function loadDMList(){
  const data = await (await fetch('/friends')).json();
  if(data) rebuildDMList(data.friends||[]);
}

closeChatBtn.onclick = ()=>{ chatOverlay.classList.add('hidden'); chatOverlay.setAttribute('aria-hidden','true'); current=null; };

await loadDMList();
})();
</script>
</body>
</html>
