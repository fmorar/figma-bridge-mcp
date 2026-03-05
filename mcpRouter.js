// mcpRouter.js
import {
  figmaGetFile,
  figmaGetNodes,
  figmaGetLocalVariables,
  figmaCreateVariables,
} from "./figmaApi.js";
import { createManifestStore } from "./manifestStore.js";

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
            typography: { type: "object" },
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
      properties: { fileKey: { type: "string" }, manifest: { type: "object" } },
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
      { type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) },
    ],
  };
}

function parseAuth(req) {
  const h = (req.get("authorization") || "").trim();
  const m = h.match(/^Bearer\s+(.+)$/i);
  const bearer = m?.[1]?.trim();
  const q = (req.query?.authKey || "").toString().trim();
  const x = (req.get("x-mcp-auth") || "").toString().trim();
  return bearer || q || x || null;
}

function attachAuth({ sharedKey }) {
  return function authorized(req) {
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

function jsonRpcError(res, { id, code, message, data }) {
  return res.status(200).json({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data ? { data } : {}) },
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
    "}",
  ].join("\n");

  const tokenMap = {
    "semantic.brand": "var(--color-brand)",
    "semantic.accent": "var(--color-accent)",
    "semantic.fg": "var(--color-fg)",
    "semantic.bg": "var(--color-bg)",
    "typography.fontFamily": "var(--font-sans)",
  };

  return { globalsCssPreview, tokenMap };
}

// Figma rejects "." in variable names on your endpoint
function sanitizeVarName(name) {
  return String(name || "")
    .trim()
    .replace(/\.+/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\//, "")
    .replace(/\/$/, "");
}

function findCollectionByName(metaBody, name) {
  const collections = metaBody?.meta?.variableCollections || {};
  for (const c of Object.values(collections)) {
    if (c?.name === name) return c;
  }
  return null;
}

function getModeIdForCollection(collection) {
  return collection?.defaultModeId || collection?.modes?.[0]?.modeId || null;
}

function findExistingVariableId(metaBody, collectionId, varName) {
  const vars = metaBody?.meta?.variables || {};
  for (const v of Object.values(vars)) {
    if (v?.variableCollectionId === collectionId && v?.name === varName) return v?.id || null;
  }
  return null;
}

function buildVariableMutationsIdempotent({ brand, collectionId, modeId, metaBody }) {
  const { colors, typography } = brand;

  const prim = {
    "color.primary": colors.primary,
    "color.accent": colors.accent,
    "color.neutral.900": colors.neutral || "#111827",
    "color.background": colors.background || "#FFFFFF",
  };

  const sem = {
    "semantic.bg": prim["color.background"],
    "semantic.fg": prim["color.neutral.900"],
    "semantic.brand": prim["color.primary"],
    "semantic.accent": prim["color.accent"],
  };

  const mutations = [];
  const planned = [];

  for (const [rawName, hex] of Object.entries({ ...prim, ...sem })) {
    const name = sanitizeVarName(rawName);
    const rgba = hexToRgba01(hex) || hexToRgba01("#000000");

    const existingId = findExistingVariableId(metaBody, collectionId, name);

    if (existingId) {
      mutations.push({
        action: "UPDATE",
        id: existingId,
        name,
        variableCollectionId: collectionId,
        resolvedType: "COLOR",
        valuesByMode: { [modeId]: rgba },
      });
      planned.push({ name, action: "UPDATE", id: existingId });
    } else {
      mutations.push({
        action: "CREATE",
        name,
        variableCollectionId: collectionId,
        resolvedType: "COLOR",
        valuesByMode: { [modeId]: rgba },
      });
      planned.push({ name, action: "CREATE" });
    }
  }

  return { variables: mutations, typography, planned };
}

const FIGMA_OAUTH_REQUIRED = new Set([
  "figma_get_file",
  "figma_get_nodes",
  "tokens_bootstrap_from_brand",
  "tokens_export_map",
]);

export function attachMcpRoutes(app, tokenStore) {
  const authorized = attachAuth({ sharedKey: process.env.MCP_AUTH_KEY });
  const manifestStore = createManifestStore({
    dir: process.env.MANIFEST_STORE_DIR || ".data/manifests",
  });

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
          "Unauthorized: missing/invalid MCP_AUTH_KEY. Provide Authorization: Bearer <key> or ?authKey=<key> or x-mcp-auth:<key>.",
      });
    }

    try {
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
            capabilities: { tools: {} },
          },
        });
      }

      if (method === "tools/list") {
        return res.json({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      }

      if (method === "tools/call") {
        const toolNameRaw = params?.name;
        const toolName = normalizeToolName(toolNameRaw);
        const args = params?.arguments || {};

        let accessToken = null;
        if (FIGMA_OAUTH_REQUIRED.has(toolName)) {
          const token = await (tokenStore?.load?.() ?? null);
          if (!token?.access_token) {
            return jsonRpcError(res, {
              id,
              code: 401,
              message: "OAuth required: open /auth/figma/login first",
            });
          }
          accessToken = token.access_token;
        }

        // Manifest (no OAuth)
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

        // Figma
        if (toolName === "figma_get_file") {
          const out = await figmaGetFile({ accessToken, fileKey: args.fileKey });
          return res.json({ jsonrpc: "2.0", id, result: textResult(out.body) });
        }

        if (toolName === "figma_get_nodes") {
          const out = await figmaGetNodes({
            accessToken,
            fileKey: args.fileKey,
            nodeIds: args.nodeIds,
          });
          return res.json({ jsonrpc: "2.0", id, result: textResult(out.body) });
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
              export: buildCssExport({ brand: args.brand || { colors: {}, typography: {} } }),
            }),
          });
        }

        // ✅ Idempotent bootstrap
        if (toolName === "tokens_bootstrap_from_brand") {
          const { fileKey, brand } = args;
          const desiredCollectionName = "Tokens";

          // Read current meta
          const meta1 = await figmaGetLocalVariables({ accessToken, fileKey });
          if (!meta1.ok) {
            return res.json({
              jsonrpc: "2.0",
              id,
              result: textResult({
                ok: false,
                status: meta1.status,
                note: "Failed to read variables/local",
                responseBody: meta1.body,
              }),
            });
          }

          let collection = findCollectionByName(meta1.body, desiredCollectionName);

          // If missing, create it once
          let createdCollectionStep = null;
          if (!collection) {
            const createCollectionResp = await figmaCreateVariables({
              accessToken,
              fileKey,
              payload: {
                variableCollections: [
                  {
                    action: "CREATE",
                    name: desiredCollectionName,
                    modes: [{ modeId: "Light", name: "Light" }],
                  },
                ],
                variables: [],
              },
            });

            createdCollectionStep = { ok: createCollectionResp.ok, status: createCollectionResp.status };

            if (!createCollectionResp.ok) {
              return res.json({
                jsonrpc: "2.0",
                id,
                result: textResult({
                  ok: false,
                  status: createCollectionResp.status,
                  note: "Failed to create collection",
                  responseBody: createCollectionResp.body,
                }),
              });
            }

            // Re-read and pick by name
            const meta2 = await figmaGetLocalVariables({ accessToken, fileKey });
            if (!meta2.ok) {
              return res.json({
                jsonrpc: "2.0",
                id,
                result: textResult({
                  ok: false,
                  status: meta2.status,
                  note: "Collection created but variables/local re-read failed",
                  responseBody: meta2.body,
                }),
              });
            }

            collection = findCollectionByName(meta2.body, desiredCollectionName);
            if (!collection) {
              return res.json({
                jsonrpc: "2.0",
                id,
                result: textResult({
                  ok: false,
                  status: 500,
                  note: "Collection created but still not found by name in variables/local meta.",
                  debug: { variablesLocal: meta2.body },
                }),
              });
            }
          }

          const collectionId = collection.id;
          const modeIdReal = getModeIdForCollection(collection);

          if (!modeIdReal) {
            return res.json({
              jsonrpc: "2.0",
              id,
              result: textResult({
                ok: false,
                status: 500,
                note: "Could not resolve modeId for collection.",
                debug: { collection },
              }),
            });
          }

          // Re-read meta (fresh) to get variable IDs for UPDATE
          const metaNow = await figmaGetLocalVariables({ accessToken, fileKey });
          if (!metaNow.ok) {
            return res.json({
              jsonrpc: "2.0",
              id,
              result: textResult({
                ok: false,
                status: metaNow.status,
                note: "Could not re-read variables/local before mutations.",
                responseBody: metaNow.body,
              }),
            });
          }

          const payload = buildVariableMutationsIdempotent({
            brand,
            collectionId,
            modeId: modeIdReal,
            metaBody: metaNow.body,
          });

          const write = await figmaCreateVariables({
            accessToken,
            fileKey,
            payload: { variableCollections: [], variables: payload.variables },
          });

          return res.json({
            jsonrpc: "2.0",
            id,
            result: textResult({
              ok: write.ok,
              status: write.status,
              responseBody: write.body,
              typography: payload.typography,
              note: write.ok
                ? "✅ Variables created/updated in Figma."
                : "❌ Figma rejected variable write. See responseBody.",
              debug: {
                usedCollectionId: collectionId,
                usedModeId: modeIdReal,
                createdCollectionStep,
                planned: payload.planned,
              },
            }),
          });
        }

        return jsonRpcError(res, { id, code: -32601, message: `Unknown tool: ${toolNameRaw}` });
      }

      return jsonRpcError(res, { id, code: -32601, message: "Unknown method" });
    } catch (err) {
      console.error("[MCP handleRpc] uncaught error:", err);
      return jsonRpcError(res, {
        id,
        code: -32000,
        message: err?.message || "Tool call failed",
        data: { stack: err?.stack },
      });
    }
  }

  app.post("/mcp", handleRpc);
  app.post("/mcp/sse", handleRpc);
}