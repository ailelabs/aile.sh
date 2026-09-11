/**
 * Trading the authorization code for tokens.
 *
 * WHY THIS FILE EXISTS. The authorize URL is only half of a browser link, and
 * the second half fails later and quieter: the lender has already approved, the
 * browser already says "Account connected", and the exchange then fails against
 * an endpoint that wanted a different encoding or its credentials in a header.
 *
 * Three endpoint dialects are covered, all of them expressed as `tokenStyle`
 * data in the catalog so that flows.js never learns a provider id:
 *
 *   encoding: "json"          — Anthropic. Was a `/anthropic\.com/` hostname
 *                               regex in the flow code, i.e. a provider id
 *                               written as a pattern.
 *   auth: "basic"             — iFlow rejects the same credentials in the body.
 *   codeFormat: "base64json"  — Cline. There is nothing to exchange: the code
 *                               IS the tokens.
 *
 * The flow is driven end to end through a loopback callback, so what is asserted
 * is a real redirect answered by a real listener, not a helper's return value.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { linkProvider } from "../src/providers/flows.js";
import { getProvider } from "../src/providers/index.js";

/** A stub token endpoint that records exactly what it was sent. */
function stubToken(handler) {
  const calls = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.text();
      calls.push({
        headers: Object.fromEntries(req.headers),
        body,
        form: Object.fromEntries(new URLSearchParams(body)),
        json: (() => { try { return JSON.parse(body); } catch { return null; } })(),
      });
      return handler ? handler(calls.at(-1)) : Response.json({ access_token: "at", expires_in: 3600 });
    },
  });
  return {
    calls,
    base: `http://127.0.0.1:${server.port}`,
    stop: () => { try { server.stop(true); } catch { /* already gone */ } },
  };
}

const restores = [];
function redirect(providerId, fields) {
  const o = getProvider(providerId).oauth;
  const saved = { ...o };
  restores.push(() => {
    for (const k of Object.keys(o)) delete o[k];
    Object.assign(o, saved);
  });
  Object.assign(o, fields);
  return o;
}
afterEach(() => { while (restores.length) restores.pop()(); });

/**
 * Run a full authcode link, answering the loopback callback ourselves.
 *
 * The provider would normally redirect the browser back; here the injected
 * opener reads the port out of the authorize URL it was handed and issues that
 * redirect directly. That keeps the listener, the state check, and the exchange
 * all on the real path.
 */
function link(providerId, { code = "the-code", extra = "" } = {}) {
  return linkProvider(providerId, {
    log: () => {},
    openBrowser: async (authUrl) => {
      const u = new URL(authUrl);
      const redirectUri = new URL(u.searchParams.get("redirect_uri")
        || u.searchParams.get("redirect")
        || u.searchParams.get("callback_url"));
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      const state = u.searchParams.get("state");
      if (state) back.searchParams.set("state", state);
      await fetch(back.toString() + extra).catch(() => {});
    },
  });
}

// ---------------------------------------------------------------------------

