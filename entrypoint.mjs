#!/usr/bin/env node
// speakr-mcp entrypoint: fetch the OpenAPI spec from the *internal* Speakr API,
// patch operationIds (required for unique MCP tool names), then serve MCP over
// Streamable HTTP using the OFFICIAL MCP SDK transport.
//
// Why the official transport: the ivotoby StreamableHttpServerTransport answers
// every non-initialize/tools-list request with HTTP 202 Accepted (response
// deferred to the SSE stream). Hermes' MCP client treats a 202 on a request as
// "no response will follow" and fails it — so keepalive pings fail and Hermes
// reconnect-loops/parked the server. The official transport answers synchronous
// requests (ping, tools/list, fast tools/call) directly with 200 + JSON body.
//
// No secrets baked into the image; everything comes from the environment.

import http from "node:http";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { OpenAPIServer } from "@ivotoby/openapi-mcp-server";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const API_URL = (process.env.SPEAKR_API_URL || "http://speakr:8000/api/v1/").replace(/\/+$/, "");
const TOKEN = process.env.SPEAKR_TOKEN;
const PORT = Number(process.env.MCP_PORT || "3000");
const HOST = process.env.MCP_HOST || "0.0.0.0";
const ENDPOINT = "/mcp";

if (!TOKEN) {
  console.error("SPEAKR_TOKEN environment variable is required.");
  process.exit(1);
}

// --- operationId patcher (method+path camelCase, dedupe-safe) ----------------
function toCamel(parts) {
  let s = "";
  for (const p of parts) {
    const words = p.replace(/[^a-zA-Z0-9]/g, " ").trim().split(/\s+/).filter(Boolean);
    for (const w of words) s += w[0].toUpperCase() + w.slice(1);
  }
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

function patchOperationIds(spec) {
  const used = {};
  let count = 0;
  for (const [path, methods] of Object.entries(spec.paths || {})) {
    for (const [m, op] of Object.entries(methods)) {
      if (!["get", "post", "put", "patch", "delete"].includes(m.toLowerCase())) continue;
      const segs = path.split("/").filter(Boolean);
      const parts = [m.toLowerCase()];
      for (const s of segs) {
        if (s.startsWith("{")) parts.push("By" + s.replace(/[{}_]/g, "").replace(/\b\w/g, (c) => c.toUpperCase()));
        else parts.push(s);
      }
      const base = toCamel(parts);
      const n = (used[base] = (used[base] || 0) + 1);
      op.operationId = n === 1 ? base : `${base}${n}`;
      count++;
    }
  }
  return count;
}

// --- fetch spec from the live internal API -----------------------------------
console.log(`[speakr-mcp] fetching spec from ${API_URL}/openapi.json ...`);
const resp = await fetch(`${API_URL}/openapi.json`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
});
if (!resp.ok) {
  console.error(`[speakr-mcp] spec fetch failed: HTTP ${resp.status} ${await resp.text()}`);
  process.exit(1);
}
const spec = await resp.json();
const patched = patchOperationIds(spec);
console.log(`[speakr-mcp] spec loaded, ${patched} operations patched with operationIds`);

const tmpSpec = "/tmp/speakr-openapi.json";
await writeFile(tmpSpec, JSON.stringify(spec));

// --- sessions: map sessionId -> { server, transport } -------------------------
// One OpenAPIServer + one official transport per session, mirroring the official
// SDK's simpleStreamableHttp example (stateful mode, sessionIdGenerator).
const sessions = new Map();
const startTime = Date.now();

function makeServer() {
  return new OpenAPIServer({
    name: "speakr",
    version: "1.0.0",
    apiBaseUrl: `${API_URL}/`,
    openApiSpec: tmpSpec,
    specInputMethod: "file",
    headers: { Authorization: `Bearer ${TOKEN}` },
    toolsMode: "all",
    disableAbbreviation: true,
    verbose: false,
  });
}

// --- HTTP server ---------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  // /health — used by the Docker HEALTHCHECK
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "healthy",
        activeSessions: sessions.size,
        uptime: Math.floor((Date.now() - startTime) / 1000),
      })
    );
    return;
  }

  if (req.url !== ENDPOINT) {
    res.writeHead(404);
    res.end();
    return;
  }

  const sessionId = req.headers["mcp-session-id"];
  try {
    if (req.method === "POST") {
      // Read + parse the JSON-RPC body
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let message = {};
      try {
        message = raw ? JSON.parse(raw) : {};
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
        return;
      }

      let entry = sessionId ? sessions.get(sessionId) : undefined;
      if (!entry) {
        // Only a brand-new initialize (no session id) may create a session
        if (sessionId || !isInitializeRequest(message)) {
          res.writeHead(400);
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "Bad Request: No valid session ID provided" },
              id: null,
            })
          );
          return;
        }
        const mcpServer = makeServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          // Answer requests directly with JSON on the POST body (Hermes expects
          // this; 202+SSE breaks its keepalive/request handling).
          enableJsonResponse: true,
          onsessioninitialized: (sid) => {
            sessions.set(sid, { server: mcpServer, transport });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await mcpServer.start(transport);
        await transport.handleRequest(req, res, message);
        return;
      }

      await entry.transport.handleRequest(req, res, message);
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      const entry = sessionId ? sessions.get(sessionId) : undefined;
      if (!entry) {
        res.writeHead(400);
        res.end("Invalid or missing session ID");
        return;
      }
      await entry.transport.handleRequest(req, res);
      return;
    }

    res.writeHead(405, { Allow: "GET, POST, DELETE" });
    res.end();
  } catch (err) {
    console.error("[speakr-mcp] error handling request:", err);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[speakr-mcp] MCP server listening on http://${HOST}:${PORT}${ENDPOINT}`);
});
