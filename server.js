import express from "express";
import session from "express-session";
import bcrypt from "bcryptjs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import bodyParser from "body-parser";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use(session({
  secret: "secret",
  resave: false,
  saveUninitialized: true
}));

// Serve static files
app.use(express.static(path.join(__dirname, "public")));
const uploadsDir = path.join(__dirname, "public", "uploads");
if(!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// Accounts JSON
const accountsFile = path.join(__dirname, "accounts.json");
if(!fs.existsSync(accountsFile)) fs.writeFileSync(accountsFile, "[]");

function getAccounts(){ return JSON.parse(fs.readFileSync(accountsFile,"utf-8")); }
function saveAccounts(data){ fs.writeFileSync(accountsFile, JSON.stringify(data,null,2)); }

// Middleware to require login
function requireLogin(req,res,next){
  if(req.session.user) next();
  else res.redirect("/login.html");
}

// --- Signup ---
app.post("/signup", async (req,res)=>{
  const { username, password } = req.body;
  if(!username || !password) return res.status(400).send("Missing fields");
  const accounts = getAccounts();
  if(accounts.find(a=>a.username===username)) return res.status(400).send("Username taken");

  const hash = await bcrypt.hash(password, 10);
  accounts.push({ username, password: hash, pfp: "" });
  saveAccounts(accounts);
  req.session.user = username;
  res.send("OK");
});

// --- Login ---
app.post("/login", async (req,res)=>{
  const { username, password } = req.body;
  if(!username || !password) return res.status(400).send("Missing fields");
  const accounts = getAccounts();
  const user = accounts.find(a=>a.username===username);
  if(!user) return res.status(400).send("Invalid username");
  const match = await bcrypt.compare(password, user.password);
  if(!match) return res.status(400).send("Invalid password");
  req.session.user = username;
  res.send("OK");
});

// --- Logout ---
app.post("/logout", (req,res)=>{
  req.session.destroy(()=>{});
  res.send("OK");
});

// --- Account info ---
app.get("/account", requireLogin, (req,res)=>{
  const user = getAccounts().find(a=>a.username===req.session.user);
  res.json({ username: user.username, pfp: user.pfp });
});

// --- Update PFP ---
app.post("/update-pfp", requireLogin, (req,res)=>{
  const { filename, base64 } = req.body; // Accept base64 string from client
  if(!filename || !base64) return res.status(400).send("Missing PFP");

  const filePath = path.join(uploadsDir, filename);
  const data = base64.replace(/^data:image\/\w+;base64,/, "");
  const buffer = Buffer.from(data, "base64");
  fs.writeFileSync(filePath, buffer);

  const accounts = getAccounts();
  const user = accounts.find(a=>a.username===req.session.user);
  user.pfp = "/uploads/" + filename;
  saveAccounts(accounts);
  res.send("OK");
});

// --- Protected example route ---
app.get("/rooms", requireLogin, (req,res)=>{
  // Just return empty array for now
  res.json([]);
});

// Start server
const PORT = 3000;
app.listen(PORT, ()=>console.log(`Server running on http://localhost:${PORT}`));
