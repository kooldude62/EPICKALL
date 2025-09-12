import express from "express";
import session from "express-session";
import bcrypt from "bcryptjs";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: "supersecretkey",
  resave: false,
  saveUninitialized: false
}));

// In-memory storage (replace with GitHub storage if needed)
let users = []; // {username, passwordHash}
let rooms = []; // {name, passwordHash, messages: []}

// Serve static files
app.use(express.static("public"));

// -------- Auth routes --------
app.post("/signup", async (req, res) => {
  const { username, password } = req.body;
  if(users.find(u => u.username===username)) return res.status(400).send("Username taken");
  const hash = await bcrypt.hash(password, 10);
  users.push({username,passwordHash:hash});
  req.session.user=username;
  res.sendStatus(200);
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u=>u.username===username);
  if(!user) return res.status(401).send("Invalid credentials");
  const ok = await bcrypt.compare(password,user.passwordHash);
  if(!ok) return res.status(401).send("Invalid credentials");
  req.session.user=username;
  res.sendStatus(200);
});

app.post("/logout",(req,res)=>{
  req.session.destroy(()=>res.sendStatus(200));
});

// -------- Room routes --------
app.get("/rooms",(req,res)=>{
  if(!req.session.user) return res.sendStatus(401);
  res.json(rooms.map(r=>({name:r.name, hasPassword:!!r.passwordHash})));
});

app.post("/create-room", async (req,res)=>{
  if(!req.session.user) return res.sendStatus(401);
  const { roomName, roomPassword } = req.body;
  if(rooms.find(r=>r.name===roomName)) return res.status(400).send("Room already exists");
  const hash = roomPassword ? await bcrypt.hash(roomPassword,10) : null;
  rooms.push({name:roomName,passwordHash:hash,messages:[]});
  res.sendStatus(200);
});

// -------- Socket.io --------
io.on("connection",(socket)=>{
  socket.on("join-room", async ({roomName, roomPassword, username})=>{
    const room = rooms.find(r=>r.name===roomName);
    if(!room) return socket.emit("error","Room not found");
    if(room.passwordHash){
      const ok = await bcrypt.compare(roomPassword,room.passwordHash);
      if(!ok) return socket.emit("error","Wrong password");
    }
    socket.join(roomName);
    socket.emit("history", room.messages);
  });

  socket.on("message", ({roomName,user,text})=>{
    const room = rooms.find(r=>r.name===roomName);
    if(!room) return;
    const msg = {user,text};
    room.messages.push(msg);
    io.to(roomName).emit("message", msg);
  });
});

// -------- Start server --------
server.listen(3000,()=>console.log("Server running on http://localhost:3000"));
