// src/figmaApi.js

const FIGMA_API_BASE = "https://api.figma.com/v1";

// Safely parse response as JSON if possible; otherwise return text
async function safeReadBody(resp) {
  const text = await resp.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text; // could be HTML or plain text
  }
}

async function figmaFetch({ path, method = "GET", accessToken, body }) {
  const url = `${FIGMA_API_BASE}${path}`;

  const headers = {
    "Authorization": `Bearer ${accessToken}`,
    "Accept": "application/json"
  };

  // Only set content-type when body exists
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers,
      body: payload
    });
  } catch (err) {
    // Network/DNS/timeout, etc.
    return {
      ok: false,
      status: 0,
      body: { message: "Network error calling Figma", error: err?.message || String(err) }
    };
  }

  const parsed = await safeReadBody(resp);

  return {
    ok: resp.ok,
    status: resp.status,
    body: parsed
  };
}

// ---- Public API ----

export async function figmaGetFile({ accessToken, fileKey }) {
  return figmaFetch({
    accessToken,
    path: `/files/${encodeURIComponent(fileKey)}`,
    method: "GET"
  });
}

export async function figmaGetNodes({ accessToken, fileKey, nodeIds }) {
  const ids = Array.isArray(nodeIds) ? nodeIds.join(",") : String(nodeIds || "");
  return figmaFetch({
    accessToken,
    path: `/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(ids)}`,
    method: "GET"
  });
}

// NOTE: Figma Variables API has changed over time; endpoint might differ depending on plan/scopes.
// You currently call this in tokens_export_map; we keep it best-effort and surface status/body.
export async function figmaGetLocalVariables({ accessToken, fileKey }) {
  // If this endpoint is wrong for your token or plan, you’ll get 403/404; we return it raw.
  return figmaFetch({
    accessToken,
    path: `/files/${encodeURIComponent(fileKey)}/variables/local`,
    method: "GET"
  });
}

// Create variables (best-effort). If endpoint/schema mismatch, you’ll get 4xx and body is returned.
export async function figmaCreateVariables({ accessToken, fileKey, payload }) {
  // ⚠️ Endpoint may differ based on Figma Variables API version.
  // Keep it isolated so we can change in one place if needed.
  return figmaFetch({
    accessToken,
    path: `/files/${encodeURIComponent(fileKey)}/variables`,
    method: "POST",
    body: payload
  });
}