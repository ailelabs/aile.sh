/**
 * The hand-vendored authcode providers — xAI OAuth and GitLab Duo.
 *
 * WHY THIS FILE EXISTS. These two are the OAuth halves of the paste-only `xai` /
 * `gitlab` registry entries, added by hand in src/providers/oauth-extra.js
 * because the generator can't emit a split link/serve id. They run through the
 * SAME authcodeFlow as the generated providers, so what needs guarding is the
 * catalog data: a form-encoded exchange, the PKCE verifier forwarded, and
 * GitLab's `client_secret` sent only when an operator configured one (a public
 * client that sends an empty secret is rejected by some endpoints).
 *
 * Same loopback-driven approach as token-exchange.test.js — a real redirect
 * answered by the real listener, so the bytes on the wire are what's asserted.
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

/** Drive a full authcode link, answering the loopback callback ourselves. */
function link(providerId, { code = "the-code" } = {}) {
  return linkProvider(providerId, {
    log: () => {},
    openBrowser: async (authUrl) => {
      const u = new URL(authUrl);
      const back = new URL(u.searchParams.get("redirect_uri"));
      back.searchParams.set("code", code);
      const state = u.searchParams.get("state");
      if (state) back.searchParams.set("state", state);
      await fetch(back.toString()).catch(() => {});
    },
  });
}

// ---------------------------------------------------------------------------

describe("xAI OAuth exchange", () => {
  it("posts a form-encoded authorization_code with the PKCE verifier and no client_secret", async () => {
    const s = stubToken(() => Response.json({ access_token: "at-xai", refresh_token: "rt-xai", expires_in: 3600 }));
    try {
      // fixedPort 0 so the test binds an ephemeral loopback port rather than the
      // catalog's real 56121 (which a dev box may have in use).
      const o = redirect("xai-oauth", { tokenUrl: `${s.base}/token`, fixedPort: 0 });
      const tokens = await link("xai-oauth");

      expect(s.calls[0].headers["content-type"]).toContain("x-www-form-urlencoded");
      expect(s.calls[0].form.grant_type).toBe("authorization_code");
      expect(s.calls[0].form.code).toBe("the-code");
      expect(s.calls[0].form.client_id).toBe(o.clientId);
      expect(s.calls[0].form.code_verifier?.length).toBeGreaterThan(20);
      // Public PKCE client — an empty client_secret must not be sent.
      expect(s.calls[0].form.client_secret).toBeUndefined();

      expect(tokens.accessToken).toBe("at-xai");
      expect(tokens.refreshToken).toBe("rt-xai");
    } finally { s.stop(); }
  });

  it("sends the S256 challenge on the authorize URL that the verifier answers", async () => {
    let challengeMethod = null;
    const s = stubToken(() => Response.json({ access_token: "at" }));
    try {
      redirect("xai-oauth", { tokenUrl: `${s.base}/token`, fixedPort: 0 });
      await linkProvider("xai-oauth", {
        log: () => {},
        openBrowser: async (authUrl) => {
          const u = new URL(authUrl);
          challengeMethod = u.searchParams.get("code_challenge_method");
          expect(u.searchParams.get("code_challenge")?.length).toBeGreaterThan(20);
          const back = new URL(u.searchParams.get("redirect_uri"));
          back.searchParams.set("code", "c");
          back.searchParams.set("state", u.searchParams.get("state"));
          await fetch(back.toString()).catch(() => {});
        },
      });
      expect(challengeMethod).toBe("S256");
    } finally { s.stop(); }
  });
});

describe("GitLab Duo exchange", () => {
  // Operator-gated: without GITLAB_DUO_OAUTH_CLIENT_ID the module leaves clientId
  // and authorizeUrl undefined, so every test here injects a client the way an
  // operator's env would, then exercises the exchange shape.
  const OPERATOR = (base, extra = {}) => ({
    clientId: "gl-cid",
    authorizeUrl: `${base}/oauth/authorize`,
    tokenUrl: `${base}/oauth/token`,
    ...extra,
  });

  it("posts a form-encoded exchange with the PKCE verifier", async () => {
    const s = stubToken(() => Response.json({ access_token: "at-gl", refresh_token: "rt-gl" }));
    try {
      redirect("gitlab-duo", OPERATOR(s.base));
      const tokens = await link("gitlab-duo");
      expect(s.calls[0].headers["content-type"]).toContain("x-www-form-urlencoded");
      expect(s.calls[0].form.grant_type).toBe("authorization_code");
      expect(s.calls[0].form.client_id).toBe("gl-cid");
      expect(s.calls[0].form.code_verifier?.length).toBeGreaterThan(20);
      expect(tokens.accessToken).toBe("at-gl");
    } finally { s.stop(); }
  });

  it("includes client_secret only when the operator configured a confidential app", async () => {
    const s = stubToken(() => Response.json({ access_token: "at-gl" }));
    try {
      redirect("gitlab-duo", OPERATOR(s.base, { clientSecret: "gl-secret" }));
      await link("gitlab-duo");
      expect(s.calls[0].form.client_secret).toBe("gl-secret");
    } finally { s.stop(); }
  });

  it("omits client_secret entirely for a public app", async () => {
    const s = stubToken(() => Response.json({ access_token: "at-gl" }));
    try {
      // clientSecret explicitly cleared — a public GitLab app has none, and an
      // empty string on the wire is not the same as the field being absent.
      redirect("gitlab-duo", OPERATOR(s.base, { clientSecret: undefined }));
      await link("gitlab-duo");
      expect(s.calls[0].form.client_secret).toBeUndefined();
    } finally { s.stop(); }
  });
});
