// mcpRouter.js
import {
  figmaGetFile,
  figmaGetNodes,
  figmaGetLocalVariables,
  figmaCreateVariables
} from "./figmaApi.js";
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
  {
    name: "tokens_bootstrap_from_brand",
    description: "Create/update primitive + semantic tokens (Figma Variables) from a brand pack.",
    inputSchema: {
      type: "object",
      properties: {
        fileKey: { type: "string" },
        brand: {
          type: "object",
          properties: { colors: { type: "object" }, typography: { type: "object" } },
          required: ["colors", "typography"]
        },
        mode: { type: "string", enum: ["Light"], default: "Light" }
      },
      required: ["fileKey", "brand"]
    }
  },
  {
    name: "tokens_export_map",
    description: "Export tokens as CSS variables (globals.css snippet) + token map.",
    inputSchema: {
      type: "object",
      properties: { fileKey: { type: "string" } },
      required: ["fileKey"]
    }
  },
  {
    name: "project_manifest_write",
    description: "Write project manifest snapshot (phase=ds) to server-side store.",
    inputSchema: {
      type: "object",
      properties: { fileKey: { type: "string" }, manifest: { type: "object" } },
      required: ["fileKey", "manifest"]
    }
  },
  {
    name: "project_manifest_read",
    description: "Read last manifest snapshot for a fileKey from server-side store.",
    inputSchema: {
      type: "object",
      properties: { fileKey: { type: "string" } },
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
  const x = (req.get("x-mcp-auth") || "").toString().trim();
  return bearer || q || x || null;
}

function attachAuth({ sharedKey }) {
  return function authorized(req) {
    // si no hay key configurada, no bloquees
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

function hexToRgba01(hex) {
  const h = (hex || "").replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (full.length !== 6) return null;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  return { r, g, b, a: 1 };
}

function normalizeVarName(name) {
  // Figma variables: evita "." (te dio error antes). Slash funciona perfecto.
  return String(name || "")
    .trim()
    .replace(/\.+/g, "/")
    .replace(/\/+/g, "/");
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

function extractMeta(body) {
  // Soporta diferentes wrappers según tu figmaApi.js
  // body puede venir como: {status,error,meta:{...}} o {meta:{...}} o {body:{meta:{...}}}
  if (!body) return null;
  if (body.meta) return body.meta;
  if (body.body?.meta) return body.body.meta;
  if (body.data?.meta) return body.data.meta;
  return null;
}

function pickTokensCollection(meta, preferName = "Tokens") {
  const collections = meta?.variableCollections || {};
  const vars = meta?.variables || {};

  const list = Object.values(collections).map((c) => {
    const count = Array.isArray(c.variableIds) ? c.variableIds.length : 0;
    return { ...c, _count: count };
  });

  const candidates = list.filter((c) => (c.name || "").trim() === preferName);

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // si hay varias “Tokens”, elige la que tenga más variables
  candidates.sort((a, b) => (b._count || 0) - (a._count || 0));
  return candidates[0];
}

async function ensureTokensCollection({ accessToken, fileKey, modeName = "Light" }) {
  // 1) lee variables existentes para hallar la colección
  const existing = await figmaGetLocalVariables({ accessToken, fileKey });
  const meta = extractMeta(existing?.body);
  const picked = pickTokensCollection(meta, "Tokens");

  if (picked?.id && picked?.defaultModeId) {
    return {
      ok: true,
      created: false,
      collectionId: picked.id,
      modeId: picked.defaultModeId,
      seenCollections: Object.values(meta?.variableCollections || {}).map((c) => ({
        id: c.id,
        name: c.name,
        variableCount: Array.isArray(c.variableIds) ? c.variableIds.length : 0,
        defaultModeId: c.defaultModeId
      }))
    };
  }

  // 2) no existe: créala (solo colección)
  // IMPORTANT: Figma usa ids temporales en writes.
  const tempCollectionId = "tokens_collection";
  const tempModeId = "mode_light";

  const createOut = await figmaCreateVariables({
    accessToken,
    fileKey,
    payload: {
      variableCollections: [
        {
          action: "CREATE",
          id: tempCollectionId,
          name: "Tokens",
          modes: [{ action: "CREATE", modeId: tempModeId, name: modeName }]
        }
      ],
      variables: []
    }
  });

  // 3) después de crear, vuelve a leer para obtener ids reales (lo más estable)
  const after = await figmaGetLocalVariables({ accessToken, fileKey });
  const afterMeta = extractMeta(after?.body);
  const afterPicked = pickTokensCollection(afterMeta, "Tokens");

  if (!afterPicked?.id || !afterPicked?.defaultModeId) {
    return {
      ok: false,
      created: true,
      status: createOut?.status,
      responseBody: createOut?.body,
      note: "Created collection but could not resolve collectionId/defaultModeId from subsequent read."
    };
  }

  return {
    ok: true,
    created: true,
    collectionId: afterPicked.id,
    modeId: afterPicked.defaultModeId,
    createdCollectionStep: { ok: createOut?.ok, status: createOut?.status, body: createOut?.body }
  };
}

function buildTokenSpec({ brand }) {
  const { colors, typography } = brand || {};
  const c = colors || {};

  const prim = {
    "color/primary": c.primary || "#1E40AF",
    "color/accent": c.accent || "#F59E0B",
    "color/neutral/900": c.neutral || "#111827",
    "color/background": c.background || "#FFFFFF"
  };

  const sem = {
    "semantic/bg": prim["color/background"],
    "semantic/fg": prim["color/neutral/900"],
    "semantic/brand": prim["color/primary"],
    "semantic/accent": prim["color/accent"]
  };

  const merged = { ...prim, ...sem };

  return {
    typography: typography || {},
    tokens: Object.entries(merged).map(([name, hex]) => ({
      name: normalizeVarName(name),
      hex: hex || "#000000",
      rgba: hexToRgba01(hex) || hexToRgba01("#000000")
    }))
  };
}

export function attachMcpRoutes(app, tokenStore) {
  const authorized = attachAuth({ sharedKey: process.env.MCP_AUTH_KEY });
  const manifestStore = createManifestStore({ dir: process.env.MANIFEST_STORE_DIR || ".data/manifests" });

  // Health / index (opcional, útil para "Cannot GET /")
  app.get("/", (_req, res) => {
    res.json({
      ok: true,
      service: "figma-bridge-mcp",
      baseUrl: process.env.PUBLIC_BASE_URL || "",
      endpoints: ["/mcp", "/mcp/tools", "/mcp/sse", "/auth/figma/login", "/auth/figma/callback"]
    });
  });

  // /mcp can return JSON tools OR open an SSE stream depending on Accept header
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
          serverInfo: { name: "figma-bridge-mcp", version: "1.2.0" },
          capabilities: { tools: {} }
        }
      });
    }

    if (method === "tools/list") {
      return res.json({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    }

    if (method === "tools/call") {
      const token = tokenStore.load?.() || tokenStore.get?.() || tokenStore.token?.();
      if (!token?.access_token) {
        return res.json({
          jsonrpc: "2.0",
          id,
          error: { code: 401, message: "OAuth required: open /auth/figma/login first" }
        });
      }

      const toolNameRaw = params?.name;
      const toolName = normalizeToolName(toolNameRaw);
      const args = params?.arguments || {};

      // --- figma_get_file ---
      if (toolName === "figma_get_file") {
        const out = await figmaGetFile({ accessToken: token.access_token, fileKey: args.fileKey });
        return res.json({ jsonrpc: "2.0", id, result: textResult(out.body) });
      }

      // --- figma_get_nodes ---
      if (toolName === "figma_get_nodes") {
        const out = await figmaGetNodes({
          accessToken: token.access_token,
          fileKey: args.fileKey,
          nodeIds: args.nodeIds
        });
        return res.json({ jsonrpc: "2.0", id, result: textResult(out.body) });
      }

      // --- tokens_bootstrap_from_brand ---
      if (toolName === "tokens_bootstrap_from_brand") {
        const { fileKey, brand, mode } = args;
        const spec = buildTokenSpec({ brand });

        // 1) asegúrate de tener collectionId + modeId REAL
        const ensured = await ensureTokensCollection({
          accessToken: token.access_token,
          fileKey,
          modeName: mode || "Light"
        });

        if (!ensured.ok) {
          return res.json({
            jsonrpc: "2.0",
            id,
            result: textResult({
              ok: false,
              status: ensured.status || 500,
              note: ensured.note || "Could not ensure Tokens collection",
              responseBody: ensured.responseBody,
              debug: ensured
            })
          });
        }

        const collectionId = ensured.collectionId;
        const modeId = ensured.modeId;

        // 2) lee variables para ver si existen (para UPDATE)
        const local = await figmaGetLocalVariables({ accessToken: token.access_token, fileKey });
        const meta = extractMeta(local?.body);
        const variables = meta?.variables || {};

        const existingByName = new Map();
        for (const v of Object.values(variables)) {
          if (v?.name && v?.variableCollectionId === collectionId) {
            existingByName.set(v.name, v);
          }
        }

        // 3) arma request usando modeId real
        const planned = [];
        const variableWrites = spec.tokens.map((t, i) => {
          const existing = existingByName.get(t.name);
          const action = existing ? "UPDATE" : "CREATE";
          planned.push({ name: t.name, action });

          return {
            action,
            id: existing?.id || `var_${i}`,
            name: t.name,
            variableCollectionId: collectionId,
            resolvedType: "COLOR",
            valuesByMode: {
              [modeId]: t.rgba
            }
          };
        });

        const out = await figmaCreateVariables({
          accessToken: token.access_token,
          fileKey,
          payload: { variableCollections: [], variables: variableWrites }
        });

        return res.json({
          jsonrpc: "2.0",
          id,
          result: textResult({
            ok: out.ok,
            status: out.status,
            responseBody: out.body,
            typography: spec.typography,
            note: out.ok ? "✅ Variables created/updated in Figma." : "❌ Figma rejected variable write.",
            debug: {
              usedCollectionId: collectionId,
              usedModeId: modeId,
              createdCollectionStep: ensured.created ? ensured.createdCollectionStep : null,
              planned,
              computedSample: spec.tokens.slice(0, 4).map((t) => ({
                name: t.name,
                hex: t.hex,
                rgba: t.rgba,
                modeId
              }))
            }
          })
        });
      }

      // --- tokens_export_map ---
      if (toolName === "tokens_export_map") {
        const { fileKey } = args;
        const vars = await figmaGetLocalVariables({ accessToken: token.access_token, fileKey });

        const exportObj = {
          localVariablesStatus: vars.status,
          localVariablesOk: vars.ok,
          localVariablesBody: vars.body,
          export: buildCssExport({ brand: args.brand || { colors: {}, typography: {} } })
        };

        return res.json({ jsonrpc: "2.0", id, result: textResult(exportObj) });
      }

      // --- manifest store ---
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
        error: { code: -32601, message: `Unknown tool: ${toolNameRaw}` }
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