/**
 * The authorization URL we send a lender's browser to.
 *
 * WHY THIS FILE EXISTS. Every other part of linking is covered — the nonce
 * ordering, the token upload, the key verification — but nothing asserted the
 * URL itself, and that is the one artifact a lender actually interacts with. It
 * shipped malformed for Claude: we appended a `nonce` the endpoint does not
 * accept, and omitted the `code=true` it requires. Anthropic's response to that
 * is a page reading "Missing client_id parameter" — naming a parameter that was
 * in the URL all along, so the error leads away from the cause. Nobody can debug
 * that from the message, which is exactly why the shape belongs in a test.
 *
 * The flow is driven through its injected `openBrowser`, so these assertions are
 * about the URL a real browser would receive, not about a helper's return value.
 */

import { describe, expect, it } from "bun:test";
import { linkProvider } from "../src/providers/flows.js";
import { PROVIDERS, getProvider } from "../src/providers/index.js";

/**
 * Run a provider's authcode flow far enough to capture the URL, then abandon it.
 *
 * The flow opens a loopback listener and waits five minutes for a redirect that
 * will never come, so the browser opener throws to unwind it. That rejection is
 * the expected path here, not a failure — the URL has already been built by the
 * time it fires.
 */
async function authorizeUrlFor(providerId, { nonce = "server-chosen-nonce" } = {}) {
  let captured = null;
  const STOP = new Error("captured");
  await linkProvider(providerId, {
    nonce,
    log: () => {},
    openBrowser: (url) => { captured = url; throw STOP; },
  }).catch((e) => { if (e !== STOP) throw e; });
  expect(captured).not.toBeNull();
  return new URL(captured);
}

const paramsOf = (url) => Object.fromEntries(url.searchParams);

describe("the Claude authorization URL", () => {
  it("carries the literal flag the endpoint requires", async () => {
    // Without `code=true` Anthropic refuses the request outright. This is the
    // whole of the reported bug.
    const url = await authorizeUrlFor("claude");
    expect(paramsOf(url).code).toBe("true");
  });

  it("does not carry a nonce, which is what the endpoint rejected", async () => {
    // Claude's scopes do not include `openid`, so no id_token is minted and the
    // nonce binds nothing. Sending it anyway cost a working sign-in.
    const url = await authorizeUrlFor("claude", { nonce: "abc123" });
    expect(url.searchParams.has("nonce")).toBe(false);
  });

  it("still sends everything the exchange depends on", async () => {
    // A fix that drops the nonce by dropping parameters generally would pass the
    // assertion above and break the flow. PKCE and state are load-bearing.
    const url = await authorizeUrlFor("claude");
    const p = paramsOf(url);
    expect(url.origin + url.pathname).toBe("https://claude.ai/oauth/authorize");
    expect(p.client_id).toBe(getProvider("claude").oauth.clientId);
    expect(p.response_type).toBe("code");
    expect(p.code_challenge_method).toBe("S256");
    expect(p.code_challenge?.length).toBeGreaterThan(20);
    expect(p.state?.length).toBeGreaterThan(20);
    expect(p.scope).toBe("org:create_api_key user:profile user:inference");
    expect(p.redirect_uri).toMatch(/^http:\/\/localhost:\d+\/callback$/);
  });

  it("encodes the scope with %20, not +", async () => {
    // Some authorization servers reject `+` for spaces in scope, which is why
    // the URL is assembled by hand instead of by URLSearchParams.
    const url = await authorizeUrlFor("claude");
    expect(url.href).toContain("scope=org%3Acreate_api_key%20user%3Aprofile");
    expect(url.href).not.toMatch(/scope=[^&]*\+/);
  });
});

/**
 * The rule, rather than the one provider that exposed it: `nonce` is an OpenID
 * Connect parameter and means nothing without `openid` in the scope. Asserting
 * it per-provider is what stops the next catalog sync from reintroducing this
 * for whichever provider is added next.
 */
