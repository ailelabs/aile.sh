/**
 * Provider linking flows.
 *
 * Branches on the catalog's `flow` family, never on a provider id, so a provider
 * added to the catalog that reuses a known family works with no code change here.
 *
 * Families: `authcode`, `device`, `google` (all OAuth), and `apikey` — a pasted
 * key, implemented in ./apikey.js and adapted to the same signature here so the
 * caller uploads all four by one path.
 *
 * SECURITY — where the tokens go:
 *
 * The OAuth exchange happens on the renter's machine because that is where the
 * browser is. The resulting tokens are handed straight to the caller, which
 * uploads them to aile.sh and does NOT write them to disk. That custody model is
 * forced by the blind-relay design: aile.sh terminates TLS with the provider, so
 * aile.sh is the party that must hold the token. A copy left on the renter's
 * machine would be a second place to steal it from, buying nothing.
 *
 * A pasted API key is held to the same rule for the same reason — see
 * ./apikey.js, which also explains why it is verified before it is uploaded.
 */

import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
// The merged view, not the generated catalog: key-based providers are
// hand-maintained and only exist in the merge. See ./index.js.
import { getProvider } from "./index.js";
import { runApiKeyFlow } from "./apikey.js";
import { APP_VERSION } from "../config/version.js";

const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Does this provider mint an id_token we could bind a nonce to?
 *
 * `nonce` is an OpenID Connect parameter, and it is only meaningful when the
 * authorization request asks for `openid` — that is what makes the provider
 * return an id_token with the nonce inside it. A few of the catalog's providers
 * do; the rest issue a plain OAuth access token and have nothing to bind.
 *
 * Sending it to them anyway is not merely useless. Claude's authorize endpoint
 * rejects the whole request as malformed — the error it renders is "Missing
 * client_id parameter", which is a lie about the cause and sent a real user
 * hunting for a client_id that was present all along. An unrecognised parameter
 * is the kind of thing a strict authorization server is entitled to refuse, so
 * the fix is to stop sending it where it means nothing rather than to hope each
 * provider ignores it.
 *
 * This is the second of two gates. ../providers/link.js has already dropped the
 * nonce for any provider the SERVER cannot attest, which is the narrower and
 * more important test — `openid` in a scope only says an id_token comes back,
 * not that anyone here can check it.
 */
function acceptsNonce(oauth) {
  return /(^|\s)openid(\s|$)/.test(scopeOf(oauth));
}




/** The provider's scopes, however the catalog happens to spell them. */
function scopeOf(oauth) {
  const s = oauth.scope || (Array.isArray(oauth.scopes) ? oauth.scopes.join(" ") : oauth.scopes);
  return String(s || "");
}

// ---------------------------------------------------------------------------
// Catalog-directed shapes
// ---------------------------------------------------------------------------

/**
 * Resolve the `@name` / `=literal` vocabulary the catalog uses to describe a
 * request without naming a provider.
 *
 * `@name` is a runtime value from `vars` — a callback URL, a generated device
 * id, an endpoint from the same oauth block. `=literal` is a constant that
 * merely looks like one. Anything else is taken as a literal, so an ordinary
 * string in the catalog means itself.
 *
 * An `@name` with nothing behind it yields undefined and the caller drops the
 * parameter. That is the important half: a template referring to a value this
 * provider does not have must not send the string "undefined", which is exactly
 * what reached api.cline.bot as `client_id=undefined`.
 */
function resolveTemplate(value, vars, { url = false } = {}) {
  if (typeof value !== "string") return value;
  if (value.startsWith("=")) return value.slice(1);
  if (!value.includes("@")) return value;
  let missing = false;
  // Longest name first, so `@pollUrlBase` is not matched as `@poll` + "UrlBase".
  const out = value.replace(/@([A-Za-z][A-Za-z0-9_]*)/g, (_, name, at) => {
    const v = vars[name];
    if (v === undefined || v === null || v === "") { missing = true; return ""; }
    // In a URL template, everything past the `?` is a query VALUE and has to be
    // escaped — a device code carrying an `&` would otherwise silently truncate
    // the parameter and poll for something the provider never issued. Before the
    // `?` the substitution is the endpoint itself, which must stay literal.
    const inQuery = url && value.includes("?") && at > value.indexOf("?");
    return inQuery ? encodeURIComponent(String(v)) : String(v);
  });
  return missing ? undefined : out;
}

