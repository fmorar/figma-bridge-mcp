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
    description: "Export tokens as CSS variables + token map.",
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

function sanitizeVarName(name) {
  return String(name || "")
    .trim()
    .replace(/\.+/g, "/") // "." -> "/"
    .replace(/\/{2,}/g, "/")
    .replace(/^\//, "")
    .replace(/\/$/, "");
}

function getCollections(metaBody) {
  return metaBody?.meta?.variableCollections || {};
}

function getVariables(metaBody) {
  return metaBody?.meta?.variables || {};
}

// ✅ if multiple "Tokens" collections exist, pick the one with the MOST variables
function pickTokensCollection(metaBody, desiredName = "Tokens") {
  const collections = Object.values(getCollections(metaBody));
  const matches = collections.filter((c) => c?.name === desiredName);

  if (matches.length === 0) return null;

  matches.sort((a, b) => (b?.variableIds?.length || 0) - (a?.variableIds?.length || 0));
  return matches[0];
}

function getModeIdForCollection(collection) {
  return collection?.defaultModeId || collection?.modes?.[0]?.modeId || null;
}

function findExistingVariableId(metaBody, collectionId, name) {
  const vars = Object.values(getVariables(metaBody));
  const hit = vars.find(
    (v) => v?.variableCollectionId === collectionId && v?.name === name
  );
  return hit?.id || null;
}

function buildBrandTokenSpecs(brand) {
  const { colors, typography } = brand;

  const prim = {
    "color.primary": colors?.primary,
    "color.accent": colors?.accent,
    "color.neutral.900": colors?.neutral || "#111827",
    "color.background": colors?.background || "#FFFFFF"
  };

  const sem = {
    "semantic.bg": prim["color.background"],
    "semantic.fg": prim["color.neutral.900"],
    "semantic.brand": prim["color.primary"],
    "semantic.accent": prim["color.accent"]
  };

  return { prim, sem, typography };
}

// ✅ Create or UPDATE (idempotent), using real modeId
function buildVariableMutations({ brand, collectionId, modeId, metaBody }) {
  const { prim, sem, typography } = buildBrandTokenSpecs(brand);
  const all = { ...prim, ...sem };

  const variables = [];
  const planned = [];
  const computedSample = [];

  for (const [rawName, hex] of Object.entries(all)) {
    const name = sanitizeVarName(rawName);
    const rgba = hexToRgba01(hex) || hexToRgba01("#000000");

    const existingId = findExistingVariableId(metaBody, collectionId, name);

    if (computedSample.length < 4) {
      computedSample.push({ name, hex, rgba, existingId: existingId || null, modeId });
    }

    if (existingId) {
      variables.push({
        action: "UPDATE",
        id: existingId,
        name,
        variableCollectionId: collectionId,
        resolvedType: "COLOR",
        valuesByMode: { [modeId]: rgba }
      });
      planned.push({ name, action: "UPDATE", id: existingId });
    } else {
      variables.push({
        action: "CREATE",
        name,
        variableCollectionId: collectionId,
        resolvedType: "COLOR",
        valuesByMode: { [modeId]: rgba }
      });
      planned.push({ name, action: "CREATE" });
    }
  }

  return { variables, typography, planned, computedSample };
}

const FIGMA_OAUTH_REQUIRED = new Set([
  "figma_get_file",
  "figma_get_nodes",
  "tokens_bootstrap_from_brand",
  "tokens_export_map"
]);

export function attachMcpRoutes(app, tokenStore) {
  const authorized = attachAuth({ sharedKey: process.env.MCP_AUTH_KEY });
  const manifestStore = createManifestStore({ dir: process.env.MANIFEST_STORE_DIR || ".data/manifests" });

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
        message: "Unauthorized: invalid MCP_AUTH_KEY"
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

        let accessToken = null;
        if (FIGMA_OAUTH_REQUIRED.has(toolName)) {
          const token = await (tokenStore?.load?.() ?? null);
          if (!token?.access_token) {
            return jsonRpcError(res, { id, code: 401, message: "OAuth required: open /auth/figma/login first" });
          }
          accessToken = token.access_token;
        }

        // Manifest tools (no OAuth)
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

        // Figma tools
        if (toolName === "figma_get_file") {
          const out = await figmaGetFile({ accessToken, fileKey: args.fileKey });
          return res.json({ jsonrpc: "2.0", id, result: textResult(out.body) });
        }

        if (toolName === "figma_get_nodes") {
          const out = await figmaGetNodes({ accessToken, fileKey: args.fileKey, nodeIds: args.nodeIds });
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
              export: buildCssExport({ brand: args.brand || { colors: {}, typography: {} } })
            })
          });
        }

        // ✅ Bootstrap (idempotent)
        if (toolName === "tokens_bootstrap_from_brand") {
          const { fileKey, brand } = args;

          // Read meta
          const meta1 = await figmaGetLocalVariables({ accessToken, fileKey });
          if (!meta1.ok) {
            return res.json({
              jsonrpc: "2.0",
              id,
              result: textResult({
                ok: false,
                status: meta1.status,
                note: "Failed to read variables/local",
                responseBody: meta1.body
              })
            });
          }

          // Pick existing Tokens collection (prefer the one with most variables)
          let tokensCollection = pickTokensCollection(meta1.body, "Tokens");

          // Only create if truly missing
          let createdCollectionStep = null;
          if (!tokensCollection) {
            const created = await figmaCreateVariables({
              accessToken,
              fileKey,
              payload: {
                variableCollections: [
                  { action: "CREATE", name: "Tokens", modes: [{ modeId: "Light", name: "Light" }] }
                ],
                variables: []
              }
            });

            createdCollectionStep = { ok: created.ok, status: created.status, body: created.body };

            if (!created.ok) {
              return res.json({
                jsonrpc: "2.0",
                id,
                result: textResult({
                  ok: false,
                  status: created.status,
                  note: "Failed to create Tokens collection",
                  responseBody: created.body
                })
              });
            }

            const meta2 = await figmaGetLocalVariables({ accessToken, fileKey });
            if (!meta2.ok) {
              return res.json({
                jsonrpc: "2.0",
                id,
                result: textResult({
                  ok: false,
                  status: meta2.status,
                  note: "Created collection but could not re-read variables/local",
                  responseBody: meta2.body
                })
              });
            }

            tokensCollection = pickTokensCollection(meta2.body, "Tokens");
            if (!tokensCollection) {
              return res.json({
                jsonrpc: "2.0",
                id,
                result: textResult({
                  ok: false,
                  status: 500,
                  note: "Created collection but still cannot find Tokens by name",
                  debug: { variablesLocal: meta2.body }
                })
              });
            }
          }

          const collectionId = tokensCollection.id;
          const modeId = getModeIdForCollection(tokensCollection);

          if (!modeId) {
            return res.json({
              jsonrpc: "2.0",
              id,
              result: textResult({
                ok: false,
                status: 500,
                note: "Could not resolve modeId for Tokens collection",
                debug: { tokensCollection }
              })
            });
          }

          // Fresh meta for updates
          const metaNow = await figmaGetLocalVariables({ accessToken, fileKey });
          if (!metaNow.ok) {
            return res.json({
              jsonrpc: "2.0",
              id,
              result: textResult({
                ok: false,
                status: metaNow.status,
                note: "Could not re-read variables/local before write",
                responseBody: metaNow.body
              })
            });
          }

          const payload = buildVariableMutations({
            brand,
            collectionId,
            modeId,
            metaBody: metaNow.body
          });

          const write = await figmaCreateVariables({
            accessToken,
            fileKey,
            payload: { variableCollections: [], variables: payload.variables }
          });

          return res.json({
            jsonrpc: "2.0",
            id,
            result: textResult({
              ok: write.ok,
              status: write.status,
              responseBody: write.body,
              typography: payload.typography,
              note: write.ok ? "✅ Variables created/updated in Figma." : "❌ Figma rejected variable write.",
              debug: {
                usedCollectionId: collectionId,
                usedModeId: modeId,
                createdCollectionStep,
                planned: payload.planned,
                computedSample: payload.computedSample
              }
            })
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
        data: { stack: err?.stack }
      });
    }
  }

  app.post("/mcp", handleRpc);
  app.post("/mcp/sse", handleRpc);
}