describe("the nonce goes only where an id_token is issued", () => {
  const authcode = PROVIDERS.filter((p) => p.flow === "authcode" || p.flow === "google");
  const scopeOf = (p) => {
    const o = p.oauth || {};
    return String(o.scope || (Array.isArray(o.scopes) ? o.scopes.join(" ") : o.scopes) || "");
  };

  it("covers more than one provider, or it is asserting nothing", () => {
    expect(authcode.length).toBeGreaterThan(1);
  });

  for (const p of authcode) {
    const wantsOpenId = /(^|\s)openid(\s|$)/.test(scopeOf(p));
    it(`${wantsOpenId ? "sends" : "omits"} it for ${p.id}`, async () => {
      // Two ways a provider legitimately builds no URL here, neither of which
      // is a fact about the nonce:
      //   - a fixed callback port already held by something else, which is a
      //     property of the machine rather than of the request;
      //   - no vendored client credentials, which is `aile connect antigravity`
      //     failing for its own separate reason. It reports that plainly, so it
      //     is a known gap rather than a silent one.
      let url;
      try {
        url = await authorizeUrlFor(p.id, { nonce: "server-chosen-nonce" });
      } catch (e) {
        // `not configured` is the operator-gated case (gitlab-duo with no OAuth
        // client env) — the same "known gap, reported plainly" category as the
        // two below, not a fact about the nonce.
        if (/in use|not in the catalog|not configured/i.test(e.message)) return;
        throw e;
      }
      expect(url.searchParams.has("nonce")).toBe(wantsOpenId);
    });
  }
});

describe("extraParams from the catalog reach the URL", () => {
  it("sends Codex its full set, unmodified", async () => {
    // Codex is the provider that already relied on extraParams, so it is the
    // check that the mechanism Claude's `code=true` now rides on still works.
    let url;
    try {
      url = await authorizeUrlFor("codex");
    } catch (e) {
      if (/in use/i.test(e.message)) return;    // codex pins port 1455
      throw e;
    }
    const p = paramsOf(url);
    for (const [k, v] of Object.entries(getProvider("codex").oauth.extraParams)) {
      expect({ [k]: p[k] }).toEqual({ [k]: v });
    }
    // Codex DOES ask for openid, so here the nonce belongs.
    expect(p.nonce).toBe("server-chosen-nonce");
  });
});

/**
 * Endpoints that are not standard OAuth2 authorization servers.
 *
 * Each of these refuses the request when handed a parameter it does not know,
 * so the catalog describes what to SEND and the standard block is replaced
 * rather than extended. The assertions are therefore about absence as much as
 * presence — an added parameter is the failure mode, not a harmless extra.
 */
describe("catalog-described authorize shapes", () => {
  it("sends Cline its two callback names and nothing else", async () => {
    const url = await authorizeUrlFor("cline");
    const p = paramsOf(url);
    expect(url.origin + url.pathname).toBe("https://api.cline.bot/api/v1/auth/authorize");
    expect(p.callback_url).toMatch(/^http:\/\/localhost:\d+\/callback$/);
    expect(p.redirect_uri).toBe(p.callback_url);
    expect(p.client_type).toBe("extension");
    expect(Object.keys(p).sort()).toEqual(["callback_url", "client_type", "redirect_uri"]);
  });

  it("never sends Cline a literal `undefined` for the client it does not have", async () => {
    // This is the actual bug: Cline has no registered client, so `@clientId`
    // resolves to nothing. Interpolating it anyway put the seven characters
    // "undefined" on the wire as if they were an id.
    const url = await authorizeUrlFor("cline");
    expect(url.href).not.toContain("undefined");
    expect(url.searchParams.has("client_id")).toBe(false);
  });

  it("gives iFlow `redirect`, not `redirect_uri`", async () => {
    // Handed the standard block, iFlow renders its generic login page instead
    // of the consent screen, and the flow waits out its five minutes on a
    // callback that is never coming.
    const url = await authorizeUrlFor("iflow");
    const p = paramsOf(url);
    expect(p.redirect).toMatch(/^http:\/\/localhost:\d+\/callback$/);
    expect(url.searchParams.has("redirect_uri")).toBe(false);
    expect(url.searchParams.has("response_type")).toBe(false);
    expect(url.searchParams.has("code_challenge")).toBe(false);
    expect(p.client_id).toBe(getProvider("iflow").oauth.clientId);
    expect(p.state?.length).toBeGreaterThan(20);
    // extraParams still apply on top of a described shape.
    expect(p.loginMethod).toBe("phone");
    expect(p.type).toBe("phone");
  });

  it("keeps the scope off an endpoint that did not ask for one", async () => {
    // The point of describing a shape is defeated if the scope arrives anyway.
    for (const id of ["cline", "clinepass", "iflow"]) {
      const url = await authorizeUrlFor(id);
      expect({ id, scope: url.searchParams.has("scope") }).toEqual({ id, scope: false });
    }
  });
});

