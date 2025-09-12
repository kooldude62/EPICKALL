// server.js
import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import session from "express-session";
import bcrypt from "bcryptjs";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import { v4 as uuidv4 } from "uuid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- LowDB setup ---
const dbFile = path.join(__dirname, "db.json");
const adapter = new JSONFile(dbFile);
const defaultData = {
  users: [],
  friendRequests: [],
  rooms: {},
  messages: [],
  dms: {}
};
const db = new Low(adapter, defaultData); // supply defaults here
await db.read();
await db.write();

// --- middleware ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use(
  session({
    secret: "replace-with-a-secure-secret",
    resave: false,
    saveUninitialized: false
  })
);

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect("/login.html");
  next();
}

// --- Auth routes ---
app.post("/signup", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).send("Missing fields");

  await db.read();
  if (db.data.users.find(u => u.username.toLowerCase() === username.toLowerCase()))
    return res.status(400).send("User exists");

  const hash = await bcrypt.hash(password, 10);
  db.data.users.push({ username, password: hash, pfp: "/default.png", friends: [] });
  await db.write();

  req.session.user = username;
  res.json({ ok: true });
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).send("Missing fields");

  await db.read();
  const user = db.data.users.find(u => u.username === username);
  if (!user) return res.status(400).send("Invalid credentials");

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).send("Invalid credentials");

  req.session.user = username;
  res.json({ ok: true });
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/me", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Not logged in" });
  await db.read();
  const u = db.data.users.find(x => x.username === req.session.user);
  if (!u) return res.status(404).json({ error: "Not found" });
  res.json({ username: u.username, pfp: u.pfp, friends: u.friends || [] });
});

// --- Friends ---
app.get("/users", async (req, res) => {
  const q = (req.query.q || "").toLowerCase();
  await db.read();
  const list = db.data.users
    .filter(u => q.length === 0 || u.username.toLowerCase().includes(q))
    .map(u => ({ username: u.username, pfp: u.pfp }));
  res.json(list);
});

app.post("/friend/request", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Not logged in" });
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: "Missing 'to' field" });

  await db.read();
  const exists = db.data.friendRequests.find(
    fr => fr.from === req.session.user && fr.to === to
  );
  if (exists) return res.status(400).json({ error: "Already requested" });

  const toUser = db.data.users.find(u => u.username === to);
  const fromUser = db.data.users.find(u => u.username === req.session.user);
  if (!toUser) return res.status(404).json({ error: "User not found" });
  if ((fromUser.friends || []).includes(to))
    return res.status(400).json({ error: "Already friends" });

  db.data.friendRequests.push({ id: uuidv4(), from: req.session.user, to, ts: Date.now() });
  await db.write();
  res.json({ ok: true });
});

app.get("/friend/requests", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Not logged in" });
  await db.read();
  const incoming = db.data.friendRequests.filter(fr => fr.to === req.session.user);
  res.json(incoming);
});

app.post("/friend/respond", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Not logged in" });
  const { id, accept } = req.body;

  await db.read();
  const idx = db.data.friendRequests.findIndex(
    fr => fr.id === id && fr.to === req.session.user
  );
  if (idx === -1) return res.status(404).json({ error: "Request not found" });
  const fr = db.data.friendRequests[idx];

  if (accept) {
    const a = db.data.users.find(u => u.username === fr.from);
    const b = db.data.users.find(u => u.username === fr.to);
    a.friends = a.friends || [];
    b.friends = b.friends || [];
    if (!a.friends.includes(b.username)) a.friends.push(b.username);
    if (!b.friends.includes(a.username)) b.friends.push(a.username);
  }
  db.data.friendRequests.splice(idx, 1);
  await db.write();
  res.json({ ok: true });
});

// --- Friends list ---
app.get("/friends", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Not logged in" });
  await db.read();
  const me = db.data.users.find(u => u.username === req.session.user);
  const friends = (me.friends || []).map(fn => {
    const u = db.data.users.find(x => x.username === fn);
    return { username: fn, pfp: u?.pfp || "/default.png" };
  });
  res.json(friends);
});

