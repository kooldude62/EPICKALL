import express from "express";
import session from "express-session";
import multer from "multer";
import bcrypt from "bcryptjs";
import fs from "fs";
import path from "path";

const app=express();
app.use(express.json());
app.use(express.static("public"));
app.use(session({secret:"secret",resave:false,saveUninitialized:true}));

const accountsFile="./accounts.json";
if(!fs.existsSync(accountsFile)) fs.writeFileSync(accountsFile,"[]");
const upload=multer({dest:"uploads/"});

function getAccounts(){ return JSON.parse(fs.readFileSync(accountsFile,"utf-8")); }
function saveAccounts(data){ fs.writeFileSync(accountsFile, JSON.stringify(data,null,2)); }

// Signup
app.post("/signup", upload.single("pfp"), async (req,res)=>{
  const {username,password}=req.body;
  const accounts=getAccounts();
  if(accounts.find(a=>a.username===username)) return res.status(400).send("Username taken");
  let pfp="";
  if(req.file) pfp="/uploads/"+req.file.filename;
  accounts.push({username,password:await bcrypt.hash(password,10),pfp});
  saveAccounts(accounts);
  req.session.user=username;
  res.send("OK");
});

// Login
app.post("/login", async (req,res)=>{
  const {username,password}=req.body;
  const accounts=getAccounts();
  const user=accounts.find(a=>a.username===username);
  if(!user) return res.status(400).send("Invalid username");
  const match=await bcrypt.compare(password,user.password);
  if(!match) return res.status(400).send("Invalid password");
  req.session.user=username;
  res.send("OK");
});

// Logout
app.post("/logout",(req,res)=>{ req.session.destroy(()=>{}); res.send("OK"); });

// Get account
app.get("/account",(req,res)=>{
  if(!req.session.user) return res.status(401).send("Not logged in");
  const user=getAccounts().find(a=>a.username===req.session.user);
  res.json({username:user.username,pfp:user.pfp});
});

// Update PFP
app.post("/update-pfp",upload.single("pfp"),(req,res)=>{
  if(!req.session.user) return res.status(401).send("Not logged in");
  const accounts=getAccounts();
  const user=accounts.find(a=>a.username===req.session.user);
  if(req.file) user.pfp="/uploads/"+req.file.filename;
  saveAccounts(accounts);
  res.send("OK");
});

app.listen(3000,()=>console.log("Server running"));
