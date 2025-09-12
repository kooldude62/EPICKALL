const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

// --- Middleware ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  secret: "super-secret-key",
  resave: false,
  saveUninitialized: false,
}));
app.use(express.static(path.join(__dirname, "public")));

// --- Multer Setup (for avatars) ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "public/uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});
const upload = multer({ storage });

// --- Database File ---
const USERS_FILE = "./users.json";
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([]));

// --- Helpers ---
const loadUsers = () => JSON.parse(fs.readFileSync(USERS_FILE));
const saveUsers = (users) => fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));

// --- Routes ---
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "public/login.html")));
app.get("/signup", (req, res) => res.sendFile(path.join(__dirname, "public/signup.html")));
app.get("/settings", (req, res) => res.sendFile(path.join(__dirname, "public/settings.html")));

// Signup
app.post("/signup", upload.single("avatar"), (req, res) => {
  const { username, password } = req.body;
  const users = loadUsers();

  if (users.find(u => u.username === username)) {
    return res.status(400).json({ error: "Username already exists" });
  }

  const hashedPassword = bcrypt.hashSync(password, 10);
  const newUser = {
    id: uuidv4(),
    username,
    password: hashedPassword,
    avatar: req.file ? `/uploads/${req.file.filename}` : "/default-avatar.png"
  };

  users.push(newUser);
  saveUsers(users);

  req.session.user = newUser;
  res.json({ success: true });
});

// Login
app.post("/login", (req, res) => {
  const { username, password } = req.body;
  const users = loadUsers();

  const user = users.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(400).json({ error: "Invalid credentials" });
  }

  req.session.user = user;
  res.json({ success: true });
});

// Account update
app.post("/update-account", upload.single("avatar"), (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Not logged in" });

  const users = loadUsers();
  const user = users.find(u => u.id === req.session.user.id);

  if (req.body.password) {
    user.password = bcrypt.hashSync(req.body.password, 10);
  }
  if (req.file) {
    user.avatar = `/uploads/${req.file.filename}`;
  }

  saveUsers(users);
  req.session.user = user;
  res.json({ success: true });
});

// --- Socket.IO ---
let rooms = {};

io.on("connection", (socket) => {
  socket.on("joinRoom", ({ roomId, username }) => {
    socket.join(roomId);
    socket.username = username;
    socket.roomId = roomId;

    socket.to(roomId).emit("chatMessage", {
      user: "System",
      text: `${username} joined the room.`,
      avatar: "/default-avatar.png"
    });
  });

  socket.on("chatMessage", (msg) => {
    if (!socket.roomId) return;
    io.to(socket.roomId).emit("chatMessage", {
      user: socket.username,
      text: msg,
      avatar: "/default-avatar.png"
    });
  });

  socket.on("disconnect", () => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit("chatMessage", {
        user: "System",
        text: `${socket.username} left the room.`,
        avatar: "/default-avatar.png"
      });
    }
  });
});

// --- Start Server ---
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
