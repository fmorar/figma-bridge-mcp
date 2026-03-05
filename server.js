// server.js
import express from "express";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import crypto from "crypto";

import { attachMcpRoutes } from "./mcpRouter.js";
import { createTokenStore } from "./tokenStore.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3333);

const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const FIGMA_CLIENT_ID = process.env.FIGMA_CLIENT_ID;
const FIGMA_CLIENT_SECRET = process.env.FIGMA_CLIENT_SECRET;

// Parsers
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

// Simple root (avoid "Cannot GET /")
app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "figma-bridge-mcp",
    endpoints: ["/mcp", "/mcp/tools", "/mcp/sse", "/auth/figma/login", "/auth/figma/callback"]
  });
});

// ---- Crash visibility (prevents silent timeouts) ----
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

// Token store
const tokenStore = createTokenStore({
  dir: process.env.TOKEN_STORE_DIR || ".data",
  filename: process.env.TOKEN_STORE_FILE || "figma-token.json"
});

// ---- OAuth helpers ----
function requireOAuthEnv(res) {
  if (!FIGMA_CLIENT_ID || !FIGMA_CLIENT_SECRET) {
    res.status(500).send(
      "Missing FIGMA_CLIENT_ID / FIGMA_CLIENT_SECRET env vars. Set them in Render env."
    );
    return false;
  }
  return true;
}

// ---- Figma OAuth: Login ----
// Open this in browser to start OAuth:
//   https://<host>/auth/figma/login
app.get("/auth/figma/login", (req, res) => {
  if (!requireOAuthEnv(res)) return;

  const state = crypto.randomBytes(16).toString("hex");
  res.cookie("figma_oauth_state", state, { httpOnly: true, sameSite: "lax", secure: true });

  const redirectUri = `${BASE_URL}/auth/figma/callback`;

  // Figma OAuth authorize endpoint
  const url = new URL("https://www.figma.com/oauth");
  url.searchParams.set("client_id", FIGMA_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);

  // Scopes: start with read-only. Add write if you want to create variables.
  // If variables creation requires write scopes, upgrade later.
  // Many devs use: "file_read file_write"
  url.searchParams.set("scope", "file_read");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);

  res.redirect(url.toString());
});

// ---- Figma OAuth: Callback ----
// Redirect URL must be set in Figma App settings:
//   https://<host>/auth/figma/callback
app.get("/auth/figma/callback", async (req, res) => {
  if (!requireOAuthEnv(res)) return;

  const { code, state } = req.query;
  const cookieState = req.cookies?.figma_oauth_state;

  if (!code) return res.status(400).send("Missing OAuth code");
  if (!state || !cookieState || String(state) !== String(cookieState)) {
    return res.status(400).send("Invalid OAuth state");
  }

  const redirectUri = `${BASE_URL}/auth/figma/callback`;

  try {
    const tokenUrl = new URL("https://www.figma.com/api/oauth/token");
    tokenUrl.searchParams.set("client_id", FIGMA_CLIENT_ID);
    tokenUrl.searchParams.set("client_secret", FIGMA_CLIENT_SECRET);
    tokenUrl.searchParams.set("redirect_uri", redirectUri);
    tokenUrl.searchParams.set("code", String(code));
    tokenUrl.searchParams.set("grant_type", "authorization_code");

    const tokenRes = await fetch(tokenUrl.toString(), {
      method: "POST",
      headers: { Accept: "application/json" }
    });

    const tokenText = await tokenRes.text();
    let token;
    try {
      token = JSON.parse(tokenText);
    } catch {
      token = { raw: tokenText };
    }

    if (!tokenRes.ok || !token?.access_token) {
      console.error("[figma oauth] token exchange failed:", tokenRes.status, token);
      return res.status(500).send(`OAuth failed (status ${tokenRes.status}). Check logs.`);
    }

    const saveResult = tokenStore.save(token);
    if (!saveResult.ok) {
      console.error("[figma oauth] failed to save token:", saveResult);
      return res.status(500).send("OAuth succeeded but saving token failed. Check logs.");
    }

    res.clearCookie("figma_oauth_state");
    res.status(200).send(
      "✅ Figma OAuth success. Token stored. You can now run MCP tools (figma_get_file, tokens_bootstrap_from_brand, etc.)."
    );
  } catch (err) {
    console.error("[figma oauth] error:", err);
    res.status(500).send("OAuth error. Check server logs.");
  }
});

// ✅ Attach MCP routes
attachMcpRoutes(app, tokenStore);

// Express error middleware (last)
app.use((err, req, res, next) => {
  console.error("[express error]", err);

  if ((req.path || "").startsWith("/mcp")) {
    return res.status(200).json({
      jsonrpc: "2.0",
      id: req.body?.id ?? null,
      error: { code: -32000, message: err?.message || "Server error" }
    });
  }

  res.status(500).send("Server error");
});

app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
  console.log(`[server] BASE_URL=${BASE_URL}`);
  console.log(`[server] MCP_AUTH_KEY ${process.env.MCP_AUTH_KEY ? "set" : "NOT set (dev open)"}`);
  console.log(`[server] FIGMA_CLIENT_ID ${FIGMA_CLIENT_ID ? "set" : "NOT set"}`);
  console.log(`[server] FIGMA_CLIENT_SECRET ${FIGMA_CLIENT_SECRET ? "set" : "NOT set"}`);
});