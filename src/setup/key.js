/**
 * Getting a buyer API key (`sk-aile-…`) onto this machine with as little asking
 * as possible.
 *
 * In order, the first that applies wins:
 *
 *   1. `--key <key>`, or `--key -` to read it from stdin (scripts, CI).
 *   2. The key a previous `aile setup` saved here, if it still works.
 *   3. This machine is signed in (`aile login`): mint one on that account.
 *      No browser, no question — the account token already proves who it is.
 *   4. The browser: the same approve-a-code flow as `aile login`, but asking for
 *      a KEY. The account is not signed in here and its token is not rotated,
 *      so a lender's running nodes are never logged out by a buyer's setup.
 *      While it waits, an existing key can be pasted instead.
 *
 * The account token itself is never used as a key: `/v1` refuses it, and it
 * is a lender credential that has no business in a coding tool's config.
 */

import { api, ApiError } from "../api/client.js";
import { makeVerifier, challengeFor } from "../auth/pkce.js";
import { machineLabel } from "../auth/login.js";
import { defaultOpenBrowser } from "../providers/link.js";
import { isInteractive, promptSecret, copyToClipboard } from "../cli/prompt.js";
import { saveConfig } from "../relay/config.js";
import { loadManifest } from "./manifest.js";
import { C } from "../cli/colors.js";

export const KEY_RE = /^sk-aile-[0-9a-f]{48}$/;

export class KeyError extends Error {
  constructor(message, reason = "failed", hint = null) {
    super(message);
    this.name = "KeyError";
    this.reason = reason;
    this.hint = hint;
  }
}

