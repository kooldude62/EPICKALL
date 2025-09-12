import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import bcrypt from "bcrypt";
import bodyParser from "body-parser";
import session from "express-session";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const http = createServer(app);
const io = new Server(http);

// --- Data ---
const users = {}; // username -> { passwordHash, friends, requests, avatar }
const rooms = {}; // roomId -> { name, password, inviteOnly, messages }
const dms = {};   // "userA_userB" -> [{sender,message,time}]
const adminIPs = ["127.0.0.1"]; // add trusted admin IPs here

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: "supersecret",
  resave: false,
  saveUninitialized: false
}));
app.use(express.static(path.join(__dirname, "public")));

// --- Middleware ---
function checkAuth(req, res, next) {
  if (!req.session.user) return res.redirect("/login.html");
  next();
}

function checkAdmin(req, res, next) {
  if (!adminIPs.includes(req.ip)) return res.status(403).send("Forbidden");
  next();
}

// --- Auth ---
app.post("/signup", async (req, res) => {
  const { username, password } = req.body;
  if (users[username]) return res.json({ success: false, message: "User exists" });

  const passwordHash = await bcrypt.hash(password, 10);
  users[username] = { passwordHash, friends: [], requests: [], avatar: `/avatars/${Math.floor(Math.random()*5)+1}.png` };
  req.session.user = username;
  res.json({ success: true });
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!users[username]) return res.json({ success: false, message: "Invalid credentials" });

  const valid = await bcrypt.compare(password, users[username].passwordHash);
  if (!valid) return res.json({ success: false, message: "Invalid credentials" });

  req.session.user = username;
  res.json({ success: true });
});

app.post("/logout", (req, res) => {
  req.session.destroy(err => {
    if (err) return res.json({ success: false });
    res.json({ success: true });
  });
});

app.get("/me", (req, res) => {
  if (!req.session.user) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, username: req.session.user, avatar: users[req.session.user].avatar });
});

// --- Friends ---
app.post("/friend-request", (req, res) => {
  const from = req.session.user;
  const to = req.body.to;
  if (!from || !users[to]) return res.json({ success: false });
  if (from === to) return res.json({ success: false, message: "You can’t friend yourself!" });

  if (!users[to].requests.includes(from) && !users[to].friends.includes(from)) {
    users[to].requests.push(from);
  }
  res.json({ success: true });
});

app.get("/friends", (req, res) => {
  const user = req.session.user;
  res.json({ friends: users[user]?.friends || [], requests: users[user]?.requests || [] });
});

app.post("/accept-request", (req, res) => {
  const user = req.session.user;
  const from = req.body.from;

  if (users[user] && users[from]) {
    users[user].friends.push(from);
    users[from].friends.push(user);
    users[user].requests = users[user].requests.filter(r => r !== from);
  }
  res.json({ success: true });
});

// --- Rooms ---
app.post("/create-room", (req, res) => {
  const { name, password, inviteOnly } = req.body;

  // Check for duplicate room name
  for (const r of Object.values(rooms)) {
    if (r.name === name) return res.json({ success: false, message: "Room name already exists" });
  }

  const id = Math.random().toString(36).substring(2, 9);
  rooms[id] = { name, password: password || null, inviteOnly: !!inviteOnly, messages: [] };
  res.json({ success: true, roomId: id, inviteLink: `${req.protocol}://${req.get("host")}/room/${id}` });
});

app.get("/rooms", (req, res) => {
  const visibleRooms = {};
  Object.entries(rooms).forEach(([id, r]) => {
    if (!r.inviteOnly) visibleRooms[id] = { name: r.name };
  });
  res.json(visibleRooms);
});

// --- DM ---
app.get("/dm/:friend", (req, res) => {
  const user = req.session.user;
  const friend = req.params.friend;
  if (!users[friend] || !users[user].friends.includes(friend)) return res.json({ success: false });

  const key = [user, friend].sort().join("_");
  res.json({ success: true, messages: dms[key] || [] });
});

// --- Admin panel ---
app.get("/admin", checkAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "public/admin.html"));
});

// --- Room page ---
app.get("/room/:roomId", checkAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public/room.html"));
});

// --- Socket.io ---
io.on("connection", (socket) => {
  socket.on("registerUser", (username) => socket.join(username));

  socket.on("joinRoom", ({ roomId, username }) => {
    socket.join(roomId);
    if (rooms[roomId]) socket.emit("chatHistory", rooms[roomId].messages);
  });

  socket.on("roomMessage", ({ roomId, username, message }) => {
    if (rooms[roomId]) {
      const msg = { username, message, time: new Date() };
      rooms[roomId].messages.push(msg);
      io.to(roomId).emit("roomMessage", msg);
    }
  });

  socket.on("dmMessage", ({ to, from, message }) => {
    if (!users[to] || !users[from]) return;
    if (!users[to].friends.includes(from)) return;
    const key = [to, from].sort().join("_");
    if (!dms[key]) dms[key] = [];
    const msg = { sender: from, message, time: new Date() };
    dms[key].push(msg);
    io.to(to).emit("dmMessage", msg);
    io.to(from).emit("dmMessage", msg);
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
