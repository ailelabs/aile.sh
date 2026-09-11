/**
 * Sign-in: device authorization, with a paste-a-token fallback.
 *
 * The happy path is the browser. The CLI never handles a password — it asks the
 * server for a code, sends the user to a browser, and polls until the renter
 * token appears.
 *
 * THE FALLBACK EXISTS BECAUSE THE BROWSER PATH FAILS FOR ORDINARY REASONS.
 * A headless VPS has nothing to open. SSH without X forwarding cannot reach a
 * display. A code times out because the user walked away. A corporate proxy eats
 * the callback. Before this, every one of those ended in `throw` and the user
 * was simply stuck with no way forward. Now they can approve on any device they
 * do have a browser on, copy the token, and paste it here.
 *
 * AND BOTH RUN AT ONCE. The fallback is not a consolation prize awarded after
 * the browser path has failed — it is offered from the first second, because
 * the user knows within two of them which one they need. Waiting out a poll
 * that cannot succeed (nothing opened; there is no display) before mentioning
 * the alternative is the failure mode this races away. See `raceLogin`.
 *
 * A pasted token is VERIFIED AGAINST THE SERVER BEFORE IT TOUCHES DISK. Saving
 * first and discovering later is the worst outcome: the user believes they are
 * signed in, and every subsequent command fails somewhere far away from the
 * mistake. `/me` is the authority on whether a token is real — this client only
 * screens out input that obviously is not a token at all, so that a typo gets a
 * useful message instead of a round trip.
 *
 * Sign-in also enrols the node, because the two are one user-visible step: after
 * `aile login` the machine is signed in AND able to relay.
 */

import os from "node:os";
import { api, ApiError, isSecureUrl } from "../api/client.js";
import { makeVerifier, challengeFor } from "./pkce.js";
import { saveConfig } from "../relay/config.js";
import { enrollNodeOrRotate } from "../relay/enroll.js";
import { defaultOpenBrowser } from "../providers/link.js";
import { isInteractive, promptSecret, copyToClipboard } from "../cli/prompt.js";
import { C } from "../cli/colors.js";

/** Carries a machine-readable `reason` so callers can react without matching prose. */
export class LoginError extends Error {
  constructor(message, reason = "failed", { hint = null } = {}) {
    super(message);
    this.name = "LoginError";
    this.reason = reason;
    this.hint = hint;
  }
}

const MAX_PASTE_ATTEMPTS = 3;

/**
 * What this machine calls itself, for the approval page to show.
 *
 * A CONVENIENCE FOR THE HUMAN, NEVER AN IDENTITY. The person approving is being
 * asked "did you just start this?", and "yes, from the box called build-01" is a
 * far easier question than "yes, from code MTQP-7RXB". The server stores it as a
 * claim and the page renders it as one — nothing anywhere treats it as a fact, and
 * it must never become one, because any client can send anything here.
 *
 * A hostname can carry an employer, a project, or a person's name, so this is the
 * one piece of local detail the CLI volunteers. `AILE_NO_MACHINE_LABEL=1` withholds
 * it; the flow works identically without it.
 */
function machineLabel() {
  if (process.env.AILE_NO_MACHINE_LABEL === "1") return null;
  try {
    const name = String(os.hostname() || "").trim();
    return name ? name.slice(0, 64) : null;
  } catch {
    return null;
  }
}

/**
 * Tidy what a human actually pastes.
 *
 * Terminals wrap, password managers add whitespace, and people copy the word
 * `Bearer` along with the value or paste it inside quotes. All of that is a
 * correct token with noise around it, and rejecting it teaches nothing.
 */
