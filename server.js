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

// load / save helpers
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      return JSON.parse(raw);
    }
  } catch (e) { console.error("Failed to load data.json", e); }
  return { users: {}, friendRequests: {}, rooms: {}, dms: {}, unreadDMs: {} };
}
function saveData() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), "utf8"); }
  catch (e) { console.error("Failed to save data.json", e); }
}

const store = loadData();

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

function genId() { return crypto.randomBytes(5).toString("hex"); }

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
    admin: false
  };
  store.friendRequests[username] = store.friendRequests[username] || [];
  store.unreadDMs[username] = store.unreadDMs[username] || {};
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

// --- FRIENDS ---
app.get("/friends", requireAuth, (req, res) => {
  const username = req.session.user;
  const requests = store.friendRequests[username] || [];
  store.users[username].friends = Array.from(new Set(store.users[username].friends || []));
  const friends = (store.users[username].friends || []).map(f => ({
    username: f, avatar: store.users[f]?.avatar || "/avatars/default.png",
    unread: store.unreadDMs[username]?.[f] || 0
  }));
  const recent = Object.values(store.users)
    .filter(u => u.username !== username && !store.users[username].friends.includes(u.username))
    .sort((a,b) => b.createdAt - a.createdAt).slice(0,10)
    .map(u => ({ username: u.username, avatar: u.avatar || "/avatars/default.png" }));
  res.json({ requests, friends, recent });
});

// --- DMs ---
app.get("/dm/:friend", requireAuth, (req,res) => {
  const me=req.session.user, friend=req.params.friend;
  if(!store.users[friend]) return res.json({ success:false, message:"User not found" });
  const key=[me,friend].sort().join("_");
  store.unreadDMs[me] = store.unreadDMs[me] || {};
  store.unreadDMs[me][friend] = 0; // reset unread count on open
  saveData();
  res.json({ success:true, messages: store.dms[key]||[] });
});

// --- SOCKET.IO ---
io.on("connection", (socket) => {
  socket.on("registerUser", (username) => {
    socket.username = username;
    socket.join(username);
  });

  socket.on("dmMessage", ({ to, message, replyTo }) => {
    const from = socket.username;
    if (!from || !to || !store.users[to] || !message) return;
    const text = ("" + message).slice(0, 300);
    const msg = {
      id: genId(),
      sender: from,
      to,
      avatar: store.users[from]?.avatar || "/avatars/default.png",
      message: text,
      time: Date.now(),
      replyTo: replyTo || null
    };
    const key = [from, to].sort().join("_");
    store.dms[key] = store.dms[key] || [];
    store.dms[key].push(msg);
    
    // unread count for recipient
    store.unreadDMs[to] = store.unreadDMs[to] || {};
    store.unreadDMs[to][from] = (store.unreadDMs[to][from] || 0) + 1;
    
    saveData();
    io.to(to).emit("dmMessage", msg);
    io.to(from).emit("dmMessage", msg);
    io.to(to).emit("dmNotification", { from, unread: store.unreadDMs[to][from] });
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Server running on port ${PORT}`));
