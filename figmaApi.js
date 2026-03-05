async function figmaFetch({ accessToken, method = "GET", url, body }) {
  const r = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await r.text();
  return { status: r.status, ok: r.ok, body: text };
}

export async function figmaGetFile({ accessToken, fileKey }) {
  return figmaFetch({
    accessToken,
    url: `https://api.figma.com/v1/files/${fileKey}`
  });
}

export async function figmaGetNodes({ accessToken, fileKey, nodeIds }) {
  const ids = encodeURIComponent(nodeIds.join(","));
  return figmaFetch({
    accessToken,
    url: `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${ids}`
  });
}

/**
 * VARIABLES (Enterprise restriction may apply depending on org/seat).
 * Endpoints:
 * - GET  /v1/files/:file_key/variables/local
 * - POST /v1/files/:file_key/variables
 */
export async function figmaGetLocalVariables({ accessToken, fileKey }) {
  return figmaFetch({
    accessToken,
    url: `https://api.figma.com/v1/files/${fileKey}/variables/local`
  });
}

export async function figmaCreateVariables({ accessToken, fileKey, payload }) {
  return figmaFetch({
    accessToken,
    method: "POST",
    url: `https://api.figma.com/v1/files/${fileKey}/variables`,
    body: payload
  });
}