export function normalizeToken(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/^["'`]|["'`]$/g, "")
    .replace(/^Bearer\s+/i, "")
    .replace(/\s+/g, "")
    .trim();
}

/**
 * Reject only what cannot be a token, and say what was pasted instead.
 * Anything plausible goes to the server, which is the real authority.
 */
export function screenToken(token) {
  if (!token) return "Nothing was pasted.";
  if (/^https?:\/\//i.test(token)) {
    return "That is a URL. Paste the token from the page, not the address bar.";
  }
  if (/^[A-Z2-9]{4}-[A-Z2-9]{4}$/i.test(token)) {
    return "That is the device code, not the token. Approve the code first, then copy the token it shows you.";
  }
  if (token.length < 20) return "That looks too short to be a token.";
  if (token.length > 512) return "That looks too long to be a token.";
  return null;
}

/**
 * Verify a token, then save it and enrol this machine.
 *
 * Nothing is written until `/me` accepts the token. The two failure modes are
 * deliberately distinguished: a token the server *rejected* is the user's to
 * fix, whereas a server we could not *reach* says nothing about the token and
 * must not be reported as if it did.
 */
export async function applyToken({
  token, serverUrl, insecure = false, enrol = true, log = console.log,
}) {
  const clean = normalizeToken(token);
  const bad = screenToken(clean);
  if (bad) throw new LoginError(bad, "malformed");

  let me;
  log("  Checking that token…");
  try {
    me = await api.me({ serverUrl, token: clean, insecure });
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
      throw new LoginError(
        "The server rejected that token.",
        "rejected",
        { hint: "Check you copied the whole value, and that it came from this server." },
      );
    }
    throw new LoginError(
      `Could not reach ${serverUrl} to check that token: ${e.message}`,
      "unreachable",
      { hint: "Nothing was saved. Fix the connection and run `aile login --paste` again." },
    );
  }

  saveConfig({ serverUrl, renterToken: clean });

  if (enrol) {
    try {
      await enrollNodeOrRotate({ serverUrl, renterToken: clean, log });
    } catch (e) {
      return { ok: true, renter: me.renter, enrolled: false, enrolError: e.message, via: "token" };
    }
  }
  return { ok: true, renter: me.renter, enrolled: enrol, via: "token" };
}

/**
 * The browser flow on its own. Throws `LoginError` with a `reason` the caller
 * can act on; `signIn` is what turns those into the paste fallback.
 *
 * `signal` lets the caller stop the poll when the user finished another way —
 * without it, a paste that succeeds leaves this loop polling a device code
 * nobody will approve until it expires minutes later.
 */
export async function deviceLogin({
  serverUrl,
  insecure = false,
  log = console.log,
  openBrowser = defaultOpenBrowser,
  enrol = true,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  signal = null,
  onStart = null,
} = {}) {
  // Minted here and never leaving this function's scope: the verifier is what
  // proves the collection is being made by the process that asked. See pkce.js.
  const verifier = makeVerifier();

  let start;
  try {
    start = await api.startDeviceLogin({
      serverUrl, insecure,
      codeChallenge: challengeFor(verifier),
      clientLabel: machineLabel(),
    });
  } catch (e) {
    throw new LoginError(`Could not start sign-in: ${e.message}`, "unreachable");
  }

  // THE SERVER'S ANSWER IS A CONTRACT, AND A BROKEN ONE USED TO REACH THE SCREEN.
  // When something other than the relay answered, `start` was an empty object and
  // the line below resolved to `undefined` — which was then printed to the user as
  // the address to visit, and handed to the browser opener. Check the shape here so
  // the failure names the server instead of looking like a broken browser.
  const missing = ["deviceCode", "userCode", "verificationUri"]
    .filter((k) => typeof start?.[k] !== "string" || !start[k]);
  if (missing.length) {
    throw new LoginError(
      `${serverUrl} did not return a usable sign-in (missing: ${missing.join(", ")}).`,
      "bad-response",
      { hint: "That server may not be an aile relay, or may sit behind an access proxy." },
    );
  }

  const url = start.verificationUriComplete || start.verificationUri;
  if (!isSecureUrl(url)) {
    throw new LoginError(
      `${serverUrl} returned a sign-in address this client will not open (${url}).`,
      "bad-response",
      { hint: "A sign-in page must be https, or on this machine." },
    );
  }
  if (onStart) await onStart({ ...start, url });
  else {
    log(`\n  Visit:  ${start.verificationUri}`);
    log(`  Code:   ${start.userCode}\n`);
  }

  // Opening the browser must never be what fails the sign-in. On a headless box
  // this throws or silently does nothing, and the printed URL is still good.
  try {
    await openBrowser(url);
  } catch { /* no browser here; the URL above is the fallback */ }

  if (!onStart) log("Waiting for you to approve in the browser…");

  const deadline = now() + (start.expiresIn || 600) * 1000;
  let interval = (start.interval || 5) * 1000;

  while (now() < deadline) {
    if (signal?.aborted) throw new LoginError("Sign-in completed another way.", "superseded");
    await sleep(interval);
    if (signal?.aborted) throw new LoginError("Sign-in completed another way.", "superseded");

    const res = await api.pollDeviceLogin({ deviceCode: start.deviceCode, codeVerifier: verifier, serverUrl, insecure });

    if (res.status === "approved") {
      saveConfig({ serverUrl, renterToken: res.token });

      if (enrol) {
        // Enrolment is what makes the later handshake verifiable; without it
        // `aile start` would connect and be rejected as an unregistered node.
        try {
          await enrollNodeOrRotate({ serverUrl, renterToken: res.token, log });
        } catch (e) {
          return { ok: true, renter: res.renter, enrolled: false, enrolError: e.message, via: "browser" };
        }
      }
      return { ok: true, renter: res.renter, enrolled: enrol, via: "browser" };
    }

    if (res.status === "slow_down") { interval += 2000; continue; }
    if (res.status === "pending") continue;
    if (res.status === "denied") throw new LoginError("Sign-in was denied in the browser.", "denied");
    if (res.status === "expired") throw new LoginError("The code expired.", "expired");
    if (res.status === "invalid") throw new LoginError("The server does not recognise this sign-in.", "invalid");
    if (res.status === "unbound") {
      throw new LoginError(
        "The server did not accept this client's proof of the sign-in it started.",
        "unbound",
        { hint: "Update with `aile update`, then run `aile login` again." },
      );
    }

    // ANYTHING ELSE IS TERMINAL, NOT A REASON TO KEEP WAITING. This used to fall
    // through and re-loop, so an unrecognised state — or, once, no state at all —
    // spent the full ten minutes looking like a user who had not clicked yet.
    throw new LoginError(
      `The server answered with a sign-in state this version does not understand (${res.status}).`,
      "unknown-status",
      { hint: "Update with `aile update`, or finish by pasting a token." },
    );
  }

  throw new LoginError("Sign-in timed out.", "timeout");
}

