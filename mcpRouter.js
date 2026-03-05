// mcpRouter.js
import {
  figmaGetFile,
  figmaGetNodes,
  figmaGetLocalVariables,
  figmaCreateVariables,
} from "./figmaApi.js";
import { createManifestStore } from "./manifestStore.js";

/**
 * MCP tools exposed to the agent
 */
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

  // ---- Vertical slice C tools ----
  {
    name: "tokens_bootstrap_from_brand",
    description:
      "Create primitive + semantic tokens (Figma Variables) from a brand pack (Light/Desktop).",
    inputSchema: {
      type: "object",
      properties: {
        fileKey: { type: "string" },
        brand: {
          type: "object",
          properties: {
            colors: {
              type: "object",
              description:
                "Hex colors. Example: { primary: '#1E40AF', accent: '#F59E0B', neutral: '#111827', background: '#FFFFFF' }",
            },
            typography: {
              type: "object",
              description:
                "Typography choices. Example: { fontFamily: 'Inter', scale: { body: 16, h1: 40 } }",
            },
          },
          required: ["colors", "typography"],
        },
        mode: { type: "string", enum: ["Light"], default: "Light" },
      },
      required: ["fileKey", "brand"],
    },
  },
  {
    name: "tokens_export_map",
    description:
      "Export tokens as CSS variables (globals.css snippet) + token map for shadcn.",
    inputSchema: {
      type: "object",
      properties: { fileKey: { type: "string" } },
      required: ["fileKey"],
    },
  },
  {
    name: "project_manifest_write",
    description: "Write project manifest snapshot (phase=ds) to server-side store.",
    inputSchema: {
      type: "object",
      properties: {
        fileKey: { type: "string" },
        manifest: { type: "object" },
      },
      required: ["fileKey", "manifest"],
    },
  },
  {
    name: "project_manifest_read",
    description: "Read last manifest snapshot for a fileKey from server-side store.",
    inputSchema: {
      type: "object",
      properties: { fileKey: { type: "string" } },
      required: ["fileKey"],
    },
  },
];

function textResult(obj) {
  return {
    content: [
      {
        type: "text",
        text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2),
      },
    ],
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

/**
 * Figma expects 0..1 floats
 */
function hexToRgba01(hex) {
  const h = String(hex || "").replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (full.length !== 6) return null;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  return { r, g, b, a: 1 };
}

/**
 * IMPORTANT: variable names cannot contain dots (.)
 * Use folders with slash: color/primary, semantic/bg, etc.
 */
function buildTokenNameMap({ brand }) {
  const { colors } = brand;

  const prim = {
    "color/primary": colors.primary,
    "color/accent": colors.accent,
    "color/neutral/900": colors.neutral || "#111827",
    "color/background": colors.background || "#FFFFFF",
  };

  const sem = {
    "semantic/bg": prim["color/background"],
    "semantic/fg": prim["color/neutral/900"],
    "semantic/brand": prim["color/primary"],
    "semantic/accent": prim["color/accent"],
  };

  return { ...prim, ...sem };
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
    "}",
  ].join("\n");

  const tokenMap = {
    "semantic.brand": "var(--color-brand)",
    "semantic.accent": "var(--color-accent)",
    "semantic.fg": "var(--color-fg)",
    "semantic.bg": "var(--color-bg)",
    "typography.fontFamily": "var(--font-sans)",
  };

  return { globalsCssPreview: css, tokenMap };
}

/**
 * Finds an existing collection by name (exact match).
 */
function findCollectionByName(localVarsBody, name) {
  const collections = localVarsBody?.meta?.variableCollections || {};
  for (const [id, col] of Object.entries(collections)) {
    if (col?.name === name) return { id, col };
  }
  return null;
}

/**
 * Builds a lookup of existing variables by name
 */
function buildExistingVarByName(localVarsBody) {
  const vars = localVarsBody?.meta?.variables || {};
  const map = new Map();
  for (const v of Object.values(vars)) {
    if (v?.name) map.set(v.name, v);
  }
  return map;
}

