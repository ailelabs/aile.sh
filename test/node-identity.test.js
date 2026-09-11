/**
 * Recovering from a machine the server will not accept.
 *
 * THE LOCKOUT THIS COVERS. Node identity is derived from files under the data
 * dir that deliberately survive `aile logout` — the machine is meant to stay the
 * same machine. But that means signing into a *second* account leaves this
 * machine still registered to the first, and the server correctly refuses to
 * move it: letting any token reclaim any node would let anyone point another
 * lender's traffic at themselves. Before this, the client had no way forward at
 * all — sign-in reported success, `aile start` connected, was rejected, and
 * retried forever behind an opaque "websocket error".
 *
 * The fix is to take a NEW identity rather than to fight for the old one, and
 * the tests below pin the three things that makes safe:
 *
 *  1. Only a 409 rotates. A 401 means the *token* is wrong, and minting a fresh
 *     identity for a bad token would produce unbounded orphaned node rows.
 *  2. Rotation actually changes the id, and the new secret is on disk — an
 *     in-memory-only rotation would sign the next handshake with a secret the
 *     server has never seen.
 *  3. The supervisor stops. Backoff is right for a flaky network and wrong for a
 *     decision, and looping forever is how the original bug stayed invisible.
 *
 * Sandboxed via test/setup.js: this writes real secret files.
 */

import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const { AILE_DIR } = await import("../src/relay/paths.js");

// --- doubles ---------------------------------------------------------------

/** Queue of responses `fetch` should give, oldest first. */
let fetchQueue = [];
const fetchCalls = [];
const realFetch = globalThis.fetch;

function reply(status, body = {}) {
  const enveloped = status >= 200 && status < 300
    ? { success: true, data: body, message: "" }
    : { success: false, message: body.error ?? "", error: body.error };
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => enveloped,
    text: async () => JSON.stringify(enveloped),
  };
}

beforeEach(() => {
  fetchQueue = [];
  fetchCalls.length = 0;
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url: String(url), body: JSON.parse(opts?.body || "{}") });
    if (!fetchQueue.length) throw new Error("unexpected fetch");
    const next = fetchQueue.shift();
    if (next instanceof Error) throw next;
    return next;
  };
});

afterEach(() => { globalThis.fetch = realFetch; });

const { getNodeId, rotateNodeIdentity } = await import("../src/relay/identity.js");
const { loadNodeSecret, rotateNodeSecret } = await import("../src/relay/state.js");
const { enrollNode, enrollNodeOrRotate } = await import("../src/relay/enroll.js");

const SERVER = "http://relay.test";
const TOKEN = "ail_test_token";

// ---------------------------------------------------------------------------

describe("sandbox", () => {
  // This file writes node-secret. If the preload ever stops taking effect it
  // would overwrite the developer's real one, silently unregistering their node.
  it("is pointed at the temp data dir", () => {
    expect(process.env.AILE_DATA_DIR).toBeTruthy();
    expect(path.resolve(AILE_DIR)).toContain("aile-test-");
  });
});

describe("rotateNodeSecret", () => {
  it("replaces the secret on disk and in memory", () => {
    const before = loadNodeSecret();
    const after = rotateNodeSecret();

    expect(after).not.toBe(before);
    expect(after).toMatch(/^[0-9a-f]{64}$/);
    // On disk, or the next process reverts to the abandoned secret.
    expect(fs.readFileSync(path.join(AILE_DIR, "node-secret"), "utf8").trim()).toBe(after);
    // And in memory — the cache is what this process keeps signing with. A
    // rotation that only reached the file would fail at exactly the moment it
    // was supposed to fix things, one layer further down.
    expect(loadNodeSecret()).toBe(after);
  });
});

