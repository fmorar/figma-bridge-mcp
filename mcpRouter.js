// mcpRouter.js
import {
  figmaGetFile,
  figmaGetNodes,
  figmaGetLocalVariables,
  figmaCreateVariables
} from "./figmaApi.js";
import { createManifestStore } from "./manifestStore.js";

/**
 * Tools exposed to MCP clients
 */
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
    description:
      "Create/update primitive + semantic tokens (Figma Variables) from a brand pack (Light/Desktop).",
    inputSchema: {
      type: "object",
      properties: {
        fileKey: { type: "string" },
        brand: {
          type: "object",
          properties: {
            colors: { type: "object" },
            typography: { type: "object" }
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
    description:
      "Export tokens as CSS variables (globals.css snippet) + token map for shadcn.",
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
      properties: { fileKey: { type: "string" } },
      required: ["fileKey"]
    }
  }
];

function textResult(obj) {
  return {
    content: [
      {
        type: "text",
        text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2)
      }
    ]
  };
}

function jsonRpcError(res, { id, code, message }) {
  return res.json({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message }
  });
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

function normalizeToolName(name) {
  if (!name || typeof name !== "string") return name;
  // Some agent platforms prefix tool names (e.g., "a_tokens_bootstrap_from_brand")
  if (name.startsWith("a_")) return name.slice(2);
  return name;
}

function sanitizeVarName(name) {
  // Figma variables reject "." and some other chars; "/" works well for grouping
  return String(name || "")
    .trim()
    .replace(/\./g, "/")
    .replace(/\s+/g, " ");
}

function hexToRgba01(hex) {
  const h = (hex || "").replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (full.length !== 6) return null;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  if (![r, g, b].every((x) => Number.isFinite(x))) return null;
  return { r, g, b, a: 1 };
}

