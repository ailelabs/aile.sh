/**
 * Asking a provider whether a credential we just obtained actually works.
 *
 * WHY THIS EXISTS FOR OAUTH AT ALL. flows.js is right that an OAuth token is
 * valid by construction — the provider minted it seconds ago. What that argument
 * does NOT cover is everything between minting and serving: a token issued for
 * scopes the inference endpoint rejects, an account with no active subscription
 * behind it, a provider that hands out a token and then 403s every request from
 * a region. All of those link successfully today and fail on the first buyer
 * request, which is the same invisible split apikey.js exists to prevent — the
 * lender is told it worked, the buyer sees failures, neither can see the other's
 * half.
 *
 * WHAT A PASS MEANS, EXACTLY: this credential was accepted by the provider's own
 * API, from this machine, once, just now. That is a strictly weaker claim than
 * attestation and must never be stored in the same field. Attestation is a
 * provider-SIGNED id_token verified against the provider's JWKS by the server
 * against a nonce the server chose (see link.js and docs/PROTOCOL.md §7); it
 * proves WHOSE account this is. A probe proves only that the credential is live.
 * An account can pass this and still be someone else's — so `attested` is not
 * written here and cannot be.
 *
 * AND IT IS OBSERVED BY THE LENDER'S MACHINE, which is the machine the trust
 * model does not trust. Uploading the result is fine and useful; promoting it to
 * a trusted fact server-side is not. See the note on `probe` in link.js.
 *
 * A FAILURE HERE DOES NOT FAIL THE LINK. That is the opposite of apikey.js, and
 * deliberately: a pasted key is unverified until proven otherwise, but an OAuth
 * token already came from a completed sign-in. When a probe of one says no, the
 * likelier explanations are a probe URL this file has wrong or an endpoint being
 * fussy — not a bad credential. Throwing away a good sign-in over that would
 * trade a rare wrong badge for a common broken `aile connect`.
 */

import { PROVIDER_HOSTS } from "../relay/provider-hosts.js";

const PROBE_TIMEOUT_MS = 10_000;

/**
 * Probe targets for providers the generated catalog gives us no `userInfoUrl`
 * for. HAND-MAINTAINED — catalog.js is regenerated from the relay's registry and
 * anything written there is lost.
 *
 * DELIBERATELY SHORT. An entry is only worth adding when the endpoint is known
 * to be (a) authenticated, (b) free, and (c) a GET. A provider absent from here
 * and from `userInfoUrl` simply keeps the behaviour it has today — no probe, no
 * badge change — which is the honest outcome. Guessing a URL produces the worst
 * failure this module can have: a live credential reported as dead, on the one
 * screen where the lender is deciding whether the product works.
 *
 * NOT a completions endpoint, ever. Those bill the lender to check their own
 * credential, and on a metered account that is a real charge for a link they may
 * then abandon.
 */
const PROBES = {
  claude: {
    // Documented free list endpoint. `limit=1` because we read nothing from the
    // body — only whether the credential was accepted.
    url: "https://api.anthropic.com/v1/models?limit=1",
    // The version header is mandatory on every api.anthropic.com route; without
    // it this 400s and would read as a rejected credential.
    headers: { "anthropic-version": "2023-06-01" },
  },
  // OAuth providers whose catalog entry carries no `userInfoUrl`. Both were
  // checked the only way that means anything: an unauthenticated GET answers
  // 401 (so the route exists AND authenticates), and a deliberately wrong
  // credential answers 401 too (so a pass is not something any string earns).
  //
  // `kimi` authenticates with `x-api-key` rather than a bearer, and its OAuth
  // access token is what goes in that header — authHeaderFor reads the same
  // `transport.auth` the relay serves with, so the probe and the real request
  // present the credential identically.
  kimi: { url: "https://api.kimi.com/coding/v1/models", headers: {} },
  gitlab: { url: "https://gitlab.com/api/v4/user", headers: {} },
};

