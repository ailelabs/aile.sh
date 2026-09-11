#!/usr/bin/env bun
/**
 * Regenerate the vendored provider catalog and egress allowlist.
 *
 * Usage: bun run scripts/sync-providers.js /path/to/provider-registry-checkout
 *
 * A build-time step on purpose. Both outputs ship as static data so that neither
 * the set of providers we will link, nor the set of hosts a node will dial, can
 * be widened at runtime by anything outside this repo.
 *
 * The generated files carry no attribution to the upstream registry: the catalog
 * is ours once vendored, and the app presents these providers as its own.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
if (!root) {
  console.error("Usage: bun run scripts/sync-providers.js /path/to/provider-registry-checkout");
  process.exit(2);
}

const registryDir = path.join(root, "open-sse/providers/registry");
const registryIndex = path.join(registryDir, "index.js");
if (!fs.existsSync(registryIndex)) {
  console.error(`No registry at ${registryIndex}`);
  process.exit(2);
}

const { default: registry } = await import(pathToFileURL(registryIndex).href);

// Loaded up front so a missing/renamed export fails the sync loudly here rather
// than producing a catalog whose Google providers quietly cannot be linked.
const sharedPath = path.join(root, "open-sse/providers/shared.js");
const shared = fs.existsSync(sharedPath)
  ? await import(pathToFileURL(sharedPath).href)
  : {};

// ---------------------------------------------------------------------------
// Egress allowlist
// ---------------------------------------------------------------------------

const hosts = new Set();
const seen = new WeakSet();
const walk = (node, depth = 0) => {
  if (!node || typeof node !== "object" || depth > 8 || seen.has(node)) return;
  seen.add(node);
  for (const value of Object.values(node)) {
    if (typeof value === "string") {
      if (value.startsWith("https://")) {
        try { hosts.add(new URL(value).hostname.toLowerCase()); } catch { /* not a URL */ }
      }
    } else if (typeof value === "object") {
      walk(value, depth + 1);
    }
  }
};
for (const entry of registry) walk(entry);

// Local endpoints are legitimate providers on a developer's own machine but must
// never be relay targets — that is exactly the open-proxy hole the allowlist closes.
const isLocal = (h) =>
  h === "localhost" ||
  h.endsWith(".localhost") ||
  h.endsWith(".local") ||
  h.endsWith(".internal") ||
  !h.includes(".") ||
  /^\d{1,3}(\.\d{1,3}){3}$/.test(h);

const dropped = [...hosts].filter(isLocal);
const cleanHosts = [...hosts].filter((h) => !isLocal(h)).sort();

// ---------------------------------------------------------------------------
// Provider catalog
// ---------------------------------------------------------------------------

/**
 * Classify a provider into a flow family. The family — not the provider id — is
 * what the linking code branches on, so adding a provider upstream that reuses a
 * known family needs no new client code.
 */
function flowFamily(entry) {
  const o = entry.oauth || {};
  if (GOOGLE_CLIENTS[entry.id]) return "google";
  if (o.deviceCodeUrl || o.initiateUrl || o.stateUrl) return "device";
  if (o.authorizeUrl && (o.tokenUrl || o.tokenExchangeUrl)) return "authcode";
  // A non-standard authorize shape is still an authorize redirect. Without this
  // a provider whose endpoint we describe by hand would fall through to `paste`
  // and the CLI would tell the lender to find a token themselves.
  if (AUTH_SHAPES[entry.id]) return "authcode";
  return "paste";
}

// Fields worth vendoring. Everything else in a registry entry is routing detail
// the relay server owns, not something the linking client needs.
//
// `referrer` is here because auth.x.ai expects it on the device-code request;
// `validationUrl` because a browser-token provider has no other way to check the
// token it was handed before uploading it.
const OAUTH_FIELDS = [
  "clientId", "clientSecret", "authorizeUrl", "tokenUrl", "tokenExchangeUrl",
  "refreshUrl", "deviceCodeUrl", "authorizeDeviceUrl", "initiateUrl", "pollUrlBase",
  "stateUrl", "userInfoUrl", "scope", "scopes", "codeChallengeMethod", "extraParams",
  "fixedPort", "callbackPath", "pollInterval", "webAppUrl", "apiBaseUrl", "appBaseUrl",
  "defaultBaseUrl", "authorizeUrlPath", "tokenUrlPath", "userAgent", "platform",
  "referrer", "validationUrl",
];

