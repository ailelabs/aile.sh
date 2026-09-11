/**
 * What the node does when the server refuses it.
 *
 * The original bug, in full: node identity survives `aile logout`, so signing
 * into a second account leaves the machine registered to the first. The server
 * refuses the handshake — correctly; letting any token claim any node would let
 * anyone redirect another lender's traffic — and the client responded by
 * printing `[aile] connect failed: websocket error` and retrying forever. Two
 * separate failures met there: the message named nothing actionable, and the
 * retry loop was the wrong response to a decision that will not change.
 *
 * So this file asserts both halves against a real server that really refuses a
 * real WebSocket upgrade:
 *
 *  - the reported message contains what the server actually said, and
 *  - the supervisor repairs itself once and then STOPS, instead of looping.
 *
 * The stub deliberately answers /agent the way the real one does — a bare status
 * with a short body — because that is what makes the message hard to get: a
 * browser-shaped WebSocket never exposes the status or body of a failed upgrade
 * to its caller, so the client has to go and ask over plain HTTP.
 *
 * Sandboxed via test/setup.js: this writes a node secret and state.json.
 */

import { describe, expect, it, beforeAll, afterAll, mock } from "bun:test";
import path from "node:path";

const { AILE_DIR } = await import("../src/relay/paths.js");
const TMP_DIR = AILE_DIR;

const { startStubServer } = await import("./helpers/stub-server.js");
const server = await startStubServer();

// Short reconnect bounds keep the "does it stop?" assertions quick — with the
// production 1s floor, proving a loop is absent means waiting on it.
mock.module("../src/relay/config.js", () => ({
  loadConfig: () => ({
    serverUrl: server.url,
    renterToken: "test-renter-token",
    autoReconnect: true,
    maxConcurrent: 2,
    reconnectMinMs: 50,
    reconnectMaxMs: 200,
    pingIntervalMs: 30000,
    pongTimeoutMs: 90000,
    connectTimeoutMs: 5000,
    idleTimeoutMs: 300000,
    maxPendingBytes: 256 * 1024,
    logLevel: "silent",
  }),
  saveConfig: (p) => p,
  updateSettings: (p) => ({ ok: true, value: p, changed: Object.keys(p) }),
  isLinked: () => true,
  storedOverrides: () => ({}),
  CONFIG_FILE: path.join(TMP_DIR, "config.json"),
  defaults: () => ({}),
}));

mock.module("../src/api/client.js", () => ({
  api: { listProviders: async () => ({ accounts: [] }) },
  ApiError: class ApiError extends Error {},
  isSecureUrl: () => true,
}));

const { RelayAgent, RelayConnectError } = await import("../src/relay/agent.js");
const { startRelayAgent, stopRelayAgent, getRelayStatus } = await import("../src/relay/supervisor.js");
const { getNodeId } = await import("../src/relay/identity.js");

afterAll(() => {
  try { stopRelayAgent("test done"); } catch { /* ignore */ }
  try { server.stop(); } catch { /* ignore */ }
});

beforeAll(() => {
  expect(process.env.AILE_DATA_DIR).toBeTruthy();
  expect(path.resolve(TMP_DIR)).toContain("aile-test-");
});

const CAPS = { models: [], providers: [], maxConcurrent: 2 };

// ---------------------------------------------------------------------------

