# syntax=docker/dockerfile:1
# speakr-mcp — MCP sidecar for Speakr (Streamable HTTP)

FROM node:22-alpine

WORKDIR /app

# Install the MCP server package
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Entrypoint: fetches the live OpenAPI spec from the internal Speakr API,
# patches operationIds, then runs the MCP server. No spec baked into the image.
COPY entrypoint.mjs ./

ENV MCP_PORT=3000
ENV MCP_HOST=0.0.0.0
EXPOSE 3000

# /health is served by the MCP server itself (wget ships with alpine)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${MCP_PORT}/health >/dev/null 2>&1 || exit 1

USER node
CMD ["node", "entrypoint.mjs"]
