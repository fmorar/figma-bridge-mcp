
export async function figmaGetFile({ accessToken, fileKey }) {
  const r = await fetch(`https://api.figma.com/v1/files/${fileKey}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const text = await r.text();
  return { status: r.status, body: text };
}

export async function figmaGetNodes({ accessToken, fileKey, nodeIds }) {
  const ids = encodeURIComponent(nodeIds.join(","));
  const r = await fetch(`https://api.figma.com/v1/files/${fileKey}/nodes?ids=${ids}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const text = await r.text();
  return { status: r.status, body: text };
}
