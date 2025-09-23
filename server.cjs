const express = require("express");
const app = express();
const http = require("http");
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const session = require("express-session");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 3000;
const ADMIN_USERS = process.env.ADMIN_USERS ? process.env.ADMIN_USERS.split(",") : [];

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "secret",
    resave: false,
    saveUninitialized: true,
  })
);

const USERS_FILE = path.join(__dirname, "storage/users.json");
const ROOMS_FILE = path.join(__dirname, "storage/rooms.json");

// Load JSON safely
function loadJSON(file, defaultData) {
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(defaultData, null, 2));
    return JSON.parse(fs.readFileSync(file));
  } catch (e) {
    console.error(`Error loading ${file}:`, e);
    return defaultData;
  }
}

// Save JSON
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let users = loadJSON(USERS_FILE, {});   // username -> {password, friends, requests, avatar, bio, banned, admin}
let rooms = loadJSON(ROOMS_FILE, {});   // roomName -> {owner, users: []}
let messages = []; // in-memory messages

// Middleware
function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ success: false });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || !req.session.user.admin) {
    return res.status(403).json({ success: false, message: "Admin only" });
  }
  next();
}

// Auth routes
app.post("/signup", (req, res) => {
  const { username, password, avatar, bio } = req.body;
  if (!username || !password) return res.json({ success: false, message: "Missing fields" });
  if (users[username]) return res.json({ success: false, message: "User exists" });

  users[username] = {
    password,
    friends: [],
    requests: [],
    avatar: avatar || "/default.png",
    bio: bio || "",
    banned: false,
    admin: ADMIN_USERS.includes(username),
  };

  saveJSON(USERS_FILE, users);
  req.session.user = { username, admin: users[username].admin };
  res.json({ success: true });
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  const user = users[username];
  if (!user || user.password !== password) return res.json({ success: false, message: "Invalid credentials" });
  if (user.banned) return res.json({ success: false, message: "Banned" });

  req.session.user = { username, admin: user.admin };
  res.json({ success: true });
});

app.post("/logout", requireLogin, (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get("/me", (req, res) => {
  if (!req.session.user) return res.json({ loggedIn: false });
  const u = users[req.session.user.username];
  res.json({
    loggedIn: true,
    username: req.session.user.username,
    admin: u.admin,
    avatar: u.avatar,
    bio: u.bio,
    friends: u.friends,
  });
});

// Friend system
app.get("/friends", requireLogin, (req, res) => {
  const me = users[req.session.user.username];
  const recent = Object.values(users)
    .filter(u => u !== me && !me.friends.includes(u.username) && !me.requests.includes(u.username))
    .map(u => ({ username: u.username, avatar: u.avatar, admin: u.admin }));
  res.json({ friends: me.friends.map(f => users[f]), requests: me.requests, recent });
});

app.post("/friend-request", requireLogin, (req, res) => {
  const fromUser = req.session.user.username;
  const { to } = req.body;
  if (!users[to]) return res.json({ success: false, message: "User not found" });
  if (to === fromUser) return res.json({ success: false, message: "Cannot friend yourself" });
  if (users[to].requests.includes(fromUser) || users[to].friends.includes(fromUser)) {
    return res.json({ success: false, message: "Already requested or friends" });
  }

  users[to].requests.push(fromUser);
  saveJSON(USERS_FILE, users);
  res.json({ success: true });
});

app.post("/accept-request", requireLogin, (req, res) => {
  const me = req.session.user.username;
  const { from } = req.body;
  if (!users[from]) return res.json({ success: false, message: "User not found" });
  users[me].friends.push(from);
  users[from].friends.push(me);
  users[me].requests = users[me].requests.filter(r => r !== from);
  saveJSON(USERS_FILE, users);
  res.json({ success: true });
});

// Profile update
app.post("/update-profile", requireLogin, (req, res) => {
  const me = req.session.user.username;
  const { avatar, bio } = req.body;
  if (avatar) users[me].avatar = avatar;
  if (bio) users[me].bio = bio;
  saveJSON(USERS_FILE, users);
  res.json({ success: true });
});

// Rooms
app.get("/rooms", requireLogin, (req, res) => {
  const list = Object.keys(rooms).map(rn => ({
    name: rn,
    owner: rooms[rn].owner,
    users: rooms[rn].users,
  }));
  res.json({ rooms: list });
});

app.post("/create-room", requireLogin, (req, res) => {
  const { name } = req.body;
  if (!name || rooms[name]) return res.json({ success: false, message: "Room exists or invalid" });
  const owner = req.session.user.username;
  rooms[name] = { owner, users: [] };
  saveJSON(ROOMS_FILE, rooms);
  res.json({ success: true });
});

app.post("/join-room", requireLogin, (req, res) => {
  const { name } = req.body;
  if (!rooms[name]) return res.json({ success: false, message: "Room not found" });
  const user = req.session.user.username;
  if (!rooms[name].users.includes(user)) rooms[name].users.push(user);
  saveJSON(ROOMS_FILE, rooms);
  res.json({ success: true, users: rooms[name].users });
});

app.post("/leave-room", requireLogin, (req, res) => {
  const { name } = req.body;
  if (!rooms[name]) return res.json({ success: false });
  const user = req.session.user.username;
  rooms[name].users = rooms[name].users.filter(u => u !== user);
  saveJSON(ROOMS_FILE, rooms);
  res.json({ success: true });
});

app.post("/manage-room", requireLogin, (req, res) => {
  const { name, action, target } = req.body;
  if (!rooms[name]) return res.json({ success: false });
  const user = req.session.user.username;
  if (rooms[name].owner !== user) return res.json({ success: false, message: "Only owner" });

  if (action === "kick") {
    rooms[name].users = rooms[name].users.filter(u => u !== target);
  } else if (action === "delete") {
    delete rooms[name];
  }
  saveJSON(ROOMS_FILE, rooms);
  res.json({ success: true });
});

// Messages
app.post("/send-message", requireLogin, (req, res) => {
  const { to, room, text } = req.body;
  const from = req.session.user.username;
  const msg = {
    id: Date.now().toString(),
    from,
    fromAvatar: users[from].avatar,
    to: to || null,
    room: room || null,
    text,
    timestamp: Date.now(),
  };
  messages.push(msg);
  io.emit("message", msg);
  res.json({ success: true });
});

app.post("/delete-message", requireLogin, (req, res) => {
  const { id } = req.body;
  const msg = messages.find(m => m.id === id);
  if (!msg) return res.json({ success: false });
  const user = req.session.user.username;
  if (users[user].admin || msg.from === user) {
    messages = messages.filter(m => m.id !== id);
    io.emit("deleteMessage", { id });
    return res.json({ success: true });
  }
  res.json({ success: false, message: "Not allowed" });
});

// Admin
app.get("/admin/users", requireAdmin, (req, res) => res.json({ success: true, users }));

app.post("/admin/ban", requireAdmin, (req, res) => {
  const { username } = req.body;
  if (!users[username]) return res.json({ success: false, message: "Not found" });
  users[username].banned = true;
  saveJSON(USERS_FILE, users);
  res.json({ success: true });
});

// Socket.io
io.on("connection", (socket) => {
  socket.on("registerUser", (username) => {
    socket.username = username;
  });
});

server.listen(PORT, () => console.log("Server running on port " + PORT));