/**
 * Serving detail, for the relay server rather than the linking client.
 *
 * WHY AN ALLOWLIST AND NOT THE WHOLE BLOCK. Four registry entries — kimi, cline,
 * gemini-cli and antigravity — repeat `clientId`/`clientSecret`/`tokenUrl` INSIDE
 * their transport block, duplicating what already lives under `oauth`. Copying
 * transport wholesale would scatter the same client credentials across two
 * places in the generated output, so that rotating one and missing the other
 * leaves a stale copy that still looks authoritative. Listing what to take keeps
 * exactly one home for each value.
 *
 * `auth` is the descriptor the header builder reads (which header carries the
 * token, and under which scheme); `headers` is the client identity the provider
 * expects to see. Both are per-provider data precisely so the serving code can
 * stay a single code path that never learns a provider id.
 */
const TRANSPORT_FIELDS = [
  "baseUrl", "baseUrls", "format", "urlSuffix", "headers", "auth", "forceStream",
  "thinkingFormat", "chatPath", "responsesUrl", "messagesUrl", "quirks",
];

/**
 * Token-renewal parameters, read from the registry's `oauth` block.
 *
 * Only the renewal-specific fields: the endpoint and client id a refresh posts
 * to are already vendored by OAUTH_FIELDS, and repeating them here would
 * recreate exactly the two-homes-for-one-value problem TRANSPORT_FIELDS exists
 * to avoid.
 *
 *  - `refreshLeadMs` — how far ahead of expiry to renew.
 *  - `maxRefreshAgeMs` — a second, INDEPENDENT trigger. Codex invalidates a
 *    refresh token that has gone unused for eight days, so an account nobody
 *    happened to route traffic through dies quietly and can only be recovered by
 *    making the lender link it again. Renewing on age as well as on expiry is
 *    what prevents that, and it is why a served-on-demand relay needs a periodic
 *    sweep rather than only a refresh-before-use check.
 *  - `refresh.encoding` — whether the token endpoint wants form or JSON.
 */
const REFRESH_FIELDS = ["refreshLeadMs", "maxRefreshAgeMs", "trackRefreshAt", "refresh"];

/**
 * Authorize-endpoint parameters the upstream registry does not carry.
 *
 * The registry stores endpoints and scopes; a provider that also demands a
 * literal flag on the authorize URL expresses it in that provider's own client
 * code upstream, which we do not vendor. Anthropic's endpoint is one: without
 * `code=true` it refuses the request and renders "Missing client_id parameter",
 * which names the wrong parameter and sends whoever reads it hunting for a
 * client_id that was in the URL the whole time.
 *
 * Applied at generation time rather than in flows.js so the flow code keeps
 * branching on the family and never on a provider id, and so the requirement is
 * visible in the catalog a reader is actually looking at.
 *
 * `access_type=offline` and `prompt=consent` on the Google-backed providers are
 * the same kind of requirement, with a failure that is worse for being delayed:
 * omit them and Google issues an access token with NO refresh token, so linking
 * appears to succeed and the account stops serving an hour later with nothing to
 * renew it from. `prompt=consent` is what forces a refresh token to be re-issued
 * for an account that has already granted consent once.
 */
const EXTRA_AUTHORIZE_PARAMS = {
  claude: { code: "true" },
  antigravity: { access_type: "offline", prompt: "consent" },
  "gemini-cli": { access_type: "offline", prompt: "consent" },
  // Cline identifies the caller by client_type rather than by a client_id; it
  // has no registered client at all, which is why the standard block below is
  // replaced wholesale for it rather than extended.
  cline: { client_type: "extension" },
  clinepass: { client_type: "extension" },
};

