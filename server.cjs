const express = require("express");
const app = express();
const http = require("http");
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const session = require("express-session");
const bodyParser = require("body-parser");
const path = require("path");

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

// In-memory storage
let users = {};      // username -> { password, friends: [], requests: [], banned, admin, avatar, createdAt }
let rooms = {};      // roomName -> { users: [], owner, avatar }
let messages = [];   // { id, from, to, room, text, timestamp }

// Middleware
function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ success: false });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user || !req.session.user.admin) return res.status(403).json({ success: false, message: "Admin only" });
  next();
}

// Auth routes
app.post("/signup", (req, res) => {
  const { username, password } = req.body;
  if (users[username]) return res.json({ success: false, message: "User exists" });

  users[username] = {
    password,
    friends: [],
    requests: [],
    banned: false,
    admin: ADMIN_USERS.includes(username),
    avatar: '/avatars/default.png',
    createdAt: Date.now(),
  };

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
  const user = users[req.session.user.username];
  res.json({
    loggedIn: true,
    username: req.session.user.username,
    admin: req.session.user.admin,
    banned: user.banned,
    avatar: user.avatar
  });
});

// Set avatar
app.post("/set-avatar", requireLogin, (req, res) => {
  const { avatar } = req.body;
  const me = users[req.session.user.username];
  me.avatar = avatar || '/avatars/default.png';
  res.json({ success: true, avatar: me.avatar });
});

// Friends
app.get("/friends", requireLogin, (req, res) => {
  const me = users[req.session.user.username];

  const recent = Object.entries(users)
    .filter(([uname]) => uname !== me.username && !me.friends.includes(uname))
    .sort((a, b) => b[1].createdAt - a[1].createdAt)
    .slice(0, 5)
    .map(([uname, u]) => ({ username: uname, admin: u.admin, avatar: u.avatar }));

  const friendsList = me.friends.map(f => {
    const u = users[f];
    return { username: f, admin: u.admin, avatar: u.avatar };
  });

  res.json({ recent, friends: friendsList, requests: me.requests });
});

app.post("/friend-request", requireLogin, (req, res) => {
  const { to } = req.body;
  const me = users[req.session.user.username];
  if (!users[to]) return res.json({ success: false, message: "User not found" });
  if (me.friends.includes(to)) return res.json({ success: false, message: "Already friends" });
  if (users[to].requests.includes(me.username)) return res.json({ success: false, message: "Request already sent" });

  users[to].requests.push(me.username);
  res.json({ success: true });
});

app.post("/accept-request", requireLogin, (req, res) => {
  const { from } = req.body;
  const me = users[req.session.user.username];
  if (!me.requests.includes(from)) return res.json({ success: false, message: "Request not found" });

  me.requests = me.requests.filter(r => r !== from);
  if (!me.friends.includes(from)) me.friends.push(from);
  if (!users[from].friends.includes(me.username)) users[from].friends.push(me.username);

  res.json({ success: true });
});

// Messages
app.post("/send-message", requireLogin, (req, res) => {
  const { to, room, message } = req.body;
  const from = req.session.user.username;
  const msg = { id: Date.now().toString(), from, to: to || null, room: room || null, text: message, timestamp: Date.now() };
  messages.push(msg);
  io.emit("message", msg);
  res.json({ success: true });
});

// Rooms
app.post("/create-room", requireLogin, (req, res) => {
  const { name } = req.body;
  const owner = req.session.user.username;
  if (!name || !name.trim()) return res.json({ success: false, message: "Room name required" });
  if (rooms[name]) return res.json({ success: false, message: "Room already exists" });

  rooms[name] = { users: [], owner, avatar: '/avatars/default.png' };
  io.emit("roomCreated", { name, avatar: '/avatars/default.png', owner });
  res.json({ success: true, room: rooms[name] });
});

app.get("/rooms", requireLogin, (req, res) => {
  const currentUser = req.session.user.username;
  const allRooms = Object.entries(rooms).map(([name, data]) => ({
    name,
    avatar: data.avatar,
    owner: data.owner,
    isOwner: data.owner === currentUser
  }));
  res.json({ rooms: allRooms });
});

app.post("/join-room", requireLogin, (req, res) => {
  const { name } = req.body;
  const user = req.session.user.username;
  const room = rooms[name];
  if (!room) return res.json({ success: false, message: "Room not found" });
  if (!room.users.includes(user)) room.users.push(user);
  res.json({ success: true, room });
});

// Admin
app.get("/admin/users", requireAdmin, (req, res) => res.json({ success: true, users }));
app.post("/admin/ban", requireAdmin, (req, res) => {
  const { username } = req.body;
  if (!users[username]) return res.json({ success: false, message: "Not found" });
  users[username].banned = true;
  res.json({ success: true });
});
app.post("/admin/delete-message", requireAdmin, (req, res) => {
  const { id } = req.body;
  messages = messages.filter(m => m.id !== id);
  io.emit("deleteMessage", { id });
  res.json({ success: true });
});

// Socket.io
io.on("connection", (socket) => {
  socket.on("registerUser", (username) => {
    socket.username = username;
  });
});

server.listen(PORT, () => console.log("Server running on port " + PORT));