/**
 * Google-backed providers.
 *
 * Two separate failures live here, and the second is the nastier one: without
 * `access_type=offline` Google issues NO refresh token, so the link appears to
 * succeed and the account stops serving an hour later with nothing to renew it
 * from. `prompt=consent` is what re-issues one for an account that already
 * consented once.
 */
describe("the Google-family authorize URL", () => {
  const google = PROVIDERS.filter((p) => p.flow === "google");

  it("covers the providers it claims to", () => {
    expect(google.length).toBeGreaterThan(0);
  });

  /**
   * Named explicitly, not left to the loop below.
   *
   * The per-provider assertions iterate whatever the catalog happens to contain,
   * so a provider dropped from the catalog takes its own coverage with it — the
   * suite stays green while silently testing one fewer thing. gemini-cli was
   * exactly that case: linkable in intent (a Google client, the openid scope, an
   * authorize-param set all wired for it) but filtered out of the catalog before
   * any of it ran. So its presence is pinned by name here, where losing it is a
   * red test rather than a quiet loss of coverage.
   */
  it("includes gemini-cli, whose linking wiring is otherwise dead", () => {
    expect(google.map((p) => p.id)).toContain("gemini-cli");
  });

  /** Google-family providers whose scope asks for `openid`. See the test below. */
  const ATTESTABLE = new Set(["gemini-cli"]);

  for (const p of google) {
    it(`asks ${p.id} for a refresh token it will actually issue`, async () => {
      const url = await authorizeUrlFor(p.id);
      const q = paramsOf(url);
      expect(q.access_type).toBe("offline");
      expect(q.prompt).toBe("consent");
    });

    it(`carries vendored client credentials for ${p.id}`, async () => {
      // The registry keeps these outside the per-provider entries, so a catalog
      // built from it alone yields a flow that refuses to start at all.
      const url = await authorizeUrlFor(p.id);
      expect(paramsOf(url).client_id).toMatch(/\.apps\.googleusercontent\.com$/);
    });

    it(`asks ${p.id} for openid exactly when the relay can attest it`, async () => {
      // `openid` is what makes Google mint the id_token the server attests the
      // account link with, and a nonce is meaningless without one — an
      // unrecognised parameter is something a strict authorization server may
      // refuse outright. Pinned BY NAME in both directions, because either drift
      // is silent: gemini-cli losing the scope downgrades every link to
      // unproven, and antigravity regaining it re-opens the first-party consent
      // screen that hangs (the relay dropped it for exactly that reason — see
      // its overlay in apps/api/src/lib/providers/registry/antigravity).
      const q = paramsOf(await authorizeUrlFor(p.id));
      const attestable = ATTESTABLE.has(p.id);
      expect({ id: p.id, openid: /(^|\s)openid(\s|$)/.test(q.scope), nonce: q.nonce })
        .toEqual({ id: p.id, openid: attestable, nonce: attestable ? "server-chosen-nonce" : undefined });
    });
  }
});
