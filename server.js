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

// tiny default png (1x1 transparent) used if not present
const tinyPNGBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";
const defaultAvatarPath = path.join(AVATAR_DIR, "default.png");
const defaultRoomPfpPath = path.join(ROOM_PFP_DIR, "default.png");
if (!fs.existsSync(defaultAvatarPath)) fs.writeFileSync(defaultAvatarPath, Buffer.from(tinyPNGBase64, "base64"));
if (!fs.existsSync(defaultRoomPfpPath)) fs.writeFileSync(defaultRoomPfpPath, Buffer.from(tinyPNGBase64, "base64"));

// load / save helpers
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
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), "utf8");
  } catch (e) {
    console.error("Failed to save data.json", e);
  }
}

const store = loadData();

// ensure older data has defaults
for (const rId of Object.keys(store.rooms || {})) {
  store.rooms[rId].pfp = store.rooms[rId].pfp || "/room_pfps/default.png";
  store.rooms[rId].owner = store.rooms[rId].owner || null;
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(
  session({
    secret: "supersecret",
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false },
  })
);
app.use(express.static(path.join(__dirname, "public")));

// multer for avatar uploads
const upload = multer({ dest: path.join(__dirname, "tmp_uploads") });

function genId() {
  return crypto.randomBytes(5).toString("hex");
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ loggedIn: false });
  next();
}

// --- AUTH ---
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
    admin: false,
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
    admin: !!u.admin,
  });
});

// --- AVATAR ---
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
      console.error(e);
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
  return res.json({ success: true, avatar: avatarUrl });
});

// --- FRIENDS ---
app.get("/friends", requireAuth, (req, res) => {
  const username = req.session.user;
  const requests = store.friendRequests[username] || [];
  store.users[username].friends = Array.from(new Set(store.users[username].friends || []));
  const friends = (store.users[username].friends || []).map(f => ({
    username: f,
    avatar: store.users[f]?.avatar || "/avatars/default.png",
  }));
  const recent = Object.values(store.users)
    .filter(u => u.username !== username && !store.users[username].friends.includes(u.username))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 10)
    .map(u => ({ username: u.username, avatar: u.avatar || "/avatars/default.png" }));
  res.json({ requests, friends, recent });
});

app.post("/friend-request", requireAuth, (req, res) => {
  const from = req.session.user, to = req.body.to;
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
  const username = req.session.user, from = req.body.from;
  store.friendRequests[username] = store.friendRequests[username] || [];
  const idx = store.friendRequests[username].indexOf(from);
  if (idx > -1) {
    store.friendRequests[username].splice(idx, 1);
    store.users[username].friends = Array.from(new Set([...(store.users[username].friends || []), from]));
    store.users[from].friends = Array.from(new Set([...(store.users[from].friends || []), username]));
    saveData();
    io.to(from).emit("friendsUpdate");
    io.to(username).emit("friendsUpdate");
  }
  res.json({ success: true });
});

// --- ROOMS ---
app.get("/rooms", requireAuth, (req, res) => {
  const result = {};
  for (const [id, r] of Object.entries(store.rooms)) {
    result[id] = {
      name: r.name,
      inviteOnly: !!r.inviteOnly,
      owner: r.owner || null,
      pfp: r.pfp || "/room_pfps/default.png",
    };
  }
  res.json(result);
});

app.post("/create-room", requireAuth, (req, res) => {
  const { name, password, inviteOnly } = req.body;
  if (!name?.trim()) return res.json({ success: false, message: "Room name required" });

  const lower = name.trim().toLowerCase();
  for (const r of Object.values(store.rooms)) {
    if (r.name?.trim().toLowerCase() === lower) {
      return res.json({ success: false, message: "Room name already in use" });
    }
  }

  const id = genId();
  store.rooms[id] = {
    name: name.trim(),
    password: password || "",
    inviteOnly: !!inviteOnly,
    users: [],
    messages: [],
    owner: req.session.user,
    pfp: "/room_pfps/default.png",
  };
  saveData();
  io.emit("roomsUpdated");
  res.json({ success: true, roomId: id, inviteLink: `${req.protocol}://${req.get("host")}/?invite=${id}` });
});

app.get("/room-info/:roomId", requireAuth, (req, res) => {
  const r = store.rooms[req.params.roomId];
  if (!r) return res.json({ success: false });
  res.json({ success: true, name: r.name, owner: r.owner || null, pfp: r.pfp || "/room_pfps/default.png" });
});

// --- DMs ---
app.get("/dm/:friend", requireAuth, (req, res) => {
  const me = req.session.user, friend = req.params.friend;
  if (!store.users[friend]) return res.json({ success: false, message: "User not found" });
  const key = [me, friend].sort().join("_");
  res.json({ success: true, messages: store.dms[key] || [] });
});

