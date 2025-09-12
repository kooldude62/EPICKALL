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

// Multer for profile pictures
const upload = multer({ dest: path.join(__dirname, "public/uploads/") });

// === Helpers ===
async function getUser(username) {
  await db.read();
  return db.data.users.find((u) => u.username === username);
}

// === Auth ===
app.post("/signup", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.json({ success: false, error: "Missing fields" });

  if (await getUser(username))
    return res.json({ success: false, error: "Username already exists" });

  const hashed = await bcrypt.hash(password, 10);
  db.data.users.push({ username, password: hashed, pfp: "/default.png" });
  await db.write();

  req.session.user = username;
  res.json({ success: true });
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.json({ success: false, error: "Missing fields" });

  const user = await getUser(username);
  if (!user) return res.json({ success: false, error: "Invalid credentials" });

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.json({ success: false, error: "Invalid credentials" });

  req.session.user = username;
  res.json({ success: true });
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {});
  res.json({ success: true });
});

app.get("/account", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Not logged in" });
  const user = await getUser(req.session.user);
  res.json({ username: user.username, pfp: user.pfp });
});

app.post("/update-pfp", upload.single("pfp"), async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Not logged in" });

  const user = await getUser(req.session.user);
  if (!user) return res.status(404).json({ error: "User not found" });

  if (req.file) user.pfp = "/uploads/" + req.file.filename;
  await db.write();

  res.json({ success: true, pfp: user.pfp });
});

// === Chat ===
io.on("connection", (socket) => {
  socket.on("chat message", async (msg) => {
    if (!msg || !msg.username || !msg.text) return;

    const user = await getUser(msg.username);
    if (!user) return;

    const chatMsg = {
      username: user.username,
      text: msg.text,
      pfp: user.pfp,
      time: new Date().toLocaleTimeString(),
    };

    db.data.messages.push(chatMsg);
    await db.write();

    io.emit("chat message", chatMsg);
  });
});

// === Start ===
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
