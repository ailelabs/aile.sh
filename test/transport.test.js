/**
 * The transport guard.
 *
 * Everything this client sends to aile.sh carries the account token in an
 * `Authorization` header, and during linking it carries provider tokens in the
 * body. On plain HTTP both cross the network in clear. So the rule is: refuse
 * non-HTTPS unless a human explicitly waived it, and refuse it BEFORE the
 * request is made — a guard that fires after the socket is open has already
 * leaked the thing it was guarding.
 *
 * Loopback is the one exemption, because those bytes never reach a network.
 * A staging box reached by IP is NOT exempt, which is the entire reason
 * `--insecure` exists.
 *
 * The second half of this file is about `enrollNode`, which calls `fetch`
 * directly rather than going through the api client. That means it has no guard
 * of its own and relies on its callers for one. Those tests pin the callers.
 */

import { describe, expect, it, beforeEach, afterEach, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";

import * as client from "../src/api/client.js";
import { enrollNode } from "../src/relay/enroll.js";
import { loadNodeSecret } from "../src/relay/state.js";
import { getNodeId } from "../src/relay/identity.js";

// This file must test the REAL client. login.test.js calls `mock.module` on it,
// and that mutates one process-wide registry with no way to undo it — so
// without `--isolate` this file silently receives that stub and every assertion
// below stops meaning anything. Fail loudly, and say what to run.
if (typeof client.assertTransportOk !== "function") {
  throw new Error(
    "src/api/client.js has been replaced by another test file's mock.module. " +
    "Run `npm test` (which passes --isolate), not a bare `bun test`."
  );
}
const { api, apiCall, ApiError, isSecureUrl, assertTransportOk } = client;

/** Records every request that actually reached the wire. */
function stubServer(handler = null) {
  const seen = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const raw = await req.text();
      seen.push({
        path: url.pathname,
        // Kept apart from the path: a filter that lands in the path instead of
        // the query is a different route, and the assertions have to be able to
        // tell those apart.
        query: url.searchParams.toString(),
        method: req.method,
        auth: req.headers.get("authorization"),
        contentType: req.headers.get("content-type"),
        body: raw ? JSON.parse(raw) : null,
      });
      return handler?.(url, seen.at(-1)) ?? Response.json({ ok: true });
    },
  });
  return {
    seen,
    url: `http://127.0.0.1:${server.port}`,
    stop: () => { try { server.stop(true); } catch { /* ignore */ } },
  };
}

let stub;
beforeEach(() => { stub?.stop(); stub = null; });
afterAll(() => stub?.stop());

// ---------------------------------------------------------------------------

describe("what counts as safe enough to send a token over", () => {
  it.each([
    "https://api.aile.sh",
    "https://api.aile.sh/",
    "https://localhost",
    "http://localhost",
    "http://localhost:20443",
    "http://127.0.0.1",
    "http://127.0.0.1:20443",
  ])("accepts %s", (url) => {
    expect({ url, secure: isSecureUrl(url) }).toEqual({ url, secure: true });
  });

  it.each([
    ["a staging box reached by IP", "http://49.51.159.242:20443"],
    ["any plain-HTTP host", "http://api.aile.sh"],
    ["a hostname that merely starts with localhost", "http://localhost.evil.example"],
    ["a hostname that merely starts with 127.0.0.1", "http://127.0.0.1.evil.example"],
    ["a different address in 127/8", "http://127.0.0.10"],
    ["a non-HTTP scheme", "ws://api.aile.sh"],
    ["nothing at all", ""],
  ])("refuses %s", (_name, url) => {
    expect({ url, secure: isSecureUrl(url) }).toEqual({ url, secure: false });
  });

  // `localhost.evil.example` resolving under an attacker's control is the whole
  // reason the check is anchored on a delimiter rather than a prefix.
  it("the loopback exemption is anchored, not a prefix match", () => {
    expect(isSecureUrl("http://localhost")).toBe(true);
    expect(isSecureUrl("http://localhostage.example")).toBe(false);
  });

  it("names the URL and the way out when it refuses", () => {
    expect(() => assertTransportOk("http://49.51.159.242:20443"))
      .toThrow(/49\.51\.159\.242:20443.*clear.*--insecure/s);
  });

  it("an explicit waiver is honoured — that is what --insecure buys", () => {
    expect(() => assertTransportOk("http://49.51.159.242:20443", { insecure: true })).not.toThrow();
  });
});

