import { figmaGetFile, figmaGetNodes } from "./figmaApi.js";

export function attachMcpRoutes(app, { mcpAuthKey, tokenStore }) {
  // ---- Tool catalog (single source of truth) ----
  const TOOLS = [
    {
      name: "figma_get_file",
      description: "Fetch Figma file",
      inputSchema: {
        type: "object",
        properties: { fileKey: { type: "string" } },
        required: ["fileKey"],
      },
    },
    {
      name: "figma_get_nodes",
      description: "Fetch specific nodes",
      inputSchema: {
        type: "object",
        properties: {
          fileKey: { type: "string" },
          nodeIds: { type: "array", items: { type: "string" } },
        },
        required: ["fileKey", "nodeIds"],
      },
    },
  ];

  // ---- Auth (compatible with many MCP UIs/platforms) ----
  function authorized(req) {
    const xMcpAuth = req.get("x-mcp-auth");

    const authz = req.get("authorization") || "";
    const bearer = authz.toLowerCase().startsWith("bearer ")
      ? authz.slice(7).trim()
      : null;

    const xApiKey = req.get("x-api-key");
    const q = req.query.authKey;

    const key = xMcpAuth || bearer || xApiKey || q;
    return key === mcpAuthKey;
  }

  // ---- SSE helper ----
  function startSSE(req, res) {
    if (!authorized(req)) return res.status(401).send("Unauthorized");

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    res.write("event: ready\n");
    res.write("data: {}\n\n");

    const ping = setInterval(() => {
      res.write("event: ping\n");
      res.write(`data: {"t":${Date.now()}}\n\n`);
    }, 15000);

    req.on("close", () => clearInterval(ping));
  }

  // Many platforms expect SSE on the *base* URL
  app.get("/mcp", startSSE);
  // Keep original SSE endpoint too
  app.get("/mcp/sse", startSSE);

  // ---- Compatibility tools endpoint (non-JSON-RPC) ----
  function toolsCompat(req, res) {
    if (!authorized(req)) return res.status(401).send("Unauthorized");
    return res.json({ tools: TOOLS });
  }

  // Some platforms call GET/POST {base}/tools
  app.get("/mcp/tools", toolsCompat);
  app.post("/mcp/tools", toolsCompat);

  // In case they treat /mcp/sse as the base
  app.get("/mcp/sse/tools", toolsCompat);
  app.post("/mcp/sse/tools", toolsCompat);

  // ---- JSON-RPC handler ----
  async function handleRpc(req, res) {
    if (!authorized(req)) return res.status(401).send("Unauthorized");

    const body = req.body || {};
    const { jsonrpc, id, method, params } = body;

    // Robust validation (prevents "undefined" crashes)
    if (jsonrpc !== "2.0" || !method) {
      return res.status(400).json({
        jsonrpc: "2.0",
        id: id ?? null,
        error: { code: -32600, message: "Invalid Request" },
      });
    }

    if (method === "initialize") {
      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-03-26",
          serverInfo: { name: "figma-bridge-mcp", version: "1.0.2" },
          capabilities: { tools: {} },
        },
      });
    }

    if (method === "tools/list") {
      return res.json({
        jsonrpc: "2.0",
        id,
        result: { tools: TOOLS },
      });
    }

    if (method === "tools/call") {
      const token = tokenStore.load();

      if (!token?.access_token) {
        return res.json({
          jsonrpc: "2.0",
          id,
          error: { code: 401, message: "OAuth required: open /auth/figma/login first" },
        });
      }

      const toolName = params?.name;
      const args = params?.arguments || {};

      if (toolName === "figma_get_file") {
        if (!args.fileKey) {
          return res.json({
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Missing fileKey" },
          });
        }

        const out = await figmaGetFile({
          accessToken: token.access_token,
          fileKey: args.fileKey,
        });

        return res.json({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: out.body }] },
        });
      }

      if (toolName === "figma_get_nodes") {
        if (!args.fileKey || !Array.isArray(args.nodeIds) || args.nodeIds.length === 0) {
          return res.json({
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Missing fileKey or nodeIds[]" },
          });
        }

        const out = await figmaGetNodes({
          accessToken: token.access_token,
          fileKey: args.fileKey,
          nodeIds: args.nodeIds,
        });

        return res.json({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: out.body }] },
        });
      }

      return res.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unknown tool: ${toolName}` },
      });
    }

    return res.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unknown method: ${method}` },
    });
  }

  // JSON-RPC endpoints
  app.post("/mcp", handleRpc);
  // Some clients POST to the SSE url (we support it)
  app.post("/mcp/sse", handleRpc);
}