// --- Update Room PFP ---
// accepts multipart/form-data with field 'pfp' and 'roomId'
// or JSON body { roomId, pfpUrl }
app.post("/update-room-pfp", requireAuth, upload.single("pfp"), (req, res) => {
  const username = req.session.user;
  const { roomId } = req.body;
  if (!roomId || !store.rooms[roomId]) {
    // maybe JSON body
    if (!req.body.roomId && req.body.pfpUrl) {
      return res.json({ success: false, message: "roomId required" });
    }
    return res.json({ success: false, message: "Room not found" });
  }

  const room = store.rooms[roomId];
  // only owner or admin can change
  if (room.owner !== username && !store.users[username]?.admin) {
    return res.status(403).json({ success: false, message: "Not allowed" });
  }

  // file upload
  if (req.file) {
    const ext = path.extname(req.file.originalname) || ".png";
    const destName = `room_${roomId}_${Date.now()}${ext}`;
    const destPath = path.join(ROOM_PFP_DIR, destName);
    try {
      fs.renameSync(req.file.path, destPath);
      room.pfp = `/room_pfps/${destName}`;
    } catch (e) {
      console.error(e);
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.json({ success: false, message: "Upload failed" });
    }
  } else if (req.body.pfpUrl) {
    // set by url
    room.pfp = req.body.pfpUrl;
  } else {
    return res.json({ success: false, message: "No pfp provided" });
  }

  saveData();
  io.emit("roomsUpdated");
  return res.json({ success: true, pfp: room.pfp });
});

// --- Message editing/deleting endpoints (unchanged) ---
// (kept for brevity — you likely already have these endpoints from previous code)
// ... (the edit-message and delete-message routes from your existing server should remain here)

app.post("/edit-message", requireAuth, (req,res) => {
  const { id, roomId, newMsg, dmWith } = req.body;
  const user = req.session.user;
  if (roomId && store.rooms[roomId]) {
    const msg = (store.rooms[roomId].messages||[]).find(m=>m.id===id);
    if (!msg) return res.json({ success: false });
    if (msg.sender !== user && !store.users[user].admin) return res.json({ success:false });
    msg.message = newMsg;
    saveData();
    io.to(roomId).emit("updateMessage", msg);
    return res.json({ success:true });
  }
  if (dmWith) {
    const key = [user, dmWith].sort().join("_");
    const m = (store.dms[key]||[]).find(mm=>mm.id===id);
    if (!m) return res.json({ success:false });
    if (m.sender !== user && !store.users[user].admin) return res.json({ success:false });
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
  if (roomId && store.rooms[roomId]) {
    const idx = (store.rooms[roomId].messages||[]).findIndex(m=>m.id===id);
    if (idx === -1) return res.json({ success:false });
    const msg = store.rooms[roomId].messages[idx];
    if (msg.sender !== user && !store.users[user].admin) return res.json({ success:false });
    store.rooms[roomId].messages.splice(idx,1);
    saveData();
    io.to(roomId).emit("deleteMessage", id);
    return res.json({ success:true });
  }
  if (dmWith) {
    const key = [user, dmWith].sort().join("_");
    const arr = store.dms[key] || [];
    const idx = arr.findIndex(m=>m.id===id);
    if (idx === -1) return res.json({ success:false });
    const msg = arr[idx];
    if (msg.sender !== user && !store.users[user].admin) return res.json({ success:false });
    arr.splice(idx,1);
    saveData();
    io.to(user).emit("deleteMessage", id);
    io.to(dmWith).emit("deleteMessage", id);
    return res.json({ success:true });
  }
  res.json({ success:false });
});

// --- SOCKET.IO ---
io.on("connection", (socket) => {
  socket.on("registerUser", (username) => {
    socket.username = username;
    socket.join(username);
  });

  socket.on("joinRoom", ({ roomId }) => {
    if (!roomId || !store.rooms[roomId]) return;
    socket.join(roomId);
    const messages = store.rooms[roomId].messages || [];
    socket.emit("chatHistory", messages);
  });

  socket.on("roomMessage", ({ roomId, message }) => {
    const sender = socket.username;
    if (!sender || !roomId || !store.rooms[roomId] || !message) return;
    const text = ("" + message).slice(0, 300);
    const msgObj = {
      id: genId(),
      sender,
      avatar: store.users[sender]?.avatar || "/avatars/default.png",
      message: text,
      time: Date.now(),
      roomId
    };
    store.rooms[roomId].messages = store.rooms[roomId].messages || [];
    store.rooms[roomId].messages.push(msgObj);
    saveData();
    io.to(roomId).emit("roomMessage", msgObj);
  });

  socket.on("dmMessage", ({ to, message }) => {
    const from = socket.username;
    if (!from || !to || !store.users[to] || !message) return;
    const text = ("" + message).slice(0, 300);
    const msg = {
      id: genId(),
      sender: from,
      to,
      avatar: store.users[from]?.avatar || "/avatars/default.png",
      message: text,
      time: Date.now()
    };
    const key = [from, to].sort().join("_");
    store.dms[key] = store.dms[key] || [];
    store.dms[key].push(msg);
    saveData();
    io.to(to).emit("dmMessage", msg);
    io.to(from).emit("dmMessage", msg);
    io.to(to).emit("dmNotification", { from });
  });

  socket.on("sendFriendRequest", async (to) => {
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
httpServer.listen(PORT, () => console.log(`Server running on port ${PORT}`));