describe("the guard fires before the socket opens", () => {
  it("no request is made when the transport is refused", async () => {
    stub = stubServer();
    // A real, reachable server — but named by an address the guard rejects.
    // If the check ran after the fetch, `seen` would not be empty.
    const lan = Object.values(os.networkInterfaces()).flat()
      .find((i) => i?.family === "IPv4" && !i.internal)?.address;
    if (!lan) return; // no non-loopback interface in this environment

    const port = new URL(stub.url).port;
    await expect(api.me({ serverUrl: `http://${lan}:${port}`, token: "ail_secret" }))
      .rejects.toThrow(/plain HTTP/);
    expect(stub.seen).toEqual([]);
  });

  it.each([
    ["me", (opts) => api.me(opts)],
    ["listProviders", (opts) => api.listProviders(opts)],
    ["providerNonce", (opts) => api.providerNonce({ provider: "codex", ...opts })],
    ["saveProvider", (opts) => api.saveProvider({ provider: "codex", tokens: {}, nonce: "n", ...opts })],
    ["removeProvider", (opts) => api.removeProvider({ id: "x", ...opts })],
    ["startDeviceLogin", (opts) => api.startDeviceLogin(opts)],
    ["health", (opts) => api.health(opts)],
  ])("%s is guarded, not just the ones someone remembered", async (_name, call) => {
    await expect(call({ serverUrl: "http://staging.example.com", token: "ail_secret" }))
      .rejects.toThrow(/plain HTTP/);
  });
});

describe("the wire shape the server is entitled to expect", () => {
  it("sends the account token as a bearer, and JSON only when there is a body", async () => {
    stub = stubServer();
    await api.listProviders({ serverUrl: stub.url, token: "ail_tok" });
    expect(stub.seen[0]).toMatchObject({
      path: "/providers", method: "GET", auth: "Bearer ail_tok", contentType: null,
    });
  });

  it("omits the header entirely rather than sending `Bearer null`", async () => {
    stub = stubServer();
    await apiCall("/health", { serverUrl: stub.url });
    expect(stub.seen[0].auth).toBeNull();
  });

  it("asks for a nonce by provider, and uploads the nonce it was given", async () => {
    stub = stubServer();
    await api.providerNonce({ provider: "codex", serverUrl: stub.url, token: "t" });
    await api.saveProvider({
      provider: "codex", tokens: { accessToken: "x" }, nonce: "n-1", email: null,
      serverUrl: stub.url, token: "t",
    });
    expect(stub.seen.map((c) => [c.method, c.path])).toEqual([
      ["POST", "/providers/nonce"], ["POST", "/providers"],
    ]);
    expect(stub.seen[0].body).toEqual({ provider: "codex" });
    // `accountKey` and `label` are sent explicitly as null rather than omitted:
    // the server distinguishes "the lender chose no key" from "this client is
    // too old to have one", and only the first may fall back to the default key.
    //
    // `probe` is null for the same reason — "nothing was asked" is a different
    // answer from "asked and it failed", and a caller that ran no probe must not
    // look like one whose probe came back negative.
    //
    // toEqual, not toMatchObject, on purpose: this is the exact body the server
    // is entitled to expect, so a field added to the client without being
    // considered here fails rather than arriving unannounced.
    expect(stub.seen[1].body).toEqual({
      provider: "codex", tokens: { accessToken: "x" }, nonce: "n-1", email: null,
      accountKey: null, label: null, probe: null,
    });
  });

  it("carries the lender's own name and key for an account when given them", async () => {
    stub = stubServer();
    await api.saveProvider({
      provider: "cursor", tokens: { accessToken: "x" }, nonce: null, email: null,
      accountKey: "work", label: "Work laptop", serverUrl: stub.url, token: "t",
    });
    expect(stub.seen[0].body).toMatchObject({ accountKey: "work", label: "Work laptop" });
  });

  it("does not send an id in the body when it belongs in the path", async () => {
    stub = stubServer();
    await api.removeProvider({ id: "acct-9", serverUrl: stub.url, token: "t" });
    expect(stub.seen[0]).toMatchObject({ method: "DELETE", path: "/providers/acct-9", body: null });
  });

  it("scopes the listing to one provider when asked, and escapes what it interpolates", async () => {
    stub = stubServer();
    await api.listProviders({ provider: "gemini-cli", serverUrl: stub.url, token: "t" });
    expect(stub.seen[0].path).toBe("/providers");
    expect(stub.seen[0].query).toBe("provider=gemini-cli");

    await api.listProviders({ provider: "a&b=c", serverUrl: stub.url, token: "t" });
    expect(stub.seen[1].query).toBe("provider=a%26b%3Dc");
  });

  it("renames by id in the path, with the label in the body", async () => {
    stub = stubServer();
    await api.labelProvider({ id: "acct-9", label: "Work", serverUrl: stub.url, token: "t" });
    expect(stub.seen[0]).toMatchObject({
      method: "PATCH", path: "/providers/acct-9", body: { label: "Work" },
    });
  });

  it("tolerates a trailing slash on the configured server URL", async () => {
    stub = stubServer();
    await api.health({ serverUrl: `${stub.url}///` });
    expect(stub.seen[0].path).toBe("/health");
  });
});

