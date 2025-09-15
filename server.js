import express from "express";
import session from "express-session";
import bodyParser from "body-parser";
import bcrypt from "bcrypt";
import { Server } from "socket.io";
import { createServer } from "http";
import multer from "multer";
import path from "path";
import fs from "fs";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3000;

// In-memory store (use MongoDB/SQLite for persistence in production)
let users = {};
let rooms = {};
let dms = {}; // { userA_userB: [messages] }

// Recent users
let recentUsers = [];

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(
  session({
    secret: "supersecret",
    resave: false,
    saveUninitialized: false,
  })
);
app.use(express.static("public"));

// Multer setup for avatars
const upload = multer({ dest: "public/avatars/" });

// Routes
app.post("/signup", async (req, res) => {
  const { username, password } = req.body;
  if (users[username]) return res.json({ success: false, message: "User exists" });

  const hashed = await bcrypt.hash(password, 10);
  users[username] = { username, password: hashed, avatar: "/default.png", friends: [], themes: [], starredRooms: [] };
  req.session.user = users[username];

  recentUsers.unshift(username);
  if (recentUsers.length > 10) recentUsers.pop();

  res.json({ success: true });
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const user = users[username];
  if (!user) return res.json({ success: false, message: "Invalid credentials" });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.json({ success: false, message: "Invalid credentials" });

  req.session.user = user;
  res.json({ success: true });
});

app.get("/me", (req, res) => {
  if (!req.session.user) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, ...req.session.user });
});

app.post("/update-avatar", upload.single("avatar"), (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, message: "Not logged in" });
  if (!req.file) return res.status(400).json({ success: false, message: "No avatar provided" });

  const ext = path.extname(req.file.originalname);
  const newPath = `public/avatars/${req.session.user.username}${ext}`;
  fs.renameSync(req.file.path, newPath);

  req.session.user.avatar = `/avatars/${req.session.user.username}${ext}`;
  users[req.session.user.username].avatar = req.session.user.avatar;

  res.json({ success: true, avatar: req.session.user.avatar });
});

// Recently joined
app.get("/recent-users", (req, res) => {
  res.json(recentUsers.map(u => ({ username: u, avatar: users[u]?.avatar || "/default.png" })));
});

// Socket.io
io.on("connection", (socket) => {
  let currentUser;

  socket.on("login", (username) => {
    currentUser = username;
    socket.join(username);
  });

  // Rooms
  socket.on("createRoom", (roomName) => {
    if (!rooms[roomName]) rooms[roomName] = [];
    io.emit("roomsUpdated", Object.keys(rooms));
  });

  socket.on("joinRoom", (roomName) => {
    socket.join(roomName);
    socket.emit("roomMessages", rooms[roomName] || []);
  });

  socket.on("roomMessage", ({ roomName, text }) => {
    if (!text || text.length > 300) return;
    const msg = { from: currentUser, text, avatar: users[currentUser].avatar, time: Date.now() };
    rooms[roomName].push(msg);
    io.to(roomName).emit("roomMessage", msg);
  });

  // DMs
  socket.on("dm", ({ to, text }) => {
    if (!text || text.length > 300) return;
    const key = [currentUser, to].sort().join("_");
    if (!dms[key]) dms[key] = [];
    const msg = { from: currentUser, to, text, avatar: users[currentUser].avatar, time: Date.now() };
    dms[key].push(msg);
    io.to(to).to(currentUser).emit("dm", msg);
  });

  // Friend request
  socket.on("addFriend", (friend) => {
    if (!users[currentUser] || !users[friend]) return;
    let list = users[currentUser].friends;
    if (!list.includes(friend)) list.push(friend);
    users[currentUser].friends = [...new Set(list)];
    socket.emit("friendsUpdated", users[currentUser].friends.map(f => ({ username: f, avatar: users[f].avatar })));
  });

  socket.on("getFriends", () => {
    if (!users[currentUser]) return;
    socket.emit("friendsUpdated", users[currentUser].friends.map(f => ({ username: f, avatar: users[f].avatar })));
  });
});

httpServer.listen(PORT, () => console.log("Server running on " + PORT));
