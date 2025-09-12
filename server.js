const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// -------------------- Setup --------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public")); // serve HTML, CSS, JS
app.use(
  session({
    secret: "supersecretkey",
    resave: false,
    saveUninitialized: true,
  })
);

// Multer setup for profile picture uploads
const upload = multer({ dest: "uploads/" });

// -------------------- Helper Functions --------------------
const usersFile = path.join(__dirname, "data/users.json");
const roomsFile = path.join(__dirname, "data/rooms.json");

// Load users or create empty array
function loadUsers() {
  if (!fs.existsSync(usersFile)) return [];
  return JSON.parse(fs.readFileSync(usersFile));
}

// Save users
function saveUsers(users) {
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
}

// Load rooms or create empty array
function loadRooms() {
  if (!fs.existsSync(roomsFile)) return [];
  return JSON.parse(fs.readFileSync(roomsFile));
}

// Save rooms
function saveRooms(rooms) {
  fs.writeFileSync(roomsFile, JSON.stringify(rooms, null, 2));
}

// -------------------- Routes --------------------

// Signup
app.post("/signup", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).send("Missing fields");

  const users = loadUsers();
  if (users.find((u) => u.username === username))
    return res.status(400).send("User exists");

  const hash = await bcrypt.hash(password, 10);
  users.push({ username, password: hash, pfp: "" });
  saveUsers(users);
  req.session.username = username;
  res.redirect("/index.html");
});

// Login
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const users = loadUsers();
  const user = users.find((u) => u.username === username);
  if (!user) return res.status(400).send("Invalid credentials");

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(400).send("Invalid credentials");

  req.session.username = username;
  res.redirect("/index.html");
});

// Logout
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login.html");
  });
});

// Upload profile picture
app.post("/upload-pfp", upload.single("pfp"), (req, res) => {
  if (!req.session.username) return res.status(401).send("Not logged in");
  const users = loadUsers();
  const user = users.find((u) => u.username === req.session.username);
  if (!user) return res.status(400).send("User not found");

  user.pfp = req.file.filename;
  saveUsers(users);
  res.redirect("/account.html");
});

// Get current user info
app.get("/me", (req, res) => {
  if (!req.session.username) return res.status(401).send("Not logged in");
  const users = loadUsers();
  const user = users.find((u) => u.username === req.session.username);
  res.json(user);
});

// Rooms
app.get("/rooms", (req, res) => {
  res.json(loadRooms());
});

// Create room
app.post("/rooms", (req, res) => {
  if (!req.session.username) return res.status(401).send("Not logged in");
  const { name, password } = req.body;
  if (!name || !password) return res.status(400).send("Missing fields");

  const rooms = loadRooms();
  if (rooms.find((r) => r.name === name)) return res.status(400).send("Room exists");

  rooms.push({ name, password, messages: [] });
  saveRooms(rooms);
  res.json({ success: true });
});

// Send message
app.post("/rooms/:roomName/message", (req, res) => {
  if (!req.session.username) return res.status(401).send("Not logged in");
  const { roomName } = req.params;
  const { message } = req.body;

  const rooms = loadRooms();
  const room = rooms.find((r) => r.name === roomName);
  if (!room) return res.status(404).send("Room not found");

  room.messages.push({ user: req.session.username, message, time: Date.now() });
  saveRooms(rooms);
  res.json({ success: true });
});

// Get messages
app.get("/rooms/:roomName/messages", (req, res) => {
  const { roomName } = req.params;
  const rooms = loadRooms();
  const room = rooms.find((r) => r.name === roomName);
  if (!room) return res.status(404).send("Room not found");

  res.json(room.messages);
});

// -------------------- Middleware: Redirect if not logged in --------------------
app.use((req, res, next) => {
  const publicPages = ["/login.html", "/signup.html"];
  if (!req.session.username && !publicPages.includes(req.path)) {
    return res.redirect("/login.html");
  }
  next();
});

// -------------------- Start Server --------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
