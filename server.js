
import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import { createTokenStore } from "./tokenStore.js";
import { attachMcpRoutes } from "./mcpRouter.js";

const app = express();
app.use(express.json());
app.use(cookieParser());

const PORT = process.env.PORT || 3333;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const FIGMA_CLIENT_ID = process.env.FIGMA_CLIENT_ID;
const FIGMA_CLIENT_SECRET = process.env.FIGMA_CLIENT_SECRET;
const FIGMA_SCOPES = process.env.FIGMA_SCOPES || "file_content:read";

const REDIRECT_URI = `${BASE_URL}/auth/figma/callback`;

const tokenStore = createTokenStore({
  filePath: process.env.TOKEN_STORE_PATH || ".data/figma-oauth.json"
});

function newState() {
  return crypto.randomBytes(16).toString("hex");
}

app.get("/", (req,res)=>{
  res.send("Figma MCP bridge running. Go to /auth/figma/login");
});

app.get("/auth/figma/login",(req,res)=>{
  const state=newState();
  res.cookie("figma_oauth_state",state);

  const url=new URL("https://www.figma.com/oauth");
  url.searchParams.set("client_id",FIGMA_CLIENT_ID);
  url.searchParams.set("redirect_uri",REDIRECT_URI);
  url.searchParams.set("scope",FIGMA_SCOPES);
  url.searchParams.set("state",state);
  url.searchParams.set("response_type","code");

  res.redirect(url.toString());
});

app.get("/auth/figma/callback",async(req,res)=>{
  const {code}=req.query;

  const body=new URLSearchParams({
    client_id:FIGMA_CLIENT_ID,
    client_secret:FIGMA_CLIENT_SECRET,
    redirect_uri:REDIRECT_URI,
    code,
    grant_type:"authorization_code"
  });

  const r=await fetch("https://api.figma.com/v1/oauth/token",{
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body
  });

  const token=await r.json();
  tokenStore.save(token);

  res.send("OAuth successful. Token saved.");
});

attachMcpRoutes(app,{
  mcpAuthKey:process.env.MCP_AUTH_KEY,
  tokenStore
});

app.listen(PORT,()=>{
  console.log("Server running:",BASE_URL);
  console.log("MCP SSE:",BASE_URL+"/mcp/sse");
});
