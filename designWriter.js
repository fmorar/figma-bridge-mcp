import { COMPONENT_SPECS, FOUNDATION_PAGES, TYPOGRAPHY_SPECS } from "./componentSpecs.js";

function getWriterConfig() {
  return {
    url: process.env.FIGMA_WRITER_MCP_URL || "",
    authKey: process.env.FIGMA_WRITER_MCP_AUTH_KEY || "",
    timeoutMs: Number(process.env.FIGMA_WRITER_MCP_TIMEOUT_MS || 30000),
  };
}

async function rpc({ url, authKey, method, params, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(authKey ? { Authorization: `Bearer ${authKey}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params,
      }),
      signal: controller.signal,
    });

    const raw = await res.text();

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = { raw };
    }

    return {
      ok: res.ok && !body?.error,
      status: res.status,
      body,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function callRemoteTool(config, name, args) {
  if (!config.url) {
    return {
      ok: false,
      status: 500,
      body: {
        error: {
          message:
            "FIGMA_WRITER_MCP_URL is not configured. Configure a writer MCP endpoint in the bridge env to create pages, typography, and components in Figma.",
        },
      },
    };
  }

  const out = await rpc({
    url: config.url,
    authKey: config.authKey,
    method: "tools/call",
    params: { name, arguments: args },
    timeoutMs: config.timeoutMs,
  });

  return out;
}

export async function generateFoundation({ fileKey, projectName = "Project" }) {
  const config = getWriterConfig();

  const payload = {
    fileKey,
    pages: FOUNDATION_PAGES.map((page) =>
      page === "10 Screens - Project" ? `10 Screens - ${projectName}` : page
    ),
    sections: {
      "00 Cover": ["Project Summary", "Manifest"],
      "01 Tokens": ["Primitives", "Semantic"],
      "02 Components": COMPONENT_SPECS.map((c) => c.name),
      "03 Patterns": ["Forms", "Tables", "Marketing Blocks"],
      [`10 Screens - ${projectName}`]: [],
      "90 Sandbox": ["Scratch"]
    }
  };

  const out = await callRemoteTool(config, "generate_figma_design", {
    prompt: `Create a design system foundation in the provided Figma file. Create pages: ${payload.pages.join(", ")}. On each page create titled sections as described in the sections payload. Use desktop-first layout, 1440 root width, light mode, and clear labels.`,
    fileKey,
    metadata: payload,
  });

  return {
    ok: out.ok,
    status: out.status,
    requestedPages: payload.pages,
    response: out.body,
  };
}

export async function generateTypography({ fileKey, brand }) {
  const config = getWriterConfig();
  const fontFamily = brand?.typography?.fontFamily || "Inter";

  const payload = {
    fileKey,
    fontFamily,
    styles: TYPOGRAPHY_SPECS,
  };

  const out = await callRemoteTool(config, "generate_figma_design", {
    prompt: `In the Figma file, create typography documentation and text styles using font family ${fontFamily}. Create styles exactly with these names: ${TYPOGRAPHY_SPECS.map((s) => s.name).join(", ")}. Use the provided sizes, line heights, and font weights. Organize them on page '01 Tokens'.`,
    fileKey,
    metadata: payload,
  });

  return {
    ok: out.ok,
    status: out.status,
    typographyStylesRequested: TYPOGRAPHY_SPECS.map((s) => s.name),
    response: out.body,
  };
}

export async function generateComponents({ fileKey }) {
  const config = getWriterConfig();

  const payload = {
    fileKey,
    components: COMPONENT_SPECS,
  };

  const out = await callRemoteTool(config, "generate_figma_design", {
    prompt: `In the Figma file, create component sets on page '02 Components' for Button, Input, Card, and Badge. Respect the exact variants, sizes, states, and slots provided. Use auto layout. Components must be token-driven and use semantic tokens and typography styles where applicable. Arrange each component set in its own section with a heading.`,
    fileKey,
    metadata: payload,
  });

  return {
    ok: out.ok,
    status: out.status,
    requestedComponents: COMPONENT_SPECS.map((c) => c.name),
    response: out.body,
  };
}