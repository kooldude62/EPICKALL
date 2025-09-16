import express from "express";
import session from "express-session";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import { Server } from "socket.io";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(session({
  secret: "supersecret",
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

app.use(express.static(path.join(__dirname, "public")));

const store = {
  users: {},
  rooms: []
};

const ADMIN_USERS = ["admin"];

// Routes same as before
app.post("/signup", (req,res)=>{
  const {username} = req.body;
  if(!username) return res.status(400).json({error:"Username required"});
  if(store.users[username]) return res.status(400).json({error:"User exists"});
  store.users[username]={username,admin:ADMIN_USERS.includes(username)};
  req.session.user=username;
  res.json({success:true});
});

app.post("/login", (req,res)=>{
  const {username} = req.body;
  if(!username||!store.users[username]) return res.status(400).json({error:"Invalid"});
  req.session.user=username;
  res.json({success:true});
});

app.post("/logout",(req,res)=>{
  req.session.destroy(()=>res.json({success:true}));
});

app.get("/me",(req,res)=>{
  if(!req.session.user) return res.json({loggedIn:false});
  const u=store.users[req.session.user];
  if(!u) return res.json({loggedIn:false});
  res.json({loggedIn:true,username:u.username,admin:u.admin});
});

app.get("/users",(req,res)=>{
  const arr=Object.values(store.users).map(u=>({username:u.username,admin:u.admin}));
  res.json(arr);
});

app.get("/rooms",(req,res)=>res.json(store.rooms));
app.post("/rooms",(req,res)=>{
  const {name}=req.body;
  if(!name) return res.status(400).json({error:"Room name required"});
  if(store.rooms.find(r=>r.name===name)) return res.status(400).json({error:"Room exists"});
  store.rooms.push({name});
  res.json({success:true});
});

// Socket.IO
io.on("connection", socket=>{
  let username=null;
  socket.on("registerUser", u=>{ username=u; });
  socket.on("chatMessage", ({to,msg})=>{
    for(let s of io.sockets.sockets.values()){
      if(s.id===socket.id) continue;
      if(s.username===to) s.emit("receiveMessage",{from:username,to,msg});
    }
  });
});

server.listen(PORT, ()=>console.log("Server running on port",PORT));
