
# Figma Bridge MCP

Simple MCP SSE server that connects agent platforms to Figma using OAuth + REST API.

## Setup

npm install
cp .env.example .env

Fill:

FIGMA_CLIENT_ID
FIGMA_CLIENT_SECRET
MCP_AUTH_KEY

Run:

npm run dev

Open:

http://localhost:3333/auth/figma/login

## MCP config

{
  "name": "figma-bridge",
  "transport": "sse",
  "url": "http://localhost:3333/mcp/sse",
  "authKey": "CHANGE_ME_SHARED_SECRET"
}
