// src/mcpRouter.js
import { figmaGetFile, figmaGetNodes, figmaGetLocalVariables, figmaCreateVariables } from "./figmaApi.js";
import { createManifestStore } from "./manifestStore.js";

const TOOLS = [
  { name: "figma_get_file", description: "Fetch Figma file", inputSchema: { type: "object", properties: { fileKey: { type: "string" } }, required: ["fileKey"] } },
  { name: "figma_get_nodes", description: "Fetch specific nodes", inputSchema: { type: "object", properties: { fileKey: { type: "string" }, nodeIds: { type: "array", items: { type: "string" } } }, required: ["fileKey", "nodeIds"] } },

  { name: "tokens_bootstrap_from_brand", description: "Create primitive + semantic tokens (Figma Variables) from a brand pack (Light/Desktop).",
    inputSchema: { type: "object", properties: { fileKey: { type: "string" }, brand: { type: "object", properties: { colors: { type: "object" }, typography: { type: "object" } }, required: ["colors","typography"] }, mode: { type: "string", enum: ["Light"], default: "Light" } }, required: ["fileKey","brand"] } },

  { name: "tokens_export_map", description: "Export tokens as CSS variables (globals.css snippet) + token map for shadcn.",
    inputSchema: { type: "object", properties: { fileKey: { type: "string" } }, required: ["fileKey"] } },

  { name: "project_manifest_write", description: "Write project manifest snapshot (phase=ds) to server-side store.",
    inputSchema: { type: "object", properties: { fileKey: { type: "string" }, manifest: { type: "object" } }, required: ["fileKey","manifest"] } },

  { name: "project_manifest_read", description: "Read last manifest snapshot for a fileKey from server-side store.",
    inputSchema: { type: "object", properties: { fileKey: { type: "string" } }, required: ["fileKey"] } }
];

function textResult(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

function parseAuth(req) {
  // ✅ soporta Authorization, query ?authKey=, y header x-mcp-auth
  const authHeader = (req.get("authorization") || "").trim();
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  const bearer = m?.[1]?.trim();

  const q = (req.query?.authKey || "").toString().trim();
  const x = (req.get("x-mcp-auth") || "").toString().trim();

  return bearer || q || x || null;
}

function attachAuth({ sharedKey }) {
  return function authorized(req) {
    // ✅ si no configuras MCP_AUTH_KEY, no bloquea (modo dev)
    if (!sharedKey) return true;
    const key = parseAuth(req);
    return Boolean(key && key === sharedKey);
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

function normalizeToolName(name) {
  if (!name || typeof name !== "string") return name;
  if (name.startsWith("a_")) return name.slice(2);
  return name;
}

function jsonRpcError(res, id, code, message, data) {
  return res.json({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data ? { data } : {}) }
  });
}

function hexToRgba01(hex) {
  const h = (hex || "").replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (full.length !== 6) return null;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  return { r, g, b, a: 1 };
}

function buildVariablesPayload({ brand }) {
  const { colors, typography } = brand;

  const prim = {
    "color.primary": colors.primary,
    "color.accent": colors.accent,
    "color.neutral.900": colors.neutral || "#111827",
    "color.background": colors.background || "#FFFFFF"
  };

  const sem = {
    "semantic.bg": prim["color.background"],
    "semantic.fg": prim["color.neutral.900"],
    "semantic.brand": prim["color.primary"],
    "semantic.accent": prim["color.accent"]
  };

  const variables = [];
  for (const [name, hex] of Object.entries({ ...prim, ...sem })) {
    const rgba = hexToRgba01(hex) || hexToRgba01("#000000");
    variables.push({
      name,
      resolvedType: "COLOR",
      valuesByMode: { Light: rgba }
    });
  }

  return { variables, typography };
}

function buildCssExport({ brand }) {
  const c = brand?.colors || {};
  const t = brand?.typography || {};

  const globalsCssPreview = [
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

  return { globalsCssPreview, tokenMap };
}

export function attachMcpRoutes(app, tokenStore) {
  const authorized = attachAuth({ sharedKey: process.env.MCP_AUTH_KEY });
  const manifestStore = createManifestStore({ dir: process.env.MANIFEST_STORE_DIR || ".data/manifests" });

  // GET endpoints (tools list / SSE)
  app.get("/mcp", (req, res) => {
    if (!authorized(req)) return res.status(401).send("Unauthorized");
    const accept = (req.get("accept") || "").toLowerCase();
    if (!accept.includes("text/event-stream")) return res.json({ tools: TOOLS });
    return startSSE(req, res);
  });

  app.get("/mcp/sse", (req, res) => {
    if (!authorized(req)) return res.status(401).send("Unauthorized");
    return startSSE(req, res);
  });

  function toolsCompat(req, res) {
    if (!authorized(req)) return res.status(401).send("Unauthorized");
    return res.json({ tools: TOOLS });
  }
  app.get("/mcp/tools", toolsCompat);
  app.post("/mcp/tools", toolsCompat);
  app.get("/mcp/sse/tools", toolsCompat);
  app.post("/mcp/sse/tools", toolsCompat);

  async function handleRpc(req, res) {
    const body = req.body || {};
    const { jsonrpc, id, method, params } = body;

    // ✅ IMPORTANTE: si no está autorizado, responde JSON-RPC (no texto)
    if (!authorized(req)) {
      return jsonRpcError(res, id, 401, "Unauthorized: missing/invalid MCP_AUTH_KEY. Send Authorization: Bearer <key> or ?authKey=<key>.");
    }

    try {
      if (jsonrpc !== "2.0" || !method) {
        return jsonRpcError(res, id, -32600, "Invalid Request");
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
        const toolNameRaw = params?.name;
        const toolName = normalizeToolName(toolNameRaw);
        const args = params?.arguments || {};

        console.log("[MCP tools/call]", {
          toolNameRaw,
          toolName,
          fileKey: args?.fileKey,
          hasAuthKey: Boolean(parseAuth(req)),
        });

        const token = await (tokenStore?.load?.() ?? null);
        if (!token?.access_token) {
          return jsonRpcError(res, id, 401, "OAuth required: open /auth/figma/login first");
        }

        if (toolName === "tokens_bootstrap_from_brand") {
          const { fileKey, brand } = args;
          const payload = buildVariablesPayload({ brand });

          const out = await figmaCreateVariables({
            accessToken: token.access_token,
            fileKey,
            payload: { variables: payload.variables }
          });

          return res.json({
            jsonrpc: "2.0",
            id,
            result: textResult({
              ok: out.ok,
              status: out.status,
              responseBody: out.body,
              typography: payload.typography
            })
          });
        }

        if (toolName === "tokens_export_map") {
          const { fileKey } = args;
          const vars = await figmaGetLocalVariables({ accessToken: token.access_token, fileKey });

          return res.json({
            jsonrpc: "2.0",
            id,
            result: textResult({
              localVariablesStatus: vars.status,
              localVariablesOk: vars.ok,
              localVariablesBody: vars.body,
              export: buildCssExport({ brand: args.brand || { colors: {}, typography: {} } })
            })
          });
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

        return jsonRpcError(res, id, -32601, `Unknown tool: ${toolNameRaw}`);
      }

      return jsonRpcError(res, id, -32601, "Unknown method");
    } catch (err) {
      console.error("[MCP handleRpc] uncaught:", err);
      return jsonRpcError(res, id, -32000, err?.message || "Tool call failed", { stack: err?.stack });
    }
  }

  app.post("/mcp", handleRpc);
  app.post("/mcp/sse", handleRpc);
}