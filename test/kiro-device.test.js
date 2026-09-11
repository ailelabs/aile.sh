/**
 * Kiro — the one device flow with a dynamic-client REGISTER pre-step.
 *
 * WHY THIS FILE EXISTS. Every other device provider carries a single static
 * clientId; kiro (AWS SSO OIDC) has none until it registers one at link time.
 * RegisterClient mints an ephemeral {clientId, clientSecret} that must then feed
 * BOTH the device-authorization POST and the token POST — get the threading
 * wrong and the initiate 400s with a client it never issued, AFTER the lender
 * has already been sent to approve. AWS also signals "keep polling" with an HTTP
 * 400 whose BODY carries the code, not a 200 with an error field, so the poll
 * loop has to read a 400 body before treating it as a hard failure.
 *
 * Same stub-on-loopback approach as device-flow.test.js: what is asserted is the
 * bytes on the wire. kiro's endpoints are nested inside `deviceStyle`, so the
 * redirect here rewrites those three URLs rather than the top-level oauth fields.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { linkProvider } from "../src/providers/flows.js";
import { getProvider } from "../src/providers/index.js";

/** A stub provider endpoint that records path/method/headers/json of each call. */
function stubProvider(routes) {
  const calls = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      calls.push({
        path: url.pathname,
        method: req.method,
        headers: Object.fromEntries(req.headers),
        body,
        json: (() => { try { return JSON.parse(body); } catch { return null; } })(),
      });
      const handler = routes[url.pathname];
      if (!handler) return Response.json({ error: "no stub route" }, { status: 404 });
      return handler(calls.filter((c) => c.path === url.pathname).length, calls.at(-1));
    },
  });
  return {
    calls,
    base: `http://127.0.0.1:${server.port}`,
    stop: () => { try { server.stop(true); } catch { /* already gone */ } },
  };
}

/**
 * Point kiro's three described endpoints at the stub for one test.
 *
 * The URLs live inside `deviceStyle` (register/initiate/poll), so this rewrites
 * a DEEP copy of that object and restores the top-level `oauth` afterwards — the
 * same restore discipline device-flow.test.js uses, extended one level down so a
 * mutated nested object can't leak into the next test. `intervalMs` is dropped to
 * a few ms so the poll loop isn't measuring the catalog's real 5s cadence.
 */
const restores = [];
function redirectKiro(base, { paceMs = 5 } = {}) {
  const o = getProvider("kiro").oauth;
  const saved = { ...o, deviceStyle: o.deviceStyle };
  restores.push(() => {
    for (const k of Object.keys(o)) delete o[k];
    Object.assign(o, saved);
  });
  const ds = structuredClone(o.deviceStyle);
  ds.register.url = `${base}/register`;
  ds.initiate.url = `${base}/device`;
  ds.poll.url = `${base}/token`;
  ds.intervalMs = paceMs;
  o.deviceStyle = ds;
  return o;
}
afterEach(() => { while (restores.length) restores.pop()(); });

function run() {
  return linkProvider("kiro", { log: () => {}, openBrowser: () => {} });
}

/** register → device → (400 pending) → 200 token, the happy path. */
function stubHappy() {
  return stubProvider({
    "/register": () => Response.json({ clientId: "reg-cid", clientSecret: "reg-secret" }),
    "/device": () => Response.json({
      deviceCode: "dc-kiro", userCode: "KIRO-1",
      verificationUriComplete: "https://view.awsapps.com/start/device?code=KIRO-1",
      expiresIn: 600,
    }),
    "/token": (n) => (n === 1
      ? Response.json({ error: "authorization_pending" }, { status: 400 })
      : Response.json({ accessToken: "at-kiro", refreshToken: "rt-kiro", expiresIn: 3600 })),
  });
}

