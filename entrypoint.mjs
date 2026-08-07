#!/usr/bin/env node
// speakr-mcp entrypoint: fetch the OpenAPI spec from the *internal* Speakr API,
// patch operationIds (required for unique MCP tool names), then run the MCP
// server over Streamable HTTP. No secrets baked into the image.

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const API_URL = (process.env.SPEAKR_API_URL || "http://speakr:8000/api/v1/").replace(/\/+$/, "");
const TOKEN = process.env.SPEAKR_TOKEN;
const PORT = process.env.MCP_PORT || "3000";
const HOST = process.env.MCP_HOST || "0.0.0.0";

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

// --- spawn the MCP server ------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(
  __dirname, "node_modules", "@ivotoby", "openapi-mcp-server", "bin", "mcp-server.js"
);

console.log(`[speakr-mcp] starting MCP server on ${HOST}:${PORT} ...`);
const child = spawn(process.execPath, [
  serverEntry,
  "--api-base-url", `${API_URL}/`,
  "--openapi-spec", tmpSpec,
  "--transport", "http",
  "--port", PORT,
  "--host", HOST,
  "--disable-abbreviation", "true",
  "--verbose", "false",
], {
  env: { ...process.env, API_HEADERS: `Authorization:Bearer ${TOKEN}` },
  stdio: "inherit",
});

child.on("exit", (code) => process.exit(code ?? 0));