describe("failures are distinguishable, because callers act on the difference", () => {
  it("carries the server's own message and status when it says no", async () => {
    stub = stubServer((url) => url.pathname === "/me"
      ? Response.json({ error: "token expired" }, { status: 401 })
      : Response.json({ ok: true }));

    const err = await api.me({ serverUrl: stub.url, token: "t" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect({ status: err.status, message: err.message }).toEqual({
      status: 401, message: "token expired",
    });
  });

  it("falls back to the status when the body is not JSON", async () => {
    stub = stubServer(() => new Response("<html>502</html>", { status: 502 }));
    const err = await api.me({ serverUrl: stub.url, token: "t" }).catch((e) => e);
    expect(err.message).toBe("server returned 502");
  });

  /**
   * THE `undefined` BUG. `api.aile.sh` sat behind an access proxy, so the start of
   * `aile login` got a 302 to a sign-in portal, `fetch` followed it, and an HTML
   * page came back with status 200. The old `res.json().catch(() => ({}))` turned
   * that into an empty object, `res.ok` was true so nothing threw, and the CLI
   * printed the word "undefined" where the sign-in URL belonged — then polled a
   * device code that had never existed until it timed out ten minutes later.
   *
   * A SUCCESSFUL response that is not JSON must therefore be loud. The 502 case
   * above must stay quiet, which is why these are asserted side by side.
   */
  it("throws on a 200 that is HTML, instead of yielding an empty object", async () => {
    stub = stubServer(() => new Response("<!doctype html><html><body>Sign in</body></html>", {
      status: 200, headers: { "content-type": "text/html" },
    }));
    const err = await api.me({ serverUrl: stub.url, token: "t" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toContain("an HTML page");
    expect(err.message).toContain("not JSON");
  });

  it("names the host that answered when a request is redirected off-host", async () => {
    // The portal case: the address was right and something else replied.
    const portal = stubServer(() => new Response("<html>login</html>", {
      status: 200, headers: { "content-type": "text/html" },
    }));
    stub = stubServer(() => new Response(null, { status: 302, headers: { location: `${portal.url}/cdn-cgi/access/login` } }));
    const err = await api.me({ serverUrl: stub.url, token: "t" }).catch((e) => e);
    portal.stop();
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toContain("redirected to");
    expect(err.body.redirectedTo).toBe(new URL(portal.url).host);
  });

  it("never echoes the body it rejected — it could be anyone's HTML", async () => {
    stub = stubServer(() => new Response("<html><script>alert(1)</script>SECRETMARKER</html>", {
      status: 200, headers: { "content-type": "text/html" },
    }));
    const err = await api.me({ serverUrl: stub.url, token: "t" }).catch((e) => e);
    expect(err.message).not.toContain("SECRETMARKER");
    expect(err.message).not.toContain("<script>");
  });

  /**
   * A relay behind Cloudflare Access. The service token is the only way a CLI gets
   * past it, and the ONLY safe way to send one is without following redirects —
   * `fetch` re-sends custom headers to whatever a 3xx points at, so a followed
   * redirect hands the operator's token to whichever host answered.
   */
  /**
   * `null` IS NOT "not sent", and a live server proved it: an optional string field
   * answers an explicit `null` with a 422 ("Expected string") while ignoring the key
   * entirely when it is absent. The first version of the binding sent `null` for
   * every field it had no value for, which turned every optional parameter into a
   * failed request the moment the caller omitted one.
   */
  describe("optional fields are omitted, never sent as null", () => {
    it("sends no codeChallenge/clientLabel key at all when there is none", async () => {
      stub = stubServer();
      await api.startDeviceLogin({ serverUrl: stub.url });
      expect(stub.seen[0].body).toEqual({});
    });

    it("sends them when they exist", async () => {
      stub = stubServer();
      await api.startDeviceLogin({ serverUrl: stub.url, codeChallenge: "chal", clientLabel: "box" });
      expect(stub.seen[0].body).toEqual({ codeChallenge: "chal", clientLabel: "box" });
    });

    it("omits codeVerifier on a poll that has none", async () => {
      stub = stubServer(() => Response.json({ status: "pending" }));
      await api.pollDeviceLogin({ deviceCode: "dc", serverUrl: stub.url });
      expect(stub.seen[0].body).toEqual({ deviceCode: "dc" });
    });

    it("includes codeVerifier when the caller has one", async () => {
      stub = stubServer(() => Response.json({ status: "pending" }));
      await api.pollDeviceLogin({ deviceCode: "dc", codeVerifier: "v", serverUrl: stub.url });
      expect(stub.seen[0].body).toEqual({ deviceCode: "dc", codeVerifier: "v" });
    });
  });

  describe("a relay behind an access proxy", () => {
    const CF = { CF_ACCESS_CLIENT_ID: "id.access", CF_ACCESS_CLIENT_SECRET: "shhh" };
    let saved;
    beforeEach(() => { saved = { ...process.env }; Object.assign(process.env, CF); });
    afterEach(() => {
      delete process.env.CF_ACCESS_CLIENT_ID;
      delete process.env.CF_ACCESS_CLIENT_SECRET;
      if (saved.CF_ACCESS_CLIENT_ID) process.env.CF_ACCESS_CLIENT_ID = saved.CF_ACCESS_CLIENT_ID;
      if (saved.CF_ACCESS_CLIENT_SECRET) process.env.CF_ACCESS_CLIENT_SECRET = saved.CF_ACCESS_CLIENT_SECRET;
    });

    it("sends the service token when both halves are in the environment", async () => {
      const seen = [];
      stub = stubServer((_url, call) => { seen.push(call); return Response.json({ ok: true }); });
      const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
        seen.push({ id: req.headers.get("cf-access-client-id"), secret: req.headers.get("cf-access-client-secret") });
        return Response.json({ ok: true });
      }});
      await api.health({ serverUrl: `http://127.0.0.1:${server.port}` });
      server.stop(true);
      expect(seen.at(-1)).toEqual({ id: "id.access", secret: "shhh" });
    });

    it("NEVER forwards the token to a redirect target", async () => {
      // The leak this guards: with `redirect: "follow"` the secret arrives at the
      // portal in full. Verified against Bun before the guard was written.
      let leaked = null;
      const portal = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
        leaked = req.headers.get("cf-access-client-secret");
        return new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } });
      }});
      const portalHost = `127.0.0.1:${portal.port}`;   // read BEFORE stop(), which zeroes it
      stub = stubServer(() => new Response(null, {
        status: 302, headers: { location: `http://${portalHost}/cdn-cgi/access/login` } }));

      const err = await api.health({ serverUrl: stub.url }).catch((e) => e);
      portal.stop(true);

      expect(leaked).toBeNull();                    // the portal never saw it
      expect(err).toBeInstanceOf(ApiError);
      expect(err.message).toContain("redirected to");
      expect(err.body.redirectedTo).toBe(portalHost);
    });

    it("sends nothing when only one half is set — a half-credential is not one", async () => {
      delete process.env.CF_ACCESS_CLIENT_SECRET;
      const seen = [];
      const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
        seen.push(req.headers.get("cf-access-client-id"));
        return Response.json({ ok: true });
      }});
      await api.health({ serverUrl: `http://127.0.0.1:${server.port}` });
      server.stop(true);
      expect(seen.at(-1)).toBeNull();
    });
  });

  it("resolves an empty 204 to null, which is not the same as an empty object", async () => {
    // The old code could not tell these apart, so `{}` stood for both "no content"
    // and "that was not JSON at all" — which is how the bug above stayed invisible.
    stub = stubServer(() => new Response(null, { status: 204 }));
    await expect(api.me({ serverUrl: stub.url, token: "t" })).resolves.toBeNull();
  });

  // "rejected" and "unreachable" lead to different advice in `aile login`:
  // one is the user's to fix, the other says nothing about their token.
  it("an unreachable server is NOT an ApiError, so it cannot be read as a rejection", async () => {
    stub = stubServer();
    const dead = stub.url;
    stub.stop();
    const err = await api.me({ serverUrl: dead, token: "t", timeoutMs: 300 }).catch((e) => e);
    expect(err).not.toBeInstanceOf(ApiError);
    expect(err.message).toMatch(/cannot reach/);
  });

  it("gives up rather than hanging when the server accepts and never answers", async () => {
    const hang = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch: () => new Promise(() => {}),   // never resolves
    });
    try {
      const err = await apiCall("/me", {
        serverUrl: `http://127.0.0.1:${hang.port}`, timeoutMs: 150,
      }).catch((e) => e);
      expect(err.message).toMatch(/no response from .* after 150ms/);
    } finally {
      hang.stop(true);
    }
  });

  it("the 202/429 poll statuses come back as values, not throws", async () => {
    stub = stubServer(() => Response.json({ status: "pending" }, { status: 202 }));
    const res = await api.pollDeviceLogin({ deviceCode: "dc", serverUrl: stub.url });
    expect(res).toEqual({ status: "pending" });
  });

  it("...but a poll failure with no status still throws", async () => {
    stub = stubServer(() => Response.json({ error: "gone" }, { status: 500 }));
    await expect(api.pollDeviceLogin({ deviceCode: "dc", serverUrl: stub.url })).rejects.toThrow(/gone/);
  });
});

