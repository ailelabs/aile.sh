/**
 * What the node tells the server about itself.
 *
 * The heartbeat is sent on every connect and every reconnect, which makes it the
 * highest-frequency outbound message this client has. Two properties matter, and
 * both are about what it must NOT do:
 *
 *  1. IT CARRIES NO CREDENTIALS. It cannot leak a provider token because this
 *     process never holds one — but it is built from the server's own `/providers`
 *     response, and that response could grow a field. An allowlist rather than a
 *     denylist is the difference between "a new server field is dropped" and "a
 *     new server field is echoed back to whoever is listening".
 *
 *  2. IT DOES NOT WAIVE THE TRANSPORT CHECK. The reconnect loop is precisely
 *     where an unconditional `insecure: true` would be invisible: no command, no
 *     prompt, the account token in clear on every retry forever.
 *
 * Everything here is an unverified *claim*. The server must treat it as one —
 * the real proof of a Codex account is the JWKS-verified `id_token` from linking,
 * against a nonce the server chose. See src/relay/attest.js.
 */

import { describe, expect, it, beforeEach, afterAll } from "bun:test";
import os from "node:os";

import { buildCapabilities, SAFE_FIELDS, DERIVED_FIELDS } from "../src/relay/attest.js";
import { saveConfig, resetSettings } from "../src/relay/config.js";
import { buildMcpCapability } from "../src/mcp/capabilities.js";
import { normalizeServer } from "../src/mcp/config.js";
import { RelayAgent } from "../src/relay/agent.js";

const LEAKY_ACCOUNT = {
  id: "acct-1",
  provider: "codex",
  account_key: "sub-abc",
  label: "Work",
  email: "lender@example.com",
  attested: 1,
  // Everything below is what a server response might carry alongside, or grow
  // later. None of it belongs in a message the node broadcasts.
  accessToken: "sk-MUST-NOT-ECHO",
  refreshToken: "rt-MUST-NOT-ECHO",
  ciphertext: "MUST-NOT-ECHO-blob",
  renter_id: "renter-internal-id",
  subject: "user-abc-123",
  attest_detail: '{"note":"internal"}',
};

let stub;

function stubServer(body = { accounts: [] }) {
  const seen = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      seen.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization") });
      return Response.json({ success: true, data: typeof body === "function" ? body() : body, message: "" });
    },
  });
  return {
    seen,
    url: `http://127.0.0.1:${server.port}`,
    stop: () => { try { server.stop(true); } catch { /* ignore */ } },
  };
}

beforeEach(() => {
  stub?.stop();
  stub = null;
  resetSettings();
  saveConfig({ renterToken: "" });
});

afterAll(() => stub?.stop());

const build = () => buildCapabilities({ nodeId: "test-node-01", maxConcurrent: 4 });

// ---------------------------------------------------------------------------

describe("the payload is an allowlist, not a passthrough", () => {
  it("forwards only the fields the server needs to route", async () => {
    stub = stubServer({ accounts: [LEAKY_ACCOUNT] });
    saveConfig({ serverUrl: stub.url, renterToken: "ail_tok" });

    const caps = await build();
    expect(caps.claimedConnections).toEqual([{
      id: "acct-1", provider: "codex", account_key: "sub-abc", label: "Work",
      email: "lender@example.com", attested: 1, authType: "oauth",
    }]);
    // Everything forwarded is either on the allowlist or derived locally. A field
    // that is neither came from the server response and was passed through.
    expect(Object.keys(caps.claimedConnections[0])).toEqual([...SAFE_FIELDS, ...DERIVED_FIELDS]);
  });

  // Every field on the allowlist is server-assigned metadata the server already
  // holds. That is the standard a new entry has to meet: `id` and `account_key`
  // are here because routing to ONE of several accounts of a provider needs
  // them, not because they were convenient to include.
  it("advertises each account of a provider separately, so the server can pick one", async () => {
    stub = stubServer({
      accounts: [
        { id: "a1", provider: "codex", account_key: "work", label: "Work", attested: 1 },
        { id: "a2", provider: "codex", account_key: "home", label: "Home", attested: 1 },
      ],
    });
    saveConfig({ serverUrl: stub.url, renterToken: "ail_tok" });

    const caps = await build();
    expect(caps.claimedConnections).toHaveLength(2);
    expect(caps.claimedConnections.map((c) => c.id)).toEqual(["a1", "a2"]);
  });

  // The test above would still pass if the allowlist were applied by deleting
  // known-bad keys. This one only passes if unknown keys are dropped by default,
  // which is the property that survives the server growing a new field.
  it("drops a field it has never heard of, rather than passing it along", async () => {
    stub = stubServer({ accounts: [{ ...LEAKY_ACCOUNT, someFutureSecret: "MUST-NOT-ECHO" }] });
    saveConfig({ serverUrl: stub.url, renterToken: "ail_tok" });

    const caps = await build();
    expect(JSON.stringify(caps)).not.toContain("MUST-NOT-ECHO");
    expect(caps.claimedConnections[0].someFutureSecret).toBeUndefined();
  });

  it("omits an absent field instead of advertising a null", async () => {
    stub = stubServer({ accounts: [{ id: "a", provider: "cursor", email: null }] });
    saveConfig({ serverUrl: stub.url, renterToken: "ail_tok" });

    const caps = await build();
    // `authType` is derived here rather than echoed, so it is present even when
    // the server said nothing about this account beyond its id and provider.
    expect(caps.claimedConnections[0]).toEqual({ id: "a", provider: "cursor", authType: "oauth" });
  });

  it("reports the node id and concurrency it was given, and the platform", async () => {
    stub = stubServer();
    saveConfig({ serverUrl: stub.url, renterToken: "ail_tok" });

    const caps = await build();
    expect(caps).toMatchObject({
      nodeId: "test-node-01", maxConcurrent: 4, platform: process.platform, agentVersion: 2,
    });
  });
});

