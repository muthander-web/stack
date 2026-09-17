const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

const { createProxyServer } = require("./ws-server");

const config = {
  wsPort: parseInt(process.env.WS_PORT || "7100", 10),
  wsHost: process.env.WS_HOST || "0.0.0.0",
  connectHost: process.env.MU_CONNECT_HOST || "127.0.0.1",
  connectPort: parseInt(process.env.MU_CONNECT_PORT || "44405", 10),
  gameHost: process.env.MU_GAME_HOST || "127.0.0.1",
  proxyPublicHost: process.env.PROXY_PUBLIC_HOST || "127.0.0.1",
  proxyPublicPort: parseInt(process.env.PROXY_PUBLIC_PORT || "7100", 10),
  // A ConnectionInfo redirect stays armed for this long. The client reconnects
  // within milliseconds, so this only exists to expire targets from players who
  // requested one and never came back — otherwise the stale target hijacks the
  // next connection ("orphan target").
  sessionTtlMs: parseInt(process.env.SESSION_TTL_MS || "30000", 10),
  // Targets queued per client before the oldest is dropped. More than one is
  // needed when several players share a public IP (same NAT), since they are
  // only distinguishable by arrival order.
  maxTargetsPerKey: parseInt(process.env.MAX_TARGETS_PER_KEY || "8", 10),
};

console.log("=== OpenMU Browser Stack — WebSocket-TCP Proxy ===");
console.log(`  WebSocket:      ws://${config.wsHost}:${config.wsPort}`);
console.log(`  Connect Server: ${config.connectHost}:${config.connectPort}`);
console.log(`  Game Host:      ${config.gameHost}`);
console.log(`  Public Address: ${config.proxyPublicHost}:${config.proxyPublicPort}`);
console.log(`  Redirect TTL:   ${config.sessionTtlMs}ms (max ${config.maxTargetsPerKey}/client)`);
console.log("");

createProxyServer(config);
