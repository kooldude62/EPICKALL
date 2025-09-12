// server.js
import express from "express";
import session from "express-session";
import bcrypt from "bcryptjs";
import { Server } from "socket.io";
import http from "http";
import path from "path";
import multer from "multer";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import { fileURLToPath } from "url";

// __dirname fix for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// === Database setup ===
const adapter = new JSONFile(path.join(__dirname, "db.json"));
const db = new Low(adapter, { users: [], messages: [] });

await db.read();
db.data ||= { users: [], messages: [] };
await db.write();

// === Middleware ===
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use(
  session({
    secret: "supersecret",
    resave: false,
    saveUninitialized: true,
  })
);

// Multer for profile picture uploads
const upload = multer({ dest: path.join(__dirname, "public/uploads/") });

// === Helper functions ===
async function getUser(username) {
  await db.read();
  return db.data.users.find((u) => u.username === username);
}

async function saveUser(user) {
  await db.read();
  db.data.users.push(user);
  await db.write();
}

// === Routes ===

// Signup
app.post("/signup", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).send("Missing fields");

  const existing = await getUser(username);
  if (existing) return res.status(400).send("Username already exists");

  const hashed = await bcrypt.hash(password, 10);
  await saveUser({ username, password: hashed, pfp: "/default.png" });

  req.session.user = username;
  res.send("OK");
});

// Login
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).send("Missing fields");

  const user = await getUser(username);
  if (!user) return res.status(400).send("Invalid credentials");

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(400).send("Invalid credentials");

  req.session.user = username;
  res.send("OK");
});

// Logout
app.post("/logout", (req, res) => {
  req.session.destroy(() => {});
  res.send("OK");
});

// Get account info
app.get("/account", async (req, res) => {
  if (!req.session.user) return res.status(401).send("Not logged in");

  const user = await getUser(req.session.user);
  if (!user) return res.status(404).send("User not found");

  res.json({ username: user.username, pfp: user.pfp });
});

// Update profile picture
app.post("/update-pfp", upload.single("pfp"), async (req, res) => {
  if (!req.session.user) return res.status(401).send("Not logged in");

  await db.read();
  const user = db.data.users.find((u) => u.username === req.session.user);
  if (!user) return res.status(404).send("User not found");

  if (req.file) user.pfp = "/uploads/" + req.file.filename;
  await db.write();

  res.send("OK");
});

// === Chat with Socket.IO ===
io.on("connection", (socket) => {
  console.log("New client connected");

  socket.on("chat message", async (msg) => {
    // msg = { username, text }
    if (!msg || !msg.username || !msg.text) return;

    const user = await getUser(msg.username);
    if (!user) return;

    const chatMsg = {
      username: user.username,
      text: msg.text,
      pfp: user.pfp,
      time: new Date().toISOString(),
    };

    await db.read();
    db.data.messages.push(chatMsg);
    await db.write();

    io.emit("chat message", chatMsg);
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected");
  });
});

// === Start server ===
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