/**
 * Authorize-query shapes for providers whose endpoint is not standard OAuth2.
 *
 * REPLACES the standard block (`response_type`, `client_id`, `redirect_uri`,
 * `state`, PKCE) for that provider; `extraParams` above is still appended. Values
 * are `@name` for a runtime value or `=literal` for a constant, so the shape stays
 * data — flows.js interprets it and never learns a provider id.
 *
 * Listing what to SEND rather than what to omit is deliberate. These endpoints
 * reject the request outright when handed a parameter they do not know — the
 * failure mode that cost a working Claude sign-in — so a parameter added to the
 * standard block later must not silently reach a provider nobody re-checked.
 */
const AUTH_SHAPES = {
  // iFlow names the callback `redirect`, wants no `response_type`, and runs no
  // PKCE. Sent the standard block it returns its generic login page instead of
  // the consent screen, so the flow hangs on a callback that never comes.
  iflow: { redirect: "@redirect", state: "@state", client_id: "@clientId" },
  // Cline's endpoint is not an authorization server: it hands the token back in
  // the `code` parameter. It takes the callback twice under two names, which is
  // what its own extension sends.
  cline: { callback_url: "@redirect", redirect_uri: "@redirect" },
  clinepass: { callback_url: "@redirect", redirect_uri: "@redirect" },
};

/**
 * How a provider's token endpoint differs from `POST` + form encoding.
 *
 *  - `encoding: "json"` — the endpoint wants a JSON body. Previously inferred in
 *    flows.js from an `anthropic.com` hostname match, which is a provider id
 *    written as a regex; as data it is visible in the catalog and testable.
 *  - `auth: "basic"` — client credentials go in an `Authorization: Basic` header.
 *    iFlow rejects them in the body alone.
 *  - `codeFormat: "base64json"` — there is nothing to exchange: the `code` is a
 *    base64 JSON blob already containing the tokens. Cline's own endpoint is the
 *    fallback for when that decode fails.
 *  - `sendState: true` — the token endpoint requires the `state` back in the
 *    exchange body, even when it also arrived as a callback query param. Claude's
 *    `/v1/oauth/token` rejects the exchange with 400 "Invalid request format"
 *    without it. Standard OAuth2 does not carry `state` into the token call, so
 *    this is off unless a provider asks for it — sending it everywhere would
 *    break the endpoints that reject unknown parameters.
 */
const TOKEN_STYLES = {
  claude: { encoding: "json", sendState: true },
  iflow: { auth: "basic" },
  cline: { encoding: "json", codeFormat: "base64json" },
  clinepass: { encoding: "json", codeFormat: "base64json" },
};

/**
 * Headers a device endpoint requires beyond content negotiation.
 *
 * Same `@runtime` / `=literal` vocabulary as AUTH_SHAPES. `@deviceId` is one
 * value generated per link attempt and reused across the initiate and every
 * poll — Kimi ties the pending authorization to it, so a fresh id per request
 * polls for an authorization that will never be granted.
 */
const DEVICE_HEADERS = {
  kimi: {
    "X-Msh-Platform": "=aile",
    "X-Msh-Version": "@appVersion",
    "X-Msh-Device-Name": "@hostname",
    "X-Msh-Device-Model": "@deviceModel",
    "X-Msh-Device-Id": "@deviceId",
  },
  // Tencent routes on these rather than on a client_id, and rejects the request
  // without them. `X-No-Authorization` is their way of saying "this is the call
  // that gets me a token, so do not expect one".
  "codebuddy-cn": {
    "X-Requested-With": "=XMLHttpRequest",
    "X-Domain": "=copilot.tencent.com",
    "X-No-Authorization": "=true",
    "X-No-User-Id": "=true",
    "X-Product": "=SaaS",
  },
};

/**
 * Device flows that are not RFC 8628.
 *
 * The default is the RFC: form-POST a device-code request, then form-POST the
 * token endpoint with `grant_type=device_code` until it stops saying pending.
 * Three providers reuse the *shape* (show the user something, poll for a token)
 * with entirely different wire calls, and the RFC request fails against them:
 * kilocode's endpoint is JSON with no client at all, codebuddy's is a two-step
 * with the state in the query string.
 *
 * `initiate` / `poll` describe those calls as data. `map` names where the
 * response keeps values the RFC would have put elsewhere.
 */