describe("a refused connection reports what the server said", () => {
  it("replaces 'websocket error' with the server's own sentence", async () => {
    server.refuse(403, "node does not belong to this renter");
    const agent = new RelayAgent({
      serverUrl: server.url, renterToken: "t", nodeId: getNodeId(),
      log: { info() {}, warn() {}, error() {}, debug() {} },
    });

    const err = await agent.connect(CAPS).catch((e) => e);
    agent.stop("test");
    server.accept();

    expect(err).toBeInstanceOf(RelayConnectError);
    // The status AND the reason. "websocket error" told the user nothing they
    // could act on; this names the account mismatch that is actually wrong.
    expect(err.message).toContain("403");
    expect(err.message).toContain("does not belong");
  }, 20000);

  it("marks a credential refusal as not worth retrying", async () => {
    server.refuse(401, "unauthorized");
    const agent = new RelayAgent({
      serverUrl: server.url, renterToken: "t", nodeId: getNodeId(),
      log: { info() {}, warn() {}, error() {}, debug() {} },
    });

    const err = await agent.connect(CAPS).catch((e) => e);
    agent.stop("test");
    server.accept();

    // The supervisor branches on this flag; without it a permanent refusal is
    // indistinguishable from a flaky network and gets retried forever.
    expect(err.rejected).toBe(true);
  }, 20000);

  /**
   * A relay behind Cloudflare Access. The upgrade is answered by the PORTAL, not
   * the relay — a 200 sign-in page, which the WebSocket reports only as "Expected
   * 101 status code". Two things must happen: the node must say what actually
   * answered, and it must stop, because no retry and no re-registration can get a
   * machine past a login page meant for a human.
   */
  describe("something in front of the relay answered", () => {
    const PORTAL = "<!DOCTYPE html><html><head><title>Sign in ・ Cloudflare Access</title></head><body>SECRETMARKER</body></html>";

    const agentFor = () => new RelayAgent({
      serverUrl: server.url, renterToken: "t", nodeId: getNodeId(),
      log: { info() {}, warn() {}, error() {}, debug() {} },
    });

    it("names the access proxy instead of pasting its HTML into the log", async () => {
      server.refuse(200, PORTAL, { "content-type": "text/html" });
      const agent = agentFor();
      const err = await agent.connect(CAPS).catch((e) => e);
      agent.stop("test");
      server.accept();

      expect(err).toBeInstanceOf(RelayConnectError);
      expect(err.message).toContain("an access proxy answered");
      // The old message printed 200 characters of somebody else's page, once per
      // reconnect. Never echo it: it is arbitrary markup from a third party.
      expect(err.message).not.toContain("SECRETMARKER");
      expect(err.message).not.toContain("<!DOCTYPE");
    });

    it("names where a redirect pointed", async () => {
      server.refuse(302, "", { location: "https://example.cloudflareaccess.com/cdn-cgi/access/login" });
      const agent = agentFor();
      const err = await agent.connect(CAPS).catch((e) => e);
      agent.stop("test");
      server.accept();

      expect(err.message).toContain("example.cloudflareaccess.com");
    });

    it("marks it as hopeless, not merely refused", async () => {
      // `blocked`, not `rejected`: the relay never saw the request, so there is
      // nothing for re-registering to repair. The supervisor branches on this.
      server.refuse(200, PORTAL, { "content-type": "text/html" });
      const agent = agentFor();
      const err = await agent.connect(CAPS).catch((e) => e);
      agent.stop("test");
      server.accept();

      expect(err.blocked).toBe(true);
      expect(err.rejected).toBe(false);
    });
  });

  it("leaves an unreachable server retryable", async () => {
    // Nothing is listening here. That says nothing about our credentials, so it
    // must NOT be marked rejected — doing so would stop the loop on a server
    // that is merely down and never come back up.
    const agent = new RelayAgent({
      serverUrl: "http://127.0.0.1:1", renterToken: "t", nodeId: getNodeId(),
      connectTimeoutMs: 3000,
      log: { info() {}, warn() {}, error() {}, debug() {} },
    });
    const err = await agent.connect(CAPS).catch((e) => e);
    agent.stop("test");
    expect(err.rejected).toBe(false);
  }, 20000);
});

describe("the supervisor recovers from a machine the server will not accept", () => {
  it("re-registers once and connects, without a re-login", async () => {
    // The lockout as the user meets it: everything is configured, the token is
    // good, and the machine alone is what the server objects to.
    server.refuse(403, "node does not belong to this renter");
    server.state.enrolled.length = 0;

    await startRelayAgent();

    // First attempt is refused → repair → the retry is accepted.
    server.accept();

    const deadline = Date.now() + 25000;
    while (!getRelayStatus().connected && !getRelayStatus().fatal && Date.now() < deadline) {
      await Bun.sleep(50);
    }

    const st = getRelayStatus();
    expect(st.fatal).toBe(null);
    expect(st.connected).toBe(true);
    // It went through enrolment rather than merely retrying the same handshake.
    expect(server.state.enrolled.length).toBeGreaterThan(0);
    expect(server.state.enrolled.at(-1)).toBe(getNodeId());

    stopRelayAgent("test");
  }, 40000);

  it("stops instead of looping when re-registering does not help", async () => {
    // A server that refuses the fresh identity too. Retrying cannot change this
    // answer, and the loop is exactly what hid the original bug.
    server.refuse(403, "node does not belong to this renter");
    server.state.enrolled.length = 0;

    await startRelayAgent();

    const deadline = Date.now() + 25000;
    while (!getRelayStatus().fatal && Date.now() < deadline) await Bun.sleep(50);

    const st = getRelayStatus();
    expect(st.fatal).toBeTruthy();
    expect(st.fatal).toContain("403");
    // Exactly one repair — a rotation per backoff tick would litter the server
    // with orphaned node rows for as long as the process ran.
    expect(server.state.enrolled.length).toBe(1);

    // And it stays stopped. This is the assertion the original bug fails.
    const attempts = server.state.connectCount;
    await Bun.sleep(1000);          // many times the 50-200ms backoff window
    expect(server.state.connectCount).toBe(attempts);

    stopRelayAgent("test");
    server.accept();
  }, 40000);

  it("does not stop for a server that is merely unreachable", async () => {
    // The inverse guard: `fatal` must be reserved for decisions. Setting it on
    // an outage would leave a laptop that closed its lid permanently offline.
    server.stop();
    await startRelayAgent();
    await Bun.sleep(600);           // several backoff intervals

    const st = getRelayStatus();
    expect(st.fatal).toBe(null);
    expect(st.running).toBe(true);   // still trying
    stopRelayAgent("test");
  }, 30000);
});
