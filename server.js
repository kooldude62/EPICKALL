// server.js
import express from "express";
import session from "express-session";
import bodyParser from "body-parser";
import { createServer } from "http";
import { Server } from "socket.io";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import crypto from "crypto";
import bcrypt from "bcryptjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.join(__dirname, "data.json");
const AVATAR_DIR = path.join(__dirname, "public", "avatars");
const ROOM_PFP_DIR = path.join(__dirname, "public", "room_pfps");

if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });
if (!fs.existsSync(ROOM_PFP_DIR)) fs.mkdirSync(ROOM_PFP_DIR, { recursive: true });
const admins = process.env.ADMINS ? process.env.ADMINS.split(',') : [];

// Check if user is admin
function isAdmin(username) {
  return admins.includes(username);
}

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      const parsed = JSON.parse(raw);
      parsed.users = parsed.users || {};
      parsed.friendRequests = parsed.friendRequests || {};
      parsed.rooms = parsed.rooms || {};
      parsed.dms = parsed.dms || {};
      parsed.notifications = parsed.notifications || {};
      parsed.blocks = parsed.blocks || {};
      parsed.rateLimits = parsed.rateLimits || {};
      return parsed;
    }
  } catch (e) { console.error("Failed to load data.json", e); }
  return { users: {}, friendRequests: {}, rooms: {}, dms: {}, notifications: {}, blocks: {}, rateLimits: {} };
}
function saveData() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), "utf8"); } catch (e) { console.error("Failed to save data.json", e); }
}

const store = loadData();

