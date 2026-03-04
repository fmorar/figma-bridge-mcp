import { figmaGetFile, figmaGetNodes } from "./figmaApi.js";

export function attachMcpRoutes(app, { mcpAuthKey, tokenStore }) {

  function authorized(req) {

    // x-mcp-auth header (original implementation)
    const xMcpAuth = req.get("x-mcp-auth");

    // Authorization: Bearer <key> (most MCP UIs send this)
    const authz = req.get("authorization") || "";
    const bearer = authz.toLowerCase().startsWith("bearer ")
      ? authz.slice(7).trim()
      : null;

    // X-API-Key support
    const xApiKey = req.get("x-api-key");

    // query param fallback
    const q = req.query.authKey;

    const key = xMcpAuth || bearer || xApiKey || q;

    return key === mcpAuthKey;
  }


  function startSSE(req, res) {

    if (!authorized(req)) {
      return res.status(401).send("Unauthorized");
    }

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


  // SSE on /mcp (many platforms expect this)
  app.get("/mcp", startSSE);

  // SSE on /mcp/sse (original endpoint)
  app.get("/mcp/sse", startSSE);



  async function handleRpc(req, res) {

    if (!authorized(req)) {
      return res.status(401).send("Unauthorized");
    }

    const { jsonrpc, id, method, params } = req.body;


    if (method === "initialize") {

      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-03-26",
          serverInfo: {
            name: "figma-bridge-mcp",
            version: "1.0.1"
          },
          capabilities: {
            tools: {}
          }
        }
      });

    }


    if (method === "tools/list") {

      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "figma_get_file",
              description: "Fetch Figma file",
              inputSchema: {
                type: "object",
                properties: {
                  fileKey: { type: "string" }
                },
                required: ["fileKey"]
              }
            },
            {
              name: "figma_get_nodes",
              description: "Fetch specific nodes",
              inputSchema: {
                type: "object",
                properties: {
                  fileKey: { type: "string" },
                  nodeIds: {
                    type: "array",
                    items: { type: "string" }
                  }
                },
                required: ["fileKey", "nodeIds"]
              }
            }
          ]
        }
      });

    }



    if (method === "tools/call") {

      const token = tokenStore.load();

      if (!token?.access_token) {
        return res.json({
          jsonrpc: "2.0",
          id,
          error: {
            code: 401,
            message: "OAuth required: open /auth/figma/login first"
          }
        });
      }

      const name = params.name;
      const args = params.arguments || {};


      if (name === "figma_get_file") {

        const out = await figmaGetFile({
          accessToken: token.access_token,
          fileKey: args.fileKey
        });

        return res.json({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: out.body
              }
            ]
          }
        });

      }


      if (name === "figma_get_nodes") {

        const out = await figmaGetNodes({
          accessToken: token.access_token,
          fileKey: args.fileKey,
          nodeIds: args.nodeIds
        });

        return res.json({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: out.body
              }
            ]
          }
        });

      }

    }


    res.json({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: "Unknown method"
      }
    });

  }


  // JSON-RPC endpoint
  app.post("/mcp", handleRpc);
  app.post("/mcp/sse", handleRpc);

}