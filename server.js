const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory data store
const users = {}; // { username: { password, pfp } }
const rooms = {}; // { roomName: { password, messages: [{user, text}] } }

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use(
  session({
    secret: "super-secret-key",
    resave: false,
    saveUninitialized: false
  })
);

// Check if logged in
function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect("/login.html");
  next();
}

// Routes
app.get("/", requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.post("/signup", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).send("Missing fields");
  if (users[username]) return res.status(400).send("User exists");

  users[username] = { password, pfp: null };
  req.session.user = username;
  res.redirect("/");
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).send("Missing fields");
  if (!users[username] || users[username].password !== password)
    return res.status(400).send("Invalid credentials");

  req.session.user = username;
  res.redirect("/");
});

app.post("/logout", requireLogin, (req, res) => {
  req.session.destroy();
  res.redirect("/login.html");
});

app.post("/create-room", requireLogin, (req, res) => {
  const { roomName, roomPassword } = req.body;
  if (!roomName || !roomPassword) return res.status(400).send("Missing fields");
  if (rooms[roomName]) return res.status(400).send("Room exists");

  rooms[roomName] = { password: roomPassword, messages: [] };
  res.redirect("/");
});

app.post("/send-message", requireLogin, (req, res) => {
  const { roomName, message } = req.body;
  if (!roomName || !message) return res.status(400).send("Missing fields");
  if (!rooms[roomName]) return res.status(400).send("Room does not exist");

  rooms[roomName].messages.push({ user: req.session.user, text: message });
  res.redirect("/");
});

app.get("/room-messages/:roomName", requireLogin, (req, res) => {
  const room = rooms[req.params.roomName];
  if (!room) return res.status(404).send("Room not found");
  res.json(room.messages);
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
