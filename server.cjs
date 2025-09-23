const express = require("express");
const app = express();
const http = require("http");
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const session = require("express-session");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ADMIN_USERS = process.env.ADMIN_USERS ? process.env.ADMIN_USERS.split(",") : [];

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(session({ secret: process.env.SESSION_SECRET || "secret", resave: false, saveUninitialized: true }));

// --- Storage ---
const USERS_FILE = path.join(__dirname,"data/users.json");
const ROOMS_FILE = path.join(__dirname,"data/rooms.json");

let users = fs.existsSync(USERS_FILE) ? JSON.parse(fs.readFileSync(USERS_FILE)) : {};
let rooms = fs.existsSync(ROOMS_FILE) ? JSON.parse(fs.readFileSync(ROOMS_FILE)) : {};
let messages = []; // {id, from, to, room, text, timestamp}

// --- Helpers ---
function saveUsers() { fs.writeFileSync(USERS_FILE, JSON.stringify(users,null,2)); }
function saveRooms() { fs.writeFileSync(ROOMS_FILE, JSON.stringify(rooms,null,2)); }

function requireLogin(req,res,next){
    if(!req.session.user) return res.status(401).json({success:false});
    next();
}
function requireAdmin(req,res,next){
    if(!req.session.user?.admin) return res.status(403).json({success:false,message:"Admin only"});
    next();
}

// --- Auth ---
app.post("/signup",(req,res)=>{
    const {username,password,bio} = req.body;
    if(users[username]) return res.json({success:false,message:"User exists"});
    users[username] = {password,friends:[],requests:[],banned:false,admin:ADMIN_USERS.includes(username),avatar:"/avatars/default.png",bio:bio||""};
    req.session.user = {username,admin:users[username].admin};
    saveUsers();
    res.json({success:true});
});

app.post("/login",(req,res)=>{
    const {username,password} = req.body;
    const u = users[username];
    if(!u||u.password!==password) return res.json({success:false,message:"Invalid credentials"});
    if(u.banned) return res.json({success:false,message:"Banned"});
    req.session.user = {username,admin:u.admin};
    res.json({success:true});
});

app.post("/logout",requireLogin,(req,res)=>{ req.session.destroy(()=>res.json({success:true})); });

app.get("/me",(req,res)=>{
    if(!req.session.user) return res.json({loggedIn:false});
    const u = users[req.session.user.username];
    res.json({loggedIn:true,username:req.session.user.username,admin:u.admin,bio:u.bio,avatar:u.avatar,banned:u.banned});
});

// --- Friend system ---
app.post("/friend-request",requireLogin,(req,res)=>{
    const from = req.session.user.username;
    const to = req.body.to;
    if(from===to) return res.json({success:false,message:"Cannot friend yourself"});
    if(!users[to]) return res.json({success:false,message:"User not found"});
    if(users[from].friends.includes(to)||users[to].requests.includes(from)) return res.json({success:false,message:"Already friends or request pending"});
    users[to].requests.push(from);
    saveUsers();
    res.json({success:true});
});

app.post("/accept-request",requireLogin,(req,res)=>{
    const me = req.session.user.username;
    const from = req.body.from;
    if(!users[me].requests.includes(from)) return res.json({success:false,message:"No request"});
    users[me].requests = users[me].requests.filter(u=>u!==from);
    users[me].friends.push(from);
    users[from].friends.push(me);
    saveUsers();
    res.json({success:true});
});

// --- Rooms ---
app.post("/create-room",requireLogin,(req,res)=>{
    const owner = req.session.user.username;
    const {name,avatar} = req.body;
    if(!name) return res.json({success:false,message:"Name required"});
    if(rooms[name]) return res.json({success:false,message:"Room exists"});
    rooms[name] = {name,owner,avatar:avatar||"/avatars/default.png",users:[owner]};
    saveRooms();
    res.json({success:true});
});

app.post("/join-room",requireLogin,(req,res)=>{
    const {name} = req.body;
    if(!rooms[name]) return res.json({success:false,message:"Room not found"});
    const user = req.session.user.username;
    if(!rooms[name].users.includes(user)) rooms[name].users.push(user);
    saveRooms();
    res.json({success:true});
});

app.post("/leave-room",requireLogin,(req,res)=>{
    const {name} = req.body;
    if(!rooms[name]) return res.json({success:false,message:"Room not found"});
    const user = req.session.user.username;
    rooms[name].users = rooms[name].users.filter(u=>u!==user);
    saveRooms();
    res.json({success:true});
});

app.post("/manage-room",requireLogin,(req,res)=>{
    const user = req.session.user.username;
    const {name,action,target} = req.body;
    if(!rooms[name]) return res.json({success:false,message:"Room not found"});
    if(rooms[name].owner!==user) return res.json({success:false,message:"Not owner"});
    if(action==="kick" && target){ rooms[name].users = rooms[name].users.filter(u=>u!==target); saveRooms(); return res.json({success:true}); }
    if(action==="delete"){ delete rooms[name]; saveRooms(); return res.json({success:true}); }
    res.json({success:false,message:"Invalid action"});
});

// --- Messages ---
app.post("/send-message",requireLogin,(req,res)=>{
    const from = req.session.user.username;
    const {to,room,text} = req.body;
    const msg = {id:Date.now().toString(),from,to:to||null,room:room||null,text,timestamp:Date.now(),avatar:users[from].avatar};
    messages.push(msg);
    io.emit("message",msg);
    res.json({success:true});
});

app.post("/delete-message",requireLogin,(req,res)=>{
    const {id} = req.body;
    const msg = messages.find(m=>m.id===id);
    if(!msg) return res.json({success:false,message:"Not found"});
    const user = req.session.user.username;
    if(user!==msg.from&&!users[user].admin) return res.json({success:false,message:"Not allowed"});
    messages = messages.filter(m=>m.id!==id);
    io.emit("deleteMessage",{id});
    res.json({success:true});
});

// --- APIs ---
app.get("/friends",requireLogin,(req,res)=>{
    const me = req.session.user.username;
    const friends = users[me].friends.map(u=>({username:u,avatar:users[u].avatar,admin:users[u].admin}));
    const requests = users[me].requests;
    const recent = Object.keys(users).filter(u=>u!==me && !users[me].friends.includes(u)).map(u=>({username:u,avatar:users[u].avatar,admin:users[u].admin}));
    res.json({friends,requests,recent});
});

app.get("/rooms",requireLogin,(req,res)=>{
    res.json({rooms:Object.values(rooms)});
});

app.get("/profile/:username",requireLogin,(req,res)=>{
    const u = users[req.params.username];
    if(!u) return res.json({success:false,message:"Not found"});
    res.json({success:true,username:req.params.username,bio:u.bio,avatar:u.avatar,friends:u.friends.length});
});

// --- Socket.io ---
io.on("connection",(socket)=>{
    socket.on("registerUser",(username)=>{ socket.username=username; });
});

// --- Server ---
server.listen(PORT,()=>console.log("Server running on port "+PORT));
