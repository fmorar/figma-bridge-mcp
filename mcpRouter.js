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
    if (!sharedKey) return true; // dev open if not set
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

/**
 * Build variable CREATE mutations (Figma expects discriminator action)
 */
function buildVariableCreateMutations({ brand, collectionId, modeId = "Light" }) {
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

  const variables = [];

  for (const [name, hex] of Object.entries({ ...prim, ...sem })) {
    const rgba = hexToRgba01(hex) || hexToRgba01("#000000");

    variables.push({
      action: "CREATE",
      variable: {
        name,
        resolvedType: "COLOR",
        variableCollectionId: collectionId,
        valuesByMode: { [modeId]: rgba },
      },
    });
  }

  return { variables, typography };
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

  // /mcp can return JSON tools OR open an SSE stream depending on Accept header
  app.get("/mcp", (req, res) => {
    if (!authorized(req)) return res.status(401).send("Unauthorized");
    const accept = (req.get("accept") || "").toLowerCase();
    if (!accept.includes("text/event-stream")) return res.json({ tools: TOOLS });
    return startSSE(req, res);
  });

  // Force SSE content-type for strict clients
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

        // Load OAuth token only for Figma tools
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

        // ---- Manifest store tools (NO OAuth) ----
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

        // ---- Figma tools (OAuth required) ----
        if (toolName === "figma_get_file") {
          const out = await figmaGetFile({ accessToken: accessToken, fileKey: args.fileKey });
          return res.json({ jsonrpc: "2.0", id, result: textResult(out.body) });
        }

        if (toolName === "figma_get_nodes") {
          const out = await figmaGetNodes({
            accessToken: accessToken,
            fileKey: args.fileKey,
            nodeIds: args.nodeIds,
          });
          return res.json({ jsonrpc: "2.0", id, result: textResult(out.body) });
        }

        // ---- Slice C: export map ----
        if (toolName === "tokens_export_map") {
          const vars = await figmaGetLocalVariables({
            accessToken: accessToken,
            fileKey: args.fileKey,
          });

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

        // ---- Slice C: bootstrap tokens (create variables) ----
        if (toolName === "tokens_bootstrap_from_brand") {
          const { fileKey, brand } = args;

          // 1) Read local vars metadata to check collections
          const varsMeta = await figmaGetLocalVariables({ accessToken: accessToken, fileKey });

          if (!varsMeta.ok) {
            return res.json({
              jsonrpc: "2.0",
              id,
              result: textResult({
                ok: false,
                status: varsMeta.status,
                note: "Failed to read local variables metadata before bootstrap.",
                responseBody: varsMeta.body,
              }),
            });
          }

          const collectionsObj = varsMeta.body?.meta?.variableCollections || {};
          const collectionList = Object.values(collectionsObj);
          const hasAnyCollection = collectionList.length > 0;

          const collectionName = "Tokens";
          const modeId = "Light";

          // If collection exists, use its id
          // If not, we'll create one with tempId tokens_collection
          const existingCollectionId = hasAnyCollection ? collectionList[0]?.id : null;
          const targetCollectionId = hasAnyCollection ? existingCollectionId : "tokens_collection";

          const payload = buildVariableCreateMutations({
            brand,
            collectionId: targetCollectionId,
            modeId,
          });

          const requestBody = {
            variableCollections: hasAnyCollection
              ? []
              : [
                  {
                    action: "CREATE",
                    tempId: "tokens_collection",
                    variableCollection: {
                      name: collectionName,
                      modes: [{ modeId, name: "Light" }],
                    },
                  },
                ],
            variables: payload.variables,
          };

          const out = await figmaCreateVariables({
            accessToken: accessToken,
            fileKey,
            payload: requestBody,
          });

          return res.json({
            jsonrpc: "2.0",
            id,
            result: textResult({
              ok: out.ok,
              status: out.status,
              responseBody: out.body,
              typography: payload.typography,
              note: out.ok
                ? "✅ Variables created (or accepted) by Figma."
                : "❌ Figma rejected variable creation. See responseBody.",
              debug: {
                hadExistingCollection: hasAnyCollection,
                usedCollectionId: targetCollectionId,
                requestShape: {
                  variableCollectionsCount: requestBody.variableCollections.length,
                  variablesCount: requestBody.variables.length,
                },
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