const DEVICE_STYLES = {
  kilocode: {
    initiate: { url: "@initiateUrl", method: "POST", encoding: "json", body: {} },
    // The code goes in the path, and HTTP status carries the pending/denied
    // state that the RFC puts in an `error` field.
    poll: { url: "@pollUrlBase/@deviceCode", method: "GET" },
    map: {
      deviceCode: "code", userCode: "code", verificationUri: "verificationUrl",
      expiresIn: "expiresIn",
    },
    pollStatus: { 202: "pending", 403: "denied", 410: "expired" },
    // Approval is a field in a 200 body, not the 200 itself.
    approvedWhen: { field: "status", equals: "approved" },
    tokenField: "token",
    emailField: "userEmail",
    intervalMs: 3000,
  },
  "codebuddy-cn": {
    initiate: {
      url: "@stateUrl?platform=@platform", method: "POST", encoding: "json", body: {},
    },
    poll: { url: "@tokenUrl?state=@deviceCode", method: "GET" },
    // Everything of interest is under `data`, and success/pending is an
    // application code in a 200 response rather than an HTTP status.
    envelope: "data",
    map: { deviceCode: "state", verificationUri: "authUrl" },
    codeField: "code",
    codePending: 11217,
    codeOk: 0,
    tokenField: "accessToken",
    refreshField: "refreshToken",
    expiresField: "expiresIn",
  },
};

/**
 * OAuth client credentials for the Google-backed providers.
 *
 * These are public installed-app clients — the "secret" is shipped in every copy
 * of the vendor's own CLI and is not a secret in the OAuth sense, which is why
 * PKCE exists. The registry keeps them outside the per-provider entries, so
 * vendoring the registry alone yields a catalog entry with no client_id and a
 * flow that refuses to start. Sourced from the checkout rather than pasted here
 * so a rotation upstream arrives with the next sync instead of silently rotting.
 */
const GOOGLE_CLIENT_SOURCE = "open-sse/providers/shared.js";
const GOOGLE_CLIENTS = {
  antigravity: "ANTIGRAVITY_OAUTH_CLIENT",
  "gemini-cli": "GOOGLE_OAUTH_CLIENT",
};

/**
 * Scopes we request beyond the upstream registry's — a DELIBERATE divergence,
 * and the only one in this file that changes what the provider is asked for.
 *
 * `openid` is what makes Google mint an id_token. The upstream project this
 * catalog derives from never verifies one, so it does not ask; we do — an
 * account the server cannot cryptographically tie to a real Google identity is
 * an unverified claim, and for the providers listed in the server's JWKS table
 * that is a link failure rather than a downgrade. Without this the browser flow
 * completes, the upload is rejected for a missing id_token, and the lender is
 * left with a consent they granted for nothing.
 *
 * Add an entry here ONLY together with a JWKS entry server-side; a scope that
 * nothing verifies is consent asked for no reason.
 */
const EXTRA_SCOPES = {
  antigravity: ["openid", "email"],
  "gemini-cli": ["openid", "email"],
};

/**
 * Serving headers the upstream registry builds in code rather than storing.
 *
 * Two providers identify their caller with headers assembled by a helper
 * function upstream, so vendoring `transport.headers` alone yields a request
 * missing them. Both helpers hardcode the upstream project's own product name,
 * which must not appear in anything this app sends — the same reason
 * DEVICE_HEADERS.kimi sends `=aile`. Restated here as data, debranded, using the
 * same `@runtime` / `=literal` vocabulary.
 *
 * `@appVersion`, `@hostname`, `@deviceModel` and `@platform` resolve on the
 * server that sends the request. `@deviceId` is the stable per-account id kept
 * with the credential: Kimi treats a changing device id as a new device, so
 * deriving one per request would present the account as a new machine on every
 * call.
 */
