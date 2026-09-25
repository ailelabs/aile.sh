/**
 * HTTP client for the aile.sh API.
 *
 * One place that knows the wire format, so the CLI stays about presentation.
 * Non-HTTPS is refused unless explicitly waived — the renter token and, during
 * linking, provider tokens cross this connection.
 */

import { loadConfig } from "../relay/config.js";
import { accessHeaders } from "./access.js";

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export function isSecureUrl(url) {
  return /^https:\/\//.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url);
}

export function assertTransportOk(url, { insecure = false } = {}) {
  if (isSecureUrl(url) || insecure) return;
  throw new Error(
    `Refusing to talk to ${url} over plain HTTP — credentials would cross the network in clear. ` +
    `Pass --insecure to override (staging only).`
  );
}

/**
 * The human message from a {success:false} error envelope. A business error puts
 * a string under `error`; a 422 validation error puts a {field: message} object
 * there under a "Validation Error" message; an unmatched route / 500 carry only
 * `message`. Falls back to the raw status so a non-enveloped error still says
 * something rather than nothing.
 */
function errorMessage(status, parsed) {
  if (status === 422 && parsed?.error && typeof parsed.error === "object") {
    const pairs = Object.entries(parsed.error).map(([field, msg]) => `${field}: ${msg}`);
    if (pairs.length) return pairs.join("; ");
  }
  const e = parsed?.error;
  return (typeof e === "string" && e) || parsed?.message || `server returned ${status}`;
}

/** The host of a URL, or null if it will not parse. Never throws. */
function safeHost(url) {
  try { return new URL(String(url)).host; } catch { return null; }
}

/** What arrived, in words, without ever echoing an attacker's bytes to a terminal. */
function describeBody(text) {
  const head = text.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html")) return "an HTML page";
  if (head.startsWith("<")) return "a markup document";
  return `a ${text.length}-byte non-JSON body`;
}

/**
 * Read a JSON response, or say precisely why it is not one.
 *
 * THIS IS THE FIX FOR THE `undefined` BUG, and the bug is worth stating because the
 * old line looked harmless: `await res.json().catch(() => ({}))`. Three different
 * outcomes — valid JSON, an empty body, and *not JSON at all* — all collapsed into
 * an empty object. So when `api.aile.sh` sat behind an access proxy, `fetch`
 * followed the 302, landed on an HTML login page with status 200, `res.ok` was
 * true, `res.json()` threw, the throw was swallowed, and every downstream
 * `res.<field>` read `undefined`. The CLI then printed the word "undefined" where
 * the sign-in URL should have been and polled a code that did not exist for ten
 * minutes. Nothing anywhere said "that was not our API".
 *
 * A redirect gets its own message because it is the one failure the user cannot
 * diagnose from the outside: the address was right, and something in front of it
 * answered instead.
 *
 * ONLY A SUCCESSFUL RESPONSE IS HELD TO THE JSON CONTRACT. A 502 whose body is an
 * HTML error page is an ordinary upstream failure, and "server returned 502" is a
 * better sentence about it than anything this function could say — so a non-ok
 * response with an unparseable body yields `null` and lets `errorMessage` speak.
 * The bug being fixed here was a response that claimed SUCCESS and was not JSON;
 * widening the strictness to failures too would only replace clear messages with
 * noisier ones.
 */