/** What to tell the user, per way the browser flow can fail. */
const WHY = {
  denied: "You (or someone) declined the request in the browser.",
  expired: "The code is only good for a few minutes and that window has passed.",
  invalid: "The server no longer has a record of this sign-in.",
  timeout: "No approval arrived in time.",
  unreachable: "The server could not be reached to start the browser flow.",
  "bad-response": "The server answered, but not with a sign-in this client can use.",
  "unknown-status": "The server reported a state this version does not know about.",
  unbound: "This client could not prove it was the one that started the sign-in.",
  superseded: "Sign-in finished the other way.",
  failed: "The browser sign-in did not complete.",
};

/**
 * Sign in: the browser and the paste prompt run AT THE SAME TIME.
 *
 * They used to be sequential — poll the device code to completion, and only on
 * failure offer the paste. That is the wrong shape, because the user already
 * knows which one they are going to use within about two seconds of the URL
 * appearing, and the sequential version made them wait out a doomed poll to say
 * so. Worse, on a headless box the browser "succeeds" (nothing errors, nothing
 * opens) and the poll runs the full ten minutes before offering the way out.
 *
 * So both are live. Approve in the browser and the prompt disappears on its own;
 * paste a token and the poll stops. Whichever completes first wins and the other
 * is aborted — including the poll, so the server is not left tracking a device
 * code nobody will approve.
 *
 * `mode` forces one path: `paste` skips the browser entirely (right on a box
 * where opening one is pointless), `browser` skips the prompt.
 */