function buildBrandTokenList({ brand }) {
  const colors = brand?.colors || {};
  const typography = brand?.typography || {};

  const prim = {
    "color/primary": colors.primary,
    "color/accent": colors.accent,
    "color/neutral/900": colors.neutral || "#111827",
    "color/background": colors.background || "#FFFFFF"
  };

  const sem = {
    "semantic/bg": prim["color/background"],
    "semantic/fg": prim["color/neutral/900"],
    "semantic/brand": prim["color/primary"],
    "semantic/accent": prim["color/accent"]
  };

  // Return the list we want to ensure exists in Figma
  const merged = { ...prim, ...sem };
  const tokens = Object.entries(merged).map(([name, hex]) => ({
    name: sanitizeVarName(name),
    hex: hex || "#000000",
    rgba: hexToRgba01(hex) || hexToRgba01("#000000")
  }));

  return { tokens, typography };
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

const FIGMA_OAUTH_REQUIRED = new Set([
  "figma_get_file",
  "figma_get_nodes",
  "tokens_bootstrap_from_brand",
  "tokens_export_map"
]);

/**
 * Helper: read local variables meta safely
 */
function extractLocalVarsMeta(varsResponseBody) {
  // Your figmaFetch wrapper returns {status, error, meta:{...}} (based on your logs)
  const meta = varsResponseBody?.meta || {};
  const variableCollections = meta.variableCollections || {};
  const variables = meta.variables || {};
  return { variableCollections, variables };
}

function findCollectionByName(variableCollections, name) {
  const entries = Object.entries(variableCollections || {});
  for (const [, col] of entries) {
    if (col?.name === name) return col;
  }
  return null;
}

function buildExistingVarMap(variables, collectionId) {
  const map = new Map(); // name -> varObject
  for (const [, v] of Object.entries(variables || {})) {
    if (!v) continue;
    if (collectionId && v.variableCollectionId !== collectionId) continue;
    if (typeof v.name === "string") map.set(v.name, v);
  }
  return map;
}

export function attachMcpRoutes(app, tokenStore) {
  const authorized = attachAuth({ sharedKey: process.env.MCP_AUTH_KEY });
  const manifestStore = createManifestStore({
    dir: process.env.MANIFEST_STORE_DIR || ".data/manifests"
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
    const body = req.body || {};
    const { jsonrpc, id, method, params } = body;

    if (!authorized(req)) {
      return jsonRpcError(res, {
        id,
        code: 401,
        message:
          "Unauthorized: missing/invalid MCP_AUTH_KEY. Provide Authorization: Bearer <key> or ?authKey=<key> or x-mcp-auth:<key>."
      });
    }

    if (jsonrpc !== "2.0" || !method) {
      return jsonRpcError(res, { id, code: -32600, message: "Invalid Request" });
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

    if (method !== "tools/call") {
      return jsonRpcError(res, { id, code: -32601, message: "Unknown method" });
    }

    // tools/call
    const toolNameRaw = params?.name;
    const toolName = normalizeToolName(toolNameRaw);
    const args = params?.arguments || {};

    try {
      // Decide OAuth requirement per tool
      let accessToken = null;

      // Manifest store tools (NO OAuth)
      if (toolName === "project_manifest_write") {
        const { fileKey, manifest } = args;
        const w = manifestStore.write({ fileKey, manifest });
        return res.json({
          jsonrpc: "2.0",
          id,
          result: textResult({ ok: true, ...w })
        });
      }

      if (toolName === "project_manifest_read") {
        const { fileKey } = args;
        const m = manifestStore.read({ fileKey });
        return res.json({
          jsonrpc: "2.0",
          id,
          result: textResult({ ok: true, manifest: m })
        });
      }

      // Figma tools (OAuth required)
      if (FIGMA_OAUTH_REQUIRED.has(toolName)) {
        const token = await (tokenStore?.load?.() ?? null);
        if (!token?.access_token) {
          return jsonRpcError(res, {
            id,
            code: 401,
            message: "OAuth required: open /auth/figma/login first"
          });
        }
        accessToken = token.access_token;
      }

      if (toolName === "figma_get_file") {
        const out = await figmaGetFile({ accessToken, fileKey: args.fileKey });
        return res.json({ jsonrpc: "2.0", id, result: textResult(out.body) });
      }

      if (toolName === "figma_get_nodes") {
        const out = await figmaGetNodes({
          accessToken,
          fileKey: args.fileKey,
          nodeIds: args.nodeIds
        });
        return res.json({ jsonrpc: "2.0", id, result: textResult(out.body) });
      }

      /**
       * ✅ FIXED tokens_bootstrap_from_brand
       * - Uses real modeId keys for valuesByMode
       * - Uses CREATE/UPDATE actions
       * - Ensures collection exists and extracts its defaultModeId
       */
      if (toolName === "tokens_bootstrap_from_brand") {
        const fileKey = args.fileKey;
        const brand = args.brand;

        // 1) Get local vars (so we can find collection + modeId)
        const before = await figmaGetLocalVariables({ accessToken, fileKey });
        if (!before.ok) {
          return res.json({
            jsonrpc: "2.0",
            id,
            result: textResult({
              ok: false,
              status: before.status,
              note: "Could not read local variables before writing.",
              responseBody: before.body
            })
          });
        }

        let { variableCollections, variables } = extractLocalVarsMeta(before.body);

        // 2) Find or create collection "Tokens"
        const COLLECTION_NAME = "Tokens";
        let collection = findCollectionByName(variableCollections, COLLECTION_NAME);

        let createdCollectionStep = null;

        if (!collection) {
          // Create collection via /variables endpoint using action discriminator
          // Use a temp id so Figma can map it back (tempIdToRealId)
          const tempCollectionId = "tokens_collection";

          const createCollectionPayload = {
            variableCollections: [
              {
                action: "CREATE",
                id: tempCollectionId,
                name: COLLECTION_NAME,
                // Minimal modes; Figma will assign real modeId(s)
                modes: [{ name: "Mode 1" }]
              }
            ],
            variables: []
          };

          createdCollectionStep = await figmaCreateVariables({
            accessToken,
            fileKey,
            payload: createCollectionPayload
          });

          if (!createdCollectionStep.ok) {
            return res.json({
              jsonrpc: "2.0",
              id,
              result: textResult({
                ok: false,
                status: createdCollectionStep.status,
                note: "❌ Failed to create Tokens collection.",
                responseBody: createdCollectionStep.body
              })
            });
          }

          // Re-read local vars to get the real collectionId/modeId
          const afterCreate = await figmaGetLocalVariables({ accessToken, fileKey });
          ({ variableCollections, variables } = extractLocalVarsMeta(afterCreate.body));
          collection = findCollectionByName(variableCollections, COLLECTION_NAME);
        }

        if (!collection?.id) {
          return res.json({
            jsonrpc: "2.0",
            id,
            result: textResult({
              ok: false,
              status: 500,
              note:
                "Created/expected collection but could not locate it via /variables/local. Check response shape.",
              debug: { collection }
            })
          });
        }

        const collectionId = collection.id;
        const modeId =
          collection.defaultModeId ||
          (Array.isArray(collection.modes) && collection.modes[0]?.modeId) ||
          null;

        if (!modeId) {
          return res.json({
            jsonrpc: "2.0",
            id,
            result: textResult({
              ok: false,
              status: 500,
              note:
                "Found collection but could not determine a modeId (defaultModeId missing).",
              debug: { collection }
            })
          });
        }

        // 3) Build plan (CREATE vs UPDATE)
        const existingByName = buildExistingVarMap(variables, collectionId);
        const { tokens, typography } = buildBrandTokenList({ brand });

        const planned = [];
        const variableOps = [];

        for (const t of tokens) {
          const existing = existingByName.get(t.name);

          if (existing?.id) {
            planned.push({ name: t.name, action: "UPDATE" });
            variableOps.push({
              action: "UPDATE",
              id: existing.id,
              name: t.name,
              variableCollectionId: collectionId,
              resolvedType: "COLOR",
              valuesByMode: {
                [modeId]: t.rgba
              }
            });
          } else {
            planned.push({ name: t.name, action: "CREATE" });
            variableOps.push({
              action: "CREATE",
              name: t.name,
              variableCollectionId: collectionId,
              resolvedType: "COLOR",
              valuesByMode: {
                [modeId]: t.rgba
              }
            });
          }
        }

        // 4) Write variables (no need to include variableCollections unless you are also updating them)
        const writePayload = { variables: variableOps };

        const out = await figmaCreateVariables({
          accessToken,
          fileKey,
          payload: writePayload
        });

        return res.json({
          jsonrpc: "2.0",
          id,
          result: textResult({
            ok: out.ok,
            status: out.status,
            responseBody: out.body,
            typography,
            note: out.ok
              ? "✅ Variables created/updated in Figma."
              : "❌ Figma rejected variable write. See responseBody.",
            debug: {
              usedCollectionId: collectionId,
              usedModeId: modeId,
              createdCollectionStep: createdCollectionStep
                ? { ok: createdCollectionStep.ok, status: createdCollectionStep.status, body: createdCollectionStep.body }
                : null,
              planned,
              computedSample: tokens.slice(0, 4).map((x) => ({
                name: x.name,
                hex: x.hex,
                rgba: x.rgba,
                existingId: existingByName.get(x.name)?.id || null,
                modeId
              }))
            }
          })
        });
      }

      if (toolName === "tokens_export_map") {
        const vars = await figmaGetLocalVariables({ accessToken, fileKey: args.fileKey });
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

      return jsonRpcError(res, {
        id,
        code: -32601,
        message: `Unknown tool: ${toolNameRaw}`
      });
    } catch (err) {
      console.error("[MCP handleRpc error]", err);
      return jsonRpcError(res, {
        id,
        code: -32000,
        message: err?.message || "Internal error"
      });
    }
  }

  // JSON-RPC endpoints
  app.post("/mcp", handleRpc);
  app.post("/mcp/sse", handleRpc);
}