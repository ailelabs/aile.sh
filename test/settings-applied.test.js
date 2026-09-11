/**
 * Settings must actually reach the code they configure.
 *
 * The failure this file exists to catch is not a crash — it is a setting that
 * validates, saves, displays correctly, and changes nothing, because the value
 * it was meant to control is still a hardcoded const somewhere. That bug is
 * invisible to every other test in this suite, and to the user until they wonder
 * why raising a timeout did nothing.
 */

import { describe, expect, test, mock } from "bun:test";

mock.module("../src/relay/allowlist.js", () => ({
  ALLOWED_PORTS: new Set([443]),
  isAllowedHost: () => true,
  isPublicIp: () => true,
  getAllowedHosts: () => new Set(["localhost"]),
  assertTargetAllowed: async () => ["127.0.0.1"],
}));

const { RelayAgent } = await import("../src/relay/agent.js");
const { backoffDelay } = await import("../src/relay/supervisor.js");
const { logger } = await import("../src/config/logger.js");
const { SCHEMA } = await import("../src/config/settings.js");

function newAgent(overrides = {}) {
  return new RelayAgent({
    serverUrl: "https://example.invalid",
    renterToken: "t",
    nodeId: "settingstest0001",
    log: { warn: () => {}, log: () => {} },
    ...overrides,
  });
}

describe("the agent honours its configured limits", () => {
  test("timers come from the caller, not a const", () => {
    const agent = newAgent({
      pingIntervalMs: 5000,
      pongTimeoutMs: 15000,
      connectTimeoutMs: 3000,
      idleTimeoutMs: 20000,
      maxPendingBytes: 32 * 1024,
      maxConcurrent: 9,
    });
    expect(agent.pingIntervalMs).toBe(5000);
    expect(agent.pongTimeoutMs).toBe(15000);
    expect(agent.connectTimeoutMs).toBe(3000);
    expect(agent.idleTimeoutMs).toBe(20000);
    expect(agent.maxPendingBytes).toBe(32 * 1024);
    expect(agent.maxConcurrent).toBe(9);
  });

  test("an unconfigured agent falls back to the schema's defaults", () => {
    // If these drift apart, a directly-constructed agent behaves differently
    // from the same agent started through the CLI.
    const agent = newAgent();
    expect(agent.pingIntervalMs).toBe(SCHEMA.pingIntervalMs.default);
    expect(agent.pongTimeoutMs).toBe(SCHEMA.pongTimeoutMs.default);
    expect(agent.connectTimeoutMs).toBe(SCHEMA.connectTimeoutMs.default);
    expect(agent.idleTimeoutMs).toBe(SCHEMA.idleTimeoutMs.default);
    expect(agent.maxPendingBytes).toBe(SCHEMA.maxPendingBytes.default);
    expect(agent.maxConcurrent).toBe(SCHEMA.maxConcurrent.default);
  });

  test("maxPendingBytes actually bounds the pre-connect buffer", async () => {
    const sent = [];
    const agent = newAgent({ maxPendingBytes: 1024 });
    agent.ws = { readyState: 1, send: (f) => sent.push(f), bufferedAmount: 0 };

    // Open a stream and push past the cap before its lookup resolves. The
    // placeholder entry has no socket yet, so this is the buffered path.
    agent._handleOpen(1, Buffer.from(JSON.stringify({ host: "localhost", port: 443 })));
    agent._handleData(1, Buffer.alloc(600));
    expect(agent.streams.has(1)).toBe(true);          // under the cap, still held

    agent._handleData(1, Buffer.alloc(600));          // now over 1024
    expect(agent.streams.has(1)).toBe(false);         // dropped rather than growing

    const errored = sent.some((f) => Buffer.from(f)[0] === 0x04);
    expect(errored).toBe(true);
    agent.stop("test done");
  });

  test("maxConcurrent actually refuses the stream past the limit", async () => {
    const sent = [];
    const agent = newAgent({ maxConcurrent: 1 });
    agent.ws = { readyState: 1, send: (f) => sent.push(f), bufferedAmount: 0 };

    const payload = Buffer.from(JSON.stringify({ host: "localhost", port: 443 }));
    agent._handleOpen(1, payload);
    agent._handleOpen(2, payload);   // one over

    const errors = sent.map((f) => Buffer.from(f)).filter((b) => b[0] === 0x04);
    expect(errors.length).toBe(1);
    expect(errors[0].subarray(5).toString()).toMatch(/at capacity/);
    expect(agent.stats.streamsRefused).toBe(1);
    agent.stop("test done");
  });
});

describe("backoff honours its configured bounds", () => {
  test("never exceeds the configured maximum", () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const d = backoffDelay(attempt, { min: 1000, max: 5000 });
      expect(d).toBeLessThanOrEqual(5000);
      expect(d).toBeGreaterThan(0);
    }
  });

  test("a tighter minimum produces a shorter first retry", () => {
    for (let i = 0; i < 20; i++) {
      expect(backoffDelay(0, { min: 250, max: 60000 })).toBeLessThanOrEqual(250);
    }
  });

  test("is jittered, so a fleet does not reconnect in lockstep", () => {
    const seen = new Set();
    for (let i = 0; i < 40; i++) seen.add(backoffDelay(5, { min: 1000, max: 60000 }));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("logLevel actually filters", () => {
  test("silent prints nothing", () => {
    const lines = [];
    const log = logger("silent", { log: (m) => lines.push(m), error: (m) => lines.push(m) });
    log.error("e"); log.warn("w"); log.info("i"); log.debug("d");
    expect(lines).toEqual([]);
  });

  test("info prints through info but not debug", () => {
    const lines = [];
    const log = logger("info", { log: (m) => lines.push(m), error: (m) => lines.push(m) });
    log.error("e"); log.warn("w"); log.info("i"); log.debug("d");
    expect(lines).toEqual(["e", "w", "i"]);
  });

  test("debug prints everything", () => {
    const lines = [];
    const log = logger("debug", { log: (m) => lines.push(m), error: (m) => lines.push(m) });
    log.error("e"); log.warn("w"); log.info("i"); log.debug("d");
    expect(lines).toEqual(["e", "w", "i", "d"]);
  });

  test("an unrecognised level falls back to info rather than going silent", () => {
    // Silently discarding logs would be the worst possible failure here.
    const lines = [];
    const log = logger("nonsense", { log: (m) => lines.push(m), error: (m) => lines.push(m) });
    log.info("i");
    expect(lines).toEqual(["i"]);
  });

  test("every schema level is a level the logger knows", () => {
    for (const level of SCHEMA.logLevel.values) {
      const lines = [];
      const log = logger(level, { log: (m) => lines.push(m), error: (m) => lines.push(m) });
      log.error("e");
      expect({ level, silent: lines.length === 0 }).toEqual({ level, silent: level === "silent" });
    }
  });
});