const SERVE_HEADERS = {
  kimi: {
    "X-Msh-Platform": "=aile",
    "X-Msh-Version": "@appVersion",
    "X-Msh-Device-Name": "@hostname",
    "X-Msh-Device-Model": "@deviceModel",
    "X-Msh-Device-Id": "@deviceId",
  },
  // Cline reads its client identity from these; the token itself is prefixed
  // `workos:` by `tokenPrefix` below, not here.
  cline: {
    "X-PLATFORM": "@platform",
    "X-PLATFORM-VERSION": "@platformVersion",
    "X-CLIENT-TYPE": "=aile",
    "X-CLIENT-VERSION": "@appVersion",
    "X-CORE-VERSION": "@appVersion",
    "X-IS-MULTIROOT": "=false",
  },
  // Per-ACCOUNT identity rather than per-client, which is why these are
  // templates with nothing constant in them. `@chatgptAccountId` comes out of
  // the id_token this server already verified at linking; a Codex request
  // without it is answered against whichever workspace the account defaults to,
  // so a lender who linked a team account silently serves from their personal
  // one. `@sessionId` is what Codex groups a conversation by — stable per
  // account, since a value that changed per request would present every call as
  // a new session.
  //
  // Both drop out when unresolved rather than sending the string "undefined":
  // an account linked before the claims were persisted keeps working, on the
  // default workspace, instead of failing outright.
  codex: {
    "ChatGPT-Account-ID": "@chatgptAccountId",
    "session_id": "@sessionId",
  },
  // Only present for a lender whose Kilo account belongs to an organization.
  kilocode: { "X-Kilocode-OrganizationID": "@orgId" },
};
SERVE_HEADERS.clinepass = SERVE_HEADERS.cline;

/**
 * Token transformations the serving request must apply.
 *
 * Cline's gateway expects its access token to carry a `workos:` scheme prefix,
 * which its own client adds at call time rather than storing. A token that
 * arrives without it is rejected as malformed, so this cannot be left to
 * whatever the token endpoint happened to return: the prefix is applied on send,
 * and applied idempotently, because the refresh response sometimes already has
 * it and doubling it fails the same way omitting it does.
 */
const TOKEN_PREFIXES = { cline: "workos:", clinepass: "workos:" };

/**
 * Guard against re-branding by accident.
 *
 * Everything above is written by hand, and the registry it reads from belongs to
 * a different project whose name appears in its own header values. A future sync
 * that picks up one more field must not silently carry that name into an app
 * that presents these providers as its own — so the emitted text is checked
 * rather than trusted, and the sync fails loudly instead of shipping it.
 *
 * ASSEMBLED RATHER THAN WRITTEN OUT, which looks like a cute trick and is not.
 * test/branding.test.js greps every shipped source for that name, and this file
 * is one of them. A literal here would make the guard's own definition the only
 * match in the tree — so either the test fails forever, or it grows a second
 * exemption and stops checking the file that holds SERVE_HEADERS, which is the
 * single most likely place for a branded header value to appear. Splitting the
 * string keeps this file honestly covered by the test that covers everything
 * else. Case-insensitive because the name has no canonical casing and an
 * alternation of the three spellings we happened to think of is not a guard.
 */
const FORBIDDEN_BRAND = new RegExp("9" + "router", "i");

/**
 * Whether a registry entry is one this app links.
 *
 * The upstream `category` is a taxonomy of how an account is BILLED — `oauth`, a
 * paid subscription; `free`, a no-charge tier — not of whether it can be linked
 * through an OAuth flow. Those usually coincide, but not always: a provider on a
 * free tier can still authenticate through a full authorization-code flow. Gating
 * purely on `category === "oauth"` therefore drops providers that are perfectly
 * linkable, and did: an entry wired here for linking (a Google client id, the
 * openid scope, an authorize-param set) was assembled and then discarded before
 * anything used it, because its category happened to read `free`.
 *
 * So the gate is the CAPABILITY, not the billing label: an entry is linkable if
 * its category is `oauth`, OR this file has explicitly declared how to link it —
 * today, by giving it a Google client under GOOGLE_CLIENTS. That declaration is a
 * deliberate act per provider (it also requires a server-side JWKS entry, see
 * EXTRA_SCOPES), so it cannot sweep in a provider nobody vetted. Entries with a
 * bespoke device/token flow that is not implemented here stay out precisely
 * because no such declaration exists for them.
 */