describe("Claude's token endpoint", () => {
  it("gets a JSON body, because that is what it accepts", async () => {
    // This was a hostname regex in the flow code — a provider id written as a
    // pattern, which is exactly what the catalog exists to hold instead.
    const s = stubToken(() => Response.json({ access_token: "at-claude", refresh_token: "rt" }));
    try {
      redirect("claude", { tokenUrl: `${s.base}/token` });
      const tokens = await link("claude");
      expect(s.calls[0].headers["content-type"]).toContain("application/json");
      expect(s.calls[0].json.grant_type).toBe("authorization_code");
      expect(s.calls[0].json.code).toBe("the-code");
      expect(s.calls[0].json.code_verifier?.length).toBeGreaterThan(20);
      expect(tokens.accessToken).toBe("at-claude");
      expect(tokens.refreshToken).toBe("rt");
    } finally { s.stop(); }
  });

  /**
   * THE REGRESSION. Claude's `/v1/oauth/token` answers an exchange that omits
   * `state` with 400 "Invalid request format" — the exact error a lender saw. On
   * the loopback path `state` comes back as its own query param and never enters
   * the code, so the earlier code (which sent `state` ONLY when the code arrived
   * as `code#state`) left it out precisely here. The exchange now always resolves
   * `state` as `codeState || state`; the catalog marks claude `sendState`.
   *
   * The stub demands `state` and 400s without it, so this reproduces the failure
   * rather than only asserting a field — a value check alone would pass against a
   * `state` the endpoint ignores, which is not what broke.
   */
  it("sends state back even when the code carried none, or it 400s", async () => {
    const s = stubToken((c) => (c.json?.state
      ? Response.json({ access_token: "at-claude" })
      : Response.json({ error: "Invalid request format" }, { status: 400 })));
    try {
      redirect("claude", { tokenUrl: `${s.base}/token` });
      const tokens = await link("claude");                 // plain code, no '#'
      expect(s.calls[0].json.state).toBeTruthy();
      expect(tokens.accessToken).toBe("at-claude");
    } finally { s.stop(); }
  });

  it("sends the same state it put on the authorize URL, not a fresh one", async () => {
    // It is the CSRF token the endpoint is pairing against; a different value
    // would be rejected exactly like a missing one.
    let authorizeState = null;
    const s = stubToken(() => Response.json({ access_token: "at" }));
    try {
      redirect("claude", { tokenUrl: `${s.base}/token` });
      await linkProvider("claude", {
        log: () => {},
        openBrowser: async (authUrl) => {
          const u = new URL(authUrl);
          authorizeState = u.searchParams.get("state");
          const back = new URL(u.searchParams.get("redirect_uri"));
          back.searchParams.set("code", "c");
          back.searchParams.set("state", authorizeState);
          await fetch(back.toString()).catch(() => {});
        },
      });
      expect(authorizeState).toBeTruthy();
      expect(s.calls[0].json.state).toBe(authorizeState);
    } finally { s.stop(); }
  });

  it("prefers the state fused onto the code when the provider returns code#state", async () => {
    // The paste path: some providers append `#state` to the code. That copy wins
    // over the one we generated — the `codeState || state` precedence.
    const s = stubToken(() => Response.json({ access_token: "at" }));
    try {
      redirect("claude", { tokenUrl: `${s.base}/token` });
      await link("claude", { code: "the-code#fused-state-xyz" });
      expect(s.calls[0].json.code).toBe("the-code");
      expect(s.calls[0].json.state).toBe("fused-state-xyz");
    } finally { s.stop(); }
  });
});

describe("state is not sent to endpoints that did not ask for it", () => {
  it("omits state for a standard OAuth2 provider on the loopback path", async () => {
    // `state` is the authorize call's CSRF token, not an exchange parameter. The
    // strict endpoints reject unknown fields, so `sendState` is opt-in and the
    // default must stay clean. cerebras is not marked, so its exchange carries
    // grant_type/code/verifier and nothing else.
    const s = stubToken(() => Response.json({ access_token: "at" }));
    try {
      // A minimal authcode provider standing in for "any unmarked one": reuse
      // iflow's shape but strip the basic-auth style so this is a plain exchange.
      redirect("iflow", { tokenUrl: `${s.base}/token`, tokenStyle: {} });
      await link("iflow");
      expect(s.calls[0].form.grant_type).toBe("authorization_code");
      expect(s.calls[0].form.state).toBeUndefined();
    } finally { s.stop(); }
  });
});

describe("iFlow's token endpoint", () => {
  it("gets its client credentials in an Authorization header", async () => {
    // It rejects them in the body alone, so the header is not belt-and-braces.
    const s = stubToken(() => Response.json({ access_token: "at-iflow" }));
    try {
      const o = redirect("iflow", { tokenUrl: `${s.base}/token` });
      await link("iflow");
      const auth = s.calls[0].headers.authorization;
      expect(auth).toStartWith("Basic ");
      const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
      expect(decoded).toBe(`${o.clientId}:${o.clientSecret}`);
    } finally { s.stop(); }
  });

  it("still sends a form body — the header replaces neither", async () => {
    const s = stubToken(() => Response.json({ access_token: "at-iflow" }));
    try {
      redirect("iflow", { tokenUrl: `${s.base}/token` });
      await link("iflow");
      expect(s.calls[0].headers["content-type"]).toContain("x-www-form-urlencoded");
      expect(s.calls[0].form.grant_type).toBe("authorization_code");
    } finally { s.stop(); }
  });
});

