// server.js
import express from "express";
import session from "express-session";
import bcrypt from "bcryptjs";
import fs from "fs";
import path from "path";
import http from "http";
import { Server } from "socket.io";
import { v4 as uuidv4 } from "uuid";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Session setup
app.use(session({
    secret: "supersecretkey",
    resave: false,
    saveUninitialized: false
}));

// Accounts storage
const ACCOUNTS_FILE = path.join(__dirname, "accounts.json");
if (!fs.existsSync(ACCOUNTS_FILE)) fs.writeFileSync(ACCOUNTS_FILE, "[]");

function getAccounts() {
    return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf-8"));
}

function saveAccounts(accounts) {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}

// Middleware to check login
function requireLogin(req, res, next) {
    if (!req.session.user) return res.status(401).send("Not logged in");
    next();
}

// Signup
app.post("/signup", async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).send("Missing fields");

    const accounts = getAccounts();
    if (accounts.find(a => a.username === username)) return res.status(400).send("Username taken");

    const hash = await bcrypt.hash(password, 10);
    accounts.push({ username, password: hash });
    saveAccounts(accounts);

    req.session.user = username;
    res.send({ success: true });
});

// Login
app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).send("Missing fields");

    const accounts = getAccounts();
    const user = accounts.find(a => a.username === username);
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
app.get("/account", requireLogin, (req, res) => {
    const accounts = getAccounts();
    const user = accounts.find(a => a.username === req.session.user);
    res.send({ username: user.username });
});

// Rooms
const roomsFile = path.join(__dirname, "rooms.json");
if (!fs.existsSync(roomsFile)) fs.writeFileSync(roomsFile, "{}");

function getRooms() {
    return JSON.parse(fs.readFileSync(roomsFile, "utf-8"));
}

function saveRooms(data) {
    fs.writeFileSync(roomsFile, JSON.stringify(data, null, 2));
}

// API to get rooms
app.get("/rooms", requireLogin, (req, res) => {
    const rooms = getRooms();
    const roomsArray = Object.keys(rooms).map(name => ({
        name,
        hasPassword: !!rooms[name].password
    }));
    res.send(roomsArray);
});

// Create room
app.post("/create-room", requireLogin, (req, res) => {
    const { roomName, roomPassword } = req.body;
    if (!roomName) return res.status(400).send("Room name required");

    const rooms = getRooms();
    if (rooms[roomName]) return res.status(400).send("Room already exists");

    rooms[roomName] = { creator: req.session.user, password: roomPassword || "", messages: [] };
    saveRooms(rooms);
    res.send({ success: true });
});

// Socket.io chat
io.on("connection", socket => {
    let currentRoom = null;
    let username = null;

    socket.on("join-room", ({ roomName, roomPassword, user }) => {
        const rooms = getRooms();
        const room = rooms[roomName];
        if (!room) return socket.emit("error", "Room does not exist");

        if (room.password && room.password !== roomPassword) return socket.emit("error", "Incorrect password");

        currentRoom = roomName;
        username = user;
        socket.join(currentRoom);

        socket.emit("history", room.messages);
    });

    socket.on("message", msg => {
        if (!currentRoom) return;
        const rooms = getRooms();
        const message = { id: uuidv4(), user: username, text: msg, timestamp: Date.now() };
        rooms[currentRoom].messages.push(message);
        saveRooms(rooms);
        io.to(currentRoom).emit("message", message);
    });
});

// Redirect root to login if not logged in
app.get("/", (req, res) => {
    if (!req.session.user) return res.redirect("/login.html");
    res.sendFile(path.join(__dirname, "public/index.html"));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
