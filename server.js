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
if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });

// load/save helpers
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error("Failed to load data.json", e);
  }
  return { users: {}, friendRequests: {}, rooms: {}, dms: {} };
}
function saveData() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), "utf8"); }
  catch (e) { console.error("Failed to save data.json", e); }
}

const store = loadData();

// ensure default avatar exists
const defaultAvatarPath = path.join(AVATAR_DIR, "default.png");
if (!fs.existsSync(defaultAvatarPath)) {
  const emptyPNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
    "base64"
  );
  fs.writeFileSync(defaultAvatarPath, emptyPNG);
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || "supersecret",
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));
app.use(express.static(path.join(__dirname, "public")));

// multer for avatar uploads
const upload = multer({ dest: path.join(__dirname, "tmp_uploads") });

function genId() { return crypto.randomBytes(5).toString("hex"); }

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ loggedIn: false });
  next();
}

/* ------------------ AUTH ------------------ */
app.post("/signup", async (req, res) => {
  const { username, password, avatarUrl } = req.body;
  if (!username || !password) return res.json({ success: false, message: "Missing fields" });
  if (store.users[username]) return res.json({ success: false, message: "User exists" });

  const hash = await bcrypt.hash(password, 10);
  store.users[username] = {
    username,
    passwordHash: hash,
    avatar: avatarUrl || "/avatars/default.png",
    friends: [],
    starredRooms: [],
    createdAt: Date.now(),
    admin: false
  };
  store.friendRequests[username] = store.friendRequests[username] || [];
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

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get("/me", (req, res) => {
  if (!req.session.user) return res.json({ loggedIn: false });
  const u = store.users[req.session.user];
  if (!u) return res.json({ loggedIn: false });
  res.json({
    loggedIn: true,
    username: u.username,
    avatar: u.avatar,
    starredRooms: u.starredRooms || [],
    admin: !!u.admin
  });
});

/* ------------ AVATAR UPLOAD -------------- */
app.post("/update-avatar", requireAuth, upload.single("avatar"), (req, res) => {
  const username = req.session.user;
  let avatarUrl = null;
  if (req.file) {
    const ext = path.extname(req.file.originalname) || ".png";
    const destName = `${username}_${Date.now()}${ext}`;
    const destPath = path.join(AVATAR_DIR, destName);
    try {
      fs.renameSync(req.file.path, destPath);
      avatarUrl = `/avatars/${destName}`;
    } catch (e) {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.json({ success: false, message: "Upload failed" });
    }
  } else if (req.body.avatarUrl) {
    avatarUrl = req.body.avatarUrl;
  } else {
    return res.json({ success: false, message: "No avatar provided" });
  }

  store.users[username].avatar = avatarUrl;
  saveData();
  res.json({ success: true, avatar: avatarUrl });
});

/* --------------- FRIENDS ----------------- */
app.get("/friends", requireAuth, (req, res) => {
  const username = req.session.user;
  const requests = store.friendRequests[username] || [];
  // dedupe
  store.users[username].friends = Array.from(new Set(store.users[username].friends || []));
  const friends = (store.users[username].friends || []).map(f => ({
    username: f, avatar: store.users[f]?.avatar || "/avatars/default.png"
  }));
  const recent = Object.values(store.users)
    .filter(u => u.username !== username && !store.users[username].friends.includes(u.username))
    .sort((a,b) => b.createdAt - a.createdAt)
    .slice(0, 10)
    .map(u => ({ username: u.username, avatar: u.avatar || "/avatars/default.png" }));
  res.json({ requests, friends, recent });
});

app.post("/friend-request", requireAuth, (req, res) => {
  const from = req.session.user;
  const to = req.body.to;
  if (!to || !store.users[to]) return res.json({ success: false, message: "User not found" });
  if (to === from) return res.json({ success: false, message: "Can't friend yourself" });
  store.friendRequests[to] = store.friendRequests[to] || [];
  if (!store.friendRequests[to].includes(from) && !store.users[to].friends.includes(from)) {
    store.friendRequests[to].push(from);
    saveData();
    io.to(to).emit("friendRequest", from);
  }
  res.json({ success: true });
});

app.post("/accept-request", requireAuth, (req, res) => {
  const username = req.session.user;
  const from = req.body.from;
  store.friendRequests[username] = store.friendRequests[username] || [];
  const idx = store.friendRequests[username].indexOf(from);
  if (idx > -1) {
    store.friendRequests[username].splice(idx, 1);
    store.users[username].friends = Array.from(new Set([...(store.users[username].friends||[]), from]));
    store.users[from].friends = Array.from(new Set([...(store.users[from].friends||[]), username]));
    saveData();
    io.to(from).emit("friendsUpdate");
    io.to(username).emit("friendsUpdate");
  }
  res.json({ success: true });
});

/* --------------- ROOMS ------------------- */
app.get("/rooms", requireAuth, (req, res) => {
  const result = {};
  for (const [id, r] of Object.entries(store.rooms || {})) {
    result[id] = { name: r.name, inviteOnly: !!r.inviteOnly };
  }
  res.json(result);
});

app.post("/create-room", requireAuth, (req, res) => {
  const { name, password, inviteOnly } = req.body;
  if (!name?.trim()) return res.json({ success: false, message: "Room name required" });
  const lower = name.trim().toLowerCase();
  for (const r of Object.values(store.rooms || {})) {
    if (r.name?.trim().toLowerCase() === lower) {
      return res.json({ success: false, message: "Room name already in use" });
    }
  }
  const id = genId();
  store.rooms[id] = { name: name.trim(), password: password || "", inviteOnly: !!inviteOnly, users: [], messages: [] };
  saveData();
  io.emit("roomsUpdated");
  res.json({ success: true, roomId: id, inviteLink: `${req.protocol}://${req.get("host")}/?invite=${id}` });
});

app.get("/room-info/:roomId", requireAuth, (req, res) => {
  const r = store.rooms[req.params.roomId];
  if (!r) return res.json({ success: false });
  res.json({ success: true, name: r.name });
});

/* --------------- DMs --------------------- */
app.get("/dm/:friend", requireAuth, (req, res) => {
  const me = req.session.user;
  const friend = req.params.friend;
  if (!store.users[friend]) return res.json({ success: false, message: "User not found" });
  const key = [me, friend].sort().join("_");
  res.json({ success: true, messages: store.dms[key] || [] });
});

/* ------------- edit/delete messages ----- */
app.post("/edit-message", requireAuth, (req, res) => {
  const { id, roomId, newMsg, dmWith } = req.body;
  const user = req.session.user;
  // room message edit
  if (roomId) {
    const room = store.rooms[roomId];
    if (!room) return res.json({ success: false, message: "Room not found" });
    const msg = room.messages.find(m => m.id === id);
    if (!msg) return res.json({ success: false });
    if (msg.sender !== user && !store.users[user].admin) return res.json({ success: false });
    msg.message = ("" + newMsg).slice(0, 300);
    saveData();
    io.to(roomId).emit("updateMessage", msg);
    return res.json({ success: true });
  }
  // dm edit
  if (dmWith) {
    const key = [user, dmWith].sort().join("_");
    const arr = store.dms[key] || [];
    const msg = arr.find(m => m.id === id);
    if (!msg) return res.json({ success: false });
    if (msg.sender !== user && !store.users[user].admin) return res.json({ success: false });
    msg.message = ("" + newMsg).slice(0, 300);
    saveData();
    io.to(dmWith).emit("updateMessage", msg);
    io.to(user).emit("updateMessage", msg);
    return res.json({ success: true });
  }
  res.json({ success: false });
});

app.post("/delete-message", requireAuth, (req, res) => {
  const { id, roomId, dmWith } = req.body;
  const user = req.session.user;
  if (roomId) {
    const room = store.rooms[roomId];
    if (!room) return res.json({ success: false });
    const idx = room.messages.findIndex(m => m.id === id);
    if (idx === -1) return res.json({ success: false });
    const msg = room.messages[idx];
    if (msg.sender !== user && !store.users[user].admin) return res.json({ success: false });
    room.messages.splice(idx, 1);
    saveData();
    io.to(roomId).emit("deleteMessage", id);
    return res.json({ success: true });
  }
  if (dmWith) {
    const key = [user, dmWith].sort().join("_");
    const arr = store.dms[key] || [];
    const idx = arr.findIndex(m => m.id === id);
    if (idx === -1) return res.json({ success: false });
    const msg = arr[idx];
    if (msg.sender !== user && !store.users[user].admin) return res.json({ success: false });
    arr.splice(idx, 1);
    saveData();
    io.to(dmWith).emit("deleteMessage", id);
    io.to(user).emit("deleteMessage", id);
    return res.json({ success: true });
  }
  res.json({ success: false });
});

/* ------------- star rooms ---------------- */
app.post("/star-room", requireAuth, (req, res) => {
  const { roomId } = req.body;
  if (!roomId || !store.rooms[roomId]) return res.json({ success: false, message: "Room not found" });
  const u = store.users[req.session.user];
  u.starredRooms = u.starredRooms || [];
  if (u.starredRooms.includes(roomId)) u.starredRooms = u.starredRooms.filter(r => r !== roomId);
  else u.starredRooms.push(roomId);
  saveData();
  res.json({ success: true, starred: u.starredRooms });
});

/* ------------- admin make route -------------- */
/*
 To grant admin on your server you can call this endpoint with a secret:
 POST /admin/grant { "username": "bob", "key": "SOME_ADMIN_KEY" }
 Set process.env.ADMIN_KEY on the server (or edit below).
*/
const ADMIN_KEY = process.env.ADMIN_KEY || "please-change-me";
app.post("/admin/grant", (req, res) => {
  const { username, key } = req.body;
  if (key !== ADMIN_KEY) return res.status(403).json({ success: false });
  if (!store.users[username]) return res.json({ success: false, message: "User not found" });
  store.users[username].admin = true;
  saveData();
  res.json({ success: true });
});

/* ---- serve SPA / room direct link ---- */
app.get("/room/:roomId", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// SPA catch-all (serve index for client routing)
app.get("*", (req, res) => {
  if (req.path.startsWith("/avatars") || req.path.includes(".")) {
    return res.status(404).send("Not found");
  }
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* --------------- SOCKET.IO ---------------- */
io.on("connection", (socket) => {
  // when client registers (after login), it should send username
  socket.on("registerUser", (username) => {
    socket.username = username;
    socket.join(username); // personal room
  });

  socket.on("joinRoom", ({ roomId }) => {
    if (!roomId || !store.rooms[roomId]) return;
    socket.join(roomId);
    socket.emit("chatHistory", store.rooms[roomId].messages || []);
  });

  socket.on("roomMessage", ({ roomId, message, clientId, replyTo }) => {
    const sender = socket.username;
    if (!sender || !roomId || !store.rooms[roomId] || !message) return;
    const text = ("" + message).slice(0, 300);
    const msgObj = {
      id: genId(),
      sender,
      avatar: store.users[sender]?.avatar || "/avatars/default.png",
      message: text,
      time: Date.now(),
      roomId,
      replyTo
    };
    store.rooms[roomId].messages = store.rooms[roomId].messages || [];
    store.rooms[roomId].messages.push(msgObj);
    saveData();
    io.to(roomId).emit("roomMessage", msgObj);
  });

  socket.on("dmMessage", ({ to, message, clientId, replyTo }) => {
    const from = socket.username;
    if (!from || !to || !store.users[to] || !message) return;
    const text = ("" + message).slice(0, 300);
    const msg = { id: genId(), sender: from, avatar: store.users[from]?.avatar || "/avatars/default.png", message: text, time: Date.now(), replyTo };
    const key = [from, to].sort().join("_");
    store.dms[key] = store.dms[key] || [];
    store.dms[key].push(msg);
    saveData();
    io.to(to).emit("dmMessage", msg);
    io.to(from).emit("dmMessage", msg);
    io.to(to).emit("dmNotification", { from });
  });

  // accept friend via socket (shortcut)
  socket.on("sendFriendRequest", (to) => {
    const from = socket.username;
    if (!from || !to || !store.users[to]) return;
    store.friendRequests[to] = store.friendRequests[to] || [];
    if (!store.friendRequests[to].includes(from) && !store.users[to].friends.includes(from)) {
      store.friendRequests[to].push(from);
      saveData();
      io.to(to).emit("friendRequest", from);
    }
  });

  socket.on("fetchFriends", () => {
    const u = socket.username;
    if (!u || !store.users[u]) return;
    socket.emit("friendsData", {
      requests: store.friendRequests[u] || [],
      friends: (store.users[u].friends || []).map(f => ({ username: f, avatar: store.users[f]?.avatar || "/avatars/default.png" }))
    });
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Server listening on ${PORT}`));