describe("Kiro register pre-step", () => {
  it("registers a client BEFORE the device call and threads its id/secret into both later POSTs", async () => {
    const s = stubHappy();
    try {
      redirectKiro(s.base);
      await run();

      // Order: register is first, then device-authorization, then the polls.
      expect(s.calls[0].path).toBe("/register");
      expect(s.calls[0].json.clientName).toBe("kiro-oauth-client");
      expect(s.calls[0].json.grantTypes).toContain("urn:ietf:params:oauth:grant-type:device_code");

      // The ephemeral credentials from /register feed the device-authorization body…
      const initiate = s.calls.find((c) => c.path === "/device");
      expect(initiate.json.clientId).toBe("reg-cid");
      expect(initiate.json.clientSecret).toBe("reg-secret");
      expect(initiate.json.startUrl).toBe("https://view.awsapps.com/start");

      // …and every token POST too, alongside the device code from initiate.
      const token = s.calls.find((c) => c.path === "/token");
      expect(token.json.clientId).toBe("reg-cid");
      expect(token.json.clientSecret).toBe("reg-secret");
      expect(token.json.deviceCode).toBe("dc-kiro");
      expect(token.json.grantType).toBe("urn:ietf:params:oauth:grant-type:device_code");
    } finally { s.stop(); }
  });

  it("carries the registered client + region into the stored credential so refresh can re-present them", async () => {
    const s = stubHappy();
    try {
      redirectKiro(s.base);
      const tokens = await run();
      expect(tokens.accessToken).toBe("at-kiro");
      expect(tokens.refreshToken).toBe("rt-kiro");
      // The half that makes refresh possible — never fabricated, only carried
      // through when the register step actually minted them.
      expect(tokens.clientId).toBe("reg-cid");
      expect(tokens.clientSecret).toBe("reg-secret");
      expect(tokens.region).toBe("us-east-1");
      expect(tokens.authMethod).toBe("builder-id");
    } finally { s.stop(); }
  });

  it("aborts when registration returns no credentials rather than dialling device-auth with an empty client", async () => {
    const s = stubProvider({
      "/register": () => Response.json({}),
      "/device": () => Response.json({ deviceCode: "dc", verificationUriComplete: "https://v" }),
      "/token": () => Response.json({ accessToken: "at" }),
    });
    try {
      redirectKiro(s.base);
      await expect(run()).rejects.toThrow(/no client credentials/i);
      // It stopped at /register — no device call went out with a blank client.
      expect(s.calls.map((c) => c.path)).toEqual(["/register"]);
    } finally { s.stop(); }
  });
});

describe("Kiro poll reads the AWS 400-body code", () => {
  it("treats a 400 authorization_pending as keep-waiting, not a failure", async () => {
    const s = stubHappy();
    try {
      redirectKiro(s.base);
      await run();
      // Two token POSTs: the first 400/pending did not end the loop.
      expect(s.calls.filter((c) => c.path === "/token")).toHaveLength(2);
    } finally { s.stop(); }
  });

  it("surfaces a 400 expired_token as an expiry rather than waiting out the timeout", async () => {
    const s = stubProvider({
      "/register": () => Response.json({ clientId: "c", clientSecret: "s" }),
      "/device": () => Response.json({ deviceCode: "dc", verificationUriComplete: "https://v" }),
      "/token": () => Response.json({ error: "expired_token" }, { status: 400 }),
    });
    try {
      redirectKiro(s.base);
      await expect(run()).rejects.toThrow(/expired/i);
    } finally { s.stop(); }
  });

  it("surfaces a 400 access_denied as a denial", async () => {
    const s = stubProvider({
      "/register": () => Response.json({ clientId: "c", clientSecret: "s" }),
      "/device": () => Response.json({ deviceCode: "dc", verificationUriComplete: "https://v" }),
      "/token": () => Response.json({ error: "access_denied" }, { status: 400 }),
    });
    try {
      redirectKiro(s.base);
      await expect(run()).rejects.toThrow(/denied/i);
    } finally { s.stop(); }
  });

  it("still fails loudly on a 400 that is not a poll-state code", async () => {
    const s = stubProvider({
      "/register": () => Response.json({ clientId: "c", clientSecret: "s" }),
      "/device": () => Response.json({ deviceCode: "dc", verificationUriComplete: "https://v" }),
      "/token": () => Response.json({ error: "invalid_grant" }, { status: 400 }),
    });
    try {
      redirectKiro(s.base);
      await expect(run()).rejects.toThrow(/Polling failed \(400\)/);
    } finally { s.stop(); }
  });
});