// --- Rooms API ---
app.get("/rooms", async (req, res) => {
  await db.read();
  const list = Object.entries(db.data.rooms || {})
    .filter(([name, info]) => !info.inviteOnly)
    .map(([name, info]) => ({
      name,
      private: !!info.pass,
      creator: info.creator
    }));
  res.json(list);
});

app.post("/rooms/create", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Not logged in" });
  const { name, password, inviteOnly } = req.body;
  if (!name) return res.status(400).json({ error: "Missing name" });

  await db.read();
  if (db.data.rooms[name]) return res.status(400).json({ error: "Room exists" });

  const inviteId = uuidv4().slice(0, 8);
  db.data.rooms[name] = {
    creator: req.session.user,
    pass: password || null,
    inviteOnly: !!inviteOnly,
    inviteId,
    createdAt: Date.now()
  };
  db.data.messages = db.data.messages || [];
  await db.write();

  res.json({ ok: true, inviteId });
});

// room details
app.get("/rooms/:name", async (req, res) => {
  const { name } = req.params;
  await db.read();
  const room = db.data.rooms[name];
  if (!room) return res.status(404).json({ error: "Not found" });
  res.json({
    name,
    creator: room.creator,
    private: !!room.pass,
    inviteOnly: !!room.inviteOnly
  });
});

// invite link
app.get("/rooms/invite/:inviteId", async (req, res) => {
  await db.read();
  const entry = Object.entries(db.data.rooms).find(
    ([, v]) => v.inviteId === req.params.inviteId
  );
  if (!entry) return res.status(404).json({ error: "Invite not found" });
  const [name, info] = entry;
  res.json({ name, info });
});

// get messages
app.get("/rooms/:name/messages", async (req, res) => {
  const { name } = req.params;
  await db.read();
  const msgs = db.data.messages.filter(m => m.room === name);
  res.json(msgs);
});

// --- DMs ---
app.get("/dms", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Not logged in" });
  await db.read();
  const me = db.data.users.find(u => u.username === req.session.user);
  const friends = (me.friends || []).map(fn => {
    const u = db.data.users.find(x => x.username === fn);
    return { username: fn, pfp: u?.pfp || "/default.png" };
  });
  res.json(friends);
});

// --- Socket.IO ---
io.on("connection", socket => {
  socket.on("identify", username => {
    socket.data.username = username;
  });

  socket.on("joinRoomSocket", async ({ room, password }) => {
    await db.read();
    const info = db.data.rooms[room];
    if (!info) return socket.emit("errorMsg", "Room not found");
    if (info.pass && info.pass !== password)
      return socket.emit("errorMsg", "Wrong password");

    socket.join(`room:${room}`);
    const hist = db.data.messages.filter(m => m.room === room);
    socket.emit("roomHistory", { room, history: hist });
    io.to(`room:${room}`).emit("systemMsg", {
      room,
      text: `${socket.data.username || "Someone"} joined ${room}`
    });
  });

  socket.on("sendRoomMessage", async ({ room, text }) => {
    if (!room || !text) return;
    const username = socket.data.username || "Anonymous";
    const msg = { id: uuidv4(), room, user: username, text, time: Date.now() };

    await db.read();
    db.data.messages.push(msg);
    await db.write();

    io.to(`room:${room}`).emit("roomMessage", msg);
  });

  socket.on("startDM", async ({ withUser }) => {
    const by = socket.data.username;
    if (!by || !withUser) return;
    const pair = [by, withUser].sort().join("|");
    socket.join(`dm:${pair}`);

    await db.read();
    const dms = db.data.dms[pair] || [];
    socket.emit("dmHistory", { withUser, history: dms });
  });

  socket.on("sendDM", async ({ to, text }) => {
    const from = socket.data.username;
    if (!from || !to || !text) return;
    const pair = [from, to].sort().join("|");
    const dmMsg = { id: uuidv4(), pair, from, to, text, time: Date.now() };

    await db.read();
    db.data.dms[pair] ||= [];
    db.data.dms[pair].push(dmMsg);
    await db.write();

    io.to(`dm:${pair}`).emit("dmMessage", dmMsg);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