describe("a broken server does not take the node down with it", () => {
  it("advertises an empty node when the server is unreachable", async () => {
    stub = stubServer();
    const dead = stub.url;
    stub.stop();
    saveConfig({ serverUrl: dead, renterToken: "ail_tok" });

    const caps = await build();
    expect(caps.claimedConnections).toEqual([]);
    expect(caps.nodeId).toBe("test-node-01");
  });

  it("advertises an empty node when the server rejects the token", async () => {
    stub = stubServer(() => Response.json({ error: "unauthorized" }, { status: 401 }));
    saveConfig({ serverUrl: stub.url, renterToken: "ail_stale" });

    const caps = await build();
    expect(caps.claimedConnections).toEqual([]);
  });

  it("survives a response with no accounts array at all", async () => {
    stub = stubServer({ unexpected: true });
    saveConfig({ serverUrl: stub.url, renterToken: "ail_tok" });

    const caps = await build();
    expect(caps.claimedConnections).toEqual([]);
  });

  /**
   * Signed out, this sends no `Authorization` header and depends on the server
   * answering 401 — which the real one does, but a heartbeat should not be the
   * thing standing between "signed out" and "connected anyway".
   *
   * It is not: the supervisor refuses to start before it ever builds a payload.
   * That is where the check belongs, and this pins it there so a future refactor
   * cannot move the guard out from under the assumption.
   */
  it("signing out is refused by the supervisor, not by the heartbeat", async () => {
    stub = stubServer({ accounts: [LEAKY_ACCOUNT] });
    saveConfig({ serverUrl: stub.url, renterToken: "" });

    const { startRelayAgent } = await import("../src/relay/supervisor.js");
    await expect(startRelayAgent()).rejects.toThrow(/not signed in/);
    expect(stub.seen).toEqual([]);   // it never got as far as a request
  });
});

describe("the reconnect loop does not quietly waive HTTPS", () => {
  // A non-loopback plain-HTTP server: reachable, and refused by the transport
  // guard. If the heartbeat waived the check, the token would arrive here.
  function lanAddress() {
    return Object.values(os.networkInterfaces()).flat()
      .find((i) => i?.family === "IPv4" && !i.internal)?.address || null;
  }

  it("makes no request at all over plain HTTP with allowInsecure off", async () => {
    const lan = lanAddress();
    if (!lan) return;

    const seen = [];
    const rec = Bun.serve({
      port: 0, hostname: "0.0.0.0",
      fetch(req) {
        seen.push(req.headers.get("authorization"));
        return Response.json({ success: true, data: { accounts: [LEAKY_ACCOUNT] }, message: "" });
      },
    });
    try {
      saveConfig({ serverUrl: `http://${lan}:${rec.port}`, renterToken: "ail_MUST_NOT_CROSS" });
      const caps = await build();
      expect(seen).toEqual([]);              // the token never left this process
      expect(caps.claimedConnections).toEqual([]);
    } finally {
      rec.stop(true);
    }
  });

  it("honours the saved opt-in, so a staging box still works when asked for", async () => {
    const lan = lanAddress();
    if (!lan) return;

    const seen = [];
    const rec = Bun.serve({
      port: 0, hostname: "0.0.0.0",
      fetch(req) {
        seen.push(req.headers.get("authorization"));
        return Response.json({ success: true, data: { accounts: [LEAKY_ACCOUNT] }, message: "" });
      },
    });
    try {
      saveConfig({ serverUrl: `http://${lan}:${rec.port}`, renterToken: "ail_tok", allowInsecure: true });
      const caps = await build();
      expect(seen).toEqual(["Bearer ail_tok"]);
      expect(caps.claimedConnections).toHaveLength(1);
    } finally {
      rec.stop(true);
    }
  });
});

