// figmaApi.js
const FIGMA_API_BASE = "https://api.figma.com/v1";

async function safeReadBody(resp) {
  const text = await resp.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function figmaFetch({ path, method = "GET", accessToken, body }) {
  const url = `${FIGMA_API_BASE}${path}`;

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };

  const init = { method, headers };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const resp = await fetch(url, init);
  const parsed = await safeReadBody(resp);

  return { ok: resp.ok, status: resp.status, body: parsed };
}

export function figmaGetFile({ accessToken, fileKey }) {
  return figmaFetch({ accessToken, path: `/files/${encodeURIComponent(fileKey)}` });
}

export function figmaGetNodes({ accessToken, fileKey, nodeIds }) {
  const ids = Array.isArray(nodeIds) ? nodeIds.join(",") : String(nodeIds || "");
  return figmaFetch({
    accessToken,
    path: `/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(ids)}`,
  });
}

export function figmaGetLocalVariables({ accessToken, fileKey }) {
  return figmaFetch({
    accessToken,
    path: `/files/${encodeURIComponent(fileKey)}/variables/local`,
  });
}

// This endpoint expects "batch mutations" with action discriminators.
export function figmaCreateVariables({ accessToken, fileKey, payload }) {
  return figmaFetch({
    accessToken,
    method: "POST",
    path: `/files/${encodeURIComponent(fileKey)}/variables`,
    body: payload,
  });
}