describe("enrolment", () => {
  it("sends this node's id and secret, authorised by the account token", async () => {
    stub = stubServer();
    await enrollNode({ serverUrl: stub.url, renterToken: "ail_acct" });

    const call = stub.seen[0];
    expect({ method: call.method, path: call.path, auth: call.auth })
      .toEqual({ method: "POST", path: "/enroll", auth: "Bearer ail_acct" });
    expect(call.body.nodeId).toBe(getNodeId());
    // The secret crosses the network exactly here and nowhere else; every later
    // handshake proves possession by HMAC instead.
    expect(call.body.secret).toBe(loadNodeSecret());
  });

  it("maps the two failures a user can act on", async () => {
    stub = stubServer(() => Response.json({ error: "raw" }, { status: 401 }));
    await expect(enrollNode({ serverUrl: stub.url, renterToken: "bad" }))
      .rejects.toThrow(/token rejected/);
    stub.stop();

    stub = stubServer(() => Response.json({ error: "raw" }, { status: 409 }));
    await expect(enrollNode({ serverUrl: stub.url, renterToken: "t" }))
      .rejects.toThrow(/registered to another account/);
  });

  it("passes anything else through with the server's own wording", async () => {
    stub = stubServer(() => Response.json({ error: "node quota exceeded" }, { status: 422 }));
    await expect(enrollNode({ serverUrl: stub.url, renterToken: "t" }))
      .rejects.toThrow(/node quota exceeded/);
  });

  it("reports an unreachable server rather than hanging", async () => {
    stub = stubServer();
    const dead = stub.url;
    stub.stop();
    await expect(enrollNode({ serverUrl: dead, renterToken: "t", timeoutMs: 300 }))
      .rejects.toThrow(/cannot reach/);
  });

  /**
   * `enrollNode` calls `fetch` directly, so it has no transport guard of its
   * own — it relies on its callers to have run one. That is fine, but it is
   * only fine as long as it stays true, so this pins it: every caller reaches
   * the api client (and therefore the guard) before enrolment can happen.
   */
  it("is reached only after a guarded call, since it has no guard of its own", async () => {
    const source = fs.readFileSync(new URL("../src/auth/login.js", import.meta.url), "utf8");
    // applyToken verifies with api.me before enrolling; deviceLogin polls first.
    // Matched on the bare name so this keeps holding for `enrollNodeOrRotate`
    // and for any later change to the argument list — the ordering is the
    // invariant, not the call's exact spelling.
    const applyToken = source.slice(source.indexOf("export async function applyToken"));
    const enrolCall = applyToken.search(/\benrollNode\w*\(/);
    expect(enrolCall).toBeGreaterThan(-1);
    expect(applyToken.indexOf("api.me(")).toBeLessThan(enrolCall);

    const cli = fs.readFileSync(new URL("../src/cli/index.js", import.meta.url), "utf8");
    const register = cli.slice(cli.indexOf("async function cmdRegister"));
    expect(register.indexOf("checkTransport")).toBeLessThan(register.indexOf("enrollNode"));
  });
});