/**
 * A key and a subscription fail differently under load — the subscription stops
 * at its monthly ceiling, the key keeps billing — so an operator has to be able
 * to tell them apart. `attested` cannot do it: an unverified subscription and a
 * key are both `0`.
 */
describe("how an account is paid for, separately from whether it is verified", () => {
  const advertise = async (accounts) => {
    stub = stubServer({ accounts });
    saveConfig({ serverUrl: stub.url, renterToken: "ail_tok" });
    return (await build()).claimedConnections;
  };

  it("marks a key-based account as apikey", async () => {
    const [account] = await advertise([{ id: "k1", provider: "openrouter", attested: 0 }]);
    expect(account.authType).toBe("apikey");
  });

  it("marks a subscription as oauth", async () => {
    const [account] = await advertise([{ id: "s1", provider: "codex", attested: 1 }]);
    expect(account.authType).toBe("oauth");
  });

  // The two questions are orthogonal, and this is the pair that proves it: both
  // accounts are unattested, and only authType separates them.
  it("distinguishes a key from an unverified subscription, which attested cannot", async () => {
    const accounts = await advertise([
      { id: "k1", provider: "openrouter", attested: 0 },
      { id: "s1", provider: "cursor", attested: 0 },
    ]);
    expect(accounts.map((a) => a.attested)).toEqual([0, 0]);
    expect(accounts.map((a) => a.authType)).toEqual(["apikey", "oauth"]);
  });

  // It is derived from the local catalog, not read off the server response, so a
  // server that starts sending its own `authType` cannot overwrite it — the same
  // allowlist rule that governs every other field here.
  it("derives it locally rather than echoing what the server claimed", async () => {
    const [account] = await advertise([
      { id: "k1", provider: "openrouter", attested: 0, authType: "oauth" },
    ]);
    expect(account.authType).toBe("apikey");
  });

  // A provider this build has never heard of is not a key provider by default —
  // it is the conservative reading, and it matches how such an account was
  // linked in the first place (an OAuth flow this client no longer ships).
  it("calls an unknown provider oauth rather than guessing apikey", async () => {
    const [account] = await advertise([{ id: "x1", provider: "not-a-provider-here", attested: 0 }]);
    expect(account.authType).toBe("oauth");
  });
});

describe("self-hosted capacity stays separable from a subscription", () => {
  it("is absent while local lending is off", async () => {
    stub = stubServer({ accounts: [LEAKY_ACCOUNT] });
    saveConfig({ serverUrl: stub.url, renterToken: "ail_tok" });

    const caps = await build();
    expect(caps.localModel).toBeNull();
  });

  // The privacy story differs: a self-hosted model runs on the lender's machine,
  // so that machine reads the prompt. Merging the two would let a buyer believe
  // the blind-relay guarantee covers traffic it does not cover.
  it("is advertised under its own key, never merged into claimedConnections", async () => {
    stub = stubServer({ accounts: [LEAKY_ACCOUNT] });
    saveConfig({
      serverUrl: stub.url, renterToken: "ail_tok",
      localEndpoint: "http://127.0.0.1:11434", localEnabled: true, localModels: "llama3",
    });

    const caps = await build();
    expect(caps.localModel).toEqual({ blind: false, models: ["llama3"], endpointPort: 11434 });
    // The subscription account is listed on its own, untouched — the assertion
    // is about the two staying separable, so it matches on identity rather than
    // on the full field list (which the allowlist test above pins).
    expect(caps.claimedConnections).toHaveLength(1);
    expect(caps.claimedConnections[0]).toMatchObject({ id: "acct-1", provider: "codex" });
    // The one field a server must not have to infer.
    expect(caps.localModel.blind).toBe(false);
  });
});

