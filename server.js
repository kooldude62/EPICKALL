import express from "express";
import session from "express-session";
import multer from "multer";
import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import { Server } from "socket.io";
import http from "http";
import { v4 as uuidv4 } from "uuid";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Ensure public/avatars exists
fs.mkdirSync(path.join("public", "avatars"), { recursive: true });

// Middleware
app.use(express.static("public"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: "supersecretkey",
  resave: false,
  saveUninitialized: false
}));

// Database file
const DB_FILE = "./db.json";
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], rooms: {}, messages: {} }, null, 2));
function readDB() { return JSON.parse(fs.readFileSync(DB_FILE, "utf-8")); }
function writeDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }

// Multer for avatar upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join("public/avatars")),
  filename: (req, file, cb) => cb(null, `${req.session.user}_${Date.now()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage });

// --- Routes ---

// Signup
app.post("/signup", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).send("Missing fields");

  const db = readDB();
  if (db.users.find(u => u.username === username)) return res.status(400).send("Username exists");

  const hash = await bcrypt.hash(password, 10);
  db.users.push({ username, password: hash, avatar: "/avatars/default.png" });
  writeDB(db);

  req.session.user = username;
  res.send({ success: true });
});

// Login
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const db = readDB();
  const user = db.users.find(u => u.username === username);
  if (!user) return res.status(400).send("Invalid credentials");

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(400).send("Invalid credentials");

  req.session.user = username;
  res.send({ success: true });
});

// Logout
app.post("/logout", (req, res) => {
  req.session.destroy(() => {});
  res.send({ success: true });
});

// Account info
app.get("/account", (req, res) => {
  const db = readDB();
  const user = db.users.find(u => u.username === req.session.user);
  if (!user) return res.status(403).send("Not logged in");
  res.send({ username: user.username, avatar: user.avatar });
});

// Update avatar
app.post("/avatar", upload.single("avatar"), (req, res) => {
  const db = readDB();
  const user = db.users.find(u => u.username === req.session.user);
  if (!user) return res.status(403).send("Not logged in");

  user.avatar = "/avatars/" + req.file.filename;
  writeDB(db);
  res.send({ success: true, avatar: user.avatar });
});

// Rooms
app.get("/rooms", (req, res) => {
  if (!req.session.user) return res.status(401).send("Not logged in");
  const db = readDB();
  res.send(Object.keys(db.rooms));
});

app.post("/rooms", (req, res) => {
  if (!req.session.user) return res.status(401).send("Not logged in");
  const { room } = req.body;
  if (!room) return res.status(400).send("Room name required");

  const db = readDB();
  if (!db.rooms[room]) {
    db.rooms[room] = { creator: req.session.user };
    db.messages[room] = [];
    writeDB(db);
  }

  res.send({ success: true });
});

// --- Socket.io ---
io.on("connection", socket => {
  let currentRoom = null;
  let username = null;

  socket.on("joinRoom", ({ room, user }) => {
    username = user;
    currentRoom = room;
    socket.join(room);

    const db = readDB();
    if (!db.messages[room]) db.messages[room] = [];
    socket.emit("history", db.messages[room]);
  });

  socket.on("message", msg => {
    if (!currentRoom) return;
    const db = readDB();
    const message = { id: uuidv4(), user: username, text: msg, timestamp: Date.now() };
    db.messages[currentRoom].push(message);
    writeDB(db);
    io.to(currentRoom).emit("message", message);
  });

  socket.on("deleteMessage", msgId => {
    if (!currentRoom) return;
    const db = readDB();
    const message = db.messages[currentRoom].find(m => m.id === msgId);
    const roomCreator = db.rooms[currentRoom].creator;
    if (!message) return;

    if (message.user === username || roomCreator === username) {
      db.messages[currentRoom] = db.messages[currentRoom].filter(m => m.id !== msgId);
      writeDB(db);
      io.to(currentRoom).emit("deleteMessage", msgId);
    }
  });
});

// --- Start server ---
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
