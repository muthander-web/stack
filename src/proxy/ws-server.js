const { WebSocketServer } = require("ws");
const PacketParser = require("./packet-parser");
const PacketRewriter = require("./packet-rewriter");
const { createTcpConnection } = require("./tcp-client");
const fs = require("fs");
const path = require("path");

// File log for NPC-dialog/shop packets (and monster-viewport codes), so the
// browser<->OpenMU NPC flow can be diagnosed without tailing the proxy terminal.
// The proxy may be auto-restarted under the user's own session, so every instance
// appends to the same file. Only codes of interest are written to keep it small.
const NPC_LOG = path.join(__dirname, "../../proxy-npc.log");
const BOX_CODES = new Set([0x30, 0x31, 0x32, 0x33, 0x34, 0x13, 0x45, 0xF3, 0x12, 0x14]);

function decodeCreateCharacter(packet) {
  // Decode 0x12 (AddCharacterToScopeExtended) against the WASM client struct
  // PCREATE_CHARACTER_EXTENDED: header(C2 00 LL 12) + Key(W@4) + PosX(6) +
  // PosY(7) + TargetX(8) + TargetY(9) + RotAndHeroState(10) + [pad 11] +
  // AttackSpeed(12-13 LE) + MagicSpeed(14-15 LE) + ID(16-25) + Class(26) +
  // Flags(27) + Equipment(28-52) + BuffCount(53)
  if (packet.length < 30) return null;
  const key = (packet[5] << 8) | packet[4];
  const atk = (packet[13] << 8) | packet[12];
  const mgc = (packet[15] << 8) | packet[14];
  let name = "";
  for (let i = 16; i < 26; i++) {
    if (packet[i] === 0) break;
    name += String.fromCharCode(packet[i]);
  }
  return `spawn=${(key & 0x8000) ? 1 : 0} key=${key & 0x7fff} pos=${packet[6]},${packet[7]} tgt=${packet[8]},${packet[9]} rot=${packet[10] >> 4} heroState=${packet[10] & 0xf} atk=${atk} mgc=${mgc} name="${name}" class=${packet[26]} flags=0x${packet[27].toString(16)} eq=${Array.from(packet.slice(28, 53)).map(b => b.toString(16).padStart(2, "0")).join(" ")} buffs=${packet[53] || 0}`;
}

function logPacketLine(tag, dir, packet) {
  if (!packet || packet.length < 3) return;
  const id = PacketParser.identify(packet);
  if (!id) return;
  const code = id.code || 0;
  if (BOX_CODES.has(code)) {
    const extra = (dir === "S2C" && code === 0x12) ? " | " + decodeCreateCharacter(packet) : "";
    const line = `${new Date().toISOString()} [${tag}] ${dir} ${PacketParser.formatPacket(packet, 64)}${extra}`;
    console.log(line);
    try { fs.appendFileSync(NPC_LOG, line + "\n"); } catch (e) { /* ignore */ }
  }
}

// Highlights NPC-dialog/shop packets so the browser<->OpenMU NPC flow is easy
// to trace during Bring-up. OpenMU sends the NPC replies (0x30 talk menu,
// 0x31 merchant list, 0x32 buy, 0x33 sell, 0x34 repair) as plaintext C1, so the
// proxy can identify them; the C2S side is Xor32/SimpleModulus-encrypted and
// shows only the encrypted prefix (still worth logging for round-trip timing).
function traceNpc(tag, dir, packet) {
  if (!packet || packet.length < 3) return;
  const id = PacketParser.identify(packet);
  if (!id) return;
  const code = id.code || 0;
  if (code >= 0x30 && code <= 0x34) {
    console.log(`[NPC:${tag}] ${dir} ${PacketParser.formatPacket(packet, 24)}`);
  }
}