/**
 * Where to send the probe, or null when we have nothing trustworthy to send it
 * to.
 *
 * PRECEDENCE, WEAKEST-ROT FIRST:
 *
 *  1. `oauth.userInfoUrl` — from the generated catalog, so it tracks the
 *     relay's registry. The relay deliberately carries none today: the two it
 *     used to (gemini-cli, iflow) were a probe that could not fail and a URL
 *     that only authenticates in the query string. This branch stays because
 *     the precedence is the rule, not the current row count.
 *  2. `apiKey.verifyUrl` — from the generated catalog too, but purpose-built for
 *     exactly this question and already exercised on every key link, so it is
 *     the best-tested URL we have for those providers. Reusing it also means a
 *     key provider cannot end up with two different notions of "does this
 *     credential work".
 *  3. `PROBES` above — the last resort, and the only entry that can rot
 *     unnoticed.
 *
 * A PROBES entry is therefore a FALLBACK, not an override: adding one for a
 * provider the catalog already covers will not take effect, which is deliberate.
 * If a catalog URL is wrong, the fix belongs upstream where the sync will keep
 * it, not in a local table that silently shadows it.
 */
export function probeTarget(provider) {
  const url = provider?.oauth?.userInfoUrl || provider?.apiKey?.verifyUrl;
  if (url) return { url, headers: {} };
  return PROBES[provider?.id] || null;
}

/**
 * Present the credential the way this provider expects it.
 *
 * Read from `transport.auth` — the SAME descriptor the relay uses to serve buyer
 * requests. That reuse is the point: a probe that authenticated differently to
 * the real request would be testing something other than what we are about to
 * advertise, and could pass while every buyer request fails.
 *
 * `combined: true` means one header regardless of credential kind. Providers with
 * no descriptor at all get bearer, which is what every one of them uses.
 */
export function authHeaderFor(provider, token, { isApiKey = false } = {}) {
  const auth = provider?.transport?.auth || {};
  const spec = auth.combined ? auth : (isApiKey ? auth.apiKey : auth.oauth) || {};
  const header = spec.header || "Authorization";
  const value = spec.scheme === "raw" ? token : `Bearer ${token}`;
  return { [header]: value };
}

/**
 * Ask the provider whether this credential is live.
 *
 * Never throws and never rejects — every outcome is a `{ok, reason}` the caller
 * can carry on past, because the caller is mid-link holding a credential it must
 * upload either way.
 *
 * `reason` distinguishes the cases that look identical in a log and mean
 * completely different things:
 *
 *   no-target   we have no endpoint for this provider — nothing was asked
 *   blocked     the target is not in the baked egress allowlist
 *   network     could not ask (timeout, DNS, offline)
 *   rejected    the provider said no: 401/403
 *   upstream    the provider was unwell: any other non-2xx
 *   ok          accepted
 *
 * `network` is NOT a rejection, for the same reason apikey.js says it is not: a
 * lender on a flaky connection must not be told their account is invalid.
 */
export async function probeCredential(provider, tokens, {
  fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS, isApiKey = false,
} = {}) {
  const token = tokens?.accessToken;
  if (!token) return { ok: false, reason: "no-target" };

  const target = probeTarget(provider);
  if (!target) return { ok: false, reason: "no-target" };

  // The same allowlist the relay enforces on egress. This file cannot widen it —
  // provider-hosts.js is generated and baked at build time precisely so no
  // hand-maintained list (including PROBES above) can open a node up as a proxy.
  let host;
  try {
    host = new URL(target.url).hostname;
  } catch {
    return { ok: false, reason: "no-target" };
  }
  if (!PROVIDER_HOSTS.has(host)) return { ok: false, reason: "blocked", host };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(target.url, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(target.headers || {}),
        ...authHeaderFor(provider, token, { isApiKey }),
      },
      signal: controller.signal,
    });
  } catch (e) {
    return {
      ok: false,
      reason: "network",
      message: e.name === "AbortError"
        ? `${provider.name} did not answer within ${Math.round(timeoutMs / 1000)}s.`
        : `Could not reach ${provider.name}: ${e.message}`,
    };
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "rejected", status: res.status };
  }
  if (!res.ok) return { ok: false, reason: "upstream", status: res.status };

  // The body is deliberately not read. Nothing in it is trusted — the question
  // was whether the credential was accepted, and the status answered it. Parsing
  // more would invite someone to start believing a field in there.
  return { ok: true, reason: "ok", host };
}

export { PROBE_TIMEOUT_MS, PROBES };
