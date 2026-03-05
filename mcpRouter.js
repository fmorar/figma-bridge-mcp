import { figmaGetFile, figmaGetNodes, figmaGetLocalVariables, figmaCreateVariables } from "./figmaApi.js";
import { createManifestStore } from "./manifestStore.js";

const TOOLS = [
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
    description: "Fetch specific nodes",
    inputSchema: {
      type: "object",
      properties: {
        fileKey: { type: "string" },
        nodeIds: { type: "array", items: { type: "string" } }
      },
      required: ["fileKey", "nodeIds"]
    }
  },

  // ---- Vertical slice C tools ----
  {
    name: "tokens_bootstrap_from_brand",
    description: "Create primitive + semantic tokens (Figma Variables) from a brand pack (Light/Desktop).",
    inputSchema: {
      type: "object",
      properties: {
        fileKey: { type: "string" },
        brand: {
          type: "object",
          properties: {
            colors: {
              type: "object",
              description: "Hex colors. Example: { primary: '#1E40AF', accent: '#F59E0B', neutral: '#111827', background: '#FFFFFF' }"
            },
            typography: {
              type: "object",
              description: "Typography choices. Example: { fontFamily: 'Inter', scale: { body: 16, h1: 40 } }"
            }
          },
          required: ["colors", "typography"]
        },
        mode: { type: "string", enum: ["Light"], default: "Light" }
      },
      required: ["fileKey", "brand"]
    }
  },
  {
    name: "tokens_export_map",
    description: "Export tokens as CSS variables (globals.css snippet) + token map for shadcn.",
    inputSchema: {
      type: "object",
      properties: {
        fileKey: { type: "string" }
      },
      required: ["fileKey"]
    }
  },
  {
    name: "project_manifest_write",
    description: "Write project manifest snapshot (phase=ds) to server-side store.",
    inputSchema: {
      type: "object",
      properties: {
        fileKey: { type: "string" },
        manifest: { type: "object" }
      },
      required: ["fileKey", "manifest"]
    }
  },
  {
    name: "project_manifest_read",
    description: "Read last manifest snapshot for a fileKey from server-side store.",
    inputSchema: {
      type: "object",
      properties: {
        fileKey: { type: "string" }
      },
      required: ["fileKey"]
    }
  }
];

function textResult(obj) {
  return {
    content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }]
  };
}

function parseAuth(req) {
  const h = req.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  const bearer = m?.[1]?.trim();
  const q = (req.query?.authKey || "").toString().trim();
  return bearer || q || null;
}

function attachAuth({ sharedKey }) {
  return function authorized(req) {
    const key = parseAuth(req);
    return Boolean(sharedKey && key && key === sharedKey);
  };
}