// The proxy runs behind nginx, which in turn runs behind Cloudflare, so neither
// req.socket.remoteAddress nor X-Real-IP identifies the player:
//   - req.socket.remoteAddress is always nginx's loopback address
//   - X-Real-IP is nginx's $remote_addr, i.e. the Cloudflare edge, which an
//     entire region shares (observed: 172.64.222.25) - keying on it would
//     collapse unrelated players into one queue
//
// Order therefore matters:
//   1. CF-Connecting-IP - set by Cloudflare itself from the real peer
//   2. X-Forwarded-For   - nginx builds it with $proxy_add_x_forwarded_for, so
//                          the *first* entry is the player seen by the outermost hop
//   3. X-Real-IP / socket - only meaningful without a proxy chain (local dev)
//
// These headers are client-controllable whenever the origin is hit directly, so
// the key is good for session affinity only - never for trust or identity.
function getClientKey(req) {
  const cfConnectingIp = req.headers["cf-connecting-ip"];
  if (cfConnectingIp) {
    return `cf:${String(cfConnectingIp).trim()}`;
  }

  const forwardedFor = req.headers["x-forwarded-for"];
  if (forwardedFor) {
    return `xff:${String(forwardedFor).split(",")[0].trim()}`;
  }

  const realIp = req.headers["x-real-ip"];
  if (realIp) {
    return `xri:${String(realIp).trim()}`;
  }

  return `sock:${req.socket.remoteAddress || "unknown"}`;
}

