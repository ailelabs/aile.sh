/**
 * The reconnect loop, against a real stub server.
 *
 * This covers what e2e.test.js deliberately does not: the supervisor's own
 * backoff/retry path. A node runs unattended for weeks, so "the server went away
 * and came back" is its normal operating condition, not an edge case.
 *
 * This test provisions a node secret and writes state.json, so it MUST run
 * against a sandboxed data dir. That redirection happens in test/setup.js, which
 * bunfig.toml preloads before any module resolves its paths — doing it here
 * would be too late whenever another test file imports paths.js first.
 */

import { describe, expect, it, afterAll, mock } from "bun:test";
import path from "node:path";

const { AILE_DIR } = await import("../src/relay/paths.js");
const TMP_DIR = AILE_DIR;

const { startStubServer } = await import("./helpers/stub-server.js");
const server = await startStubServer();

// Config is stubbed rather than written to disk so the test states its inputs
// plainly; state/identity still exercise the real files (inside TMP_DIR).
mock.module("../src/relay/config.js", () => ({
  loadConfig: () => ({
    serverUrl: server.url,
    renterToken: "test-renter-token",
    autoReconnect: true,
    maxConcurrent: 2,
    reconnectMinMs: 1000,
    reconnectMaxMs: 60000,
    pingIntervalMs: 30000,
    pongTimeoutMs: 90000,
    connectTimeoutMs: 15000,
    idleTimeoutMs: 300000,
    maxPendingBytes: 256 * 1024,
    logLevel: "info",
  }),
  saveConfig: (p) => p,
  updateSettings: (p) => ({ ok: true, value: p, changed: Object.keys(p) }),
  isLinked: () => true,
  storedOverrides: () => ({}),
  CONFIG_FILE: path.join(TMP_DIR, "config.json"),
  defaults: () => ({}),
}));

// buildCapabilities already tolerates an unreachable API, but stubbing keeps the
// test off the network and fast.
mock.module("../src/api/client.js", () => ({
  api: { listProviders: async () => ({ accounts: [] }) },
  ApiError: class ApiError extends Error {},
  isSecureUrl: () => true,
}));

const { startRelayAgent, stopRelayAgent, getRelayStatus } = await import("../src/relay/supervisor.js");

afterAll(async () => {
  try { stopRelayAgent("test done"); } catch { /* ignore */ }
  try { server.stop(); } catch { /* ignore */ }
  // TMP_DIR itself is removed by test/setup.js on process exit.
});

describe("supervisor", () => {
  // Guard, not decoration: this suite writes a node secret and deletes
  // state.json. If the preload ever stops taking effect, it would do that to the
  // developer's real node. Fail loudly here instead.
  it("is sandboxed away from the real data dir", () => {
    expect(process.env.AILE_DATA_DIR).toBeTruthy();
    expect(TMP_DIR).toBe(process.env.AILE_DATA_DIR);
    expect(path.resolve(TMP_DIR)).toContain("aile-test-");
  });

  it("connects and reports a live node", async () => {
    await startRelayAgent();
    await server.waitForConnection();
    await Bun.sleep(150);

    const status = getRelayStatus();
    expect(status.running).toBe(true);
    expect(status.connected).toBe(true);
    expect(status.lastError).toBe(null);
    expect(status.nodeId).toMatch(/^[0-9a-f]{16}$/);   // real identity derivation ran
    expect(status.lastConnectedAt).toBeTruthy();
    expect(server.state.hellos.length).toBeGreaterThan(0);
  }, 30000);

  it("reconnects by itself after the server drops the connection", async () => {
    const before = server.state.connectCount;
    expect(getRelayStatus().connected).toBe(true);

    server.dropAllConnections();
    await Bun.sleep(200);
    expect(getRelayStatus().connected).toBe(false);

    // No manual reconnect: the supervisor's backoff timer must do this. First
    // retry is ~0.5-1s, so allow generous headroom without hardcoding a sleep.
    const deadline = Date.now() + 20000;
    while (server.state.connectCount <= before && Date.now() < deadline) {
      await Bun.sleep(100);
    }
    expect(server.state.connectCount).toBeGreaterThan(before);

    await Bun.sleep(200);
    const status = getRelayStatus();
    expect(status.connected).toBe(true);
    expect(status.attempt).toBe(0);   // counter reset on success, so backoff restarts low
  }, 40000);

  it("stops cleanly and does not reconnect after being stopped", async () => {
    stopRelayAgent("test stop");
    const stopped = getRelayStatus();
    expect(stopped.running).toBe(false);
    expect(stopped.connected).toBe(false);

    const after = server.state.connectCount;
    await Bun.sleep(2500);   // longer than the first backoff interval
    expect(server.state.connectCount).toBe(after);
  }, 30000);
});
