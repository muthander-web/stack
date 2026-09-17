# OpenMU Browser Stack

MU Online in the browser. Server-side infrastructure to run MU Online via WebAssembly, using [OpenMU](https://github.com/MUnique/OpenMU) as the game server.

## What is this

Everything you need on the server side to bridge a WASM MU client to OpenMU:

- **Game Server** — OpenMU (C#/.NET) running via Docker with PostgreSQL
- **WebSocket-TCP Proxy** — Bridge between the browser (WebSocket only) and OpenMU (TCP)
- **Web Server** — Serves the WASM client with required headers (COOP/COEP)
- **HTML Template** — Ready to receive a compiled WASM client

```mermaid
flowchart LR
    subgraph Browser
        WASM[WASM Client]
    end

    subgraph Node.js
        WEB[Web Server\n:8080]
        PROXY[WS-TCP Proxy\n:7100]
    end

    subgraph Docker
        CS[Connect Server\n:44405]
        GS[Game Server\n:55901]
        PG[(PostgreSQL\n:5433)]
    end

    WASM -- HTTP --> WEB
    WASM -- WebSocket --> PROXY
    PROXY -- TCP --> CS
    PROXY -- TCP --> GS
    CS --- PG
    GS --- PG
```

**Connection flow:**
1. Client opens WebSocket to proxy → proxy connects TCP to Connect Server (:44405)
2. Connect Server sends ConnectionInfo (`C1 F4 03`) with Game Server IP:port
3. Proxy rewrites the IP:port to its public address and queues the real target
4. Client reconnects via WebSocket → proxy routes TCP to Game Server (:55901)

**How the proxy matches step 4 to step 1.** The client cannot send a session token —
its WebSocket URL is fixed at page load and cached — so the redirect is matched to the
*next connection from the same client*. Identifying that client is the delicate part,
because the proxy is behind nginx, which is behind Cloudflare, so neither the socket
address nor `X-Real-IP` names the player:

| Header | Behind Cloudflare |
|--------|-------------------|
| `req.socket.remoteAddress` | nginx's loopback address — same for every player |
| `X-Real-IP` (`$remote_addr`) | the Cloudflare **edge**, shared by a whole region |
| `X-Forwarded-For` | `$proxy_add_x_forwarded_for`; the first entry is the player |
| `CF-Connecting-IP` | the player — **preferred** |

So the key is resolved in the order `CF-Connecting-IP` → `X-Forwarded-For` (first
entry) → `X-Real-IP` → socket address, and the log shows which one was used via a
`cf:` / `xff:` / `xri:` / `sock:` prefix. Targets are kept in a short FIFO queue per
client, and this relies on the client reconnecting:

- The **queue** (rather than a single slot) is what lets several players share one
  public IP — a whole LAN behind one NAT — without stealing each other's target.
- The **TTL** (`SESSION_TTL_MS`) expires targets from clients that requested one and
  never came back. Without it such an orphan stays armed and hijacks the next
  connection, sending a fresh visitor straight into a game server.

Note that a redirect is consumed by the next connection, whatever it is, so a client
that opens a connection before reconnecting will take the redirect with it.

These headers are client-controlled whenever the origin is reached directly instead of
through Cloudflare, so the key is a session-affinity mechanism only — it must never be
used for authentication or trust.

## Status

| Component | Status |
|-----------|--------|
| WebSocket-TCP Proxy | Verified end-to-end |
| Web Server (static + COOP/COEP) | Implemented |
| MU Packet Parser (C1/C2/C3/C4) | Implemented |
| ConnectionInfo Rewriter (F4 03) | Verified end-to-end |
| OpenMU via Docker | Configured |
| **WASM Client** | **Not in this repo** — see [WASM Client](#wasm-client) |

> **Note:** The proxy has been exercised end-to-end against a live OpenMU: WebSocket
> upgrade, the connect-server hello, the server list, the ConnectionInfo rewrite and
> the redirect of the follow-up connection to the game server. The WASM client itself
> is not part of this repository.

## Quick Start

### Prerequisites

- Node.js 22+
- Docker and Docker Compose

### 1. Clone and install

```bash
git clone https://github.com/your-username/openmu-browser-stack.git
cd openmu-browser-stack
npm install
cp .env.example .env
```

### 2. Start OpenMU

```bash
docker compose up -d
```

This starts:
- **PostgreSQL 16** on port 5433
- **OpenMU** with auto-start
  - Admin panel: http://localhost:8090
  - Connect Server: port 44405
  - Game Servers: ports 55901-55906
  - Chat Server: port 55980

### 3. Start the proxy and web server

```bash
npm start
```

Or separately:

```bash
npm run proxy   # WebSocket proxy on port 7100
npm run serve   # Web server on port 8080
```

### 4. Open

Go to http://localhost:8080. You will see a placeholder page — the WASM client is not included. See [WASM Client](#wasm-client) for the next step.

## WASM Client

This repository **does not include** the game client. You need to compile a MU Online client to WebAssembly.

### Recommended client: MuMain

[sven-n/MuMain](https://github.com/sven-n/MuMain) is the best candidate:

- **C++ with OpenGL** — Emscripten maps OpenGL ES to WebGL natively
- Compatible with OpenMU (standard MU protocol C1/C2/C3/C4)

### Required work

| Task | Description |
|------|-------------|
| OpenGL 1.x → OpenGL ES 2.0 | Replace `glBegin`/`glEnd` with VBOs + GLSL ES shaders |
| Networking .NET → C++ | Rewrite `ClientLibrary` (.NET AOT) in pure C++ |
| Win32 → SDL2/Emscripten | Replace `windows.h` with SDL2 (cross-platform) |
| Audio → Web Audio | Replace DirectSound/wzAudio with OpenAL or SDL_mixer |
| Game loop | Adapt to `emscripten_set_main_loop()` |
| Assets | Package BMD/OZJ/OZB into Emscripten's `.data` file |

### Integrating the compiled client

1. Compile with Emscripten (outputs `.js`, `.wasm`, `.data`)
2. Copy to `public/`
3. Add `<script async src="YourClient.js"></script>` to `public/index.html`
4. `Module.websocket.url` already points to the proxy (`ws://127.0.0.1:7100`)

## MU Online Protocol

The proxy understands MU packet framing:

| Header | Size | Encryption |
|--------|------|------------|
| `C1` | 1 byte (max 255) | None |
| `C2` | 2 bytes BE (max 65535) | None |
| `C3` | 1 byte | SimpleModulus / XOR32 |
| `C4` | 2 bytes BE | SimpleModulus / XOR32 |

The proxy is transparent to encryption. The only exception is the **ConnectionInfo** packet (`C1 F4 03`), whose IP:port is rewritten to redirect connections through the proxy.

## Structure

```
openmu-browser-stack/
├── docker-compose.yml          # OpenMU + PostgreSQL
├── .env.example                # Configuration template
├── package.json
├── public/
│   └── index.html              # HTML template for the WASM client
└── src/
    ├── proxy/
    │   ├── index.js            # Proxy entry point
    │   ├── ws-server.js        # WebSocket↔TCP bridge
    │   ├── tcp-client.js       # TCP client wrapper
    │   ├── packet-parser.js    # MU packet framing (C1/C2/C3/C4)
    │   └── packet-rewriter.js  # ConnectionInfo (F4 03) rewriter
    └── web/
        └── server.js           # Static file server
```

## Configuration

Copy `.env.example` to `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `WS_PORT` | 7100 | WebSocket proxy port |
| `WEB_PORT` | 8080 | Web server port |
| `MU_CONNECT_HOST` | 127.0.0.1 | Connect Server host |
| `MU_CONNECT_PORT` | 44405 | Connect Server port |
| `MU_GAME_HOST` | 127.0.0.1 | Game Server host (for IP remapping) |
| `PROXY_PUBLIC_HOST` | 127.0.0.1 | Public host written into ConnectionInfo — use the public WebSocket entry (e.g. the site domain), not the origin IP |
| `PROXY_PUBLIC_PORT` | 7100 | Public port written into ConnectionInfo (443 when fronted by nginx/Cloudflare) |
| `SESSION_TTL_MS` | 30000 | How long an unused ConnectionInfo redirect stays armed |
| `MAX_TARGETS_PER_KEY` | 8 | Redirects queued per client before the oldest is dropped |

## Troubleshooting

**Port 7100 in use (macOS):** Disable AirPlay Receiver in System Settings → General → AirDrop & Handoff, or change `WS_PORT`.

**OpenMU won't start:** `docker compose down -v && docker compose up -d` to clean up and restart.

## License

MIT