export async function signIn({
  serverUrl,
  insecure = false,
  token = null,
  mode = "auto",                 // auto | browser | paste
  log = console.log,
  openBrowser = defaultOpenBrowser,
  enrol = true,
  interactive = isInteractive(),
  readSecret = promptSecret,
  copy = copyToClipboard,
  now,
  sleep,
} = {}) {
  // An explicit token skips both flows. Scripted installs live here.
  if (token) return applyToken({ token, serverUrl, insecure, enrol, log });

  // Without a terminal there is nothing to race: no prompt can be shown, so the
  // browser flow is the only candidate and its failure is the whole story.
  if (mode === "browser" || (!interactive && mode !== "paste")) {
    try {
      return await deviceLogin({ serverUrl, insecure, log, openBrowser, enrol, now, sleep });
    } catch (e) {
      if (mode === "browser") throw e;
      const reason = e instanceof LoginError ? e.reason : "failed";
      log(`\n  ${e.message}`);
      log(`  ${WHY[reason] || WHY.failed}`);
      throw new LoginError(
        e.message,
        reason,
        { hint: "No terminal to prompt on. Approve in a browser, then run: aile login --token <token>" },
      );
    }
  }

  if (!interactive) {
    throw new LoginError(
      "Cannot prompt for a token — stdin is not a terminal.",
      "no-tty",
      { hint: "Pass it directly: aile login --token <token>" },
    );
  }

  if (mode === "paste") {
    log(`\n  1. Open this on any device:  ${String(serverUrl).replace(/\/+$/, "")}/login`);
    log(`  2. Approve, then choose "Show token instead".`);
    log(`  3. Paste it below. Input is hidden.\n`);
    return pasteLoop({ serverUrl, insecure, enrol, log, readSecret });
  }

  return raceLogin({ serverUrl, insecure, enrol, log, openBrowser, readSecret, copy, now, sleep });
}

/**
 * Run the browser flow and the paste prompt concurrently; first one home wins.
 *
 * The bookkeeping that matters:
 *
 *  - A rejected paste must NOT kill the browser flow. Someone who mistypes a
 *    token then approves in the browser has done nothing wrong, and the poll is
 *    still their fastest way in — so the prompt re-arms and the poll keeps going.
 *  - The browser flow failing must NOT kill the prompt, for the same reason in
 *    reverse. Its failure is reported inline and the prompt stays up.
 *  - The prompt must not appear ABOVE the instructions. Concurrent means both
 *    are live, not that they print in whatever order the event loop happens to
 *    produce — a bare "Paste code here >" with the URL scrolling in below it
 *    reads as a broken screen. The prompt waits for `onStart`.
 *  - Only when BOTH are exhausted is this a failed sign-in, and the error
 *    reported is the browser's, since that is the path the user was told to
 *    expect.
 */
