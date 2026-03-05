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

/**
 * Figma OAuth scopes:
 * - You can pass space-separated OR comma-separated scopes (Figma supports both). :contentReference[oaicite:3]{index=3}
 * - Recommended minimum for reading file content:
 *   file_content:read, file_metadata:read, current_user:read :contentReference[oaicite:4]{index=4}
 *
 * If you want to attempt Variables writes, you may need additional scopes/permissions/plan.
 */
const FIGMA_SCOPES =
  (process.env.FIGMA_SCOPES || "file_content:read file_metadata:read current_user:read").trim();

const IS_HTTPS = BASE_URL.startsWith("https://");

// Parsers
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

// Root (avoid "Cannot GET /")
app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "figma-bridge-mcp",
    baseUrl: BASE_URL,
    endpoints: ["/mcp", "/mcp/tools", "/mcp/sse", "/auth/figma/login", "/auth/figma/callback"],
  });
});

// Crash visibility (prevents silent timeouts)
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

// Token store
const tokenStore = createTokenStore({
  dir: process.env.TOKEN_STORE_DIR || ".data",
  filename: process.env.TOKEN_STORE_FILE || "figma-token.json",
});

function requireOAuthEnv(res) {
  if (!FIGMA_CLIENT_ID || !FIGMA_CLIENT_SECRET) {
    res
      .status(500)
      .send("Missing FIGMA_CLIENT_ID / FIGMA_CLIENT_SECRET env vars. Set them in Render env.");
    return false;
  }
  return true;
}

/**
 * Build the Figma OAuth "scope" param.
 * Figma accepts comma-separated or space-separated. :contentReference[oaicite:5]{index=5}
 * We'll standardize to comma-separated (safe & explicit).
 */
function normalizeScopes(scopesRaw) {
  // supports: "a b c" OR "a,b,c" OR mixed
  const parts = scopesRaw
    .split(/[,\s]+/g)
    .map((s) => s.trim())
    .filter(Boolean);

  // de-dupe
  const unique = Array.from(new Set(parts));
  return unique.join(",");
}

// ---- Figma OAuth: Login ----
// Open this in browser to start OAuth:
//   https://<BASE_URL>/auth/figma/login
app.get("/auth/figma/login", (req, res) => {
  if (!requireOAuthEnv(res)) return;

  const state = crypto.randomBytes(16).toString("hex");

  // Cookie must be secure only on HTTPS; otherwise localhost http breaks
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
// Redirect URL must be set in Figma App settings:
//   https://<BASE_URL>/auth/figma/callback
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
      headers: { Accept: "application/json" },
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
        .send(`OAuth failed (status ${tokenRes.status}). Check logs. Body: ${tokenText}`);
    }

    const saveResult = tokenStore.save(token);
    if (!saveResult.ok) {
      console.error("[figma oauth] failed to save token:", saveResult);
      return res.status(500).send("OAuth succeeded but saving token failed. Check logs.");
    }

    res.clearCookie("figma_oauth_state");
    res.status(200).send(
      [
        "✅ Figma OAuth success. Token stored.",
        "",
        "Next:",
        `- Try GET: ${BASE_URL}/mcp/tools?authKey=<MCP_AUTH_KEY>`,
        `- Then tools/call via your agent.`,
        "",
        `Scopes used: ${normalizeScopes(FIGMA_SCOPES)}`,
      ].join("\n")
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

  // MCP clients expect JSON-RPC even on errors
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
  console.log(`[server] MCP_AUTH_KEY ${process.env.MCP_AUTH_KEY ? "set" : "NOT set (dev open)"}`);
  console.log(`[server] FIGMA_CLIENT_ID ${FIGMA_CLIENT_ID ? "set" : "NOT set"}`);
  console.log(`[server] FIGMA_CLIENT_SECRET ${FIGMA_CLIENT_SECRET ? "set" : "NOT set"}`);
  console.log(`[server] FIGMA_SCOPES=${normalizeScopes(FIGMA_SCOPES)}`);
});