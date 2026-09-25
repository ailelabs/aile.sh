/**
 * How a node reports a lost link.
 *
 * `aile start` runs for days, and the link drops several times a day for
 * reasons that heal themselves: a server deploy, a Wi-Fi blip, an edge restart.
 * The node used to print "disconnected (1006)" and "connected as node …" for
 * every one, which made a healthy node look broken. Two things are pinned here:
 *
 *  - a link that goes SILENT (no close, no pong) is dropped by the ping timer
 *    and reported exactly once, marked stale, even though the server still
 *    holds the socket open — a dead TCP connection may not deliver a close
 *    event for minutes, and waiting for it left the node "connected" to nothing;
 *  - an ordinary close reaches the supervisor with its code, so it can say
 *    "server restarting" (1012) rather than an abrupt drop.
 *
 * Sandboxed via test/setup.js.
 */

import { describe, expect, it, afterAll } from "bun:test";

const { startStubServer } = await import("./helpers/stub-server.js");
const server = await startStubServer();
const { RelayAgent } = await import("../src/relay/agent.js");
const { getNodeId } = await import("../src/relay/identity.js");

afterAll(() => { try { server.stop(); } catch { /* ignore */ } });

const CAPS = { models: [], providers: [], maxConcurrent: 2 };
const quiet = { info() {}, warn() {}, error() {}, debug() {}, log() {} };

function agentWith(onStatus, opts = {}) {
  return new RelayAgent({
    serverUrl: server.url, renterToken: "t", nodeId: getNodeId(),
    log: quiet, onStatus, ...opts,
  });
}

describe("a lost link", () => {
  it("drops a silent link on the ping timer and reports it once, as stale", async () => {
    const drops = [];
    const agent = agentWith((s, _stats, info) => { if (s === "disconnected") drops.push(info); },
      { pingIntervalMs: 40, pongTimeoutMs: 150 });
    await agent.connect(CAPS);
    expect(agent.getStats().connected).toBe(true);

    server.mute();
    try {
      const deadline = Date.now() + 3000;
      while (!drops.length && Date.now() < deadline) await Bun.sleep(20);
      // Long enough for a late close event from the abandoned socket to arrive
      // and, if it could, report the same drop a second time.
      await Bun.sleep(300);
    } finally {
      server.mute(false);
      agent.stop("test");
    }

    expect(drops.length).toBe(1);
    expect(drops[0]).toMatchObject({ opened: true, stale: true, code: null });
    expect(agent.getStats().connected).toBe(false);
  }, 10000);

  it("hands the supervisor the close code of an ordinary close", async () => {
    const drops = [];
    const agent = agentWith((s, _stats, info) => { if (s === "disconnected") drops.push(info); });
    await agent.connect(CAPS);

    const ws = [...server.state.sockets].at(-1);
    ws.close(1012, "server restarting");
    const deadline = Date.now() + 3000;
    while (!drops.length && Date.now() < deadline) await Bun.sleep(20);
    agent.stop("test");

    expect(drops.length).toBe(1);
    expect(drops[0]).toMatchObject({ opened: true, stale: false, code: 1012, reason: "server restarting" });
  }, 10000);
});
