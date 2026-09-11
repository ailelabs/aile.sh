/**
 * OPEN/DATA ordering.
 *
 * The server pipelines the TLS ClientHello immediately behind OPEN — it does not
 * wait for an acknowledgement, because there isn't one. Meanwhile the node must
 * resolve DNS before it can connect, since the allowlist check works on resolved
 * addresses (DNS-rebinding defence). So DATA for a stream routinely arrives
 * while that stream's lookup is still in flight.
 *
 * This was a real production failure, invisible to the other e2e tests because
 * their allowlist mock resolves in a microtask. Against a live provider the
 * lookup takes milliseconds, the ClientHello was dropped on the floor, and the
 * handshake stalled until the provider gave up:
 *
 *   [relay] upstream failed: Client network socket disconnected before secure
 *           TLS connection was established        (bytesUp 251, bytesDown 0)
 *
 * The mock below therefore has a DELIBERATE DELAY. Do not remove it — without it
 * this file passes even with the bug reintroduced.
 */

import { describe, expect, it, beforeAll, afterAll, mock } from "bun:test";

const LOOKUP_DELAY_MS = 40;

mock.module("../src/relay/allowlist.js", () => ({
  ALLOWED_PORTS: new Set([443]),
  isAllowedHost: () => true,
  isPublicIp: () => true,
  getAllowedHosts: () => new Set(["localhost"]),
  assertTargetAllowed: async (host) => {
    await Bun.sleep(LOOKUP_DELAY_MS);          // stands in for a real DNS lookup
    if (host !== "localhost") throw new Error(`Host ${host} is not a known provider endpoint`);
    return ["127.0.0.1"];
  },
}));

const { RelayAgent } = await import("../src/relay/agent.js");
const { startStubServer } = await import("./helpers/stub-server.js");
const { startStubProvider, SSE_TOKENS } = await import("./helpers/stub-provider.js");

const SECRET_PROMPT = "SECRET-PROMPT-race-8c22";

let server, provider, agent, ws;

beforeAll(async () => {
  provider = await startStubProvider({ secretMarker: SECRET_PROMPT });
  server = await startStubServer();
  agent = new RelayAgent({
    serverUrl: server.url,
    renterToken: "race-renter-token",
    nodeId: "racetestnode0001",
    maxConcurrent: 4,
    log: { warn: () => {}, log: () => {} },
  });
  await agent.connect({ nodeId: "racetestnode0001", maxConcurrent: 4, claimedConnections: [] });
  ws = await server.waitForConnection();
});

afterAll(async () => {
  try { agent?.stop("test done"); } catch { /* ignore */ }
  try { server?.stop(); } catch { /* ignore */ }
  try { await provider?.stop(); } catch { /* ignore */ }
});

describe("DATA arriving before the stream's lookup completes", () => {
  it("buffers the ClientHello instead of dropping it", async () => {
    // requestThroughNode writes the ClientHello as soon as the TLS client
    // produces it, which is immediately after OPEN — i.e. inside the delay.
    const raw = await server.requestThroughNode(ws, 1, {
      host: "localhost",
      port: provider.port,
      servername: "localhost",
      httpRequest:
        "POST /v1/chat/completions HTTP/1.1\r\n" +
        "Host: localhost\r\n" +
        "Content-Type: application/json\r\n" +
        `Content-Length: ${JSON.stringify({ prompt: SECRET_PROMPT }).length}\r\n` +
        "Connection: close\r\n\r\n" +
        JSON.stringify({ prompt: SECRET_PROMPT }),
      timeoutMs: 15000,
    });

    const text = raw.toString("utf8");
    expect(text).toContain("HTTP/1.1 200");
    for (const token of SSE_TOKENS) expect(text).toContain(token);
    expect(provider.state.sawSecret).toBe(true);

    // The specific regression: bytes must actually have flowed back. The old
    // code produced a TLS timeout with bytesDown at 0.
    expect(raw.length).toBeGreaterThan(0);
  }, 30000);

  it("survives several streams opened at once, all racing their lookups", async () => {
    const results = await Promise.all([11, 12, 13].map((streamId) =>
      server.requestThroughNode(ws, streamId, {
        host: "localhost", port: provider.port, servername: "localhost",
        httpRequest: "GET /v1/models HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        timeoutMs: 15000,
      })
    ));
    for (const raw of results) expect(raw.toString("utf8")).toContain("HTTP/1.1 200");
  }, 30000);

  it("still refuses a disallowed host, and drops its buffered bytes", async () => {
    const beforeRefused = agent.getStats().streamsRefused;
    const beforeOpened = agent.getStats().streamsOpened;

    // Open, then immediately push data — the same ordering as a real request,
    // so the bytes land while the (slow) allowlist check is still running. The
    // placeholder entry must not turn a refusal into an accepted stream.
    const duplex = server.openStream(ws, 21, { host: "evil.example.com", port: 443 });
    duplex.write(Buffer.from("GET / HTTP/1.1\r\nHost: evil.example.com\r\n\r\n"));
    await Bun.sleep(LOOKUP_DELAY_MS + 300);

    const errs = server.state.errors.filter((e) => e.streamId === 21);
    expect(errs.length).toBe(1);
    expect(errs[0].message).toMatch(/not a known provider/);

    expect(agent.getStats().streamsRefused).toBe(beforeRefused + 1);
    expect(agent.getStats().streamsOpened).toBe(beforeOpened);   // no socket opened
    // The refused stream must not linger holding its buffered bytes.
    expect(agent.getStats().activeStreams).toBe(0);
  }, 20000);
});
