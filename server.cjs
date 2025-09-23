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

let users = {};      // username -> { password, friends, banned, admin }
let rooms = {};      // roomName -> { users: [] }
let messages = [];   // { id, from, to, room, text, timestamp }

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
  const { username, password } = req.body;
  if (users[username]) return res.json({ success: false, message: "User exists" });

  users[username] = {
    password,
    friends: [],
    banned: false,
    admin: ADMIN_USERS.includes(username),
  };

  req.session.user = { username, admin: users[username].admin };
  res.json({ success: true });
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  const user = users[username];
  if (!user || user.password !== password) {
    return res.json({ success: false, message: "Invalid credentials" });
  }
  if (user.banned) return res.json({ success: false, message: "Banned" });

  req.session.user = { username, admin: user.admin };
  res.json({ success: true });
});

app.get("/me", (req, res) => {
  if (!req.session.user) return res.json({ loggedIn: false });
  res.json({
    loggedIn: true,
    username: req.session.user.username,
    admin: req.session.user.admin,
  });
});

// Messages
app.post("/message", requireLogin, (req, res) => {
  const { to, room, text } = req.body;
  const from = req.session.user.username;
  const msg = {
    id: Date.now().toString(),
    from,
    to: to || null,
    room: room || null,
    text,
    timestamp: Date.now(),
  };
  messages.push(msg);
  io.emit("message", msg);
  res.json({ success: true });
});

// Admin routes
app.get("/admin/users", requireAdmin, (req, res) => {
  res.json({ success: true, users });
});
app.post("/admin/ban", requireAdmin, (req, res) => {
  const { username } = req.body;
  if (!users[username]) return res.json({ success: false, message: "Not found" });
  users[username].banned = true;
  res.json({ success: true });
});
app.post("/admin/delete-message", requireAdmin, (req, res) => {
  const { id } = req.body;
  messages = messages.filter((m) => m.id !== id);
  io.emit("deleteMessage", { id });
  res.json({ success: true });
});

io.on("connection", (socket) => {
  socket.on("registerUser", (username) => {
    socket.username = username;
  });
});

server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