function genId() { return crypto.randomBytes(6).toString("hex"); }
function addNotification(user, type, payload = {}) {
  store.notifications[user] = store.notifications[user] || [];
  const note = { id: genId(), type, payload, time: Date.now(), read: false };
  store.notifications[user].unshift(note);
  saveData();
  return note;
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: "supersecret",
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({ dest: path.join(__dirname, "tmp_uploads") });

function requireAuth(req, res, next) { if (!req.session.user) return res.status(401).json({ loggedIn: false }); next(); }

/* ---------- AUTH ---------- */
app.post("/signup", async (req, res) => {
  const { username, password, avatarUrl } = req.body;
  if (!username || !password) return res.json({ success: false, message: "Missing fields" });
  if (store.users[username]) return res.json({ success: false, message: "User exists" });
  const hash = await bcrypt.hash(password, 10);
  store.users[username] = {
    username,
    passwordHash: hash,
    avatar: avatarUrl || "/avatars/default.png",
    displayName: username,
    bio: "",
    friends: [],
    createdAt: Date.now(),
    admin: false,
    dmPrivacy: "any"
  };
  store.friendRequests[username] = store.friendRequests[username] || [];
  store.notifications[username] = store.notifications[username] || [];
  store.blocks[username] = store.blocks[username] || [];
  saveData();
  req.session.user = username;
  res.json({ success: true });
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const u = store.users[username];
  if (!u) return res.json({ success: false, message: "Invalid credentials" });
  const ok = await bcrypt.compare(password, u.passwordHash);
  if (!ok) return res.json({ success: false, message: "Invalid credentials" });
  req.session.user = username;
  res.json({ success: true });
});

app.post("/logout", (req, res) => req.session.destroy(() => res.json({ success: true })));

app.get("/me", (req, res) => {
  if (!req.session.user) return res.json({ loggedIn: false });
  const u = store.users[req.session.user];
  if (!u) return res.json({ loggedIn: false });
  res.json({
    loggedIn: true,
    username: u.username,
    avatar: u.avatar,
    displayName: u.displayName,
    bio: u.bio,
    admin: !!u.admin,
    dmPrivacy: u.dmPrivacy
  });
});

/* ---------- Avatar upload ---------- */
app.post("/update-avatar", requireAuth, upload.single("avatar"), (req, res) => {
  const username = req.session.user;
  let avatarUrl = null;
  if (req.file) {
    const ext = path.extname(req.file.originalname) || ".png";
    const destName = `${username}_${Date.now()}${ext}`;
    const destPath = path.join(AVATAR_DIR, destName);
    try { fs.renameSync(req.file.path, destPath); avatarUrl = `/avatars/${destName}`; }
    catch (e) { try { fs.unlinkSync(req.file.path); } catch {} return res.json({ success:false, message:"Upload failed" }); }
  } else if (req.body.avatarUrl) avatarUrl = req.body.avatarUrl;
  else return res.json({ success:false, message:"No avatar provided" });
  store.users[username].avatar = avatarUrl;
  saveData();
  res.json({ success:true, avatar: avatarUrl });
});

/* ---------- Friends ---------- */
app.get("/friends", requireAuth, (req, res) => {
  const username = req.session.user;
  const requests = store.friendRequests[username] || [];
  store.users[username].friends = Array.from(new Set(store.users[username].friends || []));
  const friends = (store.users[username].friends || []).map(f => ({ username: f, avatar: store.users[f]?.avatar || "/avatars/default.png" }));
  const recent = Object.values(store.users)
    .filter(u => u.username !== username && !store.users[username].friends.includes(u.username))
    .sort((a,b) => b.createdAt - a.createdAt).slice(0,10)
    .map(u => ({ username: u.username, avatar: u.avatar || "/avatars/default.png" }));
  res.json({ requests, friends, recent });
});

app.post("/friend-request", requireAuth, (req,res) => {
  const from = req.session.user, to = req.body.to;
  if(!to || !store.users[to]) return res.json({ success:false, message:"User not found" });
  if(to===from) return res.json({ success:false, message:"Can't friend yourself" });
  if((store.blocks[to]||[]).includes(from) || (store.blocks[from]||[]).includes(to)) return res.json({ success:false, message:"Blocked" });
  store.friendRequests[to] = store.friendRequests[to] || [];
  if(!store.friendRequests[to].includes(from) && !store.users[to].friends.includes(from)) {
    store.friendRequests[to].push(from);
    saveData();
    const note = addNotification(to, "friend_request", { from });
    io.to(to).emit("friendRequest", from);
    io.to(to).emit("inboxUpdate", note);
  }
  res.json({ success:true });
});

app.post("/accept-request", requireAuth, (req,res) => {
  const username = req.session.user, from = req.body.from;
  store.friendRequests[username] = store.friendRequests[username] || [];
  const idx = store.friendRequests[username].indexOf(from);
  if(idx > -1) {
    store.friendRequests[username].splice(idx,1);
    store.users[username].friends = Array.from(new Set([...(store.users[username].friends||[]), from]));
    store.users[from].friends = Array.from(new Set([...(store.users[from].friends||[]), username]));
    saveData();
    io.to(from).emit("friendsUpdate");
    io.to(username).emit("friendsUpdate");
    const note = addNotification(from, "friend_accept", { by: username });
    io.to(from).emit("inboxUpdate", note);
  }
  res.json({ success:true });
});

/* ---------- Rooms (privacy + invited) ---------- */
/*
room schema:
  owner, pfp, description, privacy: public|friends|invite, canPost: any|friends|owner, banned: [], invited: []
*/
app.get("/rooms", requireAuth, (req,res) => {
  const result = {};
  for(const [id,r] of Object.entries(store.rooms || {})) {
    result[id] = { name: r.name, inviteOnly: !!r.inviteOnly, owner: r.owner||null, pfp: r.pfp||"/room_pfps/default.png", description: r.description||"", privacy: r.privacy||"public", canPost: r.canPost||"any", banned: r.banned||[], invited: r.invited||[] };
  }
  res.json(result);
});

app.post("/create-room", requireAuth, (req,res) => {
  const { name, password, inviteOnly } = req.body;
  if(!name?.trim()) return res.json({ success:false, message:"Room name required" });
  const lower = name.trim().toLowerCase();
  for(const r of Object.values(store.rooms||{})) if(r.name?.trim().toLowerCase()===lower) return res.json({ success:false, message:"Room name already in use" });
  const id = genId();
  store.rooms[id] = { name: name.trim(), password: password||"", inviteOnly: !!inviteOnly, users: [], messages: [], owner: req.session.user, pfp: "/room_pfps/default.png", description: "", privacy:"public", canPost:"any", banned: [], invited: [] };
  saveData();
  io.emit("roomsUpdated");
  res.json({ success:true, roomId:id, inviteLink: `${req.protocol}://${req.get("host")}/?invite=${id}` });
});

app.get("/room-info/:roomId", requireAuth, (req,res) => {
  const r = store.rooms[req.params.roomId];
  if(!r) return res.json({ success:false });
  res.json({ success:true, name:r.name, owner: r.owner||null, pfp: r.pfp||"/room_pfps/default.png", description: r.description||"", privacy: r.privacy||"public", canPost: r.canPost||"any", banned: r.banned||[], invited: r.invited||[] });
});

app.post("/update-room-pfp", requireAuth, upload.single("pfp"), (req,res) => {
  const username = req.session.user;
  const roomId = req.body.roomId;
  if(!roomId || !store.rooms[roomId]) return res.json({ success:false, message:"Room not found" });
  const room = store.rooms[roomId];
  if(room.owner !== username && !store.users[username].admin) return res.status(403).json({ success:false, message:"Not allowed" });
  if(req.file) {
    const ext = path.extname(req.file.originalname) || ".png";
    const destName = `room_${roomId}_${Date.now()}${ext}`;
    const destPath = path.join(ROOM_PFP_DIR, destName);
    try { fs.renameSync(req.file.path, destPath); room.pfp = `/room_pfps/${destName}`; }
    catch(e){ try{fs.unlinkSync(req.file.path)}catch{} return res.json({ success:false, message:"Upload failed" }); }
  } else if(req.body.pfpUrl) {
    room.pfp = req.body.pfpUrl;
  } else return res.json({ success:false, message:"No pfp provided" });
  saveData();
  io.emit("roomsUpdated");
  res.json({ success:true, pfp: room.pfp });
});

/* room actions: kick, ban, unban, setName, setDescription, setPrivacy, setCanPost, invite, revoke-invite */
app.post("/room-action", requireAuth, (req,res) => {
  const user = req.session.user;
  const { roomId, action, target, value } = req.body;
  if(!roomId || !store.rooms[roomId]) return res.json({ success:false, message:"Room not found" });
  const room = store.rooms[roomId];
  const allowed = room.owner === user || store.users[user]?.admin;
  if(!allowed) return res.status(403).json({ success:false, message:"Not allowed" });

  if(action === "kick") {
    io.to(target).emit("kickedFromRoom", { roomId, by: user, reason: value || null });
    return res.json({ success:true });
  }
  if(action === "ban") {
    room.banned = room.banned || [];
    if(!room.banned.includes(target)) room.banned.push(target);
    saveData();
    io.to(target).emit("kickedFromRoom", { roomId, by:user, reason: "banned" });
    io.emit("roomsUpdated");
    return res.json({ success:true });
  }
  if(action === "unban") {
    room.banned = (room.banned||[]).filter(x => x !== target);
    saveData();
    io.emit("roomsUpdated");
    return res.json({ success:true });
  }
  if(action === "setName") {
    if(typeof value === "string") room.name = value.slice(0,100);
    saveData();
    io.emit("roomsUpdated");
    return res.json({ success:true });
  }
  if(action === "setDescription") {
    room.description = (value||"").slice(0,300);
    saveData();
    io.emit("roomsUpdated");
    return res.json({ success:true });
  }
  if(action === "setPrivacy") {
    if(["public","friends","invite"].includes(value)) room.privacy = value;
    saveData();
    io.emit("roomsUpdated");
    return res.json({ success:true });
  }
  if(action === "setCanPost") {
    if(["any","friends","owner"].includes(value)) room.canPost = value;
    saveData();
    io.emit("roomsUpdated");
    return res.json({ success:true });
  }
  if(action === "setPfp") {
    if(typeof value === "string") { room.pfp = value; saveData(); io.emit("roomsUpdated"); return res.json({ success:true }); }
  }
  if(action === "invite") {
    room.invited = room.invited || [];
    if(!room.invited.includes(target)) room.invited.push(target);
    saveData();
    const note = addNotification(target, "room_invite", { roomId, by: user, roomName: room.name });
    io.to(target).emit("inboxUpdate", note);
    io.to(target).emit("roomInvite", { roomId, by: user, roomName: room.name });
    io.emit("roomsUpdated");
    return res.json({ success:true });
  }
  if(action === "revoke-invite") {
    room.invited = (room.invited||[]).filter(x => x !== target);
    saveData();
    io.emit("roomsUpdated");
    return res.json({ success:true });
  }

  res.json({ success:false, message:"Unknown action" });
});

/* ---------- DMs ---------- */
app.get("/dm/:friend", requireAuth, (req,res) => {
  const me = req.session.user, friend = req.params.friend;
  if(!store.users[friend]) return res.json({ success:false, message:"User not found" });
  if((store.blocks[friend]||[]).includes(me) || (store.blocks[me]||[]).includes(friend)) return res.json({ success:false, message:"Cannot view (blocked)" });
  const key = [me, friend].sort().join("_");
  res.json({ success:true, messages: store.dms[key] || [] });
});

/* ---------- Inbox ---------- */
app.get("/inbox", requireAuth, (req,res) => {
  const u = req.session.user;
  res.json({ success:true, notifications: store.notifications[u] || [] });
});
app.post("/inbox/mark-read", requireAuth, (req,res) => {
  const u = req.session.user; const { id } = req.body;
  if(!store.notifications[u]) return res.json({ success:false });
  if(id === "all") { store.notifications[u].forEach(n => n.read = true); saveData(); return res.json({ success:true }); }
  const n = store.notifications[u].find(x=>x.id === id);
  if(n) { n.read = true; saveData(); return res.json({ success:true }); }
  res.json({ success:false });
});

/* ---------- edit/delete message endpoints ---------- */
app.post("/edit-message", requireAuth, (req,res) => {
  const { id, roomId, newMsg, dmWith } = req.body;
  const user = req.session.user;
  if(roomId && store.rooms[roomId]) {
    const msg = (store.rooms[roomId].messages || []).find(m => m.id === id);
    if(!msg) return res.json({ success:false });
    if(msg.sender !== user && !store.users[user].admin && store.rooms[roomId].owner !== user) return res.json({ success:false });
    msg.message = newMsg;
    saveData();
    io.to(roomId).emit("updateMessage", msg);
    return res.json({ success:true });
  }
  if(dmWith) {
    const key = [user, dmWith].sort().join("_");
    const m = (store.dms[key] || []).find(mm => mm.id === id);
    if(!m) return res.json({ success:false });
    if(m.sender !== user && !store.users[user].admin) return res.json({ success:false });
    m.message = newMsg;
    saveData();
    io.to(user).emit("updateMessage", m);
    io.to(dmWith).emit("updateMessage", m);
    return res.json({ success:true });
  }
  res.json({ success:false });
});

app.post("/delete-message", requireAuth, (req,res) => {
  const { id, roomId, dmWith } = req.body;
  const user = req.session.user;
  if(roomId && store.rooms[roomId]) {
    const idx = (store.rooms[roomId].messages || []).findIndex(m => m.id === id);
    if(idx === -1) return res.json({ success:false });
    const msg = store.rooms[roomId].messages[idx];
    if(msg.sender !== user && !store.users[user].admin && store.rooms[roomId].owner !== user) return res.json({ success:false });
    store.rooms[roomId].messages.splice(idx, 1);
    saveData();
    io.to(roomId).emit("deleteMessage", id);
    return res.json({ success:true });
  }
  if(dmWith) {
    const key = [user, dmWith].sort().join("_");
    const arr = store.dms[key] || [];
    const idx = arr.findIndex(m => m.id === id);
    if(idx === -1) return res.json({ success:false });
    const msg = arr[idx];
    if(msg.sender !== user && !store.users[user].admin) return res.json({ success:false });
    arr.splice(idx,1);
    saveData();
    io.to(user).emit("deleteMessage", id);
    io.to(dmWith).emit("deleteMessage", id);
    return res.json({ success:true });
  }
  res.json({ success:false });
});

/* ---------- rate-limiting ---------- */
function allowMessage(sender) {
  const now = Date.now();
  store.rateLimits[sender] = store.rateLimits[sender] || [];
  const WINDOW = 10_000;
  const LIMIT = 25;
  store.rateLimits[sender] = store.rateLimits[sender].filter(t => now - t <= WINDOW);
  if (store.rateLimits[sender].length >= LIMIT) return false;
  store.rateLimits[sender].push(now);
  saveData();
  return true;
}

/* ---------- SOCKET.IO ---------- */
io.on("connection", (socket) => {
  socket.on("registerUser", (username) => {
    socket.username = username;
    socket.join(username);
  });

  socket.on("joinRoom", ({ roomId }) => {
    if(!roomId || !store.rooms[roomId]) return;
    const room = store.rooms[roomId];

    // BANNED check
    if((room.banned||[]).includes(socket.username)) { socket.emit("kickedFromRoom", { roomId, reason: "banned" }); return; }

    // PRIVACY logic
    const privacy = room.privacy || "public";
    const owner = room.owner;
    const isOwner = owner === socket.username;
    const isAdmin = store.users[socket.username]?.admin;

    if(privacy === "friends") {
      // allow if friend of owner, the owner, or admin
      const ownerFriends = (store.users[owner]?.friends || []);
      if(!(isOwner || isAdmin || ownerFriends.includes(socket.username))) {
        socket.emit("joinDenied", { roomId, reason: "friends-only" });
        return;
      }
    }
    if(privacy === "invite") {
      room.invited = room.invited || [];
      if(!(isOwner || isAdmin || room.invited.includes(socket.username))) {
        socket.emit("joinDenied", { roomId, reason: "invite-only" });
        return;
      }
    }

    // join
    socket.join(roomId);
    room.users = room.users || [];
    if(!room.users.includes(socket.username)) room.users.push(socket.username);
    saveData();
    const messages = room.messages || [];
    socket.emit("chatHistory", messages);
  });

  socket.on("roomMessage", ({ roomId, message }) => {
    const sender = socket.username;
    if(!sender || !roomId || !store.rooms[roomId] || !message) return;
    const text = ("" + message).trim();
    if(!text) return;
    if(!allowMessage(sender)) { socket.emit("rateLimited", { message: "Too many messages" }); return; }

    const room = store.rooms[roomId];

    // posting permissions
    if(room.canPost === "owner" && room.owner !== sender && !store.users[sender]?.admin) { socket.emit("postDenied", { message: "Only owner can post" }); return; }
    if(room.canPost === "friends" && !(store.users[room.owner].friends || []).includes(sender) && room.owner !== sender && !store.users[sender]?.admin) { socket.emit("postDenied", { message: "Only friends of owner can post" }); return; }

    const msgObj = { id: genId(), sender, avatar: store.users[sender]?.avatar || "/avatars/default.png", message: text, time: Date.now(), roomId };
    room.messages = room.messages || [];
    room.messages.push(msgObj);
    saveData();
    io.to(roomId).emit("roomMessage", msgObj);
  });

  socket.on("dmMessage", ({ to, message, tempId }) => {
    const from = socket.username;
    if(!from || !to || !store.users[to] || !message) return;
    if((store.blocks[to]||[]).includes(from) || (store.blocks[from]||[]).includes(to)) { socket.emit("dmFailed", { message: "Blocked" }); return; }
    const recipient = store.users[to];
    if(recipient.dmPrivacy === "friends" && !(store.users[to].friends || []).includes(from)) { socket.emit("dmFailed", { message: "This user only accepts DMs from friends" }); return; }
    if(!allowMessage(from)) { socket.emit("rateLimited", { message: "Too many messages" }); return; }
    const text = ("" + message).trim();
    if(!text) return;
    const msg = { id: genId(), sender: from, to, avatar: store.users[from]?.avatar || "/avatars/default.png", message: text, time: Date.now() };
    const key = [from, to].sort().join("_");
    store.dms[key] = store.dms[key] || [];
    store.dms[key].push(msg);
    saveData();
    const emitMsg = Object.assign({}, msg);
    if(tempId) emitMsg.tempId = tempId;
    io.to(to).emit("dmMessage", emitMsg);
    io.to(from).emit("dmMessage", emitMsg);
    const note = addNotification(to, "dm", { from, preview: text.slice(0,120) });
    io.to(to).emit("inboxUpdate", note);
    io.to(to).emit("dmNotification", { from });
  });

  socket.on("roomCommand", ({ roomId, action, target, pfpUrl }) => {
    const user = socket.username;
    if(!user || !store.rooms[roomId]) return;
    const room = store.rooms[roomId];
    const isOwner = room.owner === user || store.users[user]?.admin;
    if(!isOwner) { socket.emit("roomCommandFailed", { message: "Not allowed" }); return; }
    if(action === "kick") { io.to(target).emit("kickedFromRoom", { roomId, by: user }); return; }
    if(action === "ban") { room.banned = room.banned || []; if(!room.banned.includes(target)) room.banned.push(target); saveData(); io.to(target).emit("kickedFromRoom", { roomId, by: user, reason: "banned" }); io.emit("roomsUpdated"); return; }
    if(action === "unban") { room.banned = (room.banned||[]).filter(x=>x!==target); saveData(); io.emit("roomsUpdated"); return; }
    if(action === "setpfp" && pfpUrl) { room.pfp = pfpUrl; saveData(); io.emit("roomsUpdated"); return; }
  });

  socket.on("sendFriendRequest", (to) => {
    const from = socket.username;
    if(!from || !to || !store.users[to]) return;
    if((store.blocks[to]||[]).includes(from) || (store.blocks[from]||[]).includes(to)) return;
    store.friendRequests[to] = store.friendRequests[to] || [];
    if(!store.friendRequests[to].includes(from) && !store.users[to].friends.includes(from)) {
      store.friendRequests[to].push(from);
      saveData();
      const note = addNotification(to, "friend_request", { from });
      io.to(to).emit("friendRequest", from);
      io.to(to).emit("inboxUpdate", note);
    }
  });

  socket.on("fetchFriends", () => {
    const u = socket.username;
    if(!u || !store.users[u]) return;
    socket.emit("friendsData", { requests: store.friendRequests[u] || [], friends: (store.users[u].friends || []).map(f => ({ username: f, avatar: store.users[f]?.avatar || "/avatars/default.png" })) });
  });

});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