async function raceLogin({
  serverUrl, insecure, enrol, log, openBrowser, readSecret, copy, now, sleep,
}) {
  const stop = new AbortController();
  let browserErr = null;
  let pasteErr = null;

  // The prompt must not appear until the URL and code are on screen. Both
  // halves start together, and the prompt writes its question synchronously
  // while the browser half is still waiting on a network round trip — so
  // without this the user's first sight is a bare "Paste code here >" with the
  // instructions scrolling in underneath it. Resolved by `onStart`, which fires
  // exactly when the instructions have been printed, and on failure too, so a
  // server that never answers cannot strand the prompt behind it.
  let released;
  const instructionsShown = new Promise((r) => { released = r; });

  const browser = deviceLogin({
    serverUrl, insecure, enrol, log, openBrowser, now, sleep,
    signal: stop.signal,
    onStart: async ({ url, userCode }) => {
      log(`\n  Opening your browser to sign in.`);
      log(`\n  ${C_DIM}Browser didn't open? Use the url below to sign in (c to copy)${C_RESET}`);
      log(`  ${url}\n`);
      if (userCode) log(`  ${C_DIM}Confirm this code matches:${C_RESET} ${userCode}\n`);
      released();
    },
  }).catch((e) => {
    released();
    browserErr = e;
    // Say so, and say the prompt is still good. Silence here leaves someone
    // whose code expired waiting on a browser path that is already dead, with
    // a prompt in front of them they have no reason to think still works.
    // `superseded` is the one case to stay quiet about: it means the paste won,
    // and announcing the poll's cancellation as a failure would be alarming and
    // wrong.
    if (e?.reason !== "superseded") {
      log(`\n  ${e.message} ${WHY[e?.reason] || ""}`.trimEnd());
      log(`  ${C_DIM}You can still finish by pasting a token below.${C_RESET}\n`);
    }
    return null;
  });

  // The prompt loop. Re-arms after a bad paste; ends when the browser wins.
  const paste = (async () => {
    await instructionsShown;
    if (stop.signal.aborted) return null;   // browser won during the round trip

    let last = null;
    for (let attempt = 1; attempt <= MAX_PASTE_ATTEMPTS; attempt++) {
      const entered = await readSecret("  Paste code here if prompted > ", {
        signal: stop.signal,
        hotkeys: {
          c: async () => {
            const ok = await copy(pasteUrl(serverUrl));
            log(ok ? `  ${C_DIM}URL copied to clipboard.${C_RESET}` : `  ${C_DIM}Could not copy — select the URL above.${C_RESET}`);
          },
        },
      });

      // null means the browser won and the prompt was cancelled — not an answer.
      if (entered === null) return null;
      if (!entered) {
        last = new LoginError("Sign-in cancelled.", "cancelled");
        return null;
      }

      try {
        return await applyToken({ token: entered, serverUrl, insecure, enrol, log });
      } catch (e) {
        last = e;
        // Retrying cannot fix an unreachable server, and the browser flow is
        // hitting the same server, so there is nothing left to wait for.
        if (e.reason === "unreachable") { pasteErr = e; return null; }
        const left = MAX_PASTE_ATTEMPTS - attempt;
        log(`  ${e.message}${e.hint ? ` ${e.hint}` : ""}`);
        if (left > 0) log(`  ${left} attempt${left === 1 ? "" : "s"} left — or finish in the browser.\n`);
      }
    }
    pasteErr = last;
    return null;
  })();

  const winner = await firstSuccess([browser, paste]);
  stop.abort();
  // Let the loser unwind — it restores raw mode and releases stdin, and skipping
  // that leaves the user's terminal in a state they cannot connect to us.
  await Promise.allSettled([browser, paste]);

  if (winner) return winner;

  if (pasteErr?.reason === "unreachable") throw pasteErr;
  if (browserErr) {
    const reason = browserErr instanceof LoginError ? browserErr.reason : "failed";
    throw new LoginError(
      browserErr.message,
      reason,
      { hint: WHY[reason] ? `${WHY[reason]} Run \`aile login --paste\` to sign in without a browser.` : null },
    );
  }
  throw pasteErr || new LoginError("Sign-in did not complete.", "failed");
}

/** Resolve with the first truthy result; null only if every promise yields none. */
function firstSuccess(promises) {
  return new Promise((resolve) => {
    let outstanding = promises.length;
    for (const p of promises) {
      p.then((v) => {
        if (v) return resolve(v);
        if (--outstanding === 0) resolve(null);
      }, () => {
        if (--outstanding === 0) resolve(null);
      });
    }
  });
}

const pasteUrl = (serverUrl) => `${String(serverUrl).replace(/\/+$/, "")}/login`;

// Aliases kept because this file interpolates them densely and `C.dim` reads
// worse inside the long template strings above. The values come from the shared
// table, so they go empty when stdout is not a terminal.
const C_DIM = C.dim;
const C_RESET = C.reset;

/**
 * Prompt until a token verifies or the attempts run out.
 *
 * A rejected token is worth re-prompting for — a truncated paste is the single
 * most likely cause and retrying costs the user nothing. An unreachable server
 * is not: retrying cannot fix it, and pretending otherwise wastes their time.
 */
async function pasteLoop({ serverUrl, insecure, enrol, log, readSecret }) {
  let last = null;
  for (let attempt = 1; attempt <= MAX_PASTE_ATTEMPTS; attempt++) {
    const entered = await readSecret("  Token: ");
    if (!entered) {
      log("  Nothing entered — sign-in cancelled.\n");
      throw new LoginError("Sign-in cancelled.", "cancelled");
    }

    try {
      const result = await applyToken({ token: entered, serverUrl, insecure, enrol, log });
      return result;
    } catch (e) {
      last = e;
      if (e.reason === "unreachable") throw e;
      const left = MAX_PASTE_ATTEMPTS - attempt;
      log(`  ${e.message}${e.hint ? ` ${e.hint}` : ""}`);
      if (left > 0) log(`  ${left} attempt${left === 1 ? "" : "s"} left.\n`);
    }
  }

  throw new LoginError(
    last?.message || "That token was not accepted.",
    last?.reason || "rejected",
    { hint: "Approve again at /login to get a fresh token — approving rotates it." },
  );
}
