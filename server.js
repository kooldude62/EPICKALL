import express from "express";
import session from "express-session";
import bcrypt from "bcryptjs";
import http from "http";
import { Server } from "socket.io";
import fs from "fs";
import path from "path";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Sessions
app.use(session({
  secret: "secret-key",
  resave: false,
  saveUninitialized: true,
}));

// Serve static files
app.use(express.static("public"));

// Storage folder
const STORAGE_DIR = path.join(process.cwd(), "storage");
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR);

const usersFile = path.join(STORAGE_DIR, "users.json");
const roomsFile = path.join(STORAGE_DIR, "rooms.json");

if (!fs.existsSync(usersFile)) fs.writeFileSync(usersFile, JSON.stringify({}));
if (!fs.existsSync(roomsFile)) fs.writeFileSync(roomsFile, JSON.stringify({}));

const readJSON = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJSON = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

// ----- Routes -----

// Login page redirect if logged in
app.get("/", (req, res) => {
  if (!req.session.user) return res.redirect("/login.html");
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

// Signup
app.post("/signup", async (req, res) => {
  const { username, password } = req.body;
  const users = readJSON(usersFile);
  if (users[username]) return res.status(400).send("User exists");

  const hash = await bcrypt.hash(password, 10);
  users[username] = { password: hash };
  writeJSON(usersFile, users);
  req.session.user = username;
  res.send({ ok: true });
});

// Login
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const users = readJSON(usersFile);
  if (!users[username]) return res.status(400).send("Invalid credentials");

  const match = await bcrypt.compare(password, users[username].password);
  if (!match) return res.status(400).send("Invalid credentials");

  req.session.user = username;
  res.send({ ok: true });
});

// Logout
app.post("/logout", (req, res) => {
  req.session.destroy(() => res.send({ ok: true }));
});

// Create Room
app.post("/create-room", (req, res) => {
  if (!req.session.user) return res.status(401).send("Not logged in");

  const { roomName, roomPassword } = req.body;
  const rooms = readJSON(roomsFile);

  if (rooms[roomName]) return res.status(400).send("Room already exists");

  rooms[roomName] = { password: roomPassword || "", messages: [] };
  writeJSON(roomsFile, rooms);
  res.send({ ok: true });
});

// Get rooms
app.get("/rooms", (req, res) => {
  if (!req.session.user) return res.status(401).send("Not logged in");
  const rooms = readJSON(roomsFile);
  res.send(rooms);
});

// ----- Socket.io -----

io.on("connection", (socket) => {

  socket.on("join-room", ({ roomName, roomPassword }) => {
    const rooms = readJSON(roomsFile);
    if (!rooms[roomName]) return socket.emit("error", "Room does not exist");
    if (rooms[roomName].password && rooms[roomName].password !== roomPassword)
      return socket.emit("error", "Incorrect room password");

    socket.join(roomName);
    // send chat history
    socket.emit("history", rooms[roomName].messages);
  });

  socket.on("message", ({ roomName, user, text }) => {
    const rooms = readJSON(roomsFile);
    if (!rooms[roomName]) return;
    const message = { user, text, time: Date.now() };
    rooms[roomName].messages.push(message);
    writeJSON(roomsFile, rooms);
    io.to(roomName).emit("message", message);
  });

});

server.listen(3000, () => console.log("Server running on port 3000"));