/** Tidy a pasted key the way `normalizeToken` tidies a token. */
export function cleanKey(raw) {
  return String(raw ?? "").trim().replace(/^["'`]|["'`]$/g, "").replace(/^Bearer\s+/i, "").replace(/\s+/g, "");
}

export function describeKey(key) {
  return `${key.slice(0, 12)}…${key.slice(-4)}`;
}

/**
 * Ask the server whether a key works. `402` is a working key at its credit
 * limit: it is kept, and the caller says so. Unreachable is not a verdict.
 */
export async function checkKey({ key, serverUrl, insecure }) {
  try {
    const v = await api.validateKey({ key, serverUrl, insecure });
    if (v.ok) return { ok: true, limited: false };
    if (v.status === 402) return { ok: true, limited: true, reason: v.reason };
    return { ok: false, reason: v.reason || `refused (${v.status})` };
  } catch (e) {
    return { ok: true, unverified: true, reason: e.message };
  }
}

async function readStdinLine() {
  let buf = "";
  for await (const chunk of process.stdin) {
    buf += chunk;
    if (/\n/.test(buf)) break;
  }
  return buf.split(/\r?\n/)[0];
}

/**
 * The browser key grant. Resolves the key, or throws a KeyError.
 * `onPaste` is raced against the poll, like `aile login`'s paste prompt.
 */
export async function browserKey({
  serverUrl, insecure = false, keyName, log = console.log,
  openBrowser = defaultOpenBrowser, interactive = isInteractive(),
  readSecret = promptSecret, copy = copyToClipboard,
  now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const verifier = makeVerifier();
  let start;
  try {
    start = await api.startDeviceLogin({
      serverUrl, insecure, codeChallenge: challengeFor(verifier), clientLabel: machineLabel(),
      purpose: "key", keyName,
    });
  } catch (e) {
    throw new KeyError(`Could not start the browser step: ${e.message}`, "unreachable");
  }
  // A relay too old to know `purpose` would approve a LOGIN — rotating the
  // account token under every running node. Stop before anyone clicks.
  if (start?.purpose !== "key") {
    throw new KeyError("This server cannot issue a key from the browser yet.", "unsupported");
  }
  const url = start.verificationUriComplete || start.verificationUri;
  log(`\n  Approve the key in your browser${start.userCode ? ` (code ${C.bold}${start.userCode}${C.reset})` : ""}:`);
  log(`  ${C.cyan}${url}${C.reset}`);
  log(`  ${C.dim}Nothing opened? Copy the link above${interactive ? " (c copies it)" : ""}. This machine will not be signed in to your account.${C.reset}\n`);
  try { await openBrowser(url); } catch { /* the printed URL is the fallback */ }

  const stop = new AbortController();
  const poll = (async () => {
    const deadline = now() + (start.expiresIn || 600) * 1000;
    let interval = (start.interval || 5) * 1000;
    while (now() < deadline) {
      await sleep(interval);
      if (stop.signal.aborted) return null;
      const res = await api.pollDeviceLogin({ deviceCode: start.deviceCode, codeVerifier: verifier, serverUrl, insecure });
      if (res.status === "approved") {
        if (res.key?.secret) return { key: res.key.secret, id: res.key.id ?? null, account: res.renter ?? null };
        throw new KeyError("The server approved a sign-in instead of a key.", "unsupported");
      }
      if (res.status === "slow_down") { interval += 2000; continue; }
      if (res.status === "pending") continue;
      if (res.status === "denied") throw new KeyError("The key was declined in the browser.", "denied");
      if (res.status === "expired") throw new KeyError("The code expired before it was approved.", "expired");
      throw new KeyError(`The browser step ended (${res.status}).`, res.status || "failed", "Run `aile setup` again.");
    }
    throw new KeyError("No approval arrived in time.", "timeout", "Run `aile setup` again.");
  })();

  const paste = interactive ? (async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const got = await readSecret("  Or paste an existing key (sk-aile-…) > ", {
        signal: stop.signal,
        hotkeys: { c: async () => { await copy(url); } },
      });
      if (got === null || got === "") return null;
      const k = cleanKey(got);
      if (!KEY_RE.test(k)) { log("  That is not an aile key — it starts with sk-aile-."); continue; }
      const v = await checkKey({ key: k, serverUrl, insecure });
      if (v.ok) return { key: k, id: null, account: null };
      log(`  ${v.reason}`);
    }
    return null;
  })() : Promise.resolve(null);

  const first = await Promise.race([
    poll.then((k) => ({ k }), (e) => ({ e })),
    paste.then((k) => (k ? { k } : new Promise(() => {}))),
  ]);
  stop.abort();
  await Promise.allSettled([paste]);
  if (first.e) throw first.e;
  return first.k;   // {key, id, account}
}

/** The account a signed-in machine belongs to: `{id, email}`, or null. */
export async function currentAccount({ token, serverUrl, insecure }) {
  if (!token) return null;
  try {
    const me = await api.me({ serverUrl, insecure, token });
    return me?.renter?.id ? { id: me.renter.id, email: me.renter.email ?? null } : null;
  } catch {
    return null;
  }
}

/**
 * The whole decision. Resolves `{key, source, check, id, account}` — `id` and
 * `account` (`{id, email}`) when known, so a later sign-in to a DIFFERENT
 * account can tell the tools are still billing the old one. Saves a new key to
 * config so `aile run`, `aile env` and the next `aile setup` reuse it.
 */
export async function obtainKey({ args, config, serverUrl, insecure, log = console.log, interactive = isInteractive() }) {
  // 1. Given explicitly.
  if (args.key) {
    const raw = args.key === "-" ? await readStdinLine() : String(args.key);
    const k = cleanKey(raw);
    if (!KEY_RE.test(k)) throw new KeyError("That is not an aile API key — it starts with sk-aile- and has 48 hex characters.", "malformed");
    const v = await checkKey({ key: k, serverUrl, insecure });
    if (!v.ok) throw new KeyError(`The server refused that key: ${v.reason}`, "rejected");
    saveConfig({ buyerKey: k });
    return { key: k, source: "given", check: v, id: null, account: null };
  }

  // Which account this machine is signed in to, when it is. A saved key minted
  // on ANOTHER account is not reused: after `aile login` as somebody else, the
  // tools would otherwise go on billing the previous account without a word.
  const signedIn = await currentAccount({ token: config.renterToken, serverUrl, insecure });
  const recorded = loadManifest().key;

  // 2. Saved by an earlier run, unless a fresh one was asked for.
  const otherAccount = signedIn && recorded?.account?.id && recorded.account.id !== signedIn.id
    && recorded.prefix === describeKey(config.buyerKey || "");
  if (otherAccount) {
    log(`  ${C.dim}The saved key belongs to ${recorded.account.email || "another account"}; making one on ${signedIn.email || "this account"}.${C.reset}`);
  }
  if (config.buyerKey && !args["new-key"] && !otherAccount) {
    const v = await checkKey({ key: config.buyerKey, serverUrl, insecure });
    const same = recorded?.prefix === describeKey(config.buyerKey);
    if (v.ok) return { key: config.buyerKey, source: "saved", check: v, id: same ? recorded.id : null, account: same ? recorded.account : null };
    log(`  ${C.dim}The saved key no longer works (${v.reason}); getting a new one.${C.reset}`);
  }

  const keyName = `aile setup · ${machineLabel() || "this machine"}`.slice(0, 64);

  // 3. Signed in: mint on the account, no browser.
  if (config.renterToken) {
    try {
      const made = await api.createKey({ serverUrl, insecure, token: config.renterToken, name: keyName });
      if (made?.secret) {
        saveConfig({ buyerKey: made.secret });
        return { key: made.secret, source: "account", check: { ok: true }, id: made.key?.id ?? null, account: signedIn };
      }
    } catch (e) {
      // A dead account token is not fatal here: the browser can still grant a key.
      if (!(e instanceof ApiError) || (e.status !== 401 && e.status !== 403)) {
        throw new KeyError(`Could not create a key: ${e.message}`, "unreachable");
      }
    }
  }

  // 4. The browser.
  const got = await browserKey({ serverUrl, insecure, keyName, log, interactive });
  saveConfig({ buyerKey: got.key });
  return { key: got.key, source: got.id ? "browser" : "given", check: { ok: true }, id: got.id, account: got.account };
}
