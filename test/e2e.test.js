/**
 * End-to-end: a real completion streamed through a real relay node.
 *
 * Topology (all on loopback, nothing leaves the machine):
 *
 *   stub aile.sh ──ws──> RelayAgent ──tcp──> stub provider (real TLS)
 *        │                    │
 *        └── terminates TLS   └── forwards opaque bytes, holds no keys
 *
 * The stub server runs a genuine TLS client over the frame channel, so the
 * bytes the agent forwards are real ciphertext from a session it cannot read.
 *
 * NOTE ON THE MOCK: only `assertTargetAllowed` is stubbed, because the real
 * allowlist correctly refuses loopback targets — that refusal is a feature, and
 * it is covered by its own 16 tests in allowlist.test.js. Everything else here
 * is the production code path: real framing, real sockets, real TLS, real
 * reconnect/backoff.
 */

import { describe, expect, it, beforeAll, afterAll, mock } from "bun:test";

// Must be mocked before agent.js is imported.
mock.module("../src/relay/allowlist.js", () => ({
  ALLOWED_PORTS: new Set([443]),
  isAllowedHost: () => true,
  isPublicIp: () => true,
  getAllowedHosts: () => new Set(["localhost"]),
  assertTargetAllowed: async (host) => {
    if (host !== "localhost") throw new Error(`Host ${host} is not a known provider endpoint`);
    return ["127.0.0.1"];
  },
}));

const { RelayAgent } = await import("../src/relay/agent.js");
const { startStubServer } = await import("./helpers/stub-server.js");
const { startStubProvider, SSE_TOKENS } = await import("./helpers/stub-provider.js");

const SECRET_PROMPT = "SECRET-PROMPT-e2e-4b71fa";

let server, provider, agent;

beforeAll(async () => {
  provider = await startStubProvider({ secretMarker: SECRET_PROMPT });
  server = await startStubServer();
});

afterAll(async () => {
  try { agent?.stop("test done"); } catch { /* ignore */ }
  try { server?.stop(); } catch { /* ignore */ }
  try { await provider?.stop(); } catch { /* ignore */ }
});

function newAgent(overrides = {}) {
  return new RelayAgent({
    serverUrl: server.url,
    renterToken: "test-renter-token",
    nodeId: "e2etestnode00001",
    maxConcurrent: 2,
    log: { warn: () => {}, log: () => {} },
    ...overrides,
  });
}