describe("Cline's `code`, which is not a code", () => {
  const blob = (data) => Buffer.from(JSON.stringify(data)).toString("base64url");

  it("reads the tokens straight out of it and makes no network call at all", async () => {
    // Cline's endpoint is not an authorization server: it hands the tokens back
    // in the redirect. Posting to it would be a round trip for nothing.
    const s = stubToken(() => Response.json({ error: "should not be called" }, { status: 500 }));
    try {
      redirect("cline", { tokenExchangeUrl: `${s.base}/token`, tokenUrl: `${s.base}/token` });
      const tokens = await link("cline", {
        code: blob({ accessToken: "at-cline", refreshToken: "rt-cline", email: "a@b.c" }),
      });
      expect(tokens.accessToken).toBe("at-cline");
      expect(tokens.refreshToken).toBe("rt-cline");
      expect(s.calls).toHaveLength(0);
    } finally { s.stop(); }
  });

  it("tolerates the padding these blobs arrive with", async () => {
    // They carry bytes after the closing brace, so parsing the whole decoded
    // string throws — the trailing-brace scan is load-bearing, not tidying.
    const s = stubToken();
    try {
      redirect("cline", { tokenExchangeUrl: `${s.base}/token`, tokenUrl: `${s.base}/token` });
      const padded = Buffer.from(
        `${JSON.stringify({ accessToken: "at-padded" })}\n trailing`,
      ).toString("base64url");
      expect((await link("cline", { code: padded })).accessToken).toBe("at-padded");
    } finally { s.stop(); }
  });

  it("converts an absolute expiry into the duration the rest of the app expects", async () => {
    const s = stubToken();
    try {
      redirect("cline", { tokenExchangeUrl: `${s.base}/token`, tokenUrl: `${s.base}/token` });
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();
      const tokens = await link("cline", { code: blob({ accessToken: "at", expiresAt }) });
      expect(tokens.expiresIn).toBeGreaterThan(3500);
      expect(tokens.expiresIn).toBeLessThanOrEqual(3600);
    } finally { s.stop(); }
  });

  it("falls back to the real endpoint when the blob does not decode", async () => {
    // A malformed blob is a provider that changed its mind about the format,
    // not a reason to fail a link the lender already approved.
    const s = stubToken(() => Response.json({ access_token: "at-exchanged" }));
    try {
      redirect("cline", { tokenExchangeUrl: `${s.base}/token`, tokenUrl: `${s.base}/token` });
      const tokens = await link("cline", { code: "not-base64-json-at-all" });
      expect(tokens.accessToken).toBe("at-exchanged");
      expect(s.calls).toHaveLength(1);
      expect(s.calls[0].headers["content-type"]).toContain("application/json");
    } finally { s.stop(); }
  });
});

describe("the exchange refuses to proceed on a bad callback", () => {
  it("rejects a state that does not match the one it sent", async () => {
    const s = stubToken();
    try {
      redirect("claude", { tokenUrl: `${s.base}/token` });
      await expect(linkProvider("claude", {
        log: () => {},
        openBrowser: async (authUrl) => {
          const u = new URL(authUrl);
          const back = new URL(u.searchParams.get("redirect_uri"));
          back.searchParams.set("code", "c");
          back.searchParams.set("state", "not-the-state-we-sent");
          await fetch(back.toString()).catch(() => {});
        },
      })).rejects.toThrow(/State mismatch/i);
      expect(s.calls).toHaveLength(0);
    } finally { s.stop(); }
  });

  it("surfaces the provider's own error rather than exchanging nothing", async () => {
    const s = stubToken();
    try {
      redirect("claude", { tokenUrl: `${s.base}/token` });
      await expect(linkProvider("claude", {
        log: () => {},
        openBrowser: async (authUrl) => {
          const back = new URL(new URL(authUrl).searchParams.get("redirect_uri"));
          back.searchParams.set("error", "access_denied");
          back.searchParams.set("error_description", "the user said no");
          await fetch(back.toString()).catch(() => {});
        },
      })).rejects.toThrow(/the user said no/);
      expect(s.calls).toHaveLength(0);
    } finally { s.stop(); }
  });
});