/**
 * Main MCP attach
 */
export function attachMcpRoutes(app, tokenStore) {
  const authorized = attachAuth({ sharedKey: process.env.MCP_AUTH_KEY });
  const manifestStore = createManifestStore({
    dir: process.env.MANIFEST_STORE_DIR || ".data/manifests",
  });

  // ---- SMART ENDPOINT ----
  app.get("/mcp", (req, res) => {
    if (!authorized(req)) return res.status(401).send("Unauthorized");
    const accept = (req.get("accept") || "").toLowerCase();
    if (!accept.includes("text/event-stream")) return res.json({ tools: TOOLS });
    return startSSE(req, res);
  });

  // ---- SSE endpoint ----
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
        error: { code: -32600, message: "Invalid Request" },
      });
    }

    if (method === "initialize") {
      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-03-26",
          serverInfo: { name: "figma-bridge-mcp", version: "1.2.0" },
          capabilities: { tools: {} },
        },
      });
    }

    if (method === "tools/list") {
      return res.json({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    }

    if (method !== "tools/call") {
      return res.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Unknown method" },
      });
    }

    // ---- tools/call ----
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

    try {
      // -------------------------
      // figma_get_file
      // -------------------------
      if (toolName === "figma_get_file") {
        const out = await figmaGetFile({
          accessToken: token.access_token,
          fileKey: args.fileKey,
        });
        return res.json({ jsonrpc: "2.0", id, result: textResult(out.body) });
      }

      // -------------------------
      // figma_get_nodes
      // -------------------------
      if (toolName === "figma_get_nodes") {
        const out = await figmaGetNodes({
          accessToken: token.access_token,
          fileKey: args.fileKey,
          nodeIds: args.nodeIds,
        });
        return res.json({ jsonrpc: "2.0", id, result: textResult(out.body) });
      }

      // -------------------------
      // tokens_bootstrap_from_brand
      // -------------------------
      if (toolName === "tokens_bootstrap_from_brand") {
        const fileKey = args.fileKey;
        const brand = args.brand || {};
        const typography = brand.typography || {};

        // 1) Read local variables so we can:
        //    - reuse "Tokens" collection if exists
        //    - update existing variables by name if they exist
        const local = await figmaGetLocalVariables({
          accessToken: token.access_token,
          fileKey,
        });

        if (!local.ok) {
          return res.json({
            jsonrpc: "2.0",
            id,
            result: textResult({
              ok: false,
              status: local.status,
              note: "Could not read local variables. Check scopes: file_variables:read",
              responseBody: local.body,
            }),
          });
        }

        const tokens = buildTokenNameMap({ brand });
        const existingByName = buildExistingVarByName(local.body);

        // 2) Find or create collection "Tokens"
        let collectionId = null;
        let modeId = null;
        let createdCollectionStep = null;

        const found = findCollectionByName(local.body, "Tokens");
        if (found) {
          collectionId = found.id;
          modeId = found.col?.defaultModeId || found.col?.modes?.[0]?.modeId || null;
        }

        // If missing, create collection (ONLY collection) first,
        // then re-fetch to get real IDs.
        if (!collectionId || !modeId) {
          const createCollectionPayload = {
            variableCollections: [
              {
                action: "CREATE",
                id: "tokens_collection",
                name: "Tokens",
                initialModeId: "tokens_mode",
                modes: [{ modeId: "tokens_mode", name: "Mode 1" }],
              },
            ],
            variables: [],
            variableModeValues: [],
          };

          const createCol = await figmaCreateVariables({
            accessToken: token.access_token,
            fileKey,
            payload: createCollectionPayload,
          });

          createdCollectionStep = { ok: createCol.ok, status: createCol.status, body: createCol.body };

          if (!createCol.ok) {
            return res.json({
              jsonrpc: "2.0",
              id,
              result: textResult({
                ok: false,
                status: createCol.status,
                note: "Figma rejected collection creation.",
                responseBody: createCol.body,
              }),
            });
          }

          // Re-fetch to resolve real IDs
          const local2 = await figmaGetLocalVariables({
            accessToken: token.access_token,
            fileKey,
          });

          const found2 = findCollectionByName(local2.body, "Tokens");
          if (!found2) {
            return res.json({
              jsonrpc: "2.0",
              id,
              result: textResult({
                ok: false,
                status: 500,
                note: "Created collection but cannot find it after re-fetch. Paste localVariablesBody to debug.",
                localVariablesBody: local2.body,
                createdCollectionStep,
              }),
            });
          }

          collectionId = found2.id;
          modeId = found2.col?.defaultModeId || found2.col?.modes?.[0]?.modeId || null;
        }

        // 3) Build VARIABLES + VARIABLE MODE VALUES
        // IMPORTANT: values must be set via variableModeValues (Figma batch API)
        const variables = [];
        const variableModeValues = [];
        const planned = [];

        let i = 0;
        for (const [name, hex] of Object.entries(tokens)) {
          const rgba = hexToRgba01(hex) || { r: 1, g: 1, b: 1, a: 1 };
          const existing = existingByName.get(name);

          // If exists -> UPDATE
          // If not -> CREATE with temp id
          const action = existing?.id ? "UPDATE" : "CREATE";
          const variableId = existing?.id ? existing.id : `tok_${i++}`;

          planned.push({ name, action });

          variables.push({
            action,
            id: variableId,
            name,
            variableCollectionId: collectionId,
            resolvedType: "COLOR",
            scopes: ["ALL_SCOPES"],
          });

          variableModeValues.push({
            variableId,
            modeId,
            value: rgba,
          });
        }

        const payload = {
          variableCollections: [],
          variables,
          variableModeValues,
        };

        const out = await figmaCreateVariables({
          accessToken: token.access_token,
          fileKey,
          payload,
        });

        const result = {
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
            createdCollectionStep,
            planned,
            computedSample: Object.entries(tokens)
              .slice(0, 4)
              .map(([name, hex]) => ({
                name,
                hex,
                rgba: hexToRgba01(hex),
                existingId: existingByName.get(name)?.id || null,
                modeId,
              })),
          },
        };

        return res.json({ jsonrpc: "2.0", id, result: textResult(result) });
      }

      // -------------------------
      // tokens_export_map
      // -------------------------
      if (toolName === "tokens_export_map") {
        const { fileKey } = args;

        // Read local vars to validate (best-effort)
        const vars = await figmaGetLocalVariables({
          accessToken: token.access_token,
          fileKey,
        });

        const exportObj = {
          localVariablesStatus: vars.status,
          localVariablesOk: vars.ok,
          localVariablesBody: vars.body,
          export: buildCssExport({
            // brand-pack driven export for now
            brand: { colors: {}, typography: {} },
          }),
        };

        return res.json({ jsonrpc: "2.0", id, result: textResult(exportObj) });
      }

      // -------------------------
      // project_manifest_write
      // -------------------------
      if (toolName === "project_manifest_write") {
        const { fileKey, manifest } = args;
        const w = manifestStore.write({ fileKey, manifest });
        return res.json({ jsonrpc: "2.0", id, result: textResult({ ok: true, ...w }) });
      }

      // -------------------------
      // project_manifest_read
      // -------------------------
      if (toolName === "project_manifest_read") {
        const { fileKey } = args;
        const m = manifestStore.read({ fileKey });
        return res.json({ jsonrpc: "2.0", id, result: textResult({ ok: true, manifest: m }) });
      }

      return res.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unknown tool: ${toolName}` },
      });
    } catch (e) {
      return res.json({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: e?.message || String(e),
        },
      });
    }
  }

  // JSON-RPC endpoints
  app.post("/mcp", handleRpc);
  app.post("/mcp/sse", handleRpc);
}