function startSSE(req, res) {
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

function hexToRgba01(hex) {
  const h = hex.replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  if (full.length !== 6) return null;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  return { r, g, b, a: 1 };
}

function buildVariablesPayload({ brand }) {
  // Minimal, opinionated set for slice C
  const { colors, typography } = brand;

  // primitives
  const prim = {
    "color.primary": colors.primary,
    "color.accent": colors.accent,
    "color.neutral.900": colors.neutral || "#111827",
    "color.background": colors.background || "#FFFFFF"
  };

  // semantic mappings (kept as separate variables for simplicity)
  const sem = {
    "semantic.bg": prim["color.background"],
    "semantic.fg": prim["color.neutral.900"],
    "semantic.brand": prim["color.primary"],
    "semantic.accent": prim["color.accent"]
  };

  // Figma Variables API expects specific schema; we send a straightforward create request
  // NOTE: exact shape may evolve; we keep it minimal and readable.
  // If Figma returns 4xx with schema issues, we surface the response.
  const variables = [];
  for (const [name, hex] of Object.entries({ ...prim, ...sem })) {
    const rgba = hexToRgba01(hex) || hexToRgba01("#000000");
    variables.push({
      name,
      resolvedType: "COLOR",
      valuesByMode: {
        "Light": rgba
      }
    });
  }

  // Typography tokens in slice C are exported as manifest + css only (no Variables yet),
  // because many teams prefer typography in styles/components vs variables.
  return { variables, typography };
}

function buildCssExport({ brand }) {
  const c = brand.colors || {};
  const t = brand.typography || {};
  const css = [
    ":root {",
    `  --color-brand: ${c.primary || "#1E40AF"};`,
    `  --color-accent: ${c.accent || "#F59E0B"};`,
    `  --color-fg: ${c.neutral || "#111827"};`,
    `  --color-bg: ${c.background || "#FFFFFF"};`,
    `  --font-sans: ${t.fontFamily || "Inter"}, ui-sans-serif, system-ui;`,
    "}"
  ].join("\n");

  const tokenMap = {
    "semantic.brand": "var(--color-brand)",
    "semantic.accent": "var(--color-accent)",
    "semantic.fg": "var(--color-fg)",
    "semantic.bg": "var(--color-bg)",
    "typography.fontFamily": "var(--font-sans)"
  };

  return { globalsCssPreview: css, tokenMap };
}

export function attachMcpRoutes(app, tokenStore) {
  const authorized = attachAuth({ sharedKey: process.env.MCP_AUTH_KEY });
  const manifestStore = createManifestStore({ dir: process.env.MANIFEST_STORE_DIR || ".data/manifests" });

  // ---- SMART ENDPOINT ----
  // /mcp can act as JSON tools endpoint OR SSE depending on client behavior
  app.get("/mcp", (req, res) => {
    if (!authorized(req)) return res.status(401).send("Unauthorized");
    const accept = (req.get("accept") || "").toLowerCase();
    if (!accept.includes("text/event-stream")) return res.json({ tools: TOOLS });
    return startSSE(req, res);
  });

  // ---- SSE endpoint (force event-stream to satisfy strict clients) ----
  app.get("/mcp/sse", (req, res) => {
    if (!authorized(req)) return res.status(401).send("Unauthorized");
    return startSSE(req, res);
  });

  // Compatibility JSON tools
  function toolsCompat(req, res) {
    if (!authorized(req)) return res.status(401).send("Unauthorized");
    return res.json({ tools: TOOLS });
  }
  app.get("/mcp/tools", toolsCompat);
  app.post("/mcp/tools", toolsCompat);
  app.get("/mcp/sse/tools", toolsCompat);
  app.post("/mcp/sse/tools", toolsCompat);

  async function handleRpc(req, res) {
    if (!authorized(req)) return res.status(401).send("Unauthorized");

    const body = req.body || {};
    const { jsonrpc, id, method, params } = body;

    if (jsonrpc !== "2.0" || !method) {
      return res.status(400).json({
        jsonrpc: "2.0",
        id: id ?? null,
        error: { code: -32600, message: "Invalid Request" }
      });
    }

    if (method === "initialize") {
      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-03-26",
          serverInfo: { name: "figma-bridge-mcp", version: "1.1.0" },
          capabilities: { tools: {} }
        }
      });
    }

    if (method === "tools/list") {
      return res.json({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    }

    if (method === "tools/call") {
      const token = tokenStore.load();
      if (!token?.access_token) {
        return res.json({
          jsonrpc: "2.0",
          id,
          error: { code: 401, message: "OAuth required: open /auth/figma/login first" }
        });
      }

      const toolName = params?.name;
      const args = params?.arguments || {};

      // Existing tools
      if (toolName === "figma_get_file") {
        const out = await figmaGetFile({ accessToken: token.access_token, fileKey: args.fileKey });
        return res.json({ jsonrpc: "2.0", id, result: textResult(out.body) });
      }

      if (toolName === "figma_get_nodes") {
        const out = await figmaGetNodes({
          accessToken: token.access_token,
          fileKey: args.fileKey,
          nodeIds: args.nodeIds
        });
        return res.json({ jsonrpc: "2.0", id, result: textResult(out.body) });
      }

      // ---- Slice C tools ----
      if (toolName === "tokens_bootstrap_from_brand") {
        const { fileKey, brand } = args;
        const payload = buildVariablesPayload({ brand });

        // Attempt to create variables in Figma
        const out = await figmaCreateVariables({
          accessToken: token.access_token,
          fileKey,
          payload: {
            // minimal request shape: create variables only
            variables: payload.variables
          }
        });

        // Always return what happened (ok or error text)
        const result = {
          status: out.status,
          ok: out.ok,
          note: out.ok
            ? "Variables created (or accepted) by Figma."
            : "Figma rejected variable creation. Check scopes/permissions/plan.",
          responseBody: out.body,
          typography: payload.typography
        };

        return res.json({ jsonrpc: "2.0", id, result: textResult(result) });
      }

      if (toolName === "tokens_export_map") {
        const { fileKey } = args;

        // Read local vars to validate (best-effort)
        const vars = await figmaGetLocalVariables({ accessToken: token.access_token, fileKey });

        const exportObj = {
          localVariablesStatus: vars.status,
          localVariablesOk: vars.ok,
          localVariablesBody: vars.body,
          export: buildCssExport({
            // This export is “brand-pack driven”; if you want it “figma-driven”,
            // we’ll parse vars.body in the next iteration.
            brand: { colors: {}, typography: {} }
          })
        };

        return res.json({ jsonrpc: "2.0", id, result: textResult(exportObj) });
      }

      if (toolName === "project_manifest_write") {
        const { fileKey, manifest } = args;
        const w = manifestStore.write({ fileKey, manifest });
        return res.json({ jsonrpc: "2.0", id, result: textResult({ ok: true, ...w }) });
      }

      if (toolName === "project_manifest_read") {
        const { fileKey } = args;
        const m = manifestStore.read({ fileKey });
        return res.json({ jsonrpc: "2.0", id, result: textResult({ ok: true, manifest: m }) });
      }

      return res.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unknown tool: ${toolName}` }
      });
    }

    return res.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Unknown method" }
    });
  }

  // JSON-RPC endpoints
  app.post("/mcp", handleRpc);
  app.post("/mcp/sse", handleRpc);
}