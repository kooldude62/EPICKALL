import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import session from "express-session";
import cookieParser from "cookie-parser";
import { nanoid } from "nanoid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  secret: "supersecret",
  resave: false,
  saveUninitialized: false
}));

// Database (in-memory)
let users = {};   // { username: { password, pfp, friends:[], requests:[] } }
let rooms = {};   // { name: { password, inviteOnly, inviteId, messages:[] } }
let dms = {};     // { user1:user2: [ {from,to,text} ] }

// Middleware
function requireLogin(req,res,next){
  if(!req.session.user) return res.status(401).send("Unauthorized");
  next();
}

// Auth
app.post("/signup", async (req,res)=>{
  const { username, password } = req.body;
  if(!username || !password || users[username]) return res.send("Invalid signup.");
  const hashed = await bcrypt.hash(password,10);
  users[username] = { password: hashed, pfp: "/default.png", friends:[], requests:[] };
  req.session.user = username;
  res.redirect("/");
});

app.post("/login", async (req,res)=>{
  const { username, password } = req.body;
  if(!username || !password || !users[username]) return res.send("Invalid login.");
  const valid = await bcrypt.compare(password, users[username].password);
  if(!valid) return res.send("Invalid login.");
  req.session.user = username;
  res.redirect("/");
});

app.post("/logout",(req,res)=>{
  req.session.destroy(()=>res.redirect("/login.html"));
});

app.get("/me", requireLogin, (req,res)=>{
  const u = req.session.user;
  res.json({ username: u, pfp: users[u].pfp || "/default.png" });
});

// Account update
app.post("/updateAccount", requireLogin, (req,res)=>{
  const { username, pfp } = req.body;
  const current = req.session.user;
  if(username && !users[username]){
    users[username] = users[current];
    delete users[current];
    req.session.user = username;
  }
  if(pfp) users[req.session.user].pfp = pfp;
  res.redirect("/");
});

// Friend system
app.get("/users", requireLogin,(req,res)=>{
  const q = (req.query.q||"").toLowerCase();
  const arr = Object.keys(users)
    .filter(u=>u.toLowerCase().includes(q) && u!==req.session.user)
    .map(u=>({username:u, pfp: users[u].pfp||"/default.png"}));
  res.json(arr);
});

app.post("/friend/request", requireLogin,(req,res)=>{
  const { to } = req.body;
  const from = req.session.user;
  if(!users[to]) return res.sendStatus(400);
  users[to].requests.push({from,id:nanoid(6)});
  res.json({ok:true});
});

app.get("/friend/requests", requireLogin,(req,res)=>{
  res.json(users[req.session.user].requests||[]);
});

app.post("/friend/respond", requireLogin,(req,res)=>{
  const { id, accept } = req.body;
  const me = req.session.user;
  const reqs = users[me].requests;
  const fr = reqs.find(r=>r.id===id);
  if(!fr) return res.sendStatus(400);
  users[me].requests = reqs.filter(r=>r.id!==id);
  if(accept){
    users[me].friends.push(fr.from);
    users[fr.from].friends.push(me);
  }
  res.json({ok:true});
});

app.get("/dms", requireLogin,(req,res)=>{
  const me = req.session.user;
  const fs = users[me].friends||[];
  res.json(fs.map(u=>({username:u,pfp:users[u].pfp||"/default.png"})));
});

// Rooms
app.get("/rooms",(req,res)=>{
  res.json(Object.values(rooms).filter(r=>!r.inviteOnly).map(r=>({
    name:r.name, private:!!r.password
  })));
});

app.get("/rooms/:name",(req,res)=>{
  const r = rooms[req.params.name];
  if(!r) return res.json({});
  res.json({ private: !!r.password });
});

app.post("/rooms/create", requireLogin,(req,res)=>{
  const {name,password,inviteOnly} = req.body;
  if(!name || rooms[name]) return res.json({ok:false,error:"Invalid"});
  const inviteId = inviteOnly ? nanoid(8) : null;
  rooms[name] = { name, password: password||null, inviteOnly, inviteId, messages:[] };
  res.json({ok:true,inviteId});
});

app.get("/rooms/invite/:id",(req,res)=>{
  const r = Object.values(rooms).find(r=>r.inviteId===req.params.id);
  if(!r) return res.status(404).send("Invite not found");
  res.redirect("/?join=" + encodeURIComponent(r.name));
});

// Sockets
io.on("connection",(socket)=>{
  let currentUser = null;

  socket.on("identify",(u)=>{ currentUser=u; });

  socket.on("joinRoomSocket",({room,password})=>{
    const r = rooms[room];
    if(!r) return socket.emit("errorMsg","Room not found");
    if(r.password && r.password!==password) return socket.emit("errorMsg","Wrong password");
    socket.join(room);
    socket.emit("roomHistory",{ room, history:r.messages });
  });

  socket.on("sendRoomMessage",({room,text})=>{
    if(!room||!text) return;
    const msg={user:currentUser,text};
    rooms[room].messages.push(msg);
    io.to(room).emit("roomMessage",msg);
  });

  socket.on("startDM",({withUser})=>{
    const key=[currentUser,withUser].sort().join(":");
    if(!dms[key]) dms[key]=[];
    socket.emit("dmHistory",{withUser,history:dms[key]});
  });

  socket.on("sendDM",({to,text})=>{
    const key=[currentUser,to].sort().join(":");
    const msg={from:currentUser,to,text};
    if(!dms[key]) dms[key]=[];
    dms[key].push(msg);
    io.emit("dmMessage",msg);
  });
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log("Server running http://localhost:"+PORT));