describe("sandboxed MCP capacity is advertised the same way, and withheld the same way", () => {
  // Empty is the NORMAL state of a node, not a fault: almost nobody declares an
  // MCP server. The key is present regardless so the server never has to
  // distinguish "old node" from "node with nothing to offer" — the hello field
  // being absent is what says "old node", and that is version negotiation.
  it("is an empty list on a node that declares nothing", async () => {
    stub = stubServer({ accounts: [] });
    saveConfig({ serverUrl: stub.url, renterToken: "ail_tok" });

    const caps = await build();
    expect(caps.mcpServers).toEqual([]);
  });

  // The server refuses any serverId absent from this list, so an entry here is a
  // promise the node has to keep. A declaration it could not sandbox is a
  // listing that fails on first rent, which is worse than not listing at all.
  it("withholds a declared server when nothing could sandbox it", async () => {
    stub = stubServer({ accounts: [] });
    saveConfig({ serverUrl: stub.url, renterToken: "ail_tok" });

    const mcp = buildMcpCapability({
      load: () => [normalizeServer({ id: "srv", image: "alpine:3" })],
      detect: () => ({ ok: false, state: "stopped", message: "installed but not running" }),
      log: { warn() {} },
    });
    const caps = await buildCapabilities({ nodeId: "test-node-01", maxConcurrent: 4, mcp });
    expect(caps.mcpServers).toEqual([]);
    // …and the lender is told which of the two reasons it was.
    expect(mcp.reason).toMatch(/installed but not running/);
  });

  it("carries the blindness answer and the egress caveat with the listing", async () => {
    stub = stubServer({ accounts: [LEAKY_ACCOUNT] });
    saveConfig({ serverUrl: stub.url, renterToken: "ail_tok" });

    const mcp = buildMcpCapability({
      load: () => [
        normalizeServer({ id: "sealed", image: "alpine:3" }),
        normalizeServer({ id: "open", image: "alpine:3", network: ["api.anthropic.com"] }),
      ],
      detect: () => ({ ok: true, runtime: "docker", state: "running", message: "docker 27.1.1" }),
      log: { warn() {} },
    });
    const caps = await buildCapabilities({ nodeId: "test-node-01", maxConcurrent: 4, mcp });

    // Compute happens on the lender's machine, exactly like localModel — so the
    // server never has to infer it, and never merges this into a blind path.
    expect(caps.mcpServers.every((s) => s.blind === false)).toBe(true);
    // The pair travels together: a host list with no `egressEnforced` beside it
    // reads as a firewall, and only the empty one actually is.
    expect(caps.mcpServers[0]).toMatchObject({ id: "sealed", egress: [], egressEnforced: true });
    expect(caps.mcpServers[1]).toMatchObject({
      id: "open", egress: ["api.anthropic.com"], egressEnforced: false,
    });
    // Separable from a subscription, same as localModel.
    expect(caps.claimedConnections).toHaveLength(1);
  });
});

describe("re-advertising on a live socket", () => {
  // A lender who edits mcp-servers.json while the node runs sees `aile mcp` say
  // the server is valid while the agent goes on advertising the list it built at
  // connect time. Re-advertising is how those two stop disagreeing — and it must
  // not be a reconnect, which would fail somebody else's in-flight paid stream.
  it("sends a second hello and touches nothing else", () => {
    const sent = [];
    const agent = new RelayAgent({ serverUrl: "https://example.invalid", renterToken: "t", nodeId: "n1" });
    agent.ws = { readyState: 1, send: (m) => sent.push(m) };

    expect(agent.readvertise({ nodeId: "n1", mcpServers: [{ id: "srv" }] })).toBe(true);
    expect(sent).toHaveLength(1);
    const msg = JSON.parse(sent[0]);
    expect(msg.type).toBe("hello");
    expect(msg.capabilities.mcpServers).toEqual([{ id: "srv" }]);
  });

  it("does nothing without a live socket, and says so", () => {
    const agent = new RelayAgent({ serverUrl: "https://example.invalid", renterToken: "t", nodeId: "n1" });
    expect(agent.readvertise({ nodeId: "n1" })).toBe(false);
    agent.ws = { readyState: 3, send: () => { throw new Error("sent on a closed socket"); } };
    expect(agent.readvertise({ nodeId: "n1" })).toBe(false);
    // The next connect advertises fresh capabilities anyway; there is nothing
    // to queue and nothing to report.
  });
});
