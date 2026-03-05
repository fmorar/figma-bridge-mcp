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

// Use granular scopes (recommended). You can override in env.
const FIGMA_SCOPES =
  (process.env.FIGMA_SCOPES || "file_content:read file_metadata:read current_user:read").trim();

const IS_HTTPS = BASE_URL.startsWith("https://");

app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "figma-bridge-mcp",
    baseUrl: BASE_URL,
    endpoints: ["/mcp", "/mcp/tools", "/mcp/sse", "/auth/figma/login", "/auth/figma/callback"],
  });
});

process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));

const tokenStore = createTokenStore({
  dir: process.env.TOKEN_STORE_DIR || ".data",
  filename: process.env.TOKEN_STORE_FILE || "figma-token.json",
});

function requireOAuthEnv(res) {
  if (!FIGMA_CLIENT_ID || !FIGMA_CLIENT_SECRET) {
    res.status(500).send("Missing FIGMA_CLIENT_ID / FIGMA_CLIENT_SECRET env vars.");
    return false;
  }
  return true;
}

function normalizeScopes(scopesRaw) {
  const parts = scopesRaw
    .split(/[,\s]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
  return Array.from(new Set(parts)).join(" ");
}

// ---- Figma OAuth: Login ----
app.get("/auth/figma/login", (req, res) => {
  if (!requireOAuthEnv(res)) return;

  const state = crypto.randomBytes(16).toString("hex");

  res.cookie("figma_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: IS_HTTPS,
  });

  const redirectUri = `${BASE_URL}/auth/figma/callback`;

  const url = new URL("https://www.figma.com/oauth");
  url.searchParams.set("client_id", FIGMA_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", normalizeScopes(FIGMA_SCOPES));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);

  res.redirect(url.toString());
});

// ---- Figma OAuth: Callback ----
// FIX: Exchange code using https://api.figma.com/v1/oauth/token (form-encoded)
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
    // IMPORTANT: codes expire quickly (Figma docs mention very short expiry).
    // Exchange immediately. :contentReference[oaicite:1]{index=1}
    const body = new URLSearchParams({
      client_id: FIGMA_CLIENT_ID,
      client_secret: FIGMA_CLIENT_SECRET,
      redirect_uri: redirectUri,
      code: String(code),
      grant_type: "authorization_code",
    });

    const tokenRes = await fetch("https://api.figma.com/v1/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
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
      return res
        .status(500)
        .send(`OAuth failed (status ${tokenRes.status}). Body: ${tokenText}`);
    }

    const saveResult = tokenStore.save(token);
    if (!saveResult.ok) {
      console.error("[figma oauth] failed to save token:", saveResult);
      return res.status(500).send("OAuth succeeded but saving token failed.");
    }

    res.clearCookie("figma_oauth_state");

    return res.status(200).send(
      [
        "✅ Figma OAuth success. Token stored.",
        "",
        "Next:",
        `- Try MCP tools: ${BASE_URL}/mcp/tools?authKey=<MCP_AUTH_KEY>`,
        `- Then call figma_get_file / figma_get_nodes / tokens_export_map.`,
        "",
        `Scopes used: ${normalizeScopes(FIGMA_SCOPES)}`,
      ].join("\n")
    );
  } catch (err) {
    console.error("[figma oauth] error:", err);
    return res.status(500).send("OAuth error. Check server logs.");
  }
});

attachMcpRoutes(app, tokenStore);

app.use((err, req, res, next) => {
  console.error("[express error]", err);

  if ((req.path || "").startsWith("/mcp")) {
    return res.status(200).json({
      jsonrpc: "2.0",
      id: req.body?.id ?? null,
      error: { code: -32000, message: err?.message || "Server error" },
    });
  }

  res.status(500).send("Server error");
});

app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
  console.log(`[server] BASE_URL=${BASE_URL}`);
  console.log(`[server] FIGMA_SCOPES=${normalizeScopes(FIGMA_SCOPES)}`);
});