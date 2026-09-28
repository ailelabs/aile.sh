/**
 * Linking a provider by pasting an API key.
 *
 * The OAuth flows in flows.js end with a token the provider just minted, so it
 * is valid by construction. A pasted key has no such guarantee — it can be
 * truncated by a copy, expired, revoked, or from the wrong account entirely — and
 * an invalid key uploaded anyway becomes advertised capacity that 401s on every
 * buyer request. The lender is told it worked, the buyer sees failures, and
 * neither can see the other's half.
 *
 * SO THE KEY IS VERIFIED BEFORE IT IS UPLOADED, against the provider itself,
 * from the lender's own machine. A typo fails here, in front of the person who
 * can fix it, in the second after they typed it.
 *
 * WHY THE KEY STILL GOES TO THE SERVER. It is the same custody model as every
 * other credential here, forced by the same thing: aile.sh terminates TLS with
 * the provider, so aile.sh is the party that must hold the key. It is not
 * written to this disk, and this module returns it to its caller for upload and
 * nothing else. See src/providers/link.js.
 *
 * WHAT THIS CANNOT DO is attest. No provider signs anything in a key exchange,
 * so a pasted key is recorded as an unverified claim and shown as `unverified`.
 * Validating it proves the key works — not whose account it bills, and not that
 * the lender owns it. Those are different claims and only the first is made.
 */

const VERIFY_TIMEOUT_MS = 15_000;

/** `accountId` → "account ID": an input's name the way a lender reads it. */
export function inputLabel(name) {
  return String(name).replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`).replace(/\bid$/, "ID");
}

/**
 * The values a provider needs besides the key (`apiKey.requiredInputs` — Cloudflare's
 * account id, which every one of its URLs carries), trimmed and stripped of trailing
 * slashes as the server does, and checked against `apiKey.inputPatterns`.
 *
 * Checked BEFORE anything is dialled, because the value is written into the verify
 * URL's path: an unchecked `..` would point the lender's own key at some other route
 * of the provider's API. The server checks again; this is the one that runs first.
 *
 * Null for a provider that needs none. Throws a sentence naming the input otherwise.
 */
export function linkInputs(provider, raw) {
  const names = provider?.apiKey?.requiredInputs || [];
  if (!names.length) return null;
  const out = {};
  for (const name of names) {
    const value = String(raw?.[name] ?? "").trim().replace(/\/+$/, "");
    if (!value) throw new Error(`${provider.name} needs your ${inputLabel(name)} as well as the key.`);
    const pattern = provider.apiKey.inputPatterns?.[name];
    if (pattern && !new RegExp(pattern).test(value)) {
      throw new Error(`That ${inputLabel(name)} is not valid for ${provider.name}.`);
    }
    out[name] = value;
  }
  return out;
}

/**
 * Ask the provider whether this key is real.
 *
 * Every failure mode gets a message that says what to do about it, because this
 * is the one moment the person who can fix a bad key is present and looking at
 * the terminal. `network` is deliberately NOT a rejection of the key: a lender
 * on a flaky connection must not be told their key is invalid.
 *
 * `inputs` fills the verify URL's `@name` placeholders (Cloudflare's account id).
 * One left unfilled is refused, never dialled as the literal text.
 */
export async function verifyApiKey(provider, key, { fetchImpl = fetch, timeoutMs = VERIFY_TIMEOUT_MS, inputs = null } = {}) {
  const cfg = provider.apiKey;
  if (!cfg?.verifyUrl) {
    return { ok: false, reason: "no-verify-url", message: `${provider.name} has no verification endpoint configured.` };
  }
  let unfilled = null;
  const filled = new Set();
  const verifyUrl = cfg.verifyUrl.replace(/@([A-Za-z][A-Za-z0-9_]*)/g, (_, name) => {
    if (inputs?.[name]) { filled.add(name); return encodeURIComponent(inputs[name]); }
    unfilled ??= name;
    return "";
  });
  if (unfilled) {
    return { ok: false, reason: "no-verify-url", message: `${provider.name} needs your ${inputLabel(unfilled)} to check the key.` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(verifyUrl, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: controller.signal,
    });
  } catch (e) {
    // Could not ask. Saying "invalid key" here would send a lender hunting for a
    // problem in the one thing that is probably fine.
    return {
      ok: false, reason: "network",
      message: e.name === "AbortError"
        ? `${provider.name} did not respond within ${Math.round(timeoutMs / 1000)}s — could not check the key.`
        : `Could not reach ${provider.name} to check the key: ${e.message}`,
    };
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    // A 403 on a URL carrying the lender's own values is as often those values as the
    // key: Cloudflare answers a valid token on a well-formed but wrong account id 403
    // (code 10000/9109), and "rejected that key" sends the lender to the wrong fix.
    const named = res.status === 403 && filled.size
      ? new Intl.ListFormat("en").format([...filled].map(inputLabel))
      : null;
    return {
      ok: false, reason: "rejected",
      message: (named
        ? `${provider.name} refused that key for that ${named}; check the ${named} and the key's permissions.`
        : `${provider.name} rejected that key.`) +
        (cfg.prefix && !key.startsWith(cfg.prefix)
          // Only ever offered after the provider has already said no. A prefix
          // check on its own would lock out every lender the day a provider
          // changes its key format.
          ? ` Keys usually start with "${cfg.prefix}" — check you copied the whole thing.`
          : ""),
    };
  }
  if (!res.ok) {
    return {
      ok: false, reason: "upstream",
      message: `${provider.name} answered ${res.status} when checking the key — try again shortly.`,
    };
  }

  const body = await res.json().catch(() => null);
  return { ok: true, name: readName(body, cfg.nameFrom), detail: null };
}

/** Pull the key's own name out of the verify response, when the provider says one. */
function readName(body, path) {
  if (!body || !Array.isArray(path)) return null;
  let node = body;
  for (const step of path) {
    if (!node || typeof node !== "object") return null;
    node = node[step];
  }
  return typeof node === "string" && node.trim() ? node.trim() : null;
}

/**
 * The apikey equivalent of flows.js's OAuth runners.
 *
 * Returns the same token shape those do, so link.js uploads it by the same path
 * with no branch: one credential type reaching the server one way. `idToken` is
 * absent rather than null-padded, because there is nothing to attest and a
 * present-but-empty field invites someone to try.
 */
export async function runApiKeyFlow(provider, { key, log = () => {}, fetchImpl = fetch, inputs = null } = {}) {
  const trimmed = String(key ?? "").trim();
  if (!trimmed) throw new Error("No key given.");
  const checked = linkInputs(provider, inputs);

  log(`Checking the key with ${provider.name}…`);
  const check = await verifyApiKey(provider, trimmed, { fetchImpl, inputs: checked });
  if (!check.ok) throw new Error(check.message);

  return {
    provider: provider.id,
    accessToken: trimmed,
    refreshToken: null,
    // An API key does not expire on a schedule the provider tells us about, so
    // claiming an expiry would make the server refresh something unrefreshable.
    expiresIn: null,
    // The key's own name at the provider, when it has one. Only ever a default
    // for the label — a display string, never identity.
    suggestedLabel: check.name || null,
    // The check above IS a probe — same question, same endpoint, same provider —
    // so it is reported rather than repeated. link.js would otherwise send a
    // second identical request to `verifyUrl` seconds later to learn what this
    // one already established.
    //
    // Reaching this line means `check.ok`, since a failure threw. So this is the
    // observed result, not an assumption about one.
    probed: { ok: true, reason: "ok" },
  };
}

export { VERIFY_TIMEOUT_MS };