function isLinkable(entry) {
  return entry.category === "oauth" || Boolean(GOOGLE_CLIENTS[entry.id]);
}

const catalog = [];
for (const entry of registry) {
  if (!isLinkable(entry)) continue;
  const oauth = {};
  for (const f of OAUTH_FIELDS) {
    if (entry.oauth?.[f] !== undefined) oauth[f] = entry.oauth[f];
  }
  // Merged under the registry's own values, never over them: if upstream ever
  // starts carrying the parameter itself, its version is the one that survives.
  if (EXTRA_AUTHORIZE_PARAMS[entry.id]) {
    oauth.extraParams = { ...EXTRA_AUTHORIZE_PARAMS[entry.id], ...(oauth.extraParams || {}) };
  }

  // Same direction of precedence for the rest: a registry that starts carrying
  // any of these wins, so these tables shrink on their own rather than having
  // to be pruned by hand once upstream catches up.
  const clientExport = GOOGLE_CLIENTS[entry.id];
  if (clientExport) {
    const creds = shared[clientExport];
    if (!creds?.clientId) {
      console.error(
        `Missing ${clientExport} in ${GOOGLE_CLIENT_SOURCE} — ${entry.id} would be unconnectable.`,
      );
      process.exit(2);
    }
    oauth.clientId = oauth.clientId || creds.clientId;
    oauth.clientSecret = oauth.clientSecret || creds.clientSecret;
  }
  // Appended, and deduped, so the registry's own scopes are never displaced —
  // dropping one would silently reduce what the linked account can do.
  if (EXTRA_SCOPES[entry.id]) {
    const have = Array.isArray(oauth.scopes)
      ? oauth.scopes
      : String(oauth.scope || "").split(/\s+/).filter(Boolean);
    const merged = [...new Set([...EXTRA_SCOPES[entry.id], ...have])];
    if (Array.isArray(oauth.scopes) || !oauth.scope) oauth.scopes = merged;
    else oauth.scope = merged.join(" ");
  }
  if (AUTH_SHAPES[entry.id]) oauth.authShape = oauth.authShape || AUTH_SHAPES[entry.id];
  if (TOKEN_STYLES[entry.id]) oauth.tokenStyle = oauth.tokenStyle || TOKEN_STYLES[entry.id];
  if (DEVICE_HEADERS[entry.id]) oauth.deviceHeaders = oauth.deviceHeaders || DEVICE_HEADERS[entry.id];
  if (DEVICE_STYLES[entry.id]) oauth.deviceStyle = oauth.deviceStyle || DEVICE_STYLES[entry.id];

  // How to SERVE this account once linked, kept apart from `oauth` because the
  // two describe different conversations. Linking talks to an authorization
  // server; serving talks to an inference endpoint, and the same provider
  // presents a different client identity to each — codebuddy links as
  // `CLI/2.63.2` and serves as `CLI/2.108.1`. Merging them would make one of the
  // two silently wrong.
  const transport = {};
  for (const f of TRANSPORT_FIELDS) {
    if (entry.transport?.[f] !== undefined) transport[f] = entry.transport[f];
  }
  if (SERVE_HEADERS[entry.id]) {
    // Under the registry's own headers, matching every other table here: if
    // upstream starts carrying one of these, its value is the one that survives.
    transport.headers = { ...SERVE_HEADERS[entry.id], ...(transport.headers || {}) };
  }
  if (TOKEN_PREFIXES[entry.id] && !transport.tokenPrefix) {
    transport.tokenPrefix = TOKEN_PREFIXES[entry.id];
  }
  // `auth.hooks` names FUNCTIONS in the upstream project — a per-provider hook
  // table the serving code dispatches through. Vendoring the names would hand
  // this app a list of callbacks it does not have and must not grow, since a
  // hook table is exactly the per-provider branching the rest of this generator
  // exists to avoid. Every effect they had is already here as data: the client
  // identity in SERVE_HEADERS, the `workos:` scheme in TOKEN_PREFIXES. The one
  // that is not — Anthropic's overlay of headers observed from a running
  // first-party client — has no counterpart on a server with no such client,
  // and a name pointing at nothing is worse than its absence.
  if (transport.auth?.hooks) {
    const { hooks, ...rest } = transport.auth;
    transport.auth = rest;
  }

  const refresh = {};
  for (const f of REFRESH_FIELDS) {
    if (entry.oauth?.[f] !== undefined) refresh[f] = entry.oauth[f];
  }

  catalog.push({
    id: entry.id,
    name: entry.display?.name || entry.id,
    color: entry.display?.color || null,
    flow: flowFamily(entry),
    oauth,
    ...(Object.keys(transport).length ? { transport } : {}),
    ...(Object.keys(refresh).length ? { refresh } : {}),
    models: (entry.models || []).slice(0, 12).map((m) => m.id),
  });
}
catalog.sort((a, b) => a.id.localeCompare(b.id));

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

