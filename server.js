import express from "express";
import session from "express-session";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import { Server } from "socket.io";
import http from "http";
import { v4 as uuidv4 } from "uuid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session
app.use(session({
    secret: "supersecretkey",
    resave: false,
    saveUninitialized: false
}));

// Database setup
const file = path.join(__dirname, "db.json");
const adapter = new JSONFile(file);
const db = new Low(adapter);

await db.read();
db.data = db.data || { users: [], rooms: {}, messages: {} };
await db.write();

// Multer for avatar upload
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, "public/avatars")),
    filename: (req, file, cb) => cb(null, `${req.session.user}_${Date.now()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage });

// --- Routes ---

// Signup
app.post("/signup", async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).send("Missing fields");

    const userExists = db.data.users.find(u => u.username === username);
    if (userExists) return res.status(400).send("Username exists");

    const hash = await bcrypt.hash(password, 10);
    db.data.users.push({ username, password: hash, avatar: "/avatars/default.png" });
    await db.write();

    req.session.user = username;
    res.send({ success: true });
});

// Login
app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    const user = db.data.users.find(u => u.username === username);
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

// Get account info
app.get("/account", (req, res) => {
    const user = db.data.users.find(u => u.username === req.session.user);
    if (!user) return res.status(403).send("Not logged in");
    res.send({ username: user.username, avatar: user.avatar });
});

// Update avatar
app.post("/avatar", upload.single("avatar"), async (req, res) => {
    const user = db.data.users.find(u => u.username === req.session.user);
    if (!user) return res.status(403).send("Not logged in");
    user.avatar = "/avatars/" + req.file.filename;
    await db.write();
    res.send({ success: true, avatar: user.avatar });
});

// Rooms
app.get("/rooms", (req, res) => {
    res.send(Object.keys(db.data.rooms));
});

app.post("/rooms", async (req, res) => {
    const { room } = req.body;
    if (!room) return res.status(400).send("Room name required");
    if (!db.data.rooms[room]) {
        db.data.rooms[room] = { creator: req.session.user };
        db.data.messages[room] = [];
        await db.write();
    }
    res.send({ success: true });
});

// --- Socket.io ---
io.on("connection", (socket) => {
    let currentRoom = null;
    let username = null;

    socket.on("joinRoom", async ({ room, user }) => {
        username = user;
        currentRoom = room;
        socket.join(room);

        if (!db.data.messages[room]) db.data.messages[room] = [];
        socket.emit("history", db.data.messages[room]);
    });

    socket.on("message", async (msg) => {
        if (!currentRoom) return;
        const message = { id: uuidv4(), user: username, text: msg, timestamp: Date.now() };
        db.data.messages[currentRoom].push(message);
        await db.write();
        io.to(currentRoom).emit("message", message);
    });

    socket.on("deleteMessage", async (msgId) => {
        if (!currentRoom) return;
        const message = db.data.messages[currentRoom].find(m => m.id === msgId);
        const roomCreator = db.data.rooms[currentRoom].creator;
        if (!message) return;

        if (message.user === username || roomCreator === username) {
            db.data.messages[currentRoom] = db.data.messages[currentRoom].filter(m => m.id !== msgId);
            await db.write();
            io.to(currentRoom).emit("deleteMessage", msgId);
        }
    });
});

// Start server
server.listen(process.env.PORT || 3000, () => console.log("Server running"));
