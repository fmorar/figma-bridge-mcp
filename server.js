// server.js
import express from "express";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";

import { attachMcpRoutes } from "./mcpRouter.js";
import { createTokenStore } from "./tokenStore.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3333);

// Parsers (MCP tools/call uses JSON-RPC body)
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

// ---- Crash visibility (prevents silent timeouts) ----
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

// Token store (must have load/save)
const tokenStore = createTokenStore({
  dir: process.env.TOKEN_STORE_DIR || ".data",
  filename: process.env.TOKEN_STORE_FILE || "figma-token.json"
});

// ✅ IMPORTANT: pass tokenStore directly (fixes mismatch)
attachMcpRoutes(app, tokenStore);

// Express error middleware (last)
app.use((err, req, res, next) => {
  console.error("[express error]", err);

  // Always return JSON-RPC shape for MCP endpoints
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
  console.log(`[server] MCP_AUTH_KEY ${process.env.MCP_AUTH_KEY ? "set" : "NOT set (dev open)"} `);
});