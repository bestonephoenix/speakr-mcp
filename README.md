# speakr-mcp

MCP (Model Context Protocol) sidecar for [Speakr](https://murtaza-nasir.github.io/speakr/) — the self-hosted meeting recorder & diarizer. Exposes the full Speakr REST API as native MCP tools over **Streamable HTTP**, designed to run **beside the Speakr container on the same Docker network** so API traffic never leaves your host (no SSO/Pangolin round-trip, no open internet).

Under the hood it uses [`@ivotoby/openapi-mcp-server`](https://github.com/ivo-toby/mcp-openapi-server) — an OpenAPI → MCP bridge.

## Why a sidecar

| | Speakr API direct | speakr-mcp sidecar |
|---|---|---|
| Network path | Public hostname → reverse proxy (SSO) → API | `http://speakr:PORT` on the Docker network |
| Auth | Token over the internet | Token stays inside the container |
| Exposure | Whole API surface behind SSO whitelist | One MCP endpoint for your agent |
| Clients | Custom REST code | Any MCP client (Hermes, Claude, Cursor, MCPO gateway, …) |

## How it works

1. On startup, the entrypoint fetches the OpenAPI spec from the **internal** Speakr API (`GET /api/v1/openapi.json`).
2. It patches `operationId`s onto every operation — required so each endpoint becomes a uniquely-named MCP tool (Speakr's spec ships without them).
3. It starts the MCP server on `:3000/mcp` (Streamable HTTP) with your token injected as `Authorization: Bearer` on every upstream call.

Because the spec is fetched live, the tool set stays in sync with your Speakr version automatically. Rebuild/restart to refresh.

## Usage

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SPEAKR_API_URL` | no | `http://speakr:8000/api/v1/` | **Internal** API base URL as seen from this container (service name + port). |
| `SPEAKR_TOKEN` | **yes** | — | Speakr API token (Speakr → Account → API Tokens). |
| `MCP_PORT` | no | `3000` | MCP HTTP port. |
| `MCP_HOST` | no | `0.0.0.0` | Bind address. |

### docker compose

See [`docker-compose.example.yml`](docker-compose.example.yml). The key parts:

```yaml
services:
  speakr-mcp:
    image: ghcr.io/bestonephoenix/speakr-mcp:latest
    environment:
      SPEAKR_API_URL: "http://speakr:8000/api/v1/"   # your container's internal name/port
      SPEAKR_TOKEN: "${SPEAKR_TOKEN}"
    ports:
      - "3000:3000"
    networks:
      - speakr-net        # the network your Speakr container is on

networks:
  speakr-net:
    external: true
```

> Find the right values: `docker ps` for the Speakr container name, `docker inspect <speakr> --format '{{json .NetworkSettings.Networks}}'` for its network, and the internal port from the image's `EXPOSE` or compose file.

**Secrets go in `.env`, never in the compose file or code.** The compose file references `${SPEAKR_TOKEN}` which Docker Compose resolves from your local `.env`:

```bash
cp .env.example .env     # then edit .env and set SPEAKR_TOKEN (and SPEAKR_API_URL if needed)
docker compose up -d
```

`.env` is gitignored, so the token never lands in the repo.

### Build from source

```bash
docker build -t speakr-mcp .
docker run -d --name speakr-mcp \
  --network speakr-net \
  -e SPEAKR_API_URL="http://speakr:8000/api/v1/" \
  -e SPEAKR_TOKEN="$SPEAKR_TOKEN" \
  -p 3000:3000 \
  speakr-mcp
```

## Connecting clients

### Hermes (native MCP client)

```yaml
# ~/.hermes/config.yaml
mcp_servers:
  speakr:
    url: "http://<docker-host>:3000/mcp"
    timeout: 120
```

Then `/reload-mcp` — tools appear as `mcp_speakr_*` (e.g. `mcp_speakr_get_recordings`, `mcp_speakr_get_recordings_by_id_transcript`, `mcp_speakr_post_recordings_by_id_chat`).

### MCPO gateway (REST bridge)

```json
"speakr": {
  "type": "streamable_http",
  "url": "http://speakr-mcp:3000/mcp"
}

### Any MCP client

Point it at `http://<host>:3000/mcp`. Health check: `GET /health`.

## Verification

```bash
curl -s http://<host>:3000/health
# {"status":"healthy","activeSessions":0,"uptime":…}
```

Full MCP handshake:

```bash
curl -s -D - -X POST http://<host>:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
# → 200 with Mcp-Session-Id header
```

Then `tools/list` (POST with the session id) and `tools/call` — results stream back over the SSE GET connection.

## Tools

All 42 Speakr API operations are exposed, including:

- `get_stats` — recordings/queue/token usage
- `get_recordings`, `get_recordings_by_id` — list & detail
- `get_recordings_by_id_transcript` — transcript (json/text/srt/vtt)
- `get_recordings_by_id_summary`, `get_recordings_by_id_notes`
- `post_recordings_by_id_chat` — ask questions about a recording
- `post_recordings_upload`, `post_recordings_by_id_transcribe` / `summarize`
- tags, folders, speakers, webhooks, events

## Development

```bash
npm install
SPEAKR_API_URL=http://speakr:8000/api/v1/ SPEAKR_TOKEN=... npm start
```

## Notes / limitations

- The MCP server uses the **official MCP SDK StreamableHTTP transport** (`enableJsonResponse`), which answers synchronous requests (`ping`, `tools/list`, fast tool calls) with HTTP 200 + JSON body. This is required for Hermes' keepalive: the ivotoby package's own transport answers non-list requests with 202 Accepted (response deferred to SSE), which Hermes' client treats as a failed request, causing reconnect loops.
- Speakr's spec ships without `operationId`s; the entrypoint patches them at runtime (the same fix that makes tool names unique).
- Multipart file upload tools may be imperfect via the auto-converter — reads (list/get/transcript/summary/chat) are rock solid.

## License

MIT