function createProxyServer(config) {
  const {
    wsPort,
    wsHost,
    connectHost,
    connectPort,
    gameHost,
    proxyPublicHost,
    proxyPublicPort,
    sessionTtlMs,
    maxTargetsPerKey,
  } = config;

  // ConnectionInfo (F4 03) redirects, queued per client. The client cannot send
  // a token (its WebSocket URL is fixed and cached), so a redirect is matched to
  // the next connection from the same client. FIFO order is what makes several
  // players behind one NAT work: each requests its info and immediately
  // reconnects, so the queue order matches their reconnect order.
  const sessionTargets = new Map(); // key -> [{ host, port, expiresAt }]

  function armTarget(key, target) {
    const now = Date.now();
    const queue = sessionTargets.get(key) || [];
    while (queue.length > 0 && queue[0].expiresAt <= now) {
      queue.shift();
    }

    queue.push({ ...target, expiresAt: now + sessionTtlMs });
    while (queue.length > maxTargetsPerKey) {
      queue.shift();
    }

    sessionTargets.set(key, queue);
  }

  function takeTarget(key) {
    const now = Date.now();
    const queue = sessionTargets.get(key);
    if (!queue) {
      return null;
    }

    while (queue.length > 0 && queue[0].expiresAt <= now) {
      queue.shift();
    }

    const target = queue.shift() || null;
    if (queue.length === 0) {
      sessionTargets.delete(key);
    }

    return target;
  }

  // Expired entries would otherwise keep the map growing forever for clients
  // that never opened their follow-up connection.
  const purgeTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, queue] of sessionTargets) {
      while (queue.length > 0 && queue[0].expiresAt <= now) {
        queue.shift();
      }
      if (queue.length === 0) {
        sessionTargets.delete(key);
      }
    }
  }, Math.max(1000, sessionTtlMs));
  purgeTimer.unref?.();

  const wss = new WebSocketServer({
    port: wsPort,
    host: wsHost,
    perMessageDeflate: false,
  });

  // Log on the actual 'listening' event. Logging right after the constructor
  // (which is what this used to do) printed "listening" even when the bind then
  // failed, so a proxy that was serving nothing looked healthy.
  wss.on("listening", () => {
    console.log(`[WS] Proxy listening on ws://${wsHost}:${wsPort}`);
  });

  let connectionId = 0;

  wss.on("connection", (ws, req) => {
    const id = ++connectionId;
    const sessionKey = getClientKey(req);
    const tag = `conn#${id}`;

    console.log(`[WS:${tag}] New connection from ${sessionKey}`);

    const target = takeTarget(sessionKey);
    let tcpHost, tcpPort;

    if (target) {
      tcpHost = target.host;
      tcpPort = target.port;
      console.log(
        `[WS:${tag}] Routing to Game Server (redirect): ${tcpHost}:${tcpPort}`,
      );
    } else {
      tcpHost = connectHost;
      tcpPort = connectPort;
      console.log(
        `[WS:${tag}] Routing to Connect Server: ${tcpHost}:${tcpPort}`,
      );
    }

    const rewriter = new PacketRewriter(
      proxyPublicHost,
      proxyPublicPort,
      gameHost,
    );
    const tcp = createTcpConnection(tcpHost, tcpPort, tag);
    const serverParser = new PacketParser(`${tag}:server`);

    let wsAlive = true;
    let tcpAlive = false;
    const pendingClientPackets = []; // buffered while the TCP leg is still connecting

    tcp.on("connect", () => {
      tcpAlive = true;
      for (const pkt of pendingClientPackets) {
        tcp.write(pkt);
      }
      pendingClientPackets.length = 0;
    });

    tcp.on("data", (data) => {
      if (!wsAlive) return;
      if (data.length > 0) {
        console.log(`[WS:${tag}] <<server ${PacketParser.formatPacket(data)}`);
      }
      serverParser.feed(data);
    });

    serverParser.on("packet", (packet) => {
      if (!wsAlive) return;

      logPacketLine(tag, "S2C", packet);

      const result = rewriter.processServerPacket(packet);

      if (result.rewritten && result.gameServerTarget) {
        console.log(
          `[${tag}] Game server redirect armed for ${sessionKey}: ${result.gameServerTarget.host}:${result.gameServerTarget.port}`,
        );
        armTarget(sessionKey, result.gameServerTarget);
      }

      try {
        ws.send(result.packet);
      } catch (err) {
        console.error(`[WS:${tag}] Send error: ${err.message}`);
      }
    });

    ws.on("message", (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.length > 0) {
        logPacketLine(tag, "C2S", buf);
      }
      const clientResult = rewriter.processClientPacket(buf);
      const outBuf = clientResult.packet;
      if (!tcpAlive) {
        // TCP leg still connecting (async connect to the game/connect server):
        // buffer instead of silently dropping, so early client packets (e.g.
        // the connect-server hello or login) are not lost.
        if (outBuf.length > 0 && pendingClientPackets.length < 256) {
          pendingClientPackets.push(outBuf);
        } else if (outBuf.length > 0) {
          console.error(`[WS:${tag}] pending client buffer full (256); dropping a packet`);
        }
        return;
      }
      tcp.write(outBuf);
    });

    ws.on("close", (code) => {
      wsAlive = false;
      console.log(`[WS:${tag}] Closed (code=${code})`);
      // Drop any buffered client packets: the browser is gone, flushing them
      // into a still-connecting TCP leg would leak the socket and send stale
      // login bytes to the server.
      pendingClientPackets.length = 0;
      // Destroy unconditionally: if the TCP leg is still connecting, it must
      // not be left to complete the handshake and idle forever.
      if (!tcp.destroyed) {
        tcp.destroy();
      }
      tcpAlive = false;
    });

    ws.on("error", (err) => {
      console.error(`[WS:${tag}] Error: ${err.message}`);
      wsAlive = false;
      pendingClientPackets.length = 0;
      if (!tcp.destroyed) {
        tcp.destroy();
      }
      tcpAlive = false;
    });

    tcp.on("close", () => {
      tcpAlive = false;
      if (wsAlive) {
        console.log(`[${tag}] TCP closed, closing WS`);
        ws.close();
        wsAlive = false;
      }
    });

    tcp.on("error", (err) => {
      console.error(`[TCP:${tag}] Error: ${err.message}`);
      tcpAlive = false;
      if (wsAlive) {
        ws.close();
        wsAlive = false;
      }
    });
  });

  wss.on("error", (err) => {
    console.error(`[WS] Server error: ${err.message}`);

    // A failed bind (e.g. the port is still held by the previous instance) leaves
    // this process alive but serving nothing, and it looks healthy from outside.
    // Exit instead, so the supervisor restarts it once the port is free.
    if (err.syscall === "listen" || err.code === "EADDRINUSE") {
      console.error("[WS] Fatal: could not bind the proxy port, exiting");
      process.exit(1);
    }
  });

  return wss;
}

module.exports = { createProxyServer };