describe("rotateNodeIdentity", () => {
  it("yields a different node id", () => {
    const before = getNodeId();
    const after = rotateNodeIdentity();
    expect(after).not.toBe(before);
    expect(after).toMatch(/^[0-9a-f]{16}$/);
  });

  it("clears the memo, so every later caller sees the new id", () => {
    // getNodeId memoizes. Without clearing it, the process would keep handing
    // out the id it just abandoned and enrol one id while connecting as another.
    const after = rotateNodeIdentity();
    expect(getNodeId()).toBe(after);
    expect(getNodeId()).toBe(after);
  });

  it("keeps the machine id, so the machine stays recognisably itself", () => {
    const machineFile = path.join(AILE_DIR, "machine-id");
    getNodeId();                                    // provision it
    const before = fs.readFileSync(machineFile, "utf8");
    rotateNodeIdentity();
    expect(fs.readFileSync(machineFile, "utf8")).toBe(before);
  });
});

describe("enrollNode", () => {
  it("tags the ownership conflict with a code the caller can branch on", async () => {
    fetchQueue.push(reply(409, { error: "node belongs to another account" }));
    const err = await enrollNode({ serverUrl: SERVER, renterToken: TOKEN }).catch((e) => e);
    // Matching prose here would break the recovery path on a server reword.
    expect(err.code).toBe("NODE_OWNED");
  });

  it("does not tag a rejected token", async () => {
    fetchQueue.push(reply(401, { error: "unauthorized" }));
    const err = await enrollNode({ serverUrl: SERVER, renterToken: TOKEN }).catch((e) => e);
    expect(err.code).toBeUndefined();
    expect(err.message).toMatch(/token rejected/);
  });

  it("sends this machine's current id and secret", async () => {
    fetchQueue.push(reply(200, { ok: true }));
    await enrollNode({ serverUrl: SERVER, renterToken: TOKEN });
    expect(fetchCalls[0].body.nodeId).toBe(getNodeId());
    expect(fetchCalls[0].body.secret).toBe(loadNodeSecret());
  });
});

describe("enrollNodeOrRotate", () => {
  it("passes straight through when the server accepts the machine", async () => {
    fetchQueue.push(reply(200, { ok: true }));
    const res = await enrollNodeOrRotate({ serverUrl: SERVER, renterToken: TOKEN });
    expect(res.rotated).toBe(false);
    expect(fetchCalls.length).toBe(1);            // no gratuitous second identity
  });

  it("takes a new identity when the machine belongs to another account", async () => {
    const before = getNodeId();
    fetchQueue.push(reply(409, { error: "node belongs to another account" }));
    fetchQueue.push(reply(200, { ok: true }));

    const res = await enrollNodeOrRotate({ serverUrl: SERVER, renterToken: TOKEN });

    expect(res.rotated).toBe(true);
    expect(getNodeId()).not.toBe(before);
    // The retry must carry the NEW id — retrying with the old one would just
    // collect a second 409.
    expect(fetchCalls[1].body.nodeId).toBe(getNodeId());
    expect(fetchCalls[1].body.nodeId).not.toBe(fetchCalls[0].body.nodeId);
  });

  it("does NOT rotate on a rejected token", async () => {
    // A wrong token is not fixed by a new identity, and rotating on 401 would
    // let a bad token mint an unbounded supply of orphaned node rows.
    const before = getNodeId();
    fetchQueue.push(reply(401, { error: "unauthorized" }));

    await expect(enrollNodeOrRotate({ serverUrl: SERVER, renterToken: TOKEN }))
      .rejects.toThrow(/token rejected/);
    expect(getNodeId()).toBe(before);
    expect(fetchCalls.length).toBe(1);
  });

  it("gives up if the fresh identity is refused too", async () => {
    fetchQueue.push(reply(409, { error: "node belongs to another account" }));
    fetchQueue.push(reply(500, { error: "boom" }));
    await expect(enrollNodeOrRotate({ serverUrl: SERVER, renterToken: TOKEN })).rejects.toThrow();
    expect(fetchCalls.length).toBe(2);            // one rotation, not a loop
  });

  it("says what it did, because the node id in later output changes", async () => {
    const lines = [];
    fetchQueue.push(reply(409, { error: "node belongs to another account" }));
    fetchQueue.push(reply(200, { ok: true }));
    await enrollNodeOrRotate({ serverUrl: SERVER, renterToken: TOKEN, log: (m) => lines.push(m) });
    expect(lines.join(" ")).toMatch(/different account/i);
  });
});
