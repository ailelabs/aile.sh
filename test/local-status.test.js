/**
 * A self-hosted model is listed only while something answers for it.
 *
 * Named models (`localModels`) used to be advertised on the lender's word
 * alone. A node whose Ollama was stopped — or never installed — listed a model
 * it could not serve: the server's hourly known-answer probe failed against it
 * for as long as the node was up, the listing read "Offline", and the lender's
 * terminal said nothing at all. Pinned here, against a real stub server and a
 * real TCP listener:
 *
 *  - nothing listening → the hello carries no localModel, and the node says so;
 *  - the model server starts → the next check re-sends the hello WITH it;
 *  - it stops → re-sent without it, one line each way.
 *
 * Sandboxed via test/setup.js: this writes a node secret and state.json.
 */

import { describe, expect, it, afterAll, mock } from "bun:test";
import net from "node:net";
import path from "node:path";

const { AILE_DIR } = await import("../src/relay/paths.js");
const { startStubServer } = await import("./helpers/stub-server.js");
const server = await startStubServer();

/** A port that nothing listens on until `listen()` — the "Ollama is stopped" case. */
async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}
const LOCAL_PORT = await freePort();
let listener = null;
const startModelServer = () => new Promise((r) => {
  listener = net.createServer((c) => c.end()).listen(LOCAL_PORT, "127.0.0.1", r);
});
const stopModelServer = () => new Promise((r) => { listener.close(r); listener = null; });

const lines = [];
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
    logLevel: "silent",
    localEnabled: true,
    localEndpoint: `http://127.0.0.1:${LOCAL_PORT}`,
    localModels: "llama3",
  }),
  saveConfig: (p) => p,
  updateSettings: (p) => ({ ok: true, value: p, changed: Object.keys(p) }),
  isLinked: () => true,
  storedOverrides: () => ({}),
  CONFIG_FILE: path.join(AILE_DIR, "config.json"),
  defaults: () => ({}),
}));
mock.module("../src/api/client.js", () => ({
  api: { listProviders: async () => ({ accounts: [] }) },
  ApiError: class ApiError extends Error {},
  isSecureUrl: () => true,
}));

const { startRelayAgent, stopRelayAgent, recheckLocal, localTransition } = await import("../src/relay/supervisor.js");
const { localStatus, buildLocalCapability } = await import("../src/relay/local.js");

// Captures what the node would print, whatever level it is at.
const log = {
  info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m),
  debug() {}, log: (m) => lines.push(m),
};
const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");

afterAll(async () => {
  try { stopRelayAgent("test done"); } catch { /* ignore */ }
  if (listener) await stopModelServer();
  try { server.stop(); } catch { /* ignore */ }
});

describe("localStatus", () => {
  const cfg = { localEnabled: true, localEndpoint: `http://127.0.0.1:${LOCAL_PORT}`, localModels: "llama3" };

  it("is off while lending is off", async () => {
    expect(await localStatus({ localEnabled: false })).toEqual({ state: "off" });
  });

  it("is misconfigured, with the reason, for an endpoint it refuses", async () => {
    const s = await localStatus({ localEnabled: true, localEndpoint: "https://1.1.1.1", localModels: "" });
    expect(s.state).toBe("misconfigured");
    expect(s.reason).toMatch(/public address/);
  });

  it("is down when nothing listens, still naming what would be listed", async () => {
    const s = await localStatus(cfg);
    expect(s).toMatchObject({ state: "down", reason: "nothing is listening", port: LOCAL_PORT, models: ["llama3"] });
    // …and so nothing is advertised for it.
    expect(await buildLocalCapability(cfg)).toBeNull();
  });

  it("is up once something accepts a connection", async () => {
    await startModelServer();
    try {
      expect(await localStatus(cfg)).toEqual({ state: "up", port: LOCAL_PORT, models: ["llama3"] });
      expect(await buildLocalCapability(cfg)).toEqual({ blind: false, models: ["llama3"], endpointPort: LOCAL_PORT });
    } finally {
      await stopModelServer();
    }
  });
});

describe("localTransition — one line per change, none for the same state", () => {
  const ep = "http://127.0.0.1:11434";
  const down = { state: "down", reason: "nothing is listening", models: ["llama3"] };
  const up = { state: "up", models: ["llama3"] };

  it("says nothing when the state has not changed, or lending is off", () => {
    expect(localTransition("down", down, ep)).toBeNull();
    expect(localTransition("up", up, ep)).toBeNull();
    expect(localTransition(null, { state: "off" }, ep)).toBeNull();
  });
  it("says nothing for a first check that is up (the header already did)", () => {
    expect(localTransition(null, up, ep)).toBeNull();
  });
  it("names the address and what is not listed when it is not answering", () => {
    expect(plain(localTransition(null, down, ep))).toMatch(/Local AI not answering · 127\.0\.0\.1:11434 · llama3 listed once it does/);
    expect(plain(localTransition("up", down, ep))).toMatch(/Local AI stopped answering · 127\.0\.0\.1:11434 · llama3 unlisted until it's back/);
    // Any reason but the usual one is named.
    expect(plain(localTransition(null, { ...down, reason: "no answer in 3s" }, ep))).toMatch(/127\.0\.0\.1:11434 \(no answer in 3s\)/);
  });
  it("says it is listed again, and that this machine reads those prompts", () => {
    expect(plain(localTransition("down", up, ep))).toMatch(/Local AI answering · llama3 listed · this machine reads those prompts/);
  });
});

describe("the node lists the model only while it answers", () => {
  const helloLocal = () => server.state.hellos.at(-1)?.capabilities?.localModel ?? null;

  it("connects without it while nothing is listening, and says so", async () => {
    await startRelayAgent();
    const deadline = Date.now() + 5000;
    while (!server.state.hellos.length && Date.now() < deadline) await Bun.sleep(20);
    expect(server.state.hellos.length).toBe(1);
    expect(helloLocal()).toBeNull();
  }, 15000);

  it("re-advertises it when the model server starts, and again when it stops", async () => {
    await startModelServer();
    await recheckLocal(log);
    let deadline = Date.now() + 3000;
    while (server.state.hellos.length < 2 && Date.now() < deadline) await Bun.sleep(20);
    expect(server.state.hellos.length).toBe(2);
    expect(helloLocal()).toEqual({ blind: false, models: ["llama3"], endpointPort: LOCAL_PORT });
    expect(plain(lines.at(-1))).toMatch(/Local AI answering · llama3 listed/);

    // Same state, no second hello: each one costs the server an account probe.
    await recheckLocal(log);
    await Bun.sleep(100);
    expect(server.state.hellos.length).toBe(2);

    await stopModelServer();
    await recheckLocal(log);
    deadline = Date.now() + 3000;
    while (server.state.hellos.length < 3 && Date.now() < deadline) await Bun.sleep(20);
    expect(server.state.hellos.length).toBe(3);
    expect(helloLocal()).toBeNull();
    expect(plain(lines.at(-1))).toMatch(/Local AI stopped answering .* llama3 unlisted until it's back/);
  }, 15000);
});