describe("end-to-end through a stub aile.sh", () => {
  it("connects outbound and advertises capabilities", async () => {
    agent = newAgent();
    await agent.connect({ nodeId: "e2etestnode00001", maxConcurrent: 2, claimedConnections: [] });
    const ws = await server.waitForConnection();
    expect(ws).toBeDefined();

    // hello is async on the server side; give it a tick.
    await Bun.sleep(100);
    expect(server.state.hellos.length).toBeGreaterThan(0);
    expect(server.state.hellos[0].nodeId).toBe("e2etestnode00001");
    expect(agent.getStats().connected).toBe(true);
  }, 20000);

  it("streams a real SSE completion end to end, in order", async () => {
    const ws = server.firstSocket();
    const body = JSON.stringify({
      model: "gpt-4o",
      stream: true,
      messages: [{ role: "user", content: SECRET_PROMPT }],
    });
    const httpRequest =
      "POST /v1/chat/completions HTTP/1.1\r\n" +
      "Host: localhost\r\n" +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${body.length}\r\n` +
      "Connection: close\r\n\r\n" +
      body;

    const response = await server.requestThroughNode(ws, 1, {
      host: "localhost",
      port: provider.port,
      servername: "localhost",
      httpRequest,
    });

    expect(response).toContain("HTTP/1.1 200 OK");
    expect(response).toContain("text/event-stream");

    // Every token arrived, and in the order the provider sent them.
    const order = SSE_TOKENS.map((t) => response.indexOf(JSON.stringify(t).slice(1, -1)));
    for (const idx of order) expect(idx).toBeGreaterThan(-1);
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]);
    expect(response).toContain("[DONE]");

    // The provider really did receive the prompt — proves the request traversed
    // the whole chain rather than being answered by something closer.
    expect(provider.state.sawSecret).toBe(true);
    expect(agent.getStats().streamsOpened).toBeGreaterThan(0);
  }, 30000);

  it("BLINDNESS: the node forwarded only ciphertext", () => {
    const observed = Buffer.concat(server.state.bytesFromNode);
    expect(observed.length).toBeGreaterThan(0);          // it really carried traffic
    expect(observed.includes(Buffer.from(SECRET_PROMPT))).toBe(false);
    expect(observed.toString("latin1")).not.toContain(SECRET_PROMPT);
    // The response tokens are equally unreadable to the node.
    for (const token of SSE_TOKENS) {
      expect(observed.toString("latin1")).not.toContain(`delta":{"content":"${token}`);
    }
  });

  it("refuses a target the allowlist rejects, without opening a socket", async () => {
    const ws = server.firstSocket();
    const before = agent.getStats().streamsOpened;

    server.openStream(ws, 77, { host: "169.254.169.254", port: 443 });
    await Bun.sleep(300);

    // Scoped to this stream — an unrelated late error elsewhere must not decide it.
    const errs = server.state.errors.filter((e) => e.streamId === 77);
    expect(errs.length).toBe(1);
    expect(errs[0].message).toMatch(/not a known provider/);
    expect(agent.getStats().streamsOpened).toBe(before);  // no socket was opened
    expect(agent.getStats().streamsRefused).toBeGreaterThan(0);
  }, 20000);

  it("enforces maxConcurrent", async () => {
    const ws = server.firstSocket();
    // maxConcurrent is 2; open three streams the provider will hold open (it
    // waits for a complete request head that never arrives).
    for (const id of [201, 202, 203]) {
      server.openStream(ws, id, { host: "localhost", port: provider.port });
      await Bun.sleep(80);
    }
    await Bun.sleep(300);

    const rejected = server.state.errors.filter((e) => e.streamId === 203);
    expect(rejected.length).toBe(1);
    expect(rejected[0].message).toMatch(/at capacity/);
    // The two that fit are genuinely open, and the third was never socketed.
    expect(agent.getStats().activeStreams).toBe(2);
    expect(server.state.errors.filter((e) => e.streamId === 201).length).toBe(0);
    expect(server.state.errors.filter((e) => e.streamId === 202).length).toBe(0);
  }, 20000);

  it("drains in-flight streams when the connection drops mid-stream", async () => {
    agent.stop("cycling for reconnect test");

    const statuses = [];
    const fresh = newAgent({ onStatus: (s) => statuses.push(s) });
    agent = fresh;

    const before = server.state.connectCount;
    await fresh.connect({ nodeId: "e2etestnode00001", maxConcurrent: 2, claimedConnections: [] });
    const ws = await server.waitForConnection(before + 1);
    expect(statuses).toContain("connected");

    // Genuinely mid-stream: open a stream and let TLS get underway, then confirm
    // the node really is holding an open socket before we pull the rug.
    server.openStream(ws, 800, { host: "localhost", port: provider.port });
    await Bun.sleep(200);
    expect(fresh.getStats().activeStreams).toBeGreaterThan(0);

    // Server drops every socket, as a deploy or network blip would.
    server.dropAllConnections();
    await Bun.sleep(400);

    expect(fresh.getStats().connected).toBe(false);
    expect(fresh.getStats().activeStreams).toBe(0);   // in-flight stream drained, no leak
    expect(statuses).toContain("disconnected");       // supervisor's reconnect trigger fired
  }, 40000);

  it("reconnects and serves a real request again", async () => {
    const after = newAgent();
    agent = after;
    const beforeCount = server.state.connectCount;
    await after.connect({ nodeId: "e2etestnode00001", maxConcurrent: 2, claimedConnections: [] });
    const ws = await server.waitForConnection(beforeCount + 1);

    const response = await server.requestThroughNode(ws, 900, {
      host: "localhost",
      port: provider.port,
      servername: "localhost",
      httpRequest: "GET /v1/models HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    });
    expect(response).toContain("HTTP/1.1 200 OK");
    expect(response).toContain('"ok":true');
  }, 40000);
});
