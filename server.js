import express from "express";
import session from "express-session";
import bodyParser from "body-parser";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(path.join(__dirname, "public")));
app.use(bodyParser.json());
app.use(session({
  secret: "supersecret",
  resave: false,
  saveUninitialized: false
}));

// --- In-memory storage ---
const users = {}; // { username: { password, avatar, friends: [], createdAt } }
const friendRequests = {}; // { username: [fromUser1, fromUser2] }
const rooms = {}; // { roomId: { name, password, inviteOnly, users: [], messages: [] } }
const dms = {}; // { "userA_userB": [{ sender, message, avatar, id }] }

// --- Auth middleware ---
function checkAuth(req,res,next){
  if(!req.session.user) return res.status(401).json({ loggedIn:false });
  next();
}

// --- Auth routes ---
app.post("/login", (req,res)=>{
  const { username, password } = req.body;
  if(!users[username] || users[username].password !== password)
    return res.json({ success:false, message:"Invalid credentials" });
  req.session.user = username;
  res.json({ success:true });
});

app.post("/signup", (req,res)=>{
  const { username, password, avatar } = req.body;
  if(users[username]) return res.json({ success:false, message:"Username taken" });
  users[username] = { password, avatar: avatar || "/default.png", friends: [], createdAt: Date.now() };
  friendRequests[username] = [];
  req.session.user = username;
  res.json({ success:true });
});

app.post("/logout", (req,res)=>{
  req.session.destroy(()=> res.json({ success:true }));
});

app.get("/me", (req,res)=>{
  if(!req.session.user) return res.json({ loggedIn:false });
  const u = users[req.session.user];
  res.json({ loggedIn:true, username:req.session.user, admin:u.admin||false, avatar:u.avatar });
});

// --- Update avatar ---
app.post("/update-avatar", checkAuth, (req,res)=>{
  const { avatarUrl } = req.body;
  if(!avatarUrl) return res.json({ success:false, message:"No avatar provided" });
  users[req.session.user].avatar = avatarUrl;
  res.json({ success:true, avatar:avatarUrl });
});

// --- Friends ---
app.get("/friends", checkAuth, (req,res)=>{
  const username = req.session.user;
  const reqs = friendRequests[username] || [];
  const friendsList = users[username].friends.map(f => ({
    username:f,
    avatar:users[f]?.avatar || '/default.png'
  }));

  // 10 most recently registered users (excluding self + friends)
  const recentUsers = Object.entries(users)
    .filter(([name]) => name !== username && !users[username].friends.includes(name))
    .sort((a,b) => b[1].createdAt - a[1].createdAt)
    .slice(0,10)
    .map(([name,data]) => ({ username:name, avatar:data.avatar || '/default.png' }));

  res.json({ requests:reqs, friends:friendsList, recent:recentUsers });
});

app.post("/friend-request", checkAuth, (req,res)=>{
  const { to } = req.body;
  if(!users[to]) return res.json({ success:false, message:"User not found" });
  if(users[req.session.user].friends.includes(to)) return res.json({ success:false, message:"Already friends" });
  if(friendRequests[to].includes(req.session.user)) return res.json({ success:false, message:"Already requested" });
  friendRequests[to].push(req.session.user);
  res.json({ success:true });
});

app.post("/accept-request", checkAuth, (req,res)=>{
  const { from } = req.body;
  const username = req.session.user;
  const idx = friendRequests[username].indexOf(from);
  if(idx>-1){
    friendRequests[username].splice(idx,1);
    users[username].friends.push(from);
    users[from].friends.push(username);
  }
  res.json({ success:true });
});

// --- Rooms ---
app.get("/rooms", checkAuth, (req,res)=>{
  const result = {};
  for(const [id,room] of Object.entries(rooms)){
    result[id] = { name:room.name, inviteOnly:room.inviteOnly };
  }
  res.json(result);
});

app.post("/create-room", checkAuth, (req,res)=>{
  const { name, password, inviteOnly } = req.body;
  const roomId = crypto.randomBytes(4).toString("hex");
  rooms[roomId] = { name, password:password||"", inviteOnly:!!inviteOnly, users:[], messages:[] };
  res.json({ success:true, roomId });
});

app.get("/room-info/:roomId", checkAuth, (req,res)=>{
  const r = rooms[req.params.roomId];
  if(!r) return res.json({ success:false });
  res.json({ success:true, name:r.name });
});

// --- DMs ---
app.get("/dm/:friend", checkAuth, (req,res)=>{
  const userA = req.session.user;
  const userB = req.params.friend;
  const key = [userA,userB].sort().join("_");
  res.json({ success:true, messages:dms[key]||[] });
});

// --- Socket.io ---
io.on("connection", socket=>{
  let username = null;

  socket.on("registerUser", name=>{ username=name; });

  // Room chat
  socket.on("joinRoom", ({roomId,username:user})=>{
    socket.join(roomId);
    if(!rooms[roomId].users.includes(user)) rooms[roomId].users.push(user);
    socket.emit("chatHistory", rooms[roomId].messages || []);
  });

  socket.on("roomMessage", ({roomId,username:sender,message})=>{
    const avatar = users[sender]?.avatar || '/default.png';
    const msgObj = { id:crypto.randomBytes(4).toString("hex"), sender, message, avatar };
    if(!rooms[roomId].messages) rooms[roomId].messages=[];
    rooms[roomId].messages.push(msgObj);
    io.to(roomId).emit("roomMessage", msgObj);
  });

  // DMs
  socket.on("dmMessage", ({to,from,message})=>{
    const key = [to,from].sort().join("_");
    const avatar = users[from]?.avatar || '/default.png';
    const msgObj = { id:crypto.randomBytes(4).toString("hex"), sender:from, message, avatar };
    if(!dms[key]) dms[key]=[];
    dms[key].push(msgObj);
    io.emit("dmMessage", msgObj);
  });
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, ()=> console.log(`Server running on port ${PORT}`));
