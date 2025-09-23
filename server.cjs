const express = require("express");
const app = express();
const http = require("http");
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const session = require("express-session");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 3000;
const ADMIN_USERS = process.env.ADMIN_USERS ? process.env.ADMIN_USERS.split(",") : [];

// File paths for saving data
const USERS_FILE = path.join(__dirname, "data", "users.json");
const ROOMS_FILE = path.join(__dirname, "data", "rooms.json");
const MESSAGES_FILE = path.join(__dirname, "data", "messages.json");

// Ensure data folder exists
if (!fs.existsSync(path.join(__dirname, "data"))) fs.mkdirSync(path.join(__dirname, "data"));

// Helper to load JSON or return default
function loadJSON(filePath, defaultValue) {
    if (fs.existsSync(filePath)) {
        try {
            return JSON.parse(fs.readFileSync(filePath, "utf-8"));
        } catch { return defaultValue; }
    }
    return defaultValue;
}

// Load data
let users = loadJSON(USERS_FILE, {});      // username -> { password, friends, requests, banned, admin, avatar, createdAt }
let rooms = loadJSON(ROOMS_FILE, {});      // roomName -> { users: [], owner, avatar }
let messages = loadJSON(MESSAGES_FILE, []); // { id, from, to, room, text, timestamp }

// Middleware
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(
    session({
        secret: process.env.SESSION_SECRET || "secret",
        resave: false,
        saveUninitialized: true,
    })
);

function saveUsers() { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }
function saveRooms() { fs.writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2)); }
function saveMessages() { fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2)); }

function requireLogin(req, res, next) {
    if (!req.session.user) return res.status(401).json({ success: false, message: "Not logged in" });
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session.user || !req.session.user.admin) return res.status(403).json({ success: false, message: "Admin only" });
    next();
}

// Auth routes
app.post("/signup", (req, res) => {
    const { username, password, avatar } = req.body;
    if (!username || !password) return res.json({ success: false, message: "Missing fields" });
    if (users[username]) return res.json({ success: false, message: "User exists" });

    users[username] = {
        password,
        friends: [],
        requests: [],
        banned: false,
        admin: ADMIN_USERS.includes(username),
        avatar: avatar || "/avatars/default.png",
        createdAt: Date.now(),
    };
    saveUsers();
    req.session.user = { username, admin: users[username].admin };
    res.json({ success: true });
});

app.post("/login", (req, res) => {
    const { username, password } = req.body;
    const user = users[username];
    if (!user || user.password !== password) return res.json({ success: false, message: "Invalid credentials" });
    if (user.banned) return res.json({ success: false, message: "Banned" });

    req.session.user = { username, admin: user.admin };
    res.json({ success: true, admin: user.admin, avatar: user.avatar });
});

app.post("/logout", (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get("/me", (req, res) => {
    if (!req.session.user) return res.json({ loggedIn: false });
    const u = users[req.session.user.username];
    res.json({
        loggedIn: true,
        username: req.session.user.username,
        admin: req.session.user.admin,
        avatar: u.avatar,
        banned: u.banned,
    });
});

// Update avatar
app.post("/set-avatar", requireLogin, (req, res) => {
    const { avatar } = req.body;
    if (!avatar) return res.json({ success: false });
    users[req.session.user.username].avatar = avatar;
    saveUsers();
    res.json({ success: true });
});

// Friend routes
app.post("/friend-request", requireLogin, (req, res) => {
    const from = req.session.user.username;
    const { to } = req.body;
    if (!to || !users[to]) return res.json({ success: false, message: "User not found" });
    if (to === from) return res.json({ success: false, message: "Cannot friend yourself" });

    // Check if already friends
    if (users[from].friends.includes(to)) return res.json({ success: false, message: "Already friends" });

    // Send request
    if (!users[to].requests.includes(from)) {
        users[to].requests.push(from);
        saveUsers();
    }
    res.json({ success: true });
});

app.post("/accept-request", requireLogin, (req, res) => {
    const me = req.session.user.username;
    const { from } = req.body;
    if (!from || !users[from]) return res.json({ success: false, message: "User not found" });

    // Add each other as friends
    if (!users[me].friends.includes(from)) users[me].friends.push(from);
    if (!users[from].friends.includes(me)) users[from].friends.push(me);

    // Remove request
    users[me].requests = users[me].requests.filter(r => r !== from);
    saveUsers();
    res.json({ success: true });
});

// Get friends, recent, requests
app.get("/friends", requireLogin, (req, res) => {
    const me = req.session.user.username;
    const userList = Object.keys(users).map(u => ({
        username: u,
        avatar: users[u].avatar,
        admin: users[u].admin,
        createdAt: users[u].createdAt,
    }));

    // Exclude self from recently registered
    const recent = userList.filter(u => u.username !== me).sort((a,b)=> b.createdAt - a.createdAt).slice(0,10);

    res.json({
        friends: users[me].friends.map(u => ({ username: u, avatar: users[u].avatar, admin: users[u].admin })),
        requests: users[me].requests,
        recent,
    });
});

// Rooms
app.post("/create-room", requireLogin, (req, res) => {
    const { name, avatar } = req.body;
    if (!name) return res.json({ success: false, message: "No room name" });
    if (rooms[name]) return res.json({ success: false, message: "Room exists" });

    rooms[name] = {
        owner: req.session.user.username,
        users: [],
        avatar: avatar || "/avatars/room.png",
    };
    saveRooms();
    res.json({ success: true });
});

app.get("/rooms", requireLogin, (req, res) => {
    const roomList = Object.keys(rooms).map(r => ({
        name: r,
        avatar: rooms[r].avatar,
        owner: rooms[r].owner,
        userCount: rooms[r].users.length,
    }));
    res.json({ rooms: roomList });
});

app.post("/join-room", requireLogin, (req, res) => {
    const username = req.session.user.username;
    const { room } = req.body;
    if (!rooms[room]) return res.json({ success: false, message: "Room not found" });

    if (!rooms[room].users.includes(username)) rooms[room].users.push(username);
    saveRooms();
    res.json({ success: true });
});

// Messages
app.post("/send-message", requireLogin, (req, res) => {
    const from = req.session.user.username;
    const { to, room, message } = req.body;
    if (!message) return res.json({ success: false });

    const msg = {
        id: Date.now().toString(),
        from,
        to: to || null,
        room: room || null,
        text: message,
        timestamp: Date.now(),
    };
    messages.push(msg);
    saveMessages();
    io.emit("message", msg);
    res.json({ success: true });
});

// Admin message delete
app.post("/admin/delete-message", requireAdmin, (req, res) => {
    const { id } = req.body;
    messages = messages.filter(m => m.id !== id);
    saveMessages();
    io.emit("deleteMessage", { id });
    res.json({ success: true });
});

// Socket.io
io.on("connection", socket => {
    socket.on("registerUser", username => {
        socket.username = username;
    });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
