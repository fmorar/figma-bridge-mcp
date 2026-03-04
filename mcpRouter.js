
import { figmaGetFile, figmaGetNodes } from "./figmaApi.js";

export function attachMcpRoutes(app, { mcpAuthKey, tokenStore }) {

  function authorized(req) {
    const key = req.get("x-mcp-auth") || req.query.authKey;
    return key === mcpAuthKey;
  }

  app.get("/mcp/sse", (req, res) => {
    if (!authorized(req)) return res.status(401).send("Unauthorized");

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    res.write("event: ready\n");
    res.write("data: {}\n\n");

    const ping = setInterval(() => {
      res.write("event: ping\n");
      res.write(`data: {"t":${Date.now()}}\n\n`);
    }, 15000);

    req.on("close", () => clearInterval(ping));
  });

  async function handleRpc(req, res) {
    if (!authorized(req)) return res.status(401).send("Unauthorized");

    const { jsonrpc, id, method, params } = req.body;

    if (method === "initialize") {
      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-03-26",
          serverInfo: { name: "figma-bridge-mcp", version: "1.0.0" },
          capabilities: { tools: {} }
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
                properties: { fileKey: { type: "string" } },
                required: ["fileKey"]
              }
            },
            {
              name: "figma_get_nodes",
              description: "Fetch nodes",
              inputSchema: {
                type: "object",
                properties: {
                  fileKey: { type: "string" },
                  nodeIds: { type: "array", items: { type: "string" } }
                },
                required: ["fileKey","nodeIds"]
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
          jsonrpc:"2.0",
          id,
          error:{code:401,message:"OAuth required: open /auth/figma/login first"}
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
          jsonrpc:"2.0",
          id,
          result:{content:[{type:"text",text:out.body}]}
        });
      }

      if (name === "figma_get_nodes") {
        const out = await figmaGetNodes({
          accessToken: token.access_token,
          fileKey: args.fileKey,
          nodeIds: args.nodeIds
        });

        return res.json({
          jsonrpc:"2.0",
          id,
          result:{content:[{type:"text",text:out.body}]}
        });
      }
    }

    res.json({jsonrpc:"2.0",id,error:{code:-32601,message:"Unknown method"}});
  }

  app.post("/mcp", handleRpc);
  app.post("/mcp/sse", handleRpc);
}