/** Apply a template map, dropping every entry whose value did not resolve. */
function resolveMap(shape, vars) {
  const out = {};
  for (const [k, v] of Object.entries(shape || {})) {
    const resolved = resolveTemplate(v, vars);
    if (resolved !== undefined) out[k] = resolved;
  }
  return out;
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

export function generatePkce(bytes = 32) {
  const codeVerifier = crypto.randomBytes(bytes).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  const state = crypto.randomBytes(32).toString("base64url");
  return { codeVerifier, codeChallenge, state };
}

// ---------------------------------------------------------------------------
// Loopback callback listener
// ---------------------------------------------------------------------------

const RESULT_PAGE = (ok, msg) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${ok ? "Connected" : "Failed"}</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0b0b0f;color:#eee}
.c{text-align:center;padding:2.5rem}.i{font-size:3rem;color:${ok ? "#22c55e" : "#ef4444"}}p{color:#888}</style></head>
<body><div class="c"><div class="i">${ok ? "&#10003;" : "&#10007;"}</div>
<h1>${ok ? "Account connected" : "Connection failed"}</h1><p>${msg}</p>
<p>You can close this tab and return to your terminal.</p></div></body></html>`;

/**
 * Listen on loopback for the provider's redirect.
 * `fixedPort` matters for providers that registered an exact redirect URI.
 */
function listenForCallback({ fixedPort = 0, callbackPath = "/callback" } = {}) {
  return new Promise((resolve, reject) => {
    let settle;
    const received = new Promise((r) => { settle = r; });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== callbackPath && url.pathname !== "/callback" && url.pathname !== "/auth/callback") {
        res.writeHead(404); res.end("not found"); return;
      }
      const params = Object.fromEntries(url.searchParams);
      const ok = Boolean(params.code) && !params.error;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(RESULT_PAGE(ok, ok ? "Your account is now linked." : (params.error_description || params.error || "No authorization code.")));
      settle(params);
    });

    server.on("error", (err) => {
      reject(err.code === "EADDRINUSE" && fixedPort
        ? new Error(`Port ${fixedPort} is in use — close whatever is using it and retry.`)
        : err);
    });

    server.listen(fixedPort, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        close: () => server.close(),
        wait: (timeoutMs = OAUTH_TIMEOUT_MS) => Promise.race([
          received,
          new Promise((_, rj) => setTimeout(() => rj(new Error("Authorization timed out after 5 minutes")), timeoutMs).unref?.()),
        ]),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

async function postToken(url, payload, { encoding = "form", headers = {} } = {}) {
  const isJson = encoding === "json";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": isJson ? "application/json" : "application/x-www-form-urlencoded",
      accept: "application/json",
      ...headers,
    },
    body: isJson ? JSON.stringify(payload) : new URLSearchParams(payload).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { throw new Error("Provider returned a non-JSON token response"); }
}

/** Normalize the provider's token response into the shape the server stores. */
function normalizeTokens(raw) {
  return {
    accessToken: raw.access_token || raw.accessToken || null,
    refreshToken: raw.refresh_token || raw.refreshToken || null,
    idToken: raw.id_token || raw.idToken || null,
    expiresIn: raw.expires_in ?? raw.expiresIn ?? null,
    scope: raw.scope || null,
    resourceUrl: raw.resource_url || null,
  };
}

// ---------------------------------------------------------------------------
// Flow: authorization code + PKCE
// ---------------------------------------------------------------------------

async function authcodeFlow(provider, { openBrowser, log, nonce }) {
  const o = provider.oauth;

  // Operator-gated providers (gitlab-duo with no GITLAB_DUO_OAUTH_CLIENT_ID)
  // publish a null authorizeUrl — there is no usable client until the operator
  // sets the env, so there is nothing to open. Fail plainly BEFORE binding the
  // loopback listener rather than sending the browser to `undefined?…`. Mirrors
  // the API's "configure it" gate (lib/linkCatalog.ts).
  if (!o.authorizeUrl) {
    throw new Error(`${provider.name} is not configured — set its OAuth client credentials to link it`);
  }

  const { codeVerifier, codeChallenge, state } = generatePkce();

  const cb = await listenForCallback({
    fixedPort: o.fixedPort || 0,
    callbackPath: o.callbackPath || "/callback",
  });
  const redirectUri = `http://localhost:${cb.port}${o.callbackPath || "/callback"}`;

  // The standard OAuth2 block, unless the catalog describes this endpoint's own
  // shape. `authShape` REPLACES these rather than adding to them: an endpoint
  // that is not an authorization server rejects the request when handed
  // parameters it does not know, so sending the standard set "just in case" is
  // the failure, not the safety net.
  const vars = { redirect: redirectUri, state, clientId: o.clientId, codeChallenge };
  const params = o.authShape
    ? resolveMap(o.authShape, vars)
    : {
      response_type: "code",
      client_id: o.clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: o.codeChallengeMethod || "S256",
    };
  Object.assign(params, o.extraParams || {});

  const scope = scopeOf(o);
  // A described endpoint gets a scope only if it asked for one by name; the
  // rest of the shape being explicit and the scope arriving anyway would defeat
  // the point of describing it.
  if (scope && !o.authShape) params.scope = scope;

  // The server picks the nonce, so a token minted for someone else cannot be
  // replayed here — this is what makes the id_token proof meaningful rather
  // than merely well-formed. Only where an id_token is actually issued: see
  // acceptsNonce, and the authorize endpoint that rejects it outright.
  if (nonce && acceptsNonce(o)) params.nonce = nonce;

  // Manual encoding: some providers reject `+` for spaces in scope.
  const authUrl = `${o.authorizeUrl}?` + Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");

  log(`Opening your browser to authorize ${provider.name}…`);
  log(`If it does not open, visit:\n  ${authUrl}`);
  await openBrowser(authUrl);

  let cbParams;
  try {
    cbParams = await cb.wait();
  } finally {
    cb.close();
  }

  if (cbParams.error) throw new Error(cbParams.error_description || cbParams.error);
  if (!cbParams.code) throw new Error("No authorization code received");

  // Some providers append state to the code with '#'.
  let code = cbParams.code;
  let codeState = "";
  if (code.includes("#")) { [code, codeState] = code.split("#"); }
  const returnedState = cbParams.state || codeState;
  if (returnedState && returnedState !== state) {
    throw new Error("State mismatch — aborting (possible CSRF)");
  }

  const style = o.tokenStyle || {};

  // Some endpoints hand the tokens back IN the code rather than exchanging it.
  // Tried before the network call because there is nothing to exchange when it
  // succeeds; on a decode failure we fall through to the real endpoint, which
  // is the same order the provider's own client uses.
  if (style.codeFormat === "base64json") {
    const decoded = decodeEmbeddedTokens(code);
    if (decoded) return normalizeTokens(decoded);
  }

  const tokenUrl = o.tokenUrl || o.tokenExchangeUrl;
  const payload = {
    grant_type: "authorization_code",
    client_id: o.clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  };
  if (o.clientSecret) payload.client_secret = o.clientSecret;
  // Most token endpoints do not want `state` back — it is the authorize call's
  // CSRF token, not an exchange parameter, and the strict ones reject it. Two
  // cases send it anyway: an endpoint that appended it to the code as `code#state`
  // is asking for it back, and one the catalog marks `sendState` requires it
  // regardless. Claude is the latter: its `/v1/oauth/token` answers a stateless
  // exchange with 400 "Invalid request format", which is the failure a lender
  // hits on the loopback path where `state` came back as its own query param and
  // never entered the code — so `state` is always resolved as `codeState || state`.
  if (codeState) payload.state = codeState;
  else if (style.sendState) payload.state = state;

  const headers = {};
  // Client credentials in an Authorization header rather than the body. Some
  // endpoints accept only this form and reject the same credentials in the
  // payload, so it is described per-provider in the catalog.
  if (style.auth === "basic" && o.clientId) {
    const basic = Buffer.from(`${o.clientId}:${o.clientSecret || ""}`).toString("base64");
    headers.authorization = `Basic ${basic}`;
  }

  return normalizeTokens(
    await postToken(tokenUrl, payload, { encoding: style.encoding || "form", headers }),
  );
}

/**
 * Read tokens out of a base64 JSON `code`.
 *
 * Returns null on anything unexpected so the caller can fall back to a real
 * exchange — a malformed blob here is a provider that changed its mind about the
 * format, not a reason to fail the link outright.
 *
 * The trailing-brace scan is not defensive tidying: these blobs arrive with
 * padding after the JSON, so parsing the whole decoded string throws.
 */
function decodeEmbeddedTokens(code) {
  try {
    let b64 = String(code);
    const pad = 4 - (b64.length % 4);
    if (pad !== 4) b64 += "=".repeat(pad);
    const text = Buffer.from(b64, "base64").toString("utf8");
    const end = text.lastIndexOf("}");
    if (end === -1) return null;
    const data = JSON.parse(text.slice(0, end + 1));
    if (!data.accessToken && !data.access_token) return null;
    return {
      access_token: data.accessToken || data.access_token,
      refresh_token: data.refreshToken || data.refresh_token || null,
      id_token: data.idToken || data.id_token || null,
      email: data.email || null,
      // An absolute instant, which the shared normalizer expects as a duration.
      expires_in: data.expiresAt
        ? Math.max(0, Math.floor((new Date(data.expiresAt).getTime() - Date.now()) / 1000))
        : data.expires_in ?? null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Flow: device authorization
// ---------------------------------------------------------------------------

/**
 * The values a device request may refer to by `@name`.
 *
 * `deviceId` is generated ONCE per link attempt and reused across the initiate
 * call and every poll. Kimi ties the pending authorization to it, so a fresh id
 * per request polls for an approval that will never be granted — the flow then
 * times out after five minutes having looked, from the outside, like the lender
 * simply never clicked approve.
 */
function deviceVars(o) {
  const osName = process.platform;
  const model = osName === "darwin" ? `macOS ${process.arch}`
    : osName === "win32" ? `Windows ${process.arch}`
      : osName === "linux" ? `Linux ${process.arch}`
        : `${osName} ${process.arch}`;
  let host = "unknown";
  try { host = os.hostname() || "unknown"; } catch { /* keep the placeholder */ }
  return {
    ...o,
    deviceId: crypto.randomUUID(),
    appVersion: APP_VERSION,
    hostname: host,
    deviceModel: model,
  };
}

/** Read `a.b.c` out of a response body, tolerating a missing level. */
function pick(obj, dotted) {
  if (!dotted) return undefined;
  return String(dotted).split(".").reduce((v, k) => (v == null ? v : v[k]), obj);
}

/**
 * Perform one described request (`initiate` or `poll`) from a `deviceStyle`.
 *
 * Returns the raw Response, not a parsed body: kilocode carries its
 * pending/denied state in the HTTP status alone, so the caller has to see it.
 */
async function describedFetch(shape, vars, headers) {
  const url = resolveTemplate(shape.url, vars, { url: true });
  if (!url) throw new Error("The catalog describes a request whose URL did not resolve");
  const method = shape.method || "POST";
  const init = { method, headers: { accept: "application/json", ...headers } };
  if (method !== "GET" && shape.body !== undefined) {
    const json = shape.encoding === "json";
    init.headers["content-type"] = json
      ? "application/json"
      : "application/x-www-form-urlencoded";
    const body = resolveMap(shape.body, vars);
    init.body = json ? JSON.stringify(body) : new URLSearchParams(body).toString();
  }
  return fetch(url, init);
}

async function deviceFlow(provider, { openBrowser, log, nonce }) {
  const o = provider.oauth;
  const { codeVerifier, codeChallenge } = generatePkce();
  const vars = deviceVars(o);
  // Constant per attempt so both the initiate and every poll present the same
  // identity to a provider that ties the authorization to these headers.
  const headers = resolveMap(o.deviceHeaders, vars);
  if (o.userAgent) headers["user-agent"] = o.userAgent;

  const style = o.deviceStyle || null;
  let device;
  // AWS SSO OIDC (kiro) dynamic-client credentials, minted by the register
  // pre-step below and carried into the stored credential so refresh can
  // re-present the SAME {clientId, clientSecret} against the region-scoped OIDC
  // token endpoint. Null for every other device provider (no register step).
  let registeredClientId = null;
  let registeredClientSecret = null;

  if (style) {
    // Dynamic-client registration pre-step (AWS SSO OIDC / kiro): mint an
    // ephemeral {clientId, clientSecret} that feeds BOTH the device-authorization
    // and the token POSTs. The registered credentials are lifted into the
    // template vars so `@clientId` / `@clientSecret` resolve in the bodies below,
    // and kept so the poll body + stored credential can re-present them. Mirrors
    // the server's lib/linkFlows.ts:deviceStart register step verbatim.
    if (style.register) {
      const regRes = await describedFetch(style.register, vars, headers);
      if (!regRes.ok) {
        throw new Error(`Client registration failed (${regRes.status}): ${(await regRes.text()).slice(0, 300)}`);
      }
      const regBody = await regRes.json().catch(() => ({}));
      registeredClientId = pick(regBody, style.register.map.clientId) ?? null;
      registeredClientSecret = pick(regBody, style.register.map.clientSecret) ?? null;
      if (!registeredClientId || !registeredClientSecret) {
        throw new Error("Client registration returned no client credentials");
      }
      vars.clientId = registeredClientId;
      vars.clientSecret = registeredClientSecret;
    }

    // A device-shaped flow that is not RFC 8628. The catalog describes both
    // calls; nothing about them is inferred.
    const res = await describedFetch(style.initiate, vars, headers);
    if (!res.ok) {
      if (res.status === 429) throw new Error("Too many pending requests — wait a moment and retry");
      throw new Error(`Device authorization failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    }
    const raw = await res.json();
    // An application-level status inside a 200, which is how these endpoints
    // report a refusal that HTTP would have called an error.
    if (style.codeField && raw[style.codeField] !== undefined
        && raw[style.codeField] !== style.codeOk) {
      throw new Error(`Device authorization failed: ${raw.msg || raw[style.codeField]}`);
    }
    const env = style.envelope ? pick(raw, style.envelope) || {} : raw;
    const m = style.map || {};
    device = {
      device_code: pick(env, m.deviceCode),
      user_code: pick(env, m.userCode),
      verification_uri: pick(env, m.verificationUri),
      expires_in: pick(env, m.expiresIn),
    };
    if (!device.device_code) throw new Error("Device authorization returned no code");
    vars.deviceCode = device.device_code;
  } else {
    const body = { client_id: o.clientId };
    const scope = scopeOf(o);
    if (scope) body.scope = scope;
    if (o.codeChallengeMethod) {
      body.code_challenge = codeChallenge;
      body.code_challenge_method = o.codeChallengeMethod;
    }
    // Identifies the calling client to endpoints that route on it rather than
    // on client_id; auth.x.ai is the one in the catalog.
    if (o.referrer) body.referrer = o.referrer;
    if (nonce && acceptsNonce(o)) body.nonce = nonce;

    const initiateUrl = o.deviceCodeUrl || o.initiateUrl;
    if (!initiateUrl) throw new Error(`${provider.name} has no device endpoint in the catalog`);

    const res = await fetch(initiateUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        ...headers,
      },
      body: new URLSearchParams(body).toString(),
    });
    if (!res.ok) throw new Error(`Device authorization failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    device = await res.json();
    vars.deviceCode = device.device_code;
  }

  const verifyUrl = device.verification_uri_complete || device.verification_uri || o.authorizeDeviceUrl;
  log(`\n  Visit:  ${verifyUrl}`);
  if (device.user_code) log(`  Code:   ${device.user_code}\n`);
  if (verifyUrl) await openBrowser(verifyUrl);

  // The provider's own answer wins where it gives one — that is what RFC 8628
  // asks for, and polling faster than it said is how a device flow earns a
  // `slow_down`. The floor is a second, so a provider answering 0 cannot turn
  // the loop into a hot spin against its own endpoint.
  const intervalMs = style?.intervalMs
    || (Number(device.interval) > 0 ? Math.max(1, Number(device.interval)) * 1000 : 0)
    || Number(o.pollInterval)
    || 5000;
  const deadline = Date.now() + OAUTH_TIMEOUT_MS;

  log("Waiting for you to approve…");
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));

    const done = style
      ? await pollDescribed(style, vars, headers)
      : await pollRfc8628(o, device, codeVerifier, headers);
    if (done) {
      // Carry the AWS dynamic-client credentials + region into the stored
      // credential (kiro refresh re-presents them against the region-scoped OIDC
      // token endpoint). Only when the register pre-step actually minted them —
      // never fabricated. Mirrors lib/linkFlows.ts:662-669.
      if (registeredClientId && registeredClientSecret) {
        return {
          ...done,
          clientId: registeredClientId,
          clientSecret: registeredClientSecret,
          region: style?.region ?? "us-east-1",
          authMethod: "builder-id",
        };
      }
      return done;
    }
  }
  throw new Error("Authorization timed out after 5 minutes");
}

/** One poll of a described endpoint. Returns tokens, or null to keep waiting. */
async function pollDescribed(style, vars, headers) {
  const res = await describedFetch(style.poll, vars, headers);

  // Pending/denied carried by HTTP status (kilocode).
  const byStatus = style.pollStatus?.[String(res.status)];
  if (byStatus === "pending") return null;
  if (byStatus === "denied") throw new Error("Authorization was denied");
  if (byStatus === "expired") throw new Error("The device code expired — run the command again");

  // …or by an OAuth/AWS error code inside a non-2xx BODY (AWS SSO OIDC / kiro:
  // CreateToken returns HTTP 400 whose `error` or `__type` carries the real
  // state). Read BEFORE the generic non-2xx throw so "keep polling" is not
  // misread as a hard failure. `authorization_pending`/`slow_down` ⇒ keep
  // waiting; `expired_token` ⇒ expired; `access_denied` ⇒ denied. Mirrors
  // lib/linkFlows.ts:705-720.
  if (style.oauthErrors && !res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const marker = String(errBody.error || errBody.__type || "").toLowerCase();
    if (marker.includes("authorization_pending") || marker.includes("authorizationpending")
        || marker.includes("slow_down") || marker.includes("slowdown")) {
      return null;
    }
    if (marker.includes("expired_token") || marker.includes("expiredtoken")) {
      throw new Error("The device code expired — run the command again");
    }
    if (marker.includes("access_denied") || marker.includes("accessdenied")) {
      throw new Error("Authorization was denied");
    }
    // Any other non-2xx is a real failure — fall through to the generic throw.
  }

  if (!res.ok) throw new Error(`Polling failed (${res.status})`);

  const raw = await res.json().catch(() => ({}));

  // …or by an application code inside a 200 (codebuddy).
  if (style.codeField) {
    const code = raw[style.codeField];
    if (code === style.codePending) return null;
    if (code !== style.codeOk) throw new Error(raw.msg || `Polling failed (code ${code})`);
  }

  const env = style.envelope ? pick(raw, style.envelope) || {} : raw;
  // …or by a field in an otherwise successful body (kilocode again).
  if (style.approvedWhen && pick(env, style.approvedWhen.field) !== style.approvedWhen.equals) {
    return null;
  }

  const token = pick(env, style.tokenField);
  if (!token) return null;
  return normalizeTokens({
    access_token: token,
    refresh_token: style.refreshField ? pick(env, style.refreshField) : null,
    expires_in: style.expiresField ? pick(env, style.expiresField) : null,
    id_token: pick(env, "idToken") || pick(env, "id_token") || null,
    email: style.emailField ? pick(env, style.emailField) : null,
  });
}

/** One RFC 8628 poll. Returns tokens, or null to keep waiting. */
async function pollRfc8628(o, device, codeVerifier, headers) {
  const body = {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: o.clientId,
    device_code: device.device_code,
  };
  // Only where the initiate sent a challenge — an endpoint that ran no PKCE
  // rejects a verifier for a challenge it never saw.
  if (o.codeChallengeMethod) body.code_verifier = codeVerifier;

  const poll = await fetch(o.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      ...headers,
    },
    body: new URLSearchParams(body).toString(),
  });

  const data = await poll.json().catch(() => ({}));
  // Kimi answers 200 with an `error` field while the lender is still deciding,
  // so the token has to be the success test rather than the status.
  if (data.access_token) return normalizeTokens(data);

  if (data.error === "authorization_pending") return null;
  if (data.error === "slow_down") { await new Promise((r) => setTimeout(r, 5000)); return null; }
  if (data.error === "expired_token") throw new Error("The device code expired — run the command again");
  if (data.error === "access_denied") throw new Error("Authorization was denied");
  throw new Error(data.error_description || data.error || `Polling failed (${poll.status})`);
}

// ---------------------------------------------------------------------------
// Flow: Google (authorization code with a client secret)
// ---------------------------------------------------------------------------

async function googleFlow(provider, ctx) {
  if (!provider.oauth.clientId) {
    throw new Error(`${provider.name} needs OAuth client credentials that are not in the catalog`);
  }
  return authcodeFlow(provider, ctx);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * The apikey family, adapted to the same signature as the OAuth runners.
 *
 * It takes no browser and no nonce — there is no redirect to open and nothing to
 * attest — so those arguments are simply unused rather than faked. The key comes
 * from the caller, who is the one with a terminal to read it on.
 */
async function apikeyFlow(provider, { log, apiKey }) {
  return runApiKeyFlow(provider, { key: apiKey, log });
}

const FLOWS = {
  authcode: authcodeFlow, device: deviceFlow, google: googleFlow, apikey: apikeyFlow,
};

/**
 * A browser is needed by every flow except apikey, which is why this is a
 * property of the family rather than a check inside each runner: requiring an
 * opener for a flow that never opens anything would make `aile connect groq`
 * fail on a headless box for no reason.
 */
const NEEDS_BROWSER = new Set(["authcode", "device", "google"]);

export function isLinkable(id) {
  const p = getProvider(id);
  return Boolean(p && FLOWS[p.flow]);
}

/** Providers linked by pasting a key, which the caller must collect first. */
export function needsApiKey(id) {
  return getProvider(id)?.flow === "apikey";
}

/**
 * Run the linking flow for `providerId`.
 * Returns provider tokens — the caller uploads them and must not persist them.
 */
export async function linkProvider(providerId, {
  openBrowser, log = console.log, nonce = null, apiKey = null,
} = {}) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);

  const flow = FLOWS[provider.flow];
  if (!flow) {
    throw new Error(`${provider.name} must be connected by pasting a token — not supported yet`);
  }
  if (NEEDS_BROWSER.has(provider.flow) && !openBrowser) throw new Error("openBrowser is required");

  const tokens = await flow(provider, { openBrowser, log, nonce, apiKey });
  if (!tokens.accessToken) throw new Error(`${provider.name} returned no access token`);
  return { provider: providerId, ...tokens };
}

export { listenForCallback, normalizeTokens, OAUTH_TIMEOUT_MS };
