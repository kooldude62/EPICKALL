import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const rooms = {}; // { roomName: { pass: "xyz", private: true/false } }

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("createRoom", ({ room, password, privateRoom }) => {
    if (!room) return;
    rooms[room] = { pass: password || null, private: privateRoom || false };
    socket.join(room);
    socket.emit("roomJoined", room);
    console.log(`Room created: ${room}`);
  });

  socket.on("joinRoom", ({ room, password }) => {
    if (!rooms[room]) {
      socket.emit("errorMsg", "Room not found.");
      return;
    }
    if (rooms[room].pass && rooms[room].pass !== password) {
      socket.emit("errorMsg", "Invalid password.");
      return;
    }
    socket.join(room);
    socket.emit("roomJoined", room);
    console.log(`User joined room: ${room}`);
  });

  socket.on("chatMessage", ({ room, user, msg }) => {
    if (!room) return;
    io.to(room).emit("chatMessage", { user, msg });
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