async function readJson(res, base, pathname) {
  const wanted = safeHost(`${base}${pathname}`);

  // A REDIRECT IS NEVER AN ANSWER FROM THIS API, and it is not followed — see the
  // `redirect: "manual"` note in `call`. Every route the CLI touches replies
  // directly, so a 3xx means something else is standing in front: an access portal,
  // a captive gateway, a stale address. Naming where it points is the whole
  // diagnosis, and it is the one failure a user cannot work out from the outside.
  if (res.status >= 300 && res.status < 400) {
    const landed = safeHost(res.headers.get("location")) || "somewhere else";
    throw new ApiError(
      `${wanted || base} redirected to ${landed} — that is a sign-in portal or captive ` +
      `gateway answering instead of the aile relay. If this server sits behind an access ` +
      `proxy, ask whoever runs it to allow the API, or set CF_ACCESS_CLIENT_ID and ` +
      `CF_ACCESS_CLIENT_SECRET if you hold a service token for it.`,
      res.status, { redirectedTo: landed },
    );
  }

  const text = await res.text();

  // A genuinely empty body is not the same as "not JSON" — a 204 has nothing to
  // parse and nothing is wrong. `null` says so; the old `{}` claimed a payload.
  if (!text.trim()) return null;

  const ctype = (res.headers.get("content-type") || "").toLowerCase();
  if (!/\bjson\b/.test(ctype)) {
    if (!res.ok) return null; // the status is the story; see the note above
    throw new ApiError(
      `${wanted || base}${pathname} answered ${res.status} with ` +
      `${ctype ? `content-type ${ctype}` : "no content-type"} — ${describeBody(text)}, not JSON. ` +
      `Check that ${base} is really an aile relay.`,
      res.status, { contentType: ctype },
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    if (!res.ok) return null;
    throw new ApiError(
      `${wanted || base}${pathname} answered ${res.status} with malformed JSON.`,
      res.status, { malformed: true },
    );
  }
}

async function call(pathname, {
  serverUrl, method = "GET", body = null, token = null,
  timeoutMs = 20000, insecure = false, expectJson = true, headers = null,
} = {}) {
  const base = String(serverUrl || loadConfig().serverUrl).replace(/\/+$/, "");
  assertTransportOk(base, { insecure });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(`${base}${pathname}`, {
      method,
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(headers || {}),
        ...accessHeaders(),
      },
      body: body ? JSON.stringify(body) : undefined,
      // REDIRECTS ARE NOT FOLLOWED, AND THAT IS A CREDENTIAL DECISION, not tidiness.
      // `fetch` re-sends custom headers to whatever a 3xx points at — verified: a
      // redirect to another host arrives there holding CF-Access-Client-Secret in
      // full. Following one would therefore hand the operator's service token, and
      // in the general case the renter's bearer, to whichever host answered. Since
      // no route here legitimately redirects, refusing to follow costs nothing and
      // closes that off completely; `readJson` turns the 3xx into a real diagnosis.
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`no response from ${base} after ${timeoutMs}ms`);
    throw new Error(`cannot reach ${base}: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  const parsed = expectJson ? await readJson(res, base, pathname) : await res.text();
  if (!res.ok) {
    // 202/429 are flow control in the device-token poll, not failures; the
    // caller distinguishes them by status. ApiError.body keeps the FULL envelope
    // (pollDeviceLogin/wallet read fields off it); .status keeps the HTTP code.
    throw new ApiError(errorMessage(res.status, parsed), res.status, parsed);
  }
  // Unwrap the {success,data} envelope so every `res.<field>` read downstream
  // keeps working — `data` IS the old payload. A non-enveloped body (a public
  // read like /health, a text response, an un-migrated server) is left as-is.
  if (parsed && parsed.success === true && "data" in parsed) return parsed.data;
  return parsed;
}

/**
 * Drop keys whose value is absent, so an OPTIONAL field is genuinely omitted.
 *
 * `null` IS NOT THE SAME AS NOT SENDING IT, and a live server taught this the hard
 * way: an optional string field rejects an explicit `null` with a 422 ("Expected
 * string") while ignoring the key entirely when it is absent. Sending `null` as a
 * stand-in for "I have nothing here" therefore turns an optional parameter into a
 * failed request.
 *
 * Note this is the OPPOSITE of `saveProvider`'s deliberate explicit nulls a few
 * functions down. That is not an inconsistency: there, `null` is a MEANINGFUL value
 * the server stores and distinguishes from an old client that could not send the
 * field at all. Here there is nothing to distinguish — the field is either offered
 * or it is not.
 */
const omitAbsent = (obj) =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined));

export const api = {
  /**
   * `codeChallenge` binds the login to this process (src/auth/pkce.js) and
   * `clientLabel` is what the approval page shows the human. Both are listed
   * explicitly rather than spread, for the reason `saveProvider` gives: a field
   * reaches the server when someone added it here on purpose.
   */
  startDeviceLogin: ({ codeChallenge = null, clientLabel = null, purpose = null, keyName = null, ...opts } = {}) =>
    call("/auth/device", { ...opts, method: "POST", body: omitAbsent({ codeChallenge, clientLabel, purpose, keyName }) }),

  /** Resolves {status}; 429/403/410/404 poll states come back as status strings, not throws. */
  async pollDeviceLogin({ deviceCode, codeVerifier = null, ...opts }) {
    try {
      // approved(200)/pending(202) are 2xx — call() unwraps them to their `data`.
      return await call("/auth/device/token", { ...opts, method: "POST", body: omitAbsent({ deviceCode, codeVerifier }) });
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      // The poll multiplexes flow-control onto non-2xx codes. slow_down is a 429
      // SUCCESS envelope (status under `data`); denied/expired/invalid are error
      // envelopes (status under `error`); an old raw server put it at top level.
      // A status-less non-2xx (500, a wrong URL's 404) is a real error, not a
      // poll state, so it re-throws exactly as before.
      const status = e.body?.data?.status ?? e.body?.error?.status ?? e.body?.status;
      if (status) return { status };
      throw e;
    }
  },

  me: (opts) => call("/me", opts),

  /** All connected accounts, or just one provider's. */
  listProviders: ({ provider = null, ...opts } = {}) =>
    call(provider ? `/providers?provider=${encodeURIComponent(provider)}` : "/providers", opts),

  providerNonce: ({ provider, ...opts }) =>
    call("/providers/nonce", { ...opts, method: "POST", body: { provider } }),

  /**
   * `accountKey` distinguishes two accounts of the same provider when the
   * provider itself gives us nothing to tell them apart by. `label` is the
   * lender's own name for one and is never used as identity.
   *
   * `probe` is what the PROVIDER said when this machine asked whether the
   * credential works — a claim by a client, not a verification. It is a separate
   * field from anything attestation-related precisely so the server cannot
   * confuse the two: only the server can conclude `attested`, and only from a
   * signed id_token. See src/providers/probe.js.
   *
   * The body is listed explicitly rather than spread, so a field only reaches
   * the server when someone added it here on purpose.
   */
  saveProvider: ({
    provider, tokens, nonce, email, accountKey = null, label = null, probe = null,
    allowNodeless = null, replaceAccountId = null, ...opts
  }) =>
    call("/providers", {
      ...opts, method: "POST",
      // The first seven are sent EXPLICITLY, nulls included: the server
      // distinguishes "the lender chose nothing" from "this client is too old to
      // have a view", and only the first may fall back to a default.
      //
      // The last two go through `omitAbsent` instead, because for them null means
      // exactly "say nothing" — sending `allowNodeless: null` would fail the
      // server's boolean check, and `replaceAccountId: null` would read as naming
      // a row rather than naming none.
      body: {
        provider, tokens, nonce, email, accountKey, label, probe,
        ...omitAbsent({ allowNodeless, replaceAccountId }),
      },
    }),

  /**
   * Rename an account. Thin wrapper over `updateProvider` — kept because "label"
   * is what the command is called and what every caller here means.
   */
  labelProvider: ({ id, label, ...opts }) =>
    api.updateProvider({ id, patch: { label }, ...opts }),

  /**
   * Change one account's settings: `label`, `allowNodeless`, or both.
   *
   * The route has always accepted both fields; this client only ever sent `label`,
   * which is why a CLI-linked account could not be opted into nodeless serving at
   * all. The server 400s an empty patch rather than silently doing nothing, so the
   * caller must send something.
   */
  updateProvider: ({ id, patch, ...opts }) =>
    call(`/providers/${id}`, { ...opts, method: "PATCH", body: omitAbsent(patch || {}) }),

  /**
   * Re-check a credential FROM THE SERVER, and record the verdict.
   *
   * Not the same as the probe `aile connect` runs: that one dials the provider from
   * the lender's own machine to catch a bad paste early, and its result is a claim
   * the server is free to ignore. This asks the server to test the credential IT
   * custodies, over its own egress, and the answer updates `probe_ok`/`probed_at` —
   * which is what the badge reads. Without it the only way to refresh a stale badge
   * was to re-run the entire link.
   *
   * `probe.ok` is NULLABLE: null means the server learned nothing (no healthy egress
   * proxy), which is neither a pass nor a failure and must not be rendered as one.
   */
  retestProvider: ({ id, ...opts }) =>
    call(`/providers/${id}/probe`, { ...opts, method: "POST" }),

  /**
   * Quota and usage for every linked account.
   *
   * The collection route, deliberately: `/providers/:id/usage` takes a CATALOG
   * PROVIDER id while `:id` everywhere else on this surface is an account row id,
   * and picking the wrong one yields a confident answer about the wrong thing.
   *
   * `usage` is null per account whenever the provider reports no quota — which is
   * most of them. That is an answer, not a failure.
   */
  providersUsage: (opts) => call("/providers/usage", opts),

  /** The caller's own lender pricing: margin, per-model overrides, disabled models. */
  pricing: (opts) => call("/pricing", opts),

  /** The global multiplier applied to every model with no override of its own. */
  setMargin: ({ margin, ...opts }) =>
    call("/pricing", { ...opts, method: "PATCH", body: { margin } }),

  /**
   * A per-model price. Dollars per million tokens is the primary form; `margin`
   * alone is the fallback. All-null clears the override — which is a different
   * operation from `clearModelPrice` only in that it goes through the same route.
   */
  setModelPrice: ({ model, inUsd = null, outUsd = null, margin = null, ...opts }) =>
    call("/pricing/model", { ...opts, method: "PUT", body: omitAbsent({ model, inUsd, outUsd, margin }) }),

  /** Drop a per-model override, returning that model to the global margin. */
  clearModelPrice: ({ model, ...opts }) =>
    call(`/pricing/model/${encodeURIComponent(model)}`, { ...opts, method: "DELETE" }),

  /**
   * Serve this model, or stop. A separate table from pricing on the server, so
   * clearing a price cannot silently re-enable something the lender turned off.
   */
  setModelDisabled: ({ model, disabled, ...opts }) =>
    call("/pricing/model/disabled", { ...opts, method: "PUT", body: { model, disabled } }),

  removeProvider: ({ id, ...opts }) => call(`/providers/${id}`, { ...opts, method: "DELETE" }),

  /**
   * The account's wallet, or a 404 carrying the reason there is not one.
   *
   * READ-ONLY, AND THERE IS DELIBERATELY NO WRITE CALL BESIDE IT — but the reason
   * changed, and the new one is worth stating because it is stronger. There is no
   * write call because THERE IS NOTHING TO WRITE: this is not a payout destination
   * somebody sets, it is the wallet earnings accrue to, minted at sign-in. Where a
   * withdrawal goes is named on the withdraw page at the moment it is made and is
   * stored nowhere, so no call here could re-point it and no takeover could either.
   *
   * NOTHING IN THIS CLIENT EVER HANDLES A PRIVATE KEY. The key is in the wallet
   * provider's enclave; taking it out happens in a browser at `/wallet/export`,
   * which hands back ciphertext addressed to that tab. A terminal is the wrong
   * place for it and this client has no code that could receive one.
   *
   * `balance: true` asks the server for the USDC balance too, which costs it an RPC
   * round trip — so it is opt-in rather than always-on, and a failed read comes
   * back as null rather than as zero.
   *
   * 404 IS AN ORDINARY ANSWER, not a failure: a donated machine has no wallet
   * because nothing accrues to it. Returned rather than thrown so the caller can
   * print the server's own reason, which distinguishes that from the wallet service
   * being briefly unreachable — two situations that want opposite responses.
   */
  async wallet({ balance = false, ...opts } = {}) {
    try {
      return await call(balance ? "/wallet?balance=1" : "/wallet", opts);
    } catch (e) {
      // A 404 is an ordinary "no wallet". Under the envelope e.body is the whole
      // {success:false,message} object (truthy), so the old `e.body || …` would
      // wrongly hand the envelope back as the wallet; the reason the CLI prints
      // now rides in `message`, so carry that across as `reason`.
      if (e instanceof ApiError && e.status === 404) return { wallet: null, reason: e.body?.message };
      throw e;
    }
  },

  /**
   * The marketplace — who is lending right now, and what they charge.
   *
   * FILTERS ARE LISTED, NOT SPREAD, for the same reason `saveProvider`'s body is:
   * a parameter reaches the server when someone added it here on purpose. Here
   * that also stops a caller's stray key from becoming a query parameter the
   * server silently ignores — which would return an UNFILTERED listing to a
   * caller who believes it is filtered, and there is no way to see that from the
   * result.
   *
   * Only parameters that were actually given are sent. An empty `model=` is not
   * the same request as no model at all: the server prices a listing only when a
   * model is named, so a blank one asks for a price column it cannot fill.
   *
   * `maxPrice` is dollars per million tokens and bounds BOTH directions — the
   * server drops a lender whose input OR output rate is above it, so a cheap-in/
   * expensive-out lender cannot slip past a single-number ceiling.
   *
   * `handle` AND `nodeId` ARE DIFFERENT QUESTIONS AND BOTH ARE HERE ON PURPOSE.
   * A lender may run several machines. `handle` names the seller and takes
   * whichever of their machines is free; `nodeId` pins one box. Offering only
   * one of them fails exactly when a buyer wanted the other: "keep sending my
   * work to that person" and "keep sending my work to that machine" are not the
   * same request, and each has its own header on the serve path
   * (`x-aile-lender`, `x-aile-node`) so a filter you liked here is a filter you
   * can act on there.
   *
   * `minServed`, `freeOnly` and `sort` HAVE NO SERVE-PATH HEADER, and that is
   * the honest shape rather than a gap. They change what you READ: a floor on
   * track record, hiding machines at capacity, and the order of the list.
   * Routing already goes to the cheapest machine that can answer, so a `sort`
   * header would be a setting that silently did nothing.
   */
  market: ({
    model = null, maxPrice = null, verified = false, provider = null,
    handle = null, nodeId = null, minServed = null, freeOnly = false,
    sort = null, limit = null, ...opts
  } = {}) => {
    const q = new URLSearchParams();
    const num = (v) => v !== null && v !== undefined && String(v) !== "";
    if (model) q.set("model", String(model));
    if (num(maxPrice)) q.set("maxPrice", String(maxPrice));
    if (verified) q.set("verified", "1");
    if (provider) q.set("provider", String(provider));
    if (handle) q.set("handle", String(handle));
    if (nodeId) q.set("nodeId", String(nodeId));
    if (num(minServed)) q.set("minServed", String(minServed));
    if (freeOnly) q.set("freeOnly", "1");
    if (sort) q.set("sort", String(sort));
    if (limit) q.set("limit", String(limit));
    const s = q.toString();
    return call(s ? `/market?${s}` : "/market", opts);
  },

  /**
   * What this account has actually put through each lender.
   *
   * ============================================================================
   * THE OTHER HALF OF `market`, AND THE ONE THAT IS NOT PUBLIC. A listing shows a
   * lender's total across every buyer; this shows what they charged YOU. That is
   * the number that decides whether to route to them again — a lender two cents
   * cheaper who timed out on a third of your requests looks worse here than any
   * listing can show.
   *
   * NOBODY TYPED ANY OF IT. It is counted from the buyer's own ledger rows, which
   * is why there is no rating call beside this one and no `review` method to go
   * with it: a request count and a settled amount cannot be manufactured by a
   * lender who did not serve the requests, and cannot be moved by a buyer at all.
   *
   * The server scopes it to the caller's own keys — there is no renter parameter
   * to pass and no way to ask about somebody else's spend.
   * ============================================================================
   */
  spend: ({ limit = null, ...opts } = {}) =>
    call(limit ? `/market/spend?limit=${encodeURIComponent(limit)}` : "/market/spend", opts),

  health: (opts) => call("/health", opts),

  // --- Buying: keys and the model list ----------------------------------------

  /**
   * Mint a buyer API key (`sk-aile-…`) on the signed-in account.
   *
   * The account token (`ail_…`) is a lender credential and `/v1` refuses it, so a
   * machine that is signed in still needs one of these to BUY. The secret comes
   * back exactly once, here; the server keeps only its hash.
   */
  createKey: ({ name = null, ...opts } = {}) =>
    call("/keys", { ...opts, method: "POST", body: omitAbsent({ name }) }),

  /** Revoke a buyer key on the signed-in account, by its id (not its secret). */
  revokeKey: ({ id, ...opts }) =>
    call(`/keys/${encodeURIComponent(id)}`, { ...opts, method: "DELETE" }),

  /**
   * The public model list, raw OpenAI shape (`{object, data}`) — no key needed.
   * Used to pick the models a tool that cannot discover them is told about.
   */
  listModels: (opts = {}) => call("/v1/models", opts),

  /**
   * Is this buyer key live? Asked of `POST /v1/messages/count_tokens`, which
   * runs the same key gate as a real request but selects no lender and bills
   * nothing — so checking a key costs its owner nothing and dials nobody.
   *
   * Resolves `{ok, status, reason}` and never throws for a refusal; only an
   * unreachable server throws, because that says nothing about the key.
   */
  async validateKey({ key, ...opts }) {
    try {
      await call("/v1/messages/count_tokens", {
        ...opts, method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: { model: "cc/claude-sonnet-5", messages: [{ role: "user", content: "ok" }] },
      });
      return { ok: true, status: 200, reason: null };
    } catch (e) {
      if (!(e instanceof ApiError) || !e.status || e.status >= 500) throw e;
      const reason = e.body?.error?.message || e.message;
      return { ok: false, status: e.status, reason };
    }
  },
};

export { call as apiCall };