const hostsOut = `/**
 * Provider egress allowlist — GENERATED, do not hand-edit.
 *
 * Regenerate with:  bun run scripts/sync-providers.js /path/to/registry
 *
 * Baked in rather than fetched so this security control has no runtime
 * dependency: nothing outside this repo can widen the set of hosts a node will
 * dial. Local endpoints are filtered out at generation time.
 *
 * ${cleanHosts.length} hosts.
 */

export const PROVIDER_HOSTS = new Set([
${cleanHosts.map((h) => `  "${h}",`).join("\n")}
]);
`;

const catalogOut = `/**
 * Provider catalog — GENERATED, do not hand-edit.
 *
 * Regenerate with:  bun run scripts/sync-providers.js /path/to/registry
 *
 * \`flow\` is the linking strategy, and it is what src/providers/flows.js
 * branches on. Providers that share a family need no per-provider client code.
 *
 *   authcode  browser redirect to a loopback callback, PKCE where supported
 *   device    device-authorization: show a code, poll for the token
 *   google    Google OAuth with a client secret
 *   paste     no programmatic flow — the user supplies a token
 *
 * \`oauth\` is how an account is LINKED; \`transport\` and \`refresh\` are how it is
 * SERVED and RENEWED once linked. They are separate because the same provider
 * presents a different client identity to its authorization server than to its
 * inference endpoint, and collapsing them makes one of the two wrong.
 *
 * ${catalog.length} providers.
 */

export const PROVIDERS = ${JSON.stringify(catalog, null, 2)};

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}
`;

// Checked before anything is written: a sync that would ship the upstream
// project's name is a failed sync, not a file to clean up afterwards.
for (const [what, text] of [["catalog", catalogOut], ["allowlist", hostsOut]]) {
  const hit = FORBIDDEN_BRAND.exec(text);
  if (hit) {
    console.error(
      `Refusing to write: the generated ${what} contains "${hit[0]}".\n` +
      "A registry field now carries the upstream project's name. Debrand it in\n" +
      "SERVE_HEADERS (or drop the field from the allowlist) and re-run.",
    );
    process.exit(2);
  }
}

const srcDir = path.join(import.meta.dirname, "..", "src");
fs.writeFileSync(path.join(srcDir, "relay/provider-hosts.js"), hostsOut);
fs.mkdirSync(path.join(srcDir, "providers"), { recursive: true });
fs.writeFileSync(path.join(srcDir, "providers/catalog.js"), catalogOut);

console.log(`Wrote ${cleanHosts.length} hosts → src/relay/provider-hosts.js`);
console.log(`Wrote ${catalog.length} providers → src/providers/catalog.js`);
if (dropped.length) console.log(`Dropped ${dropped.length} local: ${dropped.join(", ")}`);
