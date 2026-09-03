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

function createProxyServer(config) {
  const {
    wsPort,
    wsHost,
    connectHost,
    connectPort,
    gameHost,
    proxyPublicHost,
    proxyPublicPort,
  } = config;

  // ConnectionInfo (F4 03) redirects are stored per client IP so the next
  // WebSocket connection from that IP routes to the correct game server port
  const sessionTargets = new Map();

  const wss = new WebSocketServer({
    port: wsPort,
    host: wsHost,
    perMessageDeflate: false,
  });
  console.log(`[WS] Proxy listening on ws://${wsHost}:${wsPort}`);

  let connectionId = 0;

  wss.on("connection", (ws, req) => {
    const id = ++connectionId;
    const clientIp = req.socket.remoteAddress;
    const tag = `conn#${id}`;

    console.log(`[WS:${tag}] New connection from ${clientIp}`);

    const sessionKey = clientIp;
    let tcpHost, tcpPort;

    if (sessionTargets.has(sessionKey)) {
      const target = sessionTargets.get(sessionKey);
      sessionTargets.delete(sessionKey);
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
          `[${tag}] Game server redirect: ${result.gameServerTarget.host}:${result.gameServerTarget.port}`,
        );
        sessionTargets.set(sessionKey, result.gameServerTarget);
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
  });

  return wss;
}

module.exports = { createProxyServer };
