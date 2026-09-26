#!/usr/bin/env node
/**
 * aile.sh CLI.
 *
 *   aile                       sign in (first run), else status
 *   aile setup                 use aile from Claude Code, Codex, opencode, …
 *   aile run <tool>            start one of them through aile
 *   aile login                 sign in and register this machine
 *   aile connect [provider]    link a provider account
 *   aile accounts              list linked accounts
 *   aile capacity              everything this machine lends, by kind
 *   aile label <n> <name>      name one, to tell two of a provider apart
 *   aile disconnect [n]        remove a linked account
 *   aile start                 run the node
 *   aile status                show this machine's state
 *   aile config                read and change settings
 *   aile logout                sign out
 *
 * Bare `aile` branches on whether this machine has a token: signed in, it shows
 * status; not signed in, it runs the first-run sign-in (see cli/welcome.js).
 * Nothing else is gated — every other command keeps its own "Not signed in"
 * guard, so a script never meets the interactive path.
 */

import { loadConfig, saveConfig, updateSettings, isLinked, storedOverrides, CONFIG_FILE } from "../relay/config.js";
import { resolveLocalTarget, discoverLocalModels, buildLocalCapability, localStatus } from "../relay/local.js";
import { configCommand } from "./config-command.js";
import { mcpCommand } from "./mcp-command.js";
import { setupCommand, runCommand, envCommand, doctorCommand, detectCommand, setupRemove, setupRefresh, toolsSetUp, isInstalled } from "./setup-command.js";
import { loadManifest } from "../setup/manifest.js";
import { makeCtx, webOrigin } from "../setup/ctx.js";
import { TOOLS, getTool, printsOnly } from "../setup/tools.js";
import { describeKey } from "../setup/key.js";
import { SCHEMA } from "../config/settings.js";
import { sym, heading, next, kv, withSpinner, width, padTo, die as uiDie } from "./ui.js";
import { overview, commandHelp, findCommand, unknownCommand } from "./help.js";
import { mcpStatus, buildMcpCapability } from "../mcp/capabilities.js";
import { getNodeId, getNodeInfo } from "../relay/identity.js";
import { startRelayAgent, stopRelayAgent, getRelayStatus, seedLocalState } from "../relay/supervisor.js";
import { clearState } from "../relay/state.js";
import { acquireLock, releaseLock, lockHolder } from "../relay/lock.js";
import { enrollNodeOrRotate, enrollDonor } from "../relay/enroll.js";
import { signIn, LoginError } from "../auth/login.js";
import { connectProvider } from "../providers/link.js";
import { PROVIDERS, getProvider, isApiKeyProvider } from "../providers/index.js";
import { isLinkable, needsApiKey } from "../providers/flows.js";
import { api, ApiError, isSecureUrl } from "../api/client.js";
import { welcome, welcomeNonInteractive } from "./welcome.js";
import { isInteractive, promptChoice, promptLine, promptSecret, promptConfirm } from "./prompt.js";
import { C } from "./colors.js";
import { APP_VERSION } from "../config/version.js";
import { printUpdateNotice, refreshCache, runSelfUpdate, isNewer, REFRESH_ARGV } from "../config/update-check.js";

// Flags that never take a value. Without this list, `aile config --reset logLevel`
// reads "logLevel" as the flag's value instead of as the key to reset.
const BOOLEAN_FLAGS = new Set([
  "insecure", "reset", "path", "help", "json", "paste", "browser", "off", "yes",
  // `aile lenders --verified` is a filter that takes no value. Without it here,
  // `aile lenders --verified --model x` reads "--model" as the value of
  // `--verified` and the model filter silently disappears — a listing the caller
  // believes is filtered by model and is not.
  //
  // EVERY VALUELESS FILTER BELONGS HERE, and the failure is always the same
  // shape: the flag swallows the next one. `aile lenders --free --sort served`
  // would set `free: "--sort"` and drop the order entirely. A filter that
  // silently disappears is worse than one that errors, because the listing still
  // prints and looks filtered.
  "verified", "free", "free-only",
  // Same rule for the serve-without-this-machine opt-in. `aile connect openrouter
  // --nodeless --label work` must not read "--label" as the value of "--nodeless"
  // and then link an account named nothing.
  "nodeless", "no-nodeless",
  // Same again for the attended-job runner: `aile mcp answer --keep-home --
  // claude -p` must not read "--" (or the command) as the flag's value.
  "keep-home",
  // `aile setup`: `aile setup --all claude` must not read "claude" as the value
  // of `--all`, nor `--dry-run --yes` swallow the `--yes`.
  "all", "dry-run", "new-key", "remove", "fast", "revoke", "keep-key", "tools",
  // `aile mcp --debug test x` must not read "test" as the value of --debug.
  "debug",
]);

function parseArgs(argv) {
  const out = { _: [] };
  // A bare `--` ends flag parsing: everything after it is positional. Without
  // this, `aile mcp answer -- <cmd> --flag` would read the command's own
  // `--flag` as one of ours — and `--` itself used to parse as a flag named
  // "", swallowing the command entirely.
  let positionalsOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--" && !positionalsOnly) {
      positionalsOnly = true;
      out._.push(a);
      continue;
    }
    if (positionalsOnly) {
      out._.push(a);
      continue;
    }
    // `-h` anywhere is help. It used to be a positional, so `aile start -h`
    // STARTED the node and `aile logout -h` signed out.
    if (a === "-h") { out.help = true; continue; }
    if (a.startsWith("--")) {
      // --key=value is unambiguous, so accept it for anything.
      const eq = a.indexOf("=");
      if (eq > 2) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else out._.push(a);
  }
  return out;
}

/**
 * Skipped under `--json`. Anything on stdout that is not the JSON makes the
 * output unparseable, and a flag that exists to be piped has to actually pipe.
 *
 * `args` is declared below but assigned before dispatch, and nothing calls this
 * before dispatch — so the read is safe despite reading later in the file.
 */
function banner() {
  if (args.json) return;
  console.log(`${C.cyan}${C.bold}aile.sh${C.reset}`);
}

function die(msg, hint = null) {
  uiDie(msg, hint);
}

/**
 * What to tell a person when a call failed: `[what happened, what to do]`.
 *
 * "Could not reach the server" used to cover every failure, including a server
 * that answered perfectly clearly that the sign-in had been revoked — which
 * sends the user to debug their network when they needed `aile login`.
 */
function explainError(e, server = loadConfig().serverUrl) {
  if (e instanceof LoginError) return [e.message, e.hint || null];
  if (e?.name === "KeyError") return [e.message, e.hint || null];
  if (e instanceof ApiError) {
    if (e.status === 401) return ["Your sign-in is no longer valid.", "Run `aile login` to sign in again."];
    if (e.status === 403) return [`The server refused that: ${e.message}`, "If you signed in on another machine since, run `aile login` here again."];
    if (e.status >= 500) return [`${server} had a problem (${e.status}).`, "Try again in a moment — or `aile doctor` to check everything."];
    return [e.message, null];
  }
  const m = String(e?.message || e);
  if (/^(cannot reach|no response from)/.test(m)) {
    return [`Could not reach the server (${server}).`, "Check your connection and try again — `aile doctor` checks everything."];
  }
  return [`Something went wrong: ${m}`, "Run it again with AILE_DEBUG=1 for the details, or `aile doctor` to check everything."];
}

/**
 * The guard every command that talks to the server shares.
 *
 * One helper rather than the same two lines in six places, because the message
 * changed once and had to change in all six: there are two ways to set a machine
 * up now, and naming only the paid one made contributing look unsupported rather
 * than merely unpaid. Anything that reads "not signed in" is also wrong for a
 * donor machine, which holds a token and is not signed in to anything.
 */
function requireToken(config) {
  if (config.renterToken) return config.renterToken;
  die(
    "This machine is not set up yet.",
    "Run `aile login` to be paid for what it serves, or `aile donate` to contribute unpaid.",
  );
}

/**
 * Plain HTTP sends credentials in clear, so it needs an explicit opt-in.
 * Loopback is exempt (it never leaves the machine); a staging IP is not, which
 * is why --insecure exists and why it is loud rather than silent.
 *
 * The `allowInsecure` setting is a saved --insecure, for a staging box the user
 * hits constantly. It still warns on every command: an opt-in that goes quiet is
 * an opt-in people forget is switched on.
 */
function checkTransport(server, args) {
  if (isSecureUrl(server)) return false;
  const allowed = args.insecure || loadConfig().allowInsecure === true;
  if (!allowed) {
    console.error(`${C.red}Refusing a non-HTTPS server URL:${C.reset} ${server}`);
    console.error(`${C.dim}Credentials would cross the network in clear.${C.reset}`);
    console.error(`\nFor a staging server reached by IP, opt in explicitly:`);
    console.error(`  ${C.cyan}aile <command> --server ${server} --insecure${C.reset}`);
    console.error(`${C.dim}or persist it: ${C.reset}${C.cyan}aile config allowInsecure true${C.reset}\n`);
    process.exit(1);
  }
  // stderr, not stdout: this is a diagnostic, and on stdout it would sit inside
  // the payload of anything piped to a parser.
  console.error(`${C.yellow}WARNING: using plain HTTP.${C.reset} ${C.dim}Staging only.${C.reset}`);
  return true;
}

// ---------------------------------------------------------------------------

/**
 * Sign in.
 *
 * Three ways in, one command:
 *   aile login                    browser, falling back to paste if it fails
 *   aile login --paste            skip the browser (headless boxes, SSH)
 *   aile login --token <token>    non-interactive, for scripted installs
 *
 * The fallback matters because the browser path fails for ordinary reasons — a
 * server with no display, a code that timed out, a proxy that ate the callback.
 * Ending those in an error with no way forward was the old behaviour.
 */
async function cmdLogin(args, { mode: forcedMode = null, quiet = false } = {}) {
  if (!quiet) banner();
  const server = args.server || loadConfig().serverUrl;
  const insecure = checkTransport(server, args);

  const mode = forcedMode || (args.paste ? "paste" : args.browser ? "browser" : "auto");
  const token = args.token || process.env.AILE_TOKEN || null;

  let result;
  try {
    result = await signIn({ serverUrl: server, insecure, token, mode });
  } catch (e) {
    const hint = e instanceof LoginError ? e.hint : null;
    die(`Sign-in failed: ${e.message}`, hint || "Run `aile login --paste` to sign in without a browser.");
  }

  console.log(`\n${C.green}Signed in${C.reset} as ${C.cyan}${result.renter?.email || "your account"}${C.reset}`);
  console.log(`${C.dim}Node ${getNodeId()} · token stored 0600 at ${CONFIG_FILE}${C.reset}`);

  if (result.enrolled === false) {
    console.log(`\n${C.yellow}This machine is not registered yet:${C.reset} ${result.enrolError}`);
    console.log(`${C.dim}Retry with ${C.reset}${C.cyan}aile register${C.reset}${C.dim} once the server is reachable.${C.reset}`);
  }

  console.log(`\nNext: ${C.cyan}aile connect${C.reset} to add an AI account, then ${C.cyan}aile start${C.reset}\n`);

  await offerToolSwitch(args, result.renter);
}

/**
 * After signing in as a DIFFERENT account than the one whose key the coding
 * tools hold: offer to move them over. Otherwise they go on billing the
 * previous account, which is exactly the kind of thing nobody notices until the
 * statement arrives. Nothing is changed without a yes (or `--yes`).
 */
async function offerToolSwitch(args, renter) {
  const manifest = loadManifest();
  const tools = toolsSetUp(manifest);
  const owner = manifest.key?.account;
  if (!tools.length || !owner?.id || !renter?.id || owner.id === renter.id) return;
  console.log(`${C.yellow}Your coding tools use a key from ${owner.email || "another account"}.${C.reset}`);
  const yes = args.yes || (isInteractive() && await promptConfirm(`Switch them to ${renter.email || "this account"}?`, { defaultYes: true }));
  if (!yes) {
    console.log(`${C.dim}Switch later with:${C.reset} ${C.cyan}aile setup refresh --new-key${C.reset}\n`);
    return;
  }
  await setupRefresh({ ...args, _: ["setup", "refresh"], "new-key": true });
}

/**
 * Every account, in the order the server returns them.
 *
 * That order is what makes the numbers in `aile accounts` mean anything: the
 * server sorts by provider, then creation time, so `2` is the same account in
 * the listing and in the `aile disconnect 2` that follows it. Sorting again here
 * — or anywhere else — would quietly break that pairing.
 */
async function fetchAccounts({ server, config, insecure }) {
  try {
    const { accounts } = await withSpinner("Reading your accounts…", api.listProviders({
      serverUrl: server, token: config.renterToken, insecure,
    }));
    return accounts || [];
  } catch (e) {
    die(...explainError(e, server));
  }
}

/** How an account is written on one line: label if the lender named it, else whatever identifies it. */
function accountTitle(a) {
  const name = getProvider(a.provider)?.name || a.provider;
  if (a.label) return `${name} ${C.dim}·${C.reset} ${a.label}`;
  if (a.email) return `${name} ${C.dim}·${C.reset} ${a.email}`;
  return name;
}

/**
 * The account's state, as TWO facts — because it is two questions.
 *
 *   live      does this credential still work? (the server probed it)
 *   identity  do we know WHOSE account it is?  (the provider signed an id_token)
 *
 * THIS USED TO BE ONE WORD, AND THE ONE WORD WAS WRONG THREE DIFFERENT WAYS. A
 * working API key has no identity and never can — nothing signs a key exchange. So
 * `aile status` called it "unverified" (alarming: nothing is wrong and nothing can
 * be done), `aile accounts` called it "verified" (overstating: we have no idea whose
 * key it is), and the dashboard called it "Key valid". Same row, same instant, three
 * answers.
 *
 * THE VERDICT NOW COMES FROM THE SERVER (`account.verification`, see
 * lib/accountVerification.ts on the relay) so no client derives it and none can
 * drift again. `verificationOf` falls back to the old local rule when talking to a
 * relay too old to send one, so this keeps working against an un-upgraded server.
 */
function verificationOf(a) {
  if (a?.verification && typeof a.verification === "object") return a.verification;
  // Legacy relay: the best that can be said from the two raw columns. The kind is
  // still known locally, so an api-key account is reported as one whose identity
  // CANNOT be proven rather than one that merely has not been — the distinction is
  // the whole point, and losing it against an older server would lose it in the one
  // place a lender is most likely to be looking.
  return {
    live: a?.probe_ok ? true : (a?.probed_at ? false : null),
    liveCheckedAt: a?.probed_at ?? null,
    identity: a?.attested ? "attested" : (isApiKeyProvider(a?.provider) ? "not-attestable" : "unproven"),
    reason: null,
  };
}

/** How long ago, in the coarsest unit that is still true. */
function agoText(iso) {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The badge column: LIVENESS, plus `verified` when the identity is proven too.
 *
 * An attested account earns the strong word because both questions are answered.
 * Everything else says only what was actually established, and the identity half is
 * spelled out on its own line by `identityLine` rather than crammed in here.
 */
function accountBadge(a) {
  const v = verificationOf(a);
  if (v.identity === "attested" && v.live !== false) return `${C.green}verified  ${C.reset}`;
  if (v.live === true) return `${C.green}working   ${C.reset}`;
  if (v.live === false) return `${C.red}failing   ${C.reset}`;
  return `${C.dim}unchecked ${C.reset}`;
}

/**
 * The second fact, on its own line, and only when it says something.
 *
 * Silent for an attested account — there is nothing left to explain. For everything
 * else it prints the server's OWN sentence (`verification.reason`, written at link
 * time and until now never displayed anywhere) rather than a guess assembled from
 * flags, so the lender reads why this particular provider could not be attested.
 */
function identityLine(a) {
  const v = verificationOf(a);
  if (v.identity === "attested") return "";
  const checked = v.liveCheckedAt ? ` ${C.dim}· checked ${agoText(v.liveCheckedAt)}${C.reset}` : "";
  const why = v.reason ? ` ${C.dim}— ${v.reason}${C.reset}` : "";
  const head = v.identity === "not-attestable"
    ? `${C.dim}identity cannot be proven${C.reset}`
    : `${C.dim}identity not proven${C.reset}`;
  return `${head}${why}${checked}`;
}

/**
 * Why an account reads `unverified`, when there is a reason worth saying.
 *
 * A pasted key is unverified permanently and by nature — nothing signs anything
 * in a key exchange, so there is no signature to check. Left unexplained, that
 * badge looks like a step the lender forgot, and they go hunting for the
 * verification they never had. Naming it as a billing kind instead answers the
 * question the badge raises AND the one it cannot: this account has no monthly
 * ceiling, so a busy week is an invoice rather than an exhausted plan.
 *
 * A subscription that is merely unattested says nothing here — that one may
 * genuinely become verified later, and claiming otherwise would be wrong.
 */
function accountNote(a) {
  if (!isApiKeyProvider(a.provider)) return "";
  // The BILLING half only. "never verifiable" used to live here too and now sits on
  // the identity line above, where it belongs and where it is said of every kind
  // that cannot be attested rather than only of keys.
  return `${C.dim}API key · billed to you per token${C.reset}`;
}

/**
 * The subscription tier, when the provider signed one into the account's token.
 *
 * This is not decoration. Two accounts of one provider are the case the numbered
 * listing exists for, and once both are named "verified" with an email each, the
 * tier is often the only thing that distinguishes what they can actually serve —
 * a Plus account and a Pro account have very different ceilings, and a lender
 * looking at a slow month wants to know which one they connected.
 *
 * Read from `attest_detail`, which the server writes ONLY from a verified
 * id_token — so what is printed here is what the provider itself asserted, not
 * something either side could have typed. Anything unparseable prints nothing:
 * an account listing is not worth failing over a malformed field, and a wrong
 * tier would be worse than a missing one.
 */
function accountPlan(a) {
  if (!a.attested || !a.attest_detail) return "";
  try {
    const plan = JSON.parse(a.attest_detail)?.chatgptPlanType;
    return plan ? String(plan) : "";
  } catch {
    return "";
  }
}

/**
 * HOW this account is served this instant, as the relay decides it
 * (`account.serving`, lib/serving.ts). One rule, computed on the server from live
 * node presence, so `aile accounts`, `aile status` and the dashboard cannot
 * disagree — the exact drift that made an account served through an online machine
 * read as "Needs a node" in one place and "serving" in another.
 *
 * Falls back to the raw `allow_nodeless` flag against a relay too old to send a
 * verdict: from here we cannot see another machine's live presence, so the legacy
 * path can only tell nodeless-armed from not, precisely as the old listing did.
 */
function servingOf(a) {
  if (a?.serving && typeof a.serving === "object") return a.serving;
  const nodeless = a?.allow_nodeless === true;
  return {
    via: nodeless ? "nodeless" : "none",
    nodeId: null,
    online: false,
    nodeless,
    nodelessCapable: isApiKeyProvider(a?.provider),
  };
}

/**
 * The serving state on one line — WHICH path is carrying this account now.
 *
 *   ● serving through THIS machine   a node you run, and it is this box
 *   ● serving through another machine  a different node of yours has it
 *   serving nodeless                 Aile dials the provider directly, no machine
 *   not serving                      nothing can: no node up and nodeless not on
 *
 * `hereNodeId` is this machine's stable id (`getNodeId()`), so the line can say
 * "this box" versus "another of yours" — the distinction a lender staring at a
 * terminal most wants, because it answers "is what I'm looking at doing the work?".
 */
function servedLine(a, hereNodeId) {
  const s = servingOf(a);
  if (s.via === "node") {
    const here = s.nodeId && hereNodeId && s.nodeId === hereNodeId;
    const where = here ? "through THIS machine" : "through another of your machines";
    const also = s.nodeless ? `${C.dim} · also reachable via Aile${C.reset}` : "";
    return `${C.green}● serving ${where}${C.reset}${also}`;
  }
  if (s.via === "nodeless") {
    return `${C.cyan}serving nodeless${C.reset}${C.dim} · via Aile, no machine in the path${C.reset}`;
  }
  return `${C.dim}not serving${C.reset}${C.dim} · needs a node (${C.reset}${C.cyan}aile start${C.reset}${C.dim}) or nodeless${C.reset}`;
}

/**
 * Turn what the user typed into one account.
 *
 * Accepts a position from the last listing, a full id, or an unambiguous id
 * prefix. An ambiguous prefix is an error rather than a guess — picking one of
 * two matching accounts to delete would be the worst possible way to be helpful.
 */
function resolveAccountRef(ref, accounts) {
  const s = String(ref).trim();
  if (/^\d+$/.test(s)) {
    const i = Number.parseInt(s, 10) - 1;
    if (i < 0 || i >= accounts.length) {
      die(`There is no account ${s}.`, `You have ${accounts.length}. Run \`aile accounts\` to see them.`);
    }
    return accounts[i];
  }
  const exact = accounts.find((a) => a.id === s);
  if (exact) return exact;
  const partial = accounts.filter((a) => a.id.startsWith(s));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    die(`"${s}" matches ${partial.length} accounts.`, "Use the number from `aile accounts`, or the full id.");
  }
  die(`No account matching "${s}".`, "Run `aile accounts` to see them.");
}

/**
 * Connect an AI account.
 *
 *   aile connect                    pick from a menu (or list, when not a terminal)
 *   aile connect codex              connect that provider
 *   aile connect codex --label work name it, so two accounts of one provider are tellable apart
 *   aile connect openrouter         paste an API key (prompted, masked)
 *   echo $KEY | aile connect groq --key -   read the key from a pipe, for scripts
 *
 * A second account of the same provider is a normal thing to want — a personal
 * and a work subscription have separate quotas — so nothing here treats it as a
 * mistake. What it does do is say which happened, because "Connected" printed
 * over a silently replaced credential is how a lender ends up wondering where
 * their other account went.
 */
async function cmdConnect(args) {
  banner();
  const config = loadConfig();
  requireToken(config);

  const server = args.server || config.serverUrl;
  const insecure = checkTransport(server, args);

  let providerId = args._[1];
  if (!providerId) providerId = await pickProvider();
  if (!providerId) return;

  const provider = getProvider(providerId);
  if (!provider) die(`Unknown account type: ${providerId}`, "Run `aile connect` to list them.");
  if (!isLinkable(providerId)) {
    die(`${provider.name} cannot be connected automatically yet.`,
        "It needs a token pasted in, which this version does not support.");
  }

  const label = typeof args.label === "string" ? args.label : null;
  // An explicit key is the escape hatch for a provider that tells us nothing
  // about which account we just linked. Without one, two such accounts look
  // identical to the server and the second overwrites the first.
  const accountKey = typeof args.account === "string" ? args.account : null;

  // Serving with no machine in the path. Offered ONLY where it is honoured — the
  // serve path refuses it for subscriptions (ROUTER-PLAN §6.6), so accepting the
  // flag on one would store a setting that can never do anything.
  const keyProvider = isApiKeyProvider(providerId);
  if (args.nodeless && !keyProvider) {
    die(
      `${provider.name} cannot serve without this machine.`,
      "Only API-key accounts can — a subscription is relayed through your node on purpose.",
    );
  }
  const allowNodeless = keyProvider ? (args.nodeless ? true : args["no-nodeless"] ? false : null) : null;

  // Which existing account this link should REPLACE, when the provider tells us
  // nothing that identifies it. Resolved against the same numbering `aile accounts`
  // prints, so `--replace 2` means the row the lender is looking at.
  let replaceAccountId = null;
  if (args.replace !== undefined) {
    const existing = await fetchAccounts({ server, config, insecure });
    replaceAccountId = resolveAccountRef(String(args.replace), existing).id;
  }

  const apiKey = needsApiKey(providerId) ? await collectApiKey(provider, args) : null;

  try {
    const account = await connectProvider(providerId, {
      serverUrl: server, renterToken: config.renterToken, insecure,
      label, accountKey, apiKey, allowNodeless, replaceAccountId,
    });
    const badge = accountBadge(account).trim();
    const verb = account.added ? "Connected" : "Reconnected";
    console.log(`\n${C.green}${verb}${C.reset} ${provider.name} ${badge}`);
    if (account.label) console.log(`${C.dim}named "${account.label}"${C.reset}`);
    if (account.email) console.log(`${C.dim}${account.email}${C.reset}`);
    if (!account.added) {
      console.log(`${C.dim}This replaced the credential you had linked for this account.${C.reset}`);
    }
    if (account.allow_nodeless && keyProvider) {
      console.log(`${C.dim}Serves without this machine — it keeps earning while this box is off.${C.reset}`);
    }
    if (account.total > 1) {
      console.log(`${C.dim}${account.total} accounts connected · ${C.reset}${C.cyan}aile accounts${C.reset}`);
    }
    // How many more of THIS provider can be linked. The server has always sent the
    // ceiling and this client threw it away, so a lender met it as a bare 400 after
    // pasting a key rather than as a number they could see coming.
    if (typeof account.maxPerProvider === "number" && typeof account.providerTotal === "number") {
      const left = account.maxPerProvider - account.providerTotal;
      if (left <= 2) {
        console.log(`${C.dim}${left} more ${provider.name} ${left === 1 ? "account" : "accounts"} can be linked (limit ${account.maxPerProvider}).${C.reset}`);
      }
    }
    // What makes it earn. A linked account serves nothing until a node is up —
    // unless it is nodeless, which is the one case where there is no next step.
    const serving = getRelayStatus().running || lockHolder();
    if (!(account.allow_nodeless && keyProvider) && !serving) {
      console.log(`\n${next([["aile start", "serve it from this machine"]])}`);
    }
    console.log();
  } catch (e) {
    // The cap arrives as a plain 400 from the server. Name the way out of it —
    // "max accounts per provider reached" is true and leaves the reader nowhere.
    if (/max accounts per provider/i.test(e.message || "")) {
      die(
        `${provider.name} has as many accounts linked as this server allows.`,
        "Remove one with `aile disconnect`, or replace one in place with `aile connect "
        + `${providerId} --replace <n>\`.`,
      );
    }
    die(`Could not connect ${provider.name}: ${e.message}`);
  }
}

/**
 * Get the API key for a key-based provider.
 *
 *   --key <value>   for scripts that already hold it
 *   --key -         read it from stdin, so it never appears in the process list
 *                   or the shell history — `ps` shows every argument
 *   (neither)       prompt, masked
 *
 * The prompt is masked because a key pasted in the clear lands in scrollback, in
 * a screen share, and in whatever the terminal logs. Without a terminal there is
 * nothing to prompt on, so this declines and names the two flags rather than
 * blocking forever on a stdin nobody is attached to.
 */
async function collectApiKey(provider, args) {
  const cfg = provider.apiKey || {};

  if (typeof args.key === "string" && args.key !== "-") return args.key.trim();

  // `--key -` reads stdin explicitly. promptSecret already falls back to a plain
  // line read when stdin is not a TTY, so this is one path, not two.
  if (args.key === "-") {
    const value = String(await promptSecret("") || "").trim();
    if (!value) die("No key on stdin.", `Try: echo $KEY | aile connect ${provider.id} --key -`);
    return value;
  }

  if (!isInteractive()) {
    // Nothing to ask on and nothing was passed. Reading stdin anyway would hang
    // a cron job forever on a pipe nobody is writing to.
    die(`${provider.name} needs an API key, and there is no terminal to ask on.`,
        `Pass it with --key <key>, or pipe it: echo $KEY | aile connect ${provider.id} --key -`);
  }

  console.log(`\n${C.bold}Connect ${provider.name}${C.reset}`);
  if (cfg.keyUrl) console.log(`${C.dim}Get a key at ${C.reset}${C.cyan}${cfg.keyUrl}${C.reset}`);
  // Said before the paste, not after a failure: a lender who knows the key is
  // billed to them may reasonably decide not to lend it at all.
  console.log(`${C.dim}Usage on this key is billed to your ${provider.name} account.${C.reset}\n`);

  const key = await promptSecret(`${C.cyan}?${C.reset} API key: `);
  const value = String(key || "").trim();
  if (!value) die("No key given.", "Nothing was connected.");
  return value;
}

/**
 * The provider menu: a chooser on a terminal, a printed list anywhere else.
 *
 * Subscriptions and API keys are shown apart because they are different things
 * to lend. A subscription has a monthly ceiling; an API key bills the lender per
 * token with no ceiling at all, and someone picking from a flat list of names
 * would have no way to tell which they had chosen.
 */
async function pickProvider() {
  const oauth = PROVIDERS.filter((p) => isLinkable(p.id) && !needsApiKey(p.id));
  const byok = PROVIDERS.filter((p) => needsApiKey(p.id));
  const manual = PROVIDERS.filter((p) => !isLinkable(p.id));

  if (!isInteractive()) {
    console.log(`\n${C.bold}Subscriptions${C.reset} ${C.dim}— sign in with the provider${C.reset}\n`);
    for (const p of oauth) console.log(`  ${C.green}·${C.reset} ${C.cyan}${p.id.padEnd(14)}${C.reset} ${p.name}`);
    if (byok.length) {
      console.log(`\n${C.bold}API keys${C.reset} ${C.dim}— paste a key; usage is billed to you${C.reset}\n`);
      for (const p of byok) console.log(`  ${C.green}·${C.reset} ${C.cyan}${p.id.padEnd(14)}${C.reset} ${p.name}`);
    }
    if (manual.length) {
      console.log(`\n${C.dim}Not yet supported${C.reset}\n`);
      for (const p of manual) console.log(`  ${C.dim}·${C.reset} ${C.cyan}${p.id.padEnd(14)}${C.reset} ${p.name} ${C.dim}(manual token)${C.reset}`);
    }
    console.log(`\n${C.dim}Connect one with: ${C.reset}${C.cyan}aile connect <name>${C.reset}\n`);
    return null;
  }

  const choices = [
    ...oauth.map((p) => ({ label: p.name, note: p.id })),
    ...byok.map((p) => ({ label: p.name, note: `${p.id} · API key` })),
  ];
  const ordered = [...oauth, ...byok];
  // The same split the printed list makes. Without it the chooser is nineteen
  // names in a row, and the one distinction that changes what a lender is
  // agreeing to — a plan's ceiling versus their own invoice — is carried only by
  // a dim "· API key" at the end of seven of the lines.
  const headings = { 0: "Subscriptions" };
  if (byok.length) headings[oauth.length] = "API keys — billed to you per token";
  const i = await promptChoice(
    `\n${C.bold}Which account?${C.reset} ${C.dim}(number, or ↑↓ then enter)${C.reset}\n`,
    choices, { headings },
  );
  if (i === null) return null;
  return ordered[i].id;
}

/**
 * List connected accounts, grouped by provider and numbered.
 *
 * The numbers are the point: they are what the other commands take, so a lender
 * never has to copy a 32-character id to remove or rename something.
 */
async function cmdAccounts(args) {
  banner();
  const config = loadConfig();
  requireToken(config);
  const server = args.server || config.serverUrl;
  const insecure = checkTransport(server, args);

  const accounts = await fetchAccounts({ server, config, insecure });

  if (args.json) {
    console.log(JSON.stringify(accounts, null, 2));
    return;
  }

  if (!accounts.length) {
    console.log(`\n${C.dim}No accounts connected yet.${C.reset}`);
    console.log(`Add one with ${C.cyan}aile connect${C.reset}`);
    // A machine lending only a local model has no accounts and is still
    // lending. Saying only the first half reads as "you are lending nothing",
    // which is wrong in the direction that makes a lender stop.
    if (config.localEnabled && config.localEndpoint) {
      console.log(`\n${C.dim}A self-hosted model is lent from this machine: ${C.reset}${C.cyan}${config.localEndpoint}${C.reset}`);
      console.log(`${C.dim}It is not listed here because it is not an account — see ${C.reset}${C.cyan}aile capacity${C.reset}`);
    }
    console.log();
    return;
  }

  console.log(`\n${C.bold}Connected accounts${C.reset}\n`);
  // This machine's stable id, so `servedLine` can say "THIS machine" versus
  // "another of yours" for an account a node is carrying.
  const here = getNodeId();
  let group = null;
  for (const [i, a] of accounts.entries()) {
    if (a.provider !== group) {
      group = a.provider;
      const name = getProvider(a.provider)?.name || a.provider;
      const n = accounts.filter((x) => x.provider === group).length;
      console.log(`  ${C.bold}${name}${C.reset}${n > 1 ? ` ${C.dim}(${n})${C.reset}` : ""}`);
    }
    const detail = a.label || a.email || `${C.dim}account ${a.account_key || "default"}${C.reset}`;
    const plan = accountPlan(a);
    console.log(
      `    ${C.cyan}${String(i + 1).padStart(2)}${C.reset}  ${accountBadge(a)}  ${detail}`
      + (plan ? `  ${C.dim}${plan}${C.reset}` : ""),
    );
    if (a.label && a.email) console.log(`        ${C.dim}${a.email}${C.reset}`);
    // The identity half of the verdict, in the server's own words. Printed before
    // the kind note because it is the line that answers "why does this not say
    // verified?" — the question the badge column raises and cannot answer.
    const identity = identityLine(a);
    if (identity) console.log(`        ${identity}`);
    const note = accountNote(a);
    if (note) console.log(`        ${note}`);
    // WHAT ACTUALLY SERVES IT NOW — a live node wins over the flag. This replaced a
    // line that read the flag alone, so an account served through an online machine
    // showed "Needs a node" and one with the flag set but never honoured showed
    // "serves without this machine". The verdict comes from the server now.
    console.log(`        ${servedLine(a, here)}`);
    // The switch, pointed the right way for where this account currently is. Only
    // for api-key accounts — a subscription is relayed through the node on purpose
    // (ROUTER-PLAN §6.6), so offering to serve one without a machine would arm a
    // setting the serve path will not honour.
    if (isApiKeyProvider(a.provider)) {
      if (servingOf(a).nodeless) {
        console.log(`        ${C.dim}serve only through this machine · ${C.reset}${C.cyan}aile nodeless ${i + 1} off${C.reset}`);
      } else {
        console.log(`        ${C.dim}also serve without this machine · ${C.reset}${C.cyan}aile nodeless ${i + 1} on${C.reset}`);
      }
    }
    console.log(`        ${C.dim}${a.id}${C.reset}`);
  }
  console.log(`\n${C.dim}Name one:   ${C.reset}${C.cyan}aile label 1 "work account"${C.reset}`);
  console.log(`${C.dim}Remove one: ${C.reset}${C.cyan}aile disconnect 1${C.reset}\n`);
}

/**
 * What this machine lends, with the three kinds separated.
 *
 * `aile accounts` groups by provider, which is the right axis for "which of my
 * accounts is this one" and the wrong axis for "what am I actually lending". The
 * three kinds of capacity differ in ways that matter more than which company
 * issued them: a subscription stops at a monthly ceiling, a key keeps billing
 * past one, and a self-hosted model is not blind at all. Nothing showed those
 * together until now — self-hosted lived behind its own command, so a machine
 * lending only a local model was told "No accounts connected yet", which was
 * false in the one way that discourages the lender who read it.
 *
 * THE NUMBERS COME FROM THE SERVER'S ORDER, NOT FROM THIS DISPLAY'S. Regrouping
 * the rows and numbering them 1..n as they are printed would make `aile
 * disconnect 2` mean one account here and a different one under `aile accounts`
 * — which is how a lender removes a credential they never named. The position is
 * carried in from the fetch and only ever displayed.
 */
async function cmdCapacity(args) {
  banner();
  const config = loadConfig();
  requireToken(config);
  const server = args.server || config.serverUrl;
  const insecure = checkTransport(server, args);

  const accounts = await fetchAccounts({ server, config, insecure });
  const numbered = accounts.map((a, i) => ({ ...a, n: i + 1 }));
  const subscriptions = numbered.filter((a) => !isApiKeyProvider(a.provider));
  const keys = numbered.filter((a) => isApiKeyProvider(a.provider));

  // Built rather than read from config: this is what the node would actually
  // advertise, so an endpoint that no longer resolves shows as not serving
  // instead of as capacity. A settings dump would say "on" either way.
  const local = await buildLocalCapability(config);
  const localConfigured = Boolean(config.localEnabled && config.localEndpoint);

  if (args.json) {
    console.log(JSON.stringify({
      subscriptions, apiKeys: keys,
      selfHosted: local
        ? { endpoint: config.localEndpoint, models: local.models, blind: false }
        : null,
    }, null, 2));
    return;
  }

  if (!accounts.length && !localConfigured) {
    console.log(`\n${C.dim}This machine is not lending anything yet.${C.reset}\n`);
    console.log(`  Connect an account:   ${C.cyan}aile connect${C.reset}`);
    console.log(`  Lend a local model:   ${C.cyan}aile local http://127.0.0.1:11434${C.reset}`);
    console.log(`  ${C.dim}Buyers reach it as ${C.reset}${C.cyan}local/<model>${C.reset}\n`);
    return;
  }

  const row = (a) => {
    const name = getProvider(a.provider)?.name || a.provider;
    const detail = a.label || a.email || `${C.dim}account ${a.account_key || "default"}${C.reset}`;
    console.log(`    ${C.cyan}${String(a.n).padStart(2)}${C.reset}  ${accountBadge(a)}  ${name} ${C.dim}·${C.reset} ${detail}`);
    if (a.label && a.email) console.log(`        ${C.dim}${a.email}${C.reset}`);
  };

  console.log(`\n${C.bold}What this machine lends${C.reset}`);

  if (subscriptions.length) {
    console.log(`\n  ${C.bold}Subscriptions${C.reset} ${C.dim}(${subscriptions.length})${C.reset}`);
    console.log(`  ${C.dim}Stops at the plan's monthly ceiling · relayed ${C.reset}${C.green}blind${C.reset}${C.dim}, so this machine cannot read it${C.reset}`);
    for (const a of subscriptions) row(a);
  }

  if (keys.length) {
    console.log(`\n  ${C.bold}API keys${C.reset} ${C.dim}(${keys.length})${C.reset}`);
    // Said once here rather than per row: in this view the heading is what the
    // rows belong to, so repeating it on each would be noise instead of news.
    console.log(`  ${C.dim}${C.reset}${C.yellow}No ceiling${C.reset}${C.dim} · billed to you per token · never verifiable${C.reset}`);
    console.log(`  ${C.dim}Relayed ${C.reset}${C.green}blind${C.reset}${C.dim} — the key is used at the server, never read here${C.reset}`);
    for (const a of keys) row(a);
  }

  if (localConfigured) {
    console.log(`\n  ${C.bold}Self-hosted model${C.reset}`);
    console.log(`  ${C.yellow}Not blind${C.reset}${C.dim} — it runs here, so this machine reads these prompts${C.reset}`);
    console.log(`        ${C.cyan}${config.localEndpoint}${C.reset}`);
    if (local) {
      console.log(`        ${local.models.length
        ? `${C.dim}${local.models.join(", ")}${C.reset}`
        : `${C.yellow}no models advertised${C.reset} ${C.dim}· aile config localModels llama3${C.reset}`}`);
    } else {
      // Turned on but not serving. Nothing else in the CLI says this, so a
      // lender who typo'd a port sees "enabled" everywhere and no traffic.
      let why = "cannot be reached";
      try { await resolveLocalTarget(config.localEndpoint); } catch (e) { why = e.message; }
      console.log(`        ${C.red}not serving${C.reset} ${C.dim}${why}${C.reset}`);
    }
  }

  // Count what would actually serve. A local endpoint that is enabled but
  // unreachable is not capacity, and counting it would contradict the
  // "not serving" printed two lines above it.
  const total = accounts.length + (local ? 1 : 0);
  console.log(`\n${C.dim}${total} source${total === 1 ? "" : "s"} of capacity${C.reset}`);
  // Only when there are numbers to match and something to remove. Offering
  // `aile disconnect 1` to a machine lending only a local model names a command
  // that can only fail — and the self-hosted model is not removed that way.
  if (accounts.length) {
    console.log(`${C.dim}Numbers match ${C.reset}${C.cyan}aile accounts${C.reset}${C.dim} · remove one: ${C.reset}${C.cyan}aile disconnect 1${C.reset}`);
  } else if (localConfigured) {
    console.log(`${C.dim}Stop lending it: ${C.reset}${C.cyan}aile local --off${C.reset}`);
  }
  console.log();
}

/**
 * Give an account a name.
 *
 * Purely cosmetic on purpose — the server never routes on a label, because a
 * value the client chooses cannot be identity. It is for the human reading the
 * list, who has two ChatGPT accounts and needs to know which is which.
 */
async function cmdLabel(args) {
  banner();
  const config = loadConfig();
  requireToken(config);
  const server = args.server || config.serverUrl;
  const insecure = checkTransport(server, args);

  const ref = args._[1];
  if (!ref) die("Which account?", "Run `aile accounts`, then: aile label 1 \"work\"");

  const accounts = await fetchAccounts({ server, config, insecure });
  const account = resolveAccountRef(ref, accounts);

  let label = args._.slice(2).join(" ").trim();
  if (!label && isInteractive()) {
    label = await promptLine(`Name for ${accountTitle(account)}: `);
  }
  if (!label) die("No name given.", "aile label 1 \"work account\"");

  try {
    await api.labelProvider({ id: account.id, label, serverUrl: server, token: config.renterToken, insecure });
    console.log(`\n${C.green}Named${C.reset} ${C.cyan}${label}${C.reset}\n`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) die("No account with that id.");
    die(`Could not rename it: ${e.message}`);
  }
}

/**
 * Ask the SERVER to re-check a credential it holds.
 *
 * WHY THIS EXISTS. `aile connect` probes once, from this machine, to catch a bad
 * paste before uploading it. Nothing re-checked it afterwards, so when an account
 * quietly stopped working the badge kept reporting the verdict from link day, and
 * the only way to refresh it was to run the whole link again — a full OAuth round
 * trip to answer "is my key still good?".
 *
 * IT CANNOT MAKE AN ACCOUNT VERIFIED, and says so, because that is the next thing a
 * lender tries. Attestation is bound to a nonce issued during the link; there is no
 * way to attest an account that already exists. Only re-linking can.
 */
async function cmdRetest(args) {
  banner();
  const config = loadConfig();
  requireToken(config);
  const server = args.server || config.serverUrl;
  const insecure = checkTransport(server, args);

  const accounts = await fetchAccounts({ server, config, insecure });
  if (!accounts.length) {
    console.log(`\n${C.dim}No accounts connected yet.${C.reset}`);
    console.log(`Add one with ${C.cyan}aile connect${C.reset}\n`);
    return;
  }

  const ref = args._[1];
  const targets = ref ? [resolveAccountRef(String(ref), accounts)] : accounts;

  console.log(`\n${C.bold}Re-testing ${targets.length === 1 ? "one account" : `${targets.length} accounts`}${C.reset}\n`);
  for (const a of targets) {
    const name = getProvider(a.provider)?.name || a.provider;
    const detail = a.label || a.email || a.id.slice(0, 8);
    let res;
    try {
      res = await api.retestProvider({ id: a.id, serverUrl: server, token: config.renterToken, insecure });
    } catch (e) {
      console.log(`  ${C.red}error     ${C.reset}  ${name} ${C.dim}·${C.reset} ${detail}  ${C.dim}${e.message}${C.reset}`);
      continue;
    }
    const probe = res.probe || {};
    // `ok: null` is the server saying it LEARNED NOTHING — it had no healthy egress
    // to test through. Reporting that as a failure would send a lender off to
    // re-link a credential that was never in question.
    const word = probe.ok === true
      ? `${C.green}works     ${C.reset}`
      : probe.ok === false
        ? `${C.red}rejected  ${C.reset}`
        : `${C.dim}no answer ${C.reset}`;
    const why = probe.reason && probe.reason !== "ok" ? `  ${C.dim}${probe.reason}${C.reset}` : "";
    console.log(`  ${word}  ${name} ${C.dim}·${C.reset} ${detail}${why}`);
  }

  console.log(`\n${C.dim}This checks whether the credential still works. It cannot make an account${C.reset}`);
  console.log(`${C.dim}verified — only re-linking can, because attestation is bound to the link.${C.reset}\n`);
}

/**
 * Render whatever quota shape a provider happened to report.
 *
 * DELIBERATELY DUCK-TYPED. Usage is normalised per provider on the server and the
 * windows differ — a Codex account reports two rolling windows, an Anthropic one
 * mirrors ratelimit headers. Insisting on a single shape here would print nothing
 * for the providers that report the most. Anything unrecognised is printed raw
 * rather than swallowed: a reading nobody laid out beats pretending there was none.
 */
function usageLines(usage) {
  const out = [];
  const windows = Array.isArray(usage.windows) ? usage.windows : [];
  for (const w of windows) {
    const label = w.label || w.name || w.window || "window";
    if (typeof w.usedPercent === "number") {
      out.push(`${label}: ${Math.round(w.usedPercent)}% used`);
    } else if (typeof w.used === "number") {
      const of = typeof w.limit === "number" ? ` of ${w.limit}` : "";
      const pct = typeof w.limit === "number" && w.limit > 0
        ? ` ${C.dim}(${Math.round((w.used / w.limit) * 100)}%)${C.reset}` : "";
      out.push(`${label}: ${w.used}${of}${pct}`);
    }
    if (w.resetsAt) out.push(`${C.dim}${label} resets ${w.resetsAt}${C.reset}`);
  }
  if (!out.length) out.push(`${C.dim}${JSON.stringify(usage).slice(0, 200)}${C.reset}`);
  return out;
}

/**
 * What each account has left to give, as the provider itself reports it.
 *
 * MOST PROVIDERS REPORT NOTHING, and that is the case this command is really
 * written around. Usage comes back null whenever a provider publishes no quota, so
 * the honest output is a sentence saying so — an empty meter reads as either "you
 * have used it all" or "this is broken", and both are wrong.
 */
async function cmdUsage(args) {
  banner();
  const config = loadConfig();
  requireToken(config);
  const server = args.server || config.serverUrl;
  const insecure = checkTransport(server, args);

  const accounts = await fetchAccounts({ server, config, insecure });
  const res = await withSpinner("Asking each provider for its quota…", api.providersUsage({ serverUrl: server, token: config.renterToken, insecure }));
  const byId = new Map((res.accounts || []).map((r) => [r.accountId, r]));

  if (args.json) {
    // Keyed to the same numbers every other account command uses, so a script does
    // not have to re-derive the pairing — and must not re-sort to get it.
    console.log(JSON.stringify(
      accounts.map((a, i) => ({
        n: i + 1, id: a.id, provider: a.provider, label: a.label ?? null,
        ...(byId.get(a.id) || { usage: null, stale: false }),
      })),
      null, 2,
    ));
    return;
  }

  if (!accounts.length) {
    console.log(`\n${C.dim}No accounts connected yet.${C.reset}`);
    console.log(`Add one with ${C.cyan}aile connect${C.reset}\n`);
    return;
  }

  console.log(`\n${C.bold}Quota reported by each provider${C.reset}\n`);
  let reported = 0;
  for (const [i, a] of accounts.entries()) {
    const name = getProvider(a.provider)?.name || a.provider;
    const detail = a.label || a.email || `${C.dim}account ${a.account_key || "default"}${C.reset}`;
    console.log(`  ${C.cyan}${String(i + 1).padStart(2)}${C.reset}  ${name} ${C.dim}·${C.reset} ${detail}`);

    const row = byId.get(a.id);
    if (!row?.usage) {
      console.log(`        ${C.dim}no quota reported by this provider${C.reset}`);
      continue;
    }
    reported++;
    for (const line of usageLines(row.usage)) console.log(`        ${line}`);
    if (row.stale) {
      console.log(`        ${C.dim}this reading is stale — it refreshes when the account next serves${C.reset}`);
    }
  }

  if (!reported) {
    console.log(`\n${C.dim}None of these providers publish a quota. That is normal, and it does not${C.reset}`);
    console.log(`${C.dim}mean an account is out of capacity. What each kind can serve: ${C.reset}${C.cyan}aile capacity${C.reset}`);
  }
  console.log();
}

/**
 * What this lender charges — read it, and change it.
 *
 * NAMED `rates`, NOT `pricing`, AND THE DISTANCE IS THE POINT. `aile price <model>`
 * already exists and means the opposite thing: what a model would COST this account
 * to buy, quoted across every lender. Two commands one keystroke apart with opposite
 * meanings is a mistake waiting to be made silently, so the seller-side one takes a
 * different word.
 *
 * THE GRAIN IS (RENTER, MODEL), NEVER AN ACCOUNT. Two OpenRouter keys share one
 * price sheet — there is no per-account price on the server and the schema has no
 * room for one. Nothing here takes an account number, and it must not start to:
 * offering one would imply a control that does not exist.
 *
 * A margin is a multiplier on the provider's own list price, 0 (free) to 1 (list);
 * nobody sells above retail, and it is the ONLY price a lender sets — globally, or
 * per model. Every surface bills list × margin, per-unit models included, which
 * sell by default. `disabled` is deliberately separate from price on the server,
 * so clearing a margin cannot quietly re-enable a model the lender turned off.
 */
async function cmdRates(args) {
  banner();
  const config = loadConfig();
  requireToken(config);
  const server = args.server || config.serverUrl;
  const insecure = checkTransport(server, args);
  const opts = { serverUrl: server, token: config.renterToken, insecure };

  const verb = String(args._[1] || "").toLowerCase();
  const model = args._[2] ? String(args._[2]) : null;

  // Refused here, before anything is sent: the server 400s any dollar price, and
  // silently dropping the flag would leave a lender believing it took.
  if (args.in !== undefined || args.out !== undefined) {
    die("Dollar prices are retired — use --model-margin (0 = free, 1 = list).");
  }

  // --margin is a change, not a subcommand: `aile rates --margin 0.9` reads better
  // than `aile rates margin set 0.9` and there is only ever one global multiplier.
  if (args.margin !== undefined) {
    const margin = checkMargin(args.margin, "--margin");
    await callRates(() => api.setMargin({ margin, ...opts }));
    console.log(`\n${C.green}Margin set to ${marginText(margin)}.${C.reset} ${C.dim}Applies to every model with no margin of its own.${C.reset}\n`);
    return;
  }

  if (verb === "set") {
    if (!model) die("Which model?", "Try `aile rates set claude-opus-5 --model-margin 0.8`.");
    if (args["model-margin"] === undefined) {
      die("Set what?", "Try `aile rates set <model> --model-margin 0.8` (0 = free, 1 = list).");
    }
    const margin = checkMargin(args["model-margin"], "--model-margin");
    await callRates(() => api.setModelMargin({ model, margin, ...opts }));
    console.log(`\n${C.green}Set.${C.reset} ${model} ${C.dim}now sells at${C.reset} ${C.bold}${marginText(margin)}${C.reset}\n`);
    return;
  }

  if (verb === "clear") {
    if (!model) die("Which model?", "Try `aile rates clear claude-opus-5`.");
    await callRates(() => api.clearModelMargin({ model, ...opts }));
    console.log(`\n${C.green}Cleared.${C.reset} ${model} ${C.dim}is back on your global margin.${C.reset}\n`);
    return;
  }

  if (verb === "off" || verb === "on") {
    if (!model) die("Which model?", `Try \`aile rates ${verb} claude-opus-5\`.`);
    await callRates(() => api.setModelDisabled({ model, disabled: verb === "off", ...opts }));
    console.log(verb === "off"
      ? `\n${C.green}Off.${C.reset} ${model} ${C.dim}is hidden from the market and will not be served.${C.reset}\n`
      : `\n${C.green}On.${C.reset} ${model} ${C.dim}can be served again.${C.reset}\n`);
    return;
  }

  if (verb) {
    die(`Unknown: aile rates ${verb}`, "Try `aile rates` on its own, or `set` / `clear` / `on` / `off`.");
  }

  // ---- read ----------------------------------------------------------------
  const p = await withSpinner("Reading your prices…", api.pricing(opts));
  if (args.json) {
    console.log(JSON.stringify(p, null, 2));
    return;
  }

  const d = p.defaults || {};
  console.log(`\n${C.bold}What you charge${C.reset}\n`);
  // `marginSet` tells "never set" from a deliberate 0, which is free. When it is
  // false the server has already put the deployment default in `margin`.
  console.log(`  Margin  ${C.bold}${marginText(p.margin)}${C.reset}`
    + (p.marginSet ? "" : `  ${C.dim}(the default — you have not set one)${C.reset}`));
  console.log(`  ${C.dim}A multiplier on each provider's own list price.${C.reset}`);
  if (d.min !== undefined && d.max !== undefined) {
    console.log(`  ${C.dim}Allowed: ${d.min} to ${d.max}${C.reset}`);
  }

  const margins = p.modelMargins || {};
  const names = Object.keys(margins).sort();
  console.log(`\n  ${C.bold}Per-model margins${C.reset} ${C.dim}(${names.length})${C.reset}`);
  if (!names.length) {
    console.log(`  ${C.dim}None — every model follows the margin above.${C.reset}`);
  } else {
    for (const m of names) console.log(`  ${C.cyan}${m}${C.reset}  ${marginText(margins[m])}`);
  }

  const off = Array.isArray(p.disabled) ? p.disabled : [];
  console.log(`\n  ${C.bold}Not served${C.reset} ${C.dim}(${off.length})${C.reset}`);
  if (!off.length) {
    console.log(`  ${C.dim}None — every model you have capacity for is offered.${C.reset}`);
  } else {
    for (const m of off) console.log(`  ${C.yellow}${m}${C.reset}`);
  }
  console.log(`  ${C.dim}Per-unit models with a published list sell at list × margin by default; ${C.reset}`
    + `${C.cyan}aile rates off <model>${C.reset}${C.dim} stops one.${C.reset}`);

  console.log(`\n${C.dim}Change it:  ${C.reset}${C.cyan}aile rates --margin 0.9${C.reset}`);
  console.log(`${C.dim}One model:  ${C.reset}${C.cyan}aile rates set <model> --model-margin 0.8${C.reset}`);
  console.log(`${C.dim}Stop one:   ${C.reset}${C.cyan}aile rates off <model>${C.reset}\n`);
}

/**
 * A margin with what it means: `×0.9 (10% below list)`, `×1 (list price)`,
 * `×0 (free)`. The percentage is rounded to two places so float noise
 * (1 − 0.9 = 0.0999…) never reaches the screen.
 */
function marginText(m) {
  const n = Number(m);
  if (!Number.isFinite(n)) return String(m);
  if (n === 0) return "×0 (free)";
  if (n === 1) return "×1 (list price)";
  return `×${n} (${Number(((1 - n) * 100).toFixed(2))}% below list)`;
}

/**
 * Run a pricing write and let the SERVER's refusal speak.
 *
 * The bounds live on the server (`min`/`max`) and it returns a sentence naming
 * the one that was crossed. Re-deriving that here would mean two copies of the
 * limits, and the copy in the client is the one that goes stale.
 */
async function callRates(run) {
  try {
    return await run();
  } catch (e) {
    die(`That price was refused: ${e.message}`, "See `aile rates` for the allowed range.");
  }
}

/**
 * A margin, refused here when it is outside 0–1 so a markup never reaches the
 * wire. The one bound worth copying: it is the marketplace's rule (at or below
 * retail), not a tunable. Anything finer stays the server's to refuse.
 */
function checkMargin(raw, flag) {
  const m = Number(raw);
  if (raw === true || raw === "" || !Number.isFinite(m)) die(`${flag} is a number from 0 (free) to 1 (list price).`);
  if (m < 0 || m > 1) die(`${flag} must be 0 to 1: free up to list price, never above.`);
  return m;
}

/**
 * Serve an account with no machine in the path, or stop.
 *
 * THE CLI COULD NOT SET THIS AT ALL, and that was a difference in behaviour rather
 * than a missing convenience: the dashboard opts its own links in, this client never
 * sent the field, so the same provider linked from a terminal simply would not serve
 * nodeless and nothing anywhere said why.
 *
 * IT IS HONOURED ONLY FOR API KEYS. A consumer subscription served with no node is
 * refused upstream by design (ROUTER-PLAN §6.6), and the server stores the flag
 * verbatim rather than coercing it — so a `true` on one is silently ignored for
 * ever. Refusing it here, out loud, is the difference between a setting that does
 * nothing and a lender who knows that it would.
 */
async function cmdNodeless(args) {
  banner();
  const config = loadConfig();
  requireToken(config);
  const server = args.server || config.serverUrl;
  const insecure = checkTransport(server, args);

  const ref = args._[1];
  const verb = String(args._[2] || "").toLowerCase();
  if (!ref || (verb !== "on" && verb !== "off")) {
    die(
      "Which account, and on or off?",
      "Try `aile nodeless 1 on`. `aile accounts` lists them numbered.",
    );
  }

  const accounts = await fetchAccounts({ server, config, insecure });
  const account = resolveAccountRef(String(ref), accounts);
  const name = getProvider(account.provider)?.name || account.provider;

  if (verb === "on" && !isApiKeyProvider(account.provider)) {
    die(
      `${name} cannot serve without this machine.`,
      "Only API-key accounts can. A subscription is relayed through your node on purpose — "
      + "serving one directly would present it from this service's address instead of yours.",
    );
  }

  await api.updateProvider({
    id: account.id,
    patch: { allowNodeless: verb === "on" },
    serverUrl: server, token: config.renterToken, insecure,
  });

  if (verb === "on") {
    console.log(`\n${C.green}On.${C.reset} ${name} can now serve with no machine in the path.`);
    console.log(`${C.dim}It keeps earning while this machine is off — and stopping the node no${C.reset}`);
    console.log(`${C.dim}longer stops it. ${C.reset}${C.cyan}aile nodeless ${ref} off${C.reset}${C.dim} is the only way to halt it.${C.reset}\n`);
  } else {
    console.log(`\n${C.green}Off.${C.reset} ${name} now serves only while this machine is connected.\n`);
  }
}

/**
 * Remove a connected account.
 *
 * Takes a number from `aile accounts`, an id, or nothing at all — in which case
 * it asks. It also names what it is about to delete and waits for a yes, because
 * the cost of getting this wrong is re-running an OAuth flow, and the number is
 * only meaningful relative to a listing the user may have run a while ago.
 */
async function cmdDisconnect(args) {
  banner();
  const config = loadConfig();
  requireToken(config);

  const server = args.server || config.serverUrl;
  const insecure = checkTransport(server, args);
  const accounts = await fetchAccounts({ server, config, insecure });
  if (!accounts.length) {
    console.log(`\n${C.dim}Nothing to remove — no accounts connected.${C.reset}\n`);
    return;
  }

  let account;
  const ref = args._[1];
  if (ref) {
    account = resolveAccountRef(ref, accounts);
  } else if (isInteractive()) {
    const choices = accounts.map((a) => ({
      label: (getProvider(a.provider)?.name || a.provider) + (a.label ? ` · ${a.label}` : ""),
      note: a.email || a.id,
    }));
    const i = await promptChoice(`\n${C.bold}Remove which account?${C.reset} ${C.dim}(number, or ↑↓ then enter)${C.reset}\n`, choices);
    if (i === null) return;
    account = accounts[i];
  } else {
    die("Which account?", "Run `aile accounts` to see their numbers.");
  }

  if (isInteractive() && !args.yes) {
    console.log();
    if (!(await promptConfirm(`Remove ${accountTitle(account)}?`, { defaultYes: false }))) {
      console.log(`${C.dim}Nothing changed.${C.reset}\n`);
      return;
    }
  }

  try {
    await api.removeProvider({ id: account.id, serverUrl: server, token: config.renterToken, insecure });
    const left = accounts.length - 1;
    console.log(`\n${C.green}Removed.${C.reset} ${C.dim}${left} account${left === 1 ? "" : "s"} still connected.${C.reset}\n`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) die("No account with that id.");
    die(`Could not remove it: ${e.message}`);
  }
}

/**
 * The dashboard link, derived from the configured server.
 *
 * The dashboard is the WEB app, not the JSON API — in this deployment the API is
 * `api.<host>` and the site the lender logs into is `<host>`, at `/dash`. Pointing
 * at `<api>/dashboard` (what this used to do) sent people to a path the API does
 * not serve. Stripping a leading `api.` keeps a staging install on its own host
 * (`api.dev.aile.sh` → `dev.aile.sh/dash`) instead of hard-coding production.
 */
function dashboardUrl(serverUrl) {
  try {
    const u = new URL(serverUrl);
    u.hostname = u.hostname.replace(/^api\./, "");
    u.pathname = "/dash";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return "https://aile.sh/dash";
  }
}

/**
 * The overview — `aile status`, and what bare `aile` shows on a machine that is
 * already set up.
 *
 * BOTH SIDES, because a machine can be either or both: a buyer's coding tools
 * (the key, what uses it) and a lender's node (accounts, relay, earnings). It
 * used to show only the second, so a machine set up for buying read as
 * "Signed in: NO (run: aile login)" — pointing a buyer at the seller path — and
 * bare `aile` sent it back to the first-run welcome every time.
 *
 * IT ENDS WITH WHAT TO DO NEXT, chosen from the state it just read. A status
 * that lists facts and stops leaves the reader to work out which fact matters.
 */
/**
 * Everything the two status views show, read once. The account and the balance
 * are asked for TOGETHER, under one spinner: they are independent calls, and
 * waiting for one before starting the other doubled the pause before the first
 * line appeared.
 */
async function readStatus() {
  const config = loadConfig();
  const info = getNodeInfo();
  const server = config.serverUrl;
  const manifest = loadManifest();
  const setUp = toolsSetUp(manifest);
  const ctx = makeCtx({ serverUrl: server });

  let me = null;
  let meError = null;
  // `wallet`: the wallet view, or null when there is none (a donor, or a 404).
  // `walletError`: the read itself failed, which is not the same as no wallet.
  let wallet = null;
  let walletError = false;
  if (isLinked()) {
    const insecure = !isSecureUrl(server) && config.allowInsecure === true;
    const opts = { serverUrl: server, token: config.renterToken, insecure };
    const [m, w] = await withSpinner("Checking your account…", () => Promise.allSettled([
      api.me(opts),
      api.wallet({ ...opts, balance: true }),
    ]));
    if (m.status === "fulfilled") me = m.value; else meError = m.reason;
    if (w.status === "fulfilled") {
      const v = w.value?.wallet;
      wallet = v && typeof v === "object" ? v : null;
    } else {
      walletError = true;
    }
  }
  const st = getRelayStatus();
  const holder = st.running ? null : lockHolder();
  const mcp = mcpStatus();
  // Protected keys are credentials, not preferences someone changed.
  const changed = Object.keys(storedOverrides()).filter((k) => !SCHEMA[k]?.protected);
  // Installed tools not yet set up — local checks only, nothing is run.
  const notYet = TOOLS.filter((t) => !printsOnly(t) && !setUp.some((u) => u.id === t.id) && isInstalled(t.detect(ctx)));

  // How the connected accounts are carried. A NODELESS account is served by
  // aile directly and needs no machine at all; only an IDLE one — no node up
  // and not nodeless — is waiting on `aile start`. Suggesting `aile start` to
  // somebody whose every account is nodeless sent them to run a node that
  // would have served nothing.
  const accounts = me?.accounts || [];
  const nodeless = accounts.filter((a) => servingOf(a).via === "nodeless").length;
  const idle = accounts.filter((a) => servingOf(a).via === "none").length;
  const running = Boolean(st.running || holder);

  return { config, info, server, manifest, setUp, me, meError, wallet, walletError, st, holder, mcp, changed, notYet, accounts, nodeless, idle, running };
}

/** What to do next, in order of what unblocks the most. */
function statusSteps(s, { home }) {
  const steps = [];
  const { config, setUp, notYet, manifest, me } = s;
  if (!setUp.length) steps.push(["aile setup", "use aile in your coding tools"]);
  else if (notYet.length) steps.push([`aile setup ${notYet.map((t) => t.id).join(" ")}`, `also set up ${notYet.map((t) => t.label).join(", ")}`]);
  const shortcut = setUp.map((t) => manifest.tools[t.id]?.shortcut?.name).find(Boolean);
  if (shortcut && steps.length === 0) steps.push([shortcut, "start coding through aile"]);
  if (me && !me.renter.donor && !s.accounts.length) steps.push(["aile connect", "connect an AI account to lend"]);
  else if (me && s.idle && !s.running) steps.push(["aile start", `serve ${s.idle === 1 ? "your idle account" : `${s.idle} idle accounts`} from this machine`]);
  if (!isLinked() && !steps.length) steps.push(["aile login", "sign in to lend and get paid"]);
  if (!home) steps.push(["aile help", "every command"]);
  return steps.slice(0, 3);
}

/** `$12.34`, then what is spoken for or on its way — each only when non-zero. */
function balanceText(w) {
  if (w.usdc === null || w.usdc === undefined) return `${C.dim}could not be read just now${C.reset}`;
  const parts = [`${C.green}$${w.usdc}${C.reset}`];
  if (Number(w.owedMicros || 0) > 0 && w.spendable !== null && w.spendable !== undefined) parts.push(`$${w.spendable} spendable`);
  if (Number(w.incomingMicros || 0) > 0 && w.incoming) parts.push(`$${w.incoming} incoming`);
  return parts.join(`${C.dim} ${sym.dot} ${C.reset}`);
}

/** The relay in a word or two, or null when there is nothing running to report. */
function relayWord(s) {
  if (s.st.running) {
    return s.st.connected ? `${C.green}serving here${C.reset}`
      : s.st.fatal ? `${C.red}refused${C.reset}`
      : `${C.yellow}reconnecting${C.reset}`;
  }
  if (s.holder) return `${C.green}serving${C.reset}${C.dim} (another terminal)${C.reset}`;
  return null;
}

/**
 * Bare `aile`: the few lines worth reading every time, then the menu. Anything
 * a person reads once — the machine id, the config path, each account's row —
 * is `aile status`.
 */
function printGlance(s) {
  const { config, me, meError, wallet, walletError, setUp, notYet, server } = s;
  const dot = `${C.dim} ${sym.dot} ${C.reset}`;
  const who = me
    ? (me.renter.donor ? "contributing, unpaid" : (me.renter.email || "signed in"))
    : (isLinked() ? "signed in" : "not signed in");
  console.log(`\n${heading(`aile.sh ${APP_VERSION}`, who)}\n`);

  const rows = [];
  if (wallet) rows.push(["Balance", balanceText(wallet)]);
  else if (me && walletError) rows.push(["Balance", `${C.dim}could not be read just now${C.reset}`]);
  else if (!isLinked() && config.buyerKey) rows.push(["Balance", `${C.dim}see${C.reset} ${C.cyan}${dashboardUrl(server)}${C.reset}`]);

  const done = setUp.map((t) => getTool(t.id)?.label || t.id);
  const found = notYet.map((t) => t.label);
  rows.push(["Tools", done.length
    ? [done.join(", "), found.length ? `${C.dim}also found ${found.join(", ")}${C.reset}` : null,
      config.buyerKey ? null : `${C.yellow}no key${C.reset}`].filter(Boolean).join(dot)
    : [`${C.dim}not set up${C.reset}`, found.length ? `found ${found.join(", ")}` : null].filter(Boolean).join(dot)]);

  if (!isLinked()) {
    rows.push(["Lending", `${C.dim}not signed in${C.reset}`]);
  } else if (!me) {
    rows.push(["Lending", `${C.yellow}${explainError(meError, server)[0]}${C.reset}`]);
  } else {
    const n = s.accounts.length;
    const parts = [n
      ? `${n} account${n === 1 ? "" : "s"}${s.nodeless === n ? " (nodeless)" : s.nodeless ? ` (${s.nodeless} nodeless)` : ""}`
      : `${C.dim}no accounts connected${C.reset}`];
    const relay = relayWord(s);
    if (relay) parts.push(relay);
    // Requests are counted per MACHINE (`me.nodes`); a nodeless serve passes
    // through none, so for an all-nodeless account the count would read "0
    // served" beside real earnings. Shown only where a machine can serve.
    const served = (me.nodes || []).reduce((a, x) => a + (x.requests || 0), 0);
    if (n && s.nodeless < n) parts.push(`${count(served)} served`);
    rows.push(["Lending", parts.join(dot)]);
  }

  const local = [];
  if (config.localEnabled && config.localEndpoint) local.push(String(config.localEndpoint).replace(/^https?:\/\//, ""));
  if (s.mcp.configError) local.push(`${C.red}MCP config error${C.reset}`);
  else if (s.mcp.declared.length) {
    local.push(`MCP ${s.mcp.declared.map((d) => d.id).join(", ")}${s.mcp.advertising ? "" : `${C.yellow} (not served)${C.reset}`}`);
  }
  if (local.length) rows.push(["Local", local.join(dot)]);

  console.log(kv(rows));
  const block = next(statusSteps(s, { home: true }));
  if (block) console.log(`\n${block}`);
  console.log();
}

async function cmdStatus(args, { home = false } = {}) {
  const s = await readStatus();
  const { config, info, server, manifest, setUp, me, meError, wallet, walletError, st, holder, mcp, changed, notYet } = s;

  if (args.json) {
    console.log(JSON.stringify({
      machine: { id: info.nodeId, platform: info.platform, arch: info.arch },
      server,
      config: CONFIG_FILE,
      signedIn: isLinked(),
      account: me ? { id: me.renter.id, email: me.renter.email ?? null, donor: Boolean(me.renter.donor) } : null,
      accountError: meError ? meError.message : null,
      accounts: me ? me.accounts.length : null,
      served: me ? (me.nodes || []).reduce((a, n) => a + (n.requests || 0), 0) : null,
      balance: wallet ? {
        usdc: wallet.usdc ?? null,
        spendable: wallet.spendable ?? null,
        owedMicros: Number(wallet.owedMicros || 0),
        incoming: wallet.incoming ?? null,
      } : null,
      relay: st.running
        ? { running: true, connected: Boolean(st.connected), fatal: st.fatal || null, here: true }
        : holder ? { running: true, here: false, pid: holder.pid } : { running: false },
      key: config.buyerKey ? { prefix: describeKey(config.buyerKey), account: manifest.key?.account ?? null } : null,
      tools: setUp,
      notSetUp: notYet.map((t) => t.id),
      settingsChanged: changed,
    }, null, 2));
    return;
  }

  if (home) return printGlance(s);

  // --- `aile status`: the detail, one fact per line -----------------------------
  const dot = `${C.dim} ${sym.dot} ${C.reset}`;
  const line = (label, value) => console.log(`  ${padTo(label, 10)} ${value}`);
  const more = (value) => console.log(`             ${value}`);
  console.log(`\n${heading(`aile.sh ${APP_VERSION}`)}\n`);

  line("Machine:", `${C.cyan}${info.nodeId}${C.reset}${dot}${info.platform}/${info.arch}`);
  line("Server:", server);
  if (changed.length) {
    line("Settings:", `${C.yellow}${changed.length} changed${C.reset} ${C.dim}${changed.join(", ")}${C.reset}`
      + (config.allowInsecure === true ? `${dot}${C.yellow}plain HTTP allowed${C.reset}` : ""));
  }

  const owner = manifest.key?.account?.email;
  line("Key:", config.buyerKey ? `${describeKey(config.buyerKey)}${owner ? `${dot}${C.dim}${owner}${C.reset}` : ""}` : `${C.dim}none${C.reset}`);
  if (setUp.length || notYet.length) {
    const done = setUp.map((t) => {
      const name = manifest.tools[t.id]?.shortcut?.name;
      return `${getTool(t.id)?.label || t.id}${name ? ` ${C.dim}(${name})${C.reset}` : ""}`;
    });
    const found = notYet.map((t) => t.label);
    line("Tools:", [done.join(", ") || null, found.length ? `${C.dim}found, not set up: ${C.reset}${found.join(", ")}` : null].filter(Boolean).join(dot));
  }

  // --- the account ------------------------------------------------------------
  if (!isLinked()) {
    line("Account:", `${C.dim}not signed in${C.reset}`);
  } else if (!me) {
    const [why] = explainError(meError, server);
    line("Account:", `${C.yellow}${why}${C.reset}`);
  } else {
    // A donor row has no email and its id is not an account anyone can reach,
    // so printing the id here would be a meaningless hex string where a person
    // expects to recognise themselves.
    line("Account:", me.renter.donor
      ? `${C.yellow}contributing${C.reset}${dot}${C.dim}not paid, nothing accrues${C.reset}`
      : (me.renter.email || me.renter.id));
    if (wallet) line("Balance:", balanceText(wallet));
    else if (walletError) line("Balance:", `${C.dim}could not be read just now${C.reset}`);

    line("Accounts:", `${me.accounts.length} connected`);
    const hereId = info.nodeId;
    for (const a of me.accounts.slice(0, 8)) {
      // The SAME renderer `aile accounts` uses, so the two commands cannot
      // disagree about one account.
      const badge = accountBadge(a).trimEnd();
      const name = getProvider(a.provider)?.name || a.provider;
      // Label first, then email: with several accounts of one provider, the
      // repeated provider name tells them apart least.
      const detail = a.label || a.email;
      // Which path carries it, so status answers "is THIS box doing the work?"
      const v = servingOf(a);
      const served = v.via === "node"
        ? (v.nodeId && v.nodeId === hereId
            ? `${C.green}${sym.live} this node${C.reset}`
            : `${C.green}${sym.live} another node${C.reset}`)
        : v.via === "nodeless"
          ? `${C.cyan}nodeless${C.reset}`
          : `${C.dim}no node${C.reset}`;
      console.log(`    ${C.dim}${sym.dot}${C.reset} ${name} ${badge}${detail ? ` ${C.dim}${detail}${C.reset}` : ""}  ${served}`);
    }
    if (me.accounts.length > 8) console.log(`    ${C.dim}… and ${me.accounts.length - 8} more ${sym.dot} aile accounts${C.reset}`);

    // Across every machine, not just this one: "the account is earning" and
    // "THIS box is earning" are different numbers. The split is `aile stats`.
    const nodes = me.nodes || [];
    if (nodes.length) {
      const total = nodes.reduce((a, n) => a + (n.requests || 0), 0);
      const mine = nodes.find((n) => n.node_id === info.nodeId)?.requests || 0;
      line("Served:", `${C.bold}${count(total)}${C.reset} request${total === 1 ? "" : "s"} across ${nodes.length} machine${nodes.length === 1 ? "" : "s"}`
        + (nodes.length > 1 ? `${dot}${C.dim}${count(mine)} on this one${dot}${C.reset}${C.cyan}aile stats${C.reset}` : ""));
    }
  }

  // --- what this machine serves itself ------------------------------------------
  if (config.localEnabled && config.localEndpoint) {
    line("Local AI:", `${C.cyan}${config.localEndpoint}${C.reset}${dot}${C.yellow}not blind${C.reset}`);
  }
  // MCP, and — when none is served — WHY. Silence would read as "aile ignored
  // my file" to a lender who declared a server and stopped Docker.
  if (mcp.configError) {
    line("MCP:", `${C.red}config error${C.reset} ${C.dim}${mcp.configError}${C.reset}`);
  } else if (mcp.declared.length) {
    const ids = mcp.declared.map((d) => d.id).join(", ");
    line("MCP:", (mcp.advertising
      ? `${C.green}${mcp.advertising} server${mcp.advertising === 1 ? "" : "s"}${C.reset}`
      : `${C.yellow}0 of ${mcp.declared.length} served${C.reset}`)
      + ` ${C.dim}${ids}${C.reset}${dot}${C.yellow}not blind${C.reset}`);
    if (!mcp.advertising) more(`${C.dim}${mcp.runtime.message}${C.reset}`);
    else if (!mcp.declared.every((d) => d.egressEnforced)) more(`${C.dim}some declare network hosts: advertised, not packet-enforced${C.reset}`);
  }

  /**
   * Is this machine serving? Two sources, because `getRelayStatus` only knows an
   * agent in THIS process — and `aile status` is almost always typed into a
   * second terminal. One held by another process is reported from its lock file.
   */
  const steps = statusSteps(s, { home: false });
  if (st.running) {
    line("Relay:", st.connected ? `${C.green}CONNECTED${C.reset}`
      : st.fatal ? `${C.red}REFUSED${C.reset} ${C.dim}${st.fatal}${C.reset}`
      : `${C.yellow}reconnecting${C.reset}`);
    if (st.stats) {
      const extra = [
        st.stats.localStreamsOpened ? `${st.stats.localStreamsOpened} by your local model` : null,
        st.stats.mcpStreamsOpened ? `${st.stats.mcpStreamsOpened} by MCP` : null,
      ].filter(Boolean);
      line("Streams:", `${st.stats.activeStreams} active, ${st.stats.streamsOpened} total${extra.length ? ` ${C.dim}(${extra.join(", ")})${C.reset}` : ""}`);
    }
  } else if (holder) {
    line("Relay:", `${C.green}RUNNING${C.reset} ${C.dim}in another process (pid ${holder.pid}, since ${holder.at || "unknown"})${C.reset}`);
  } else if (isLinked()) {
    // A hint only where starting a node would do something. Unknown accounts
    // (the server did not answer) still get it; none connected, or every one
    // nodeless (served with no machine at all), do not; and an idle account
    // is already the Next block's `aile start`.
    const allNodeless = me && s.accounts.length && s.nodeless === s.accounts.length;
    const hint = !me ? `${dot}${C.cyan}aile start${C.reset}`
      : allNodeless ? `${dot}${C.dim}not needed, your accounts are nodeless${C.reset}`
      : "";
    line("Relay:", `${C.dim}not running${C.reset}${hint}`);
  }

  // Earnings, keys and spend are a browser's job, and nobody finds a page they
  // were never told about.
  if (isLinked() || config.buyerKey) line("Dashboard:", `${C.cyan}${dashboardUrl(server)}${C.reset}`);

  const block = next(steps);
  if (block) console.log(`\n${block}`);
  console.log();
}

async function cmdStart(args) {
  const config = loadConfig();
  requireToken(config);

  // One agent per machine. Node identity is derived from the machine, so a
  // second agent presents the same id and the relay — which allows one socket
  // per node — closes whichever connected first. The two then trade the
  // connection back and forth, dropping in-flight streams on every swap. See
  // src/relay/lock.js.
  const lock = acquireLock();
  if (!lock.ok) {
    die(
      `Already running on this machine (pid ${lock.holder.pid}).`,
      "Stop it first, or use `aile status` to check on it.",
    );
  }
  process.on("exit", releaseLock);

  /**
   * ONE BLOCK, THEN THE LOG. Everything the node is about to do is read first
   * — the account (a donor machine, or none connected, changes what it serves),
   * the self-hosted model and MCP — and said once as aligned rows, so the
   * timestamped event lines that follow are the only thing that moves.
   *
   * Two facts stay on it however short it gets: what the relay can read
   * (subscription traffic is blind, a self-hosted model's prompts are NOT —
   * a lender who turned that on opted into a different privacy property), and
   * that a node with nothing connected serves nothing.
   */
  let me = null;
  try {
    const insecure = !isSecureUrl(config.serverUrl) && config.allowInsecure === true;
    me = await withSpinner("Checking your account…", api.me({ serverUrl: config.serverUrl, token: config.renterToken, insecure }));
  } catch { /* offline: the node's log reports the link itself */ }
  const mcp = mcpStatus();
  // The header states why MCP is not served; tell the node's own log that it
  // has been said, so the same sentence does not follow it a line later.
  if (mcp.declared.length && !mcp.configError && !mcp.runtime.ok) {
    buildMcpCapability({ log: { warn() {} }, detect: () => mcp.runtime });
  }

  const accounts = me ? me.accounts || [] : null;
  const local = Boolean(config.localEnabled && config.localEndpoint);
  // Whether the model server answers, not just whether one is configured: a
  // stopped (or never-installed) Ollama is listed as nothing, and the header is
  // where the lender learns that. Seeded into the node so its log does not say
  // it again a line later.
  const localNow = local ? await localStatus(config) : null;
  if (localNow) seedLocalState(localNow);
  const localModels = localNow?.models?.length ? localNow.models.join(", ") : "its models";
  let host = config.serverUrl;
  try { host = new URL(config.serverUrl).host; } catch { /* shown as written */ }
  const rows = [
    ["Server", host],
    accounts === null ? null
      : me.renter?.donor ? ["Account", `${C.yellow}contributing, unpaid${C.reset} ${C.dim}· ${C.reset}${C.cyan}aile login${C.reset}${C.dim} to be paid${C.reset}`]
      : accounts.length ? ["Accounts", `${accounts.length} connected`]
      // "Serves nothing" is only true with no self-hosted model either.
      : localNow?.state === "up" ? ["Accounts", `${C.dim}none · serving your self-hosted model only${C.reset}`]
      : ["Accounts", `${C.yellow}none${C.reset} ${C.dim}· serves nothing until you run${C.reset} ${C.cyan}aile connect${C.reset}`],
    ["Relay", `subscription traffic, relayed blind ${C.dim}· ${config.maxConcurrent} streams at once${C.reset}`],
    !localNow ? null
      : localNow.state === "up" ? ["Local AI", `${config.localEndpoint} ${C.dim}·${C.reset} ${C.yellow}this machine reads those prompts${C.reset}`]
      : localNow.state === "down" ? ["Local AI", `${config.localEndpoint} ${C.dim}·${C.reset} ${C.yellow}not answering${C.reset} ${C.dim}· ${localModels} listed once it does${C.reset}`]
      : ["Local AI", `${C.red}misconfigured${C.reset} ${C.dim}${localNow.reason}${C.reset}`],
    mcp.configError ? ["MCP", `${C.red}config error${C.reset} ${C.dim}${mcp.configError}${C.reset}`]
      : !mcp.declared.length ? null
      : mcp.runtime.ok ? ["MCP", `${mcp.declared.length} server${mcp.declared.length === 1 ? "" : "s"}`]
      : ["MCP", `${C.yellow}${mcp.declared.length} not served${C.reset} ${C.dim}· ${mcp.runtime.short ?? mcp.runtime.message}${C.reset}`],
    config.autoReconnect === false ? ["Reconnect", `${C.yellow}off${C.reset}`] : null,
  ];
  console.log(`\n${heading("aile.sh", "lending from this machine · Ctrl+C stops")}\n`);
  console.log(kv(rows.filter(Boolean)));
  console.log(`\n${C.dim}${C.reset}${C.cyan}aile status${C.reset}${C.dim} in another terminal shows what it is serving.${C.reset}\n`);

  const shutdown = (sig) => {
    console.log(`\n${C.dim}stopping (${sig})…${C.reset}`);
    stopRelayAgent(sig);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await startRelayAgent();
  } catch (e) {
    die(`Failed to start: ${e.message}`);
  }

  // The supervisor keeps this process alive to reconnect. But once it has given
  // up — the server refuses this machine and re-registering did not change that
  // — there is nothing left to wait for, and staying resident would present an
  // idle process as a working node. Exit non-zero so a service manager sees a
  // failure rather than restarting into the same wall forever.
  const heartbeat = setInterval(() => {
    const st = getRelayStatus();
    if (st.fatal) {
      clearInterval(heartbeat);
      // The supervisor has already said why and what to do; saying it twice
      // made one refusal look like two problems.
      die(st.fatal);
    }
  }, 1000);
  if (heartbeat.unref) heartbeat.unref();
  setInterval(() => {}, 1 << 30);
}

async function cmdLogout(args = {}) {
  // THE CODING TOOLS ARE A SEPARATE CREDENTIAL. Signing out ends this machine's
  // account token; the API key `aile setup` put into Claude Code, Codex and the
  // rest keeps working — and billing — until it is removed or revoked. Say so,
  // and offer to remove it while this machine can still revoke it.
  const manifest = loadManifest();
  const tools = toolsSetUp(manifest);
  let removeTools = Boolean(args.tools);
  if (tools.length && !removeTools && isInteractive() && !args.yes) {
    const who = manifest.key?.account?.email ? ` (${manifest.key.account.email})` : "";
    console.log(`Your coding tools still use aile: ${tools.map((t) => t.id).join(", ")} · key ${manifest.key?.prefix || ""}${who}.`);
    removeTools = await promptConfirm("Remove aile from them too, and revoke the key?", { defaultYes: false });
  }
  if (removeTools && tools.length) await setupRemove({ yes: true, revoke: true }, []);

  const wasSignedIn = Boolean(loadConfig().renterToken);
  stopRelayAgent("signed out");
  saveConfig({ renterToken: "" });
  clearState();
  if (wasSignedIn) console.log(`${C.green}Signed out.${C.reset} ${C.dim}Connected accounts remain on the server.${C.reset}`);
  else console.log(`${C.dim}This machine was not signed in.${C.reset}`);
  if (tools.length && !removeTools) {
    console.log(`${C.dim}Your coding tools still use aile. Remove it:${C.reset} ${C.cyan}aile setup --remove${C.reset}${C.dim} · move them to another account:${C.reset} ${C.cyan}aile login${C.reset}${C.dim}, then${C.reset} ${C.cyan}aile setup refresh --new-key${C.reset}`);
  }
}

/**
 * Register this machine without a full sign-in. Useful when a token was issued
 * out of band; `aile login` does this automatically.
 */
async function cmdRegister(args) {
  banner();
  const server = args.server || loadConfig().serverUrl;
  const insecure = checkTransport(server, args);
  const token = args.token || process.env.AILE_TOKEN || loadConfig().renterToken;
  if (!token) die("No account token.", "Run `aile login`, or pass --token.");

  saveConfig({ serverUrl: server, renterToken: String(token).trim() });
  try {
    await enrollNodeOrRotate({
      serverUrl: server, renterToken: String(token).trim(),
      log: (m) => console.log(m),
    });
  } catch (e) {
    die(`Registration failed: ${e.message}`, "The token was saved; retry with `aile register`.");
  }
  console.log(`\n${C.green}Registered.${C.reset} Machine ${C.cyan}${getNodeId()}${C.reset} → ${server}`);
  console.log(`${C.dim}${insecure ? "over plain HTTP · " : ""}token stored 0600 at ${CONFIG_FILE}${C.reset}\n`);
}

/**
 * Contribute this machine without an account.
 *
 * Signing in is how you get PAID. It is not what the network needs in order to
 * receive capacity, and for a while those were the same thing — `aile start`
 * refused without a token, so someone who wanted to point a spare machine at the
 * network and walk away simply could not.
 *
 * The consent this asks for is narrow and specific, and it is asked ONCE, here,
 * because this is the only moment the person deciding is present. Two facts have
 * to be plainly true to them before they type y, and neither is discoverable
 * later:
 *
 *   1. Nothing accrues. Not "you can claim it later" — there is no balance, and
 *      there is no account for one to sit in.
 *   2. Buyers still pay. The donation is of the payout, not of the price. Someone
 *      who assumed they were making capacity free for buyers has been misled, and
 *      that is the kind of misunderstanding people are right to be angry about.
 *
 * `--yes` skips the prompt, for images and provisioning scripts. It does not skip
 * printing what was agreed to, because the person who reads that output later is
 * often not the person who wrote the script.
 */
async function cmdDonate(args, { quiet = false } = {}) {
  if (!quiet) banner();
  const existing = loadConfig();
  const server = args.server || existing.serverUrl;
  const insecure = checkTransport(server, args);

  if (existing.renterToken) {
    // Refusing rather than overwriting: replacing a real account's token with a
    // donor one would silently stop their earnings, and the token it replaced is
    // not recoverable from here.
    die(
      "This machine is already signed in.",
      "Contributing anonymously would replace that. Run `aile logout` first if that is what you want.",
    );
  }

  console.log(`\n  ${C.bold}Contribute this machine${C.reset}`);
  console.log(`  ${C.dim}No account, no sign-up, nothing to remember.${C.reset}\n`);
  console.log(`  Your machine carries encrypted traffic for the network. What that means:\n`);
  console.log(`    ${C.green}·${C.reset} Requests stay unreadable here — the same blind relay as everyone else.`);
  console.log(`    ${C.green}·${C.reset} You can add AI accounts and a self-hosted model, exactly as a signed-in machine can.`);
  console.log(`    ${C.yellow}·${C.reset} ${C.bold}You are not paid.${C.reset} Nothing accrues, and nothing can be claimed later.`);
  console.log(`    ${C.yellow}·${C.reset} Buyers still pay the normal rate. You are donating the earnings, not the price.\n`);
  console.log(`  ${C.dim}Want to be paid for this instead? ${C.reset}${C.cyan}aile login${C.reset}${C.dim} — it takes a minute and an email.${C.reset}\n`);

  if (!args.yes) {
    if (!isInteractive()) {
      die(
        "Cannot ask for confirmation — stdin is not a terminal.",
        "Pass --yes to contribute non-interactively: aile donate --yes",
      );
    }
    if (!(await promptConfirm("  Contribute this machine unpaid?", { defaultYes: false }))) {
      console.log(`\n  ${C.dim}Nothing changed.${C.reset}\n`);
      return;
    }
  }

  let result;
  try {
    result = await enrollDonor({ serverUrl: server, log: (m) => console.log(m) });
  } catch (e) {
    die(`Could not enrol this machine: ${e.message}`, "Nothing was saved. Check the connection and try again.");
  }

  // The token is a real bearer credential for the donor row, so it is stored the
  // same way and with the same permissions as any other. It is also the ONLY
  // copy: the server cannot reissue it, because there is no identity to prove.
  saveConfig({ serverUrl: server, renterToken: result.renterToken });

  console.log(`\n${C.green}Thank you — this machine is contributing.${C.reset}`);
  console.log(`${C.dim}Machine ${getNodeId()} · ${insecure ? "over plain HTTP · " : ""}stored 0600 at ${CONFIG_FILE}${C.reset}`);
  // Said plainly because it is the one operational consequence of anonymity, and
  // the moment it bites is the moment the file is gone and it is too late.
  console.log(`${C.dim}There is no account behind this. Lose that file and this machine simply enrols again.${C.reset}`);

  if (result.pricing && result.pricing.paid === false) {
    console.log(`\n${C.dim}This server is currently giving donated capacity away for free.${C.reset}`);
  }

  console.log(`\nNext: ${C.cyan}aile connect${C.reset} to add an AI account, then ${C.cyan}aile start${C.reset}\n`);
}

/**
 * The account's wallet — where earnings land, and what a withdrawal spends from.
 *
 *   aile wallet          show the wallet and its balance
 *   aile wallet --json   the same, for a script
 *
 * ============================================================================
 * THIS USED TO SHOW A PAYOUT ADDRESS AND NOW SHOWS A BALANCE, and the difference
 * is the whole change behind it.
 *
 * There used to be a destination on file: a wallet the lender already owned,
 * recorded once from a signature, unchangeable by any route. This command's job
 * was largely to explain that — why it could not be replaced, why nothing was
 * created, why there was nothing to export. Every one of those sentences was
 * true and every one of them is now false.
 *
 * WHAT IS TRUE INSTEAD. The account has one wallet, minted at sign-in, and it is
 * where payments arrive. Where money goes NEXT is typed on the withdraw page at
 * the moment it is sent, confirmed beside the amount, and stored nowhere — so
 * there is no destination for this command to show, and none for anyone who
 * reaches the account to quietly re-point.
 *
 * WHAT DID NOT CHANGE, AND IS THE MORE IMPORTANT HALF. This client still never
 * handles a private key. The key is in the wallet provider's enclave, and taking
 * it out is a browser errand — `/wallet/export` returns ciphertext addressed to
 * the tab that asked, which is not a thing a terminal can decrypt. So there is
 * still no `--new` and no `--replace`: not because a destination is frozen, but
 * because a wallet is not a setting, and a key printed into a scrollback buffer
 * would be a worse place for it than anywhere it currently is.
 *
 * So the questions this answers are: how much is there, where is it, and can
 * this server spend it. The last one gets an honest "yes, with your session" —
 * which is exactly why the withdraw page asks for a code when 2FA is on.
 * ============================================================================
 */
async function cmdWallet(args) {
  banner();
  const config = loadConfig();
  requireToken(config);
  const server = args.server || config.serverUrl;
  const insecure = checkTransport(server, args);

  let res;
  try {
    res = await withSpinner("Reading your wallet…", api.wallet({ serverUrl: server, token: config.renterToken, insecure, balance: true }));
  } catch (e) {
    die(...explainError(e, server));
  }

  if (args.json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (!res.wallet) {
    console.log(`\n  ${C.dim}No wallet.${C.reset}`);
    console.log(`  ${res.reason || "This account has no wallet yet."}\n`);
    // A donated machine is told nothing further ON PURPOSE: nothing accrues to it
    // by its own choice, so instructions for getting paid would be noise. Its
    // reason already says the one thing worth saying — sign in instead.
    return;
  }

  console.log(`\n  Wallet:   ${C.cyan}${res.wallet.address}${C.reset}`);
  // The balance is why anybody runs this. Null is "could not be read", printed as
  // that rather than as a zero — telling a lender they have nothing when the RPC
  // was merely unreachable is the one wrong answer this line could give.
  const usdc = res.wallet.usdc;
  console.log(`  Balance:  ${usdc === null || usdc === undefined
    ? `${C.dim}could not be read just now${C.reset}`
    : `${C.green}$${usdc}${C.reset} ${C.dim}USDC${C.reset}`}`);

  /**
   * WHAT IS ALREADY SPOKEN FOR, WHICH IS NOT THE SAME NUMBER.
   *
   * Requests bought against this balance are subtracted from what may be spent the
   * moment they are reserved, while the USDC stays on chain until settlement
   * batches it. Printing only the chain figure would report an account as funded
   * right up to the request that gets refused — the confusion this line exists to
   * prevent, so it is worth two lines of output when there is anything to say.
   *
   * ONLY WHEN THERE IS. Almost every account owes nothing almost always, and a
   * permanent "$0.00 owed" would ask everybody to understand batched settlement in
   * order to read their own balance.
   */
  const owed = Number(res.wallet.owedMicros || 0);
  if (owed > 0) {
    const spendable = res.wallet.spendable;
    console.log(`  Owed:     ${C.yellow}$${(owed / 1_000_000).toFixed(6)}${C.reset} ${C.dim}for requests already served, not yet paid out${C.reset}`);
    if (spendable !== null && spendable !== undefined) {
      console.log(`  Spendable: ${C.green}$${spendable}${C.reset} ${C.dim}balance minus what is owed${C.reset}`);
    }
  }

  /**
   * THE OTHER DIRECTION: WHAT IS OWED TO YOU FOR LENDING.
   *
   * Everything above is the buying side. A lender read `Balance: $0.00` with
   * nothing to explain it — their earnings exist, they are counted, and they have
   * not been sent yet because a Solana fee costs more than one small request is
   * worth. The balance line alone reports that as nothing at all.
   *
   * THE WHEN COMES FROM THE SERVER AND IS NOT COMPUTED HERE. The threshold, the
   * maximum age and the sweep period are that deployment's settings; a client
   * counting down from hardcoded defaults would print a confident wrong minute,
   * and would keep printing it after an operator changed one. So `settlement`
   * is read, never derived.
   *
   * ONLY WHEN THERE IS SOMETHING TO SAY, matching the `owed > 0` rule above and
   * for the same reason: a permanent "Incoming: $0.0000" asks somebody who only
   * buys to understand batched settlement in order to read their own balance.
   */
  const incoming = Number(res.wallet.incomingMicros || 0);
  if (incoming > 0) {
    const s = res.wallet.settlement || {};
    const reqs = Number(s.requests || 0);
    console.log(`  Incoming: ${C.green}$${(incoming / 1_000_000).toFixed(4)}${C.reset} ${C.dim}from ${count(reqs)} request${reqs === 1 ? "" : "s"} already served, not yet paid out${C.reset}`);
    if (s.firstPayout) {
      /**
       * ====================================================================
       * THE FIRST PAYOUT IS AN AMOUNT, NEVER A COUNTDOWN.
       *
       * Checked BEFORE `dueNow`, because a first batch can be well past the
       * batching threshold and still not go anywhere. The first payment to a
       * wallet has to open a USDC token account for it, the network charges
       * about two hundred times a transfer's fee for that, and — unlike the
       * batching threshold — no amount of waiting releases it. So `etaMs` comes
       * back null and the honest answer is how much more, not how much longer.
       *
       * Printing minutes here would be the "usually within a minute" bug
       * arriving in the terminal: a confident duration for something duration
       * does not deliver.
       * ====================================================================
       */
      const short = Number(s.openShortfallMicros || 0);
      const at = Number(s.openAtMicros || 0);
      console.log(`            ${C.dim}$${(short / 1_000_000).toFixed(4)} more, to $${(at / 1_000_000).toFixed(2)}, before the first one is sent${C.reset}`);
      console.log(`            ${C.dim}a first payment also opens a USDC account for your wallet, which${C.reset}`);
      console.log(`            ${C.dim}costs far more than a transfer — after that, the ordinary schedule${C.reset}`);
    } else if (s.dueNow) {
      console.log(`            ${C.dim}due now — it goes out on the next settlement pass${C.reset}`);
    } else {
      // BOTH HALVES OF "WHICHEVER COMES FIRST", because either one can be the
      // one that fires. A lender told only about the amount waits for traffic
      // that may never come; one told only about the clock cannot see that four
      // more requests would send it today.
      const short = Number(s.shortfallMicros || 0);
      const mins = Math.ceil(Number(s.etaMs || 0) / 60_000);
      console.log(`            ${C.dim}$${(short / 1_000_000).toFixed(4)} more, or ${mins <= 1 ? "a minute" : `${mins} minutes`}, before the batch is sent${C.reset}`);
    }
  }

  /**
   * ==========================================================================
   * WHOSE WALLET THE EARNINGS ACTUALLY LAND IN, WHICH IS NOT ALWAYS THIS ONE.
   *
   * Somebody who signed in with their own Solana wallet is paid straight to that
   * address: the money never enters the account below, there is nothing to
   * withdraw for it, and there is no key of theirs on the server to export. The
   * three paragraphs after this one are all about a wallet the server MINTED,
   * and every sentence in them is false for that person — "earnings arrive here"
   * most of all.
   *
   * READ FROM THE SERVER, NEVER GUESSED. `selfCustody` and `payTo` come back
   * from `/wallet`, because which of the two arrangements an account is in is a
   * fact about that account and not something a client can infer from an address.
   * ==========================================================================
   */
  if (res.wallet.selfCustody) {
    console.log(`  ${C.dim}Spending balance. Earnings go straight to your own wallet:${C.reset}`);
    console.log(`  ${C.cyan}${res.wallet.payTo}${C.reset}`);

    console.log(`\n  ${C.bold}Your earnings need no withdrawal${C.reset}`);
    console.log(`  ${C.dim}They are settled to the wallet you signed in with, so they are yours the`);
    console.log(`  moment they land — nothing to claim, and no key of yours held here. The`);
    console.log(`  balance above is what you added for spending, and ${C.reset}${C.cyan}${webOrigin(server)}/wallet/withdraw${C.reset}`);
    console.log(`  ${C.dim}sends it anywhere you name.${C.reset}\n`);
    return;
  }

  console.log(`  ${C.dim}Earnings arrive here. Solana.${C.reset}`);

  console.log(`\n  ${C.bold}To send it somewhere${C.reset}`);
  console.log(`  ${C.dim}Open ${C.reset}${C.cyan}${webOrigin(server)}/wallet/withdraw${C.reset}${C.dim} and paste the address to send`);
  console.log(`  to. Nothing is on file, so a withdrawal names where it is going at the`);
  console.log(`  moment you make it — which is also why nobody who reaches your account`);
  console.log(`  can point your earnings anywhere in advance.${C.reset}\n`);

  // "Can this server spend my money" is the question a wallet view raises, and a
  // balance alone cannot answer it. Answered every time rather than on request,
  // and answered honestly: it can sign, and the protections are named.
  console.log(`  ${C.dim}The key lives in the wallet provider's secure enclave — not in this`);
  console.log(`  program, and not in a file on this machine. You can take it out at any`);
  console.log(`  time from ${C.reset}${C.cyan}${server}/wallet/export${C.reset}${C.dim}, which hands it to your browser`);
  console.log(`  encrypted; the server relays ciphertext it cannot read.${C.reset}`);
  console.log(`  ${C.dim}Withdrawals are signed on your instruction with your browser session. If`);
  console.log(`  you turn on two-step verification, they ask for a code as well.${C.reset}\n`);
}

/**
 * Set up (or inspect) self-hosted model lending.
 *
 *   aile local                      show current state
 *   aile local http://…:11434       point at an endpoint and turn it on
 *   aile local --off                stop lending it
 *
 * A dedicated command rather than three `aile config` writes, because turning
 * this on changes the privacy story and that deserves saying out loud once, in
 * the place where the decision is actually made.
 */
async function cmdLocal(args) {
  banner();
  const config = loadConfig();

  if (args.off) {
    const res = updateSettings({ localEnabled: false });
    if (!res.ok) die(res.error);
    console.log(`\n${C.green}Self-hosted lending is off.${C.reset} ${C.dim}The endpoint is remembered.${C.reset}\n`);
    return;
  }

  const endpoint = args._[1] || args.endpoint;

  if (!endpoint) {
    if (!config.localEnabled || !config.localEndpoint) {
      console.log(`\n${C.dim}Not lending a self-hosted model.${C.reset}\n`);
      console.log(`Lend one with: ${C.cyan}aile local http://127.0.0.1:11434${C.reset}`);
      console.log(`${C.dim}Works with Ollama, vLLM, LM Studio, llama.cpp — anything`);
      console.log(`speaking the OpenAI API.${C.reset}\n`);
      return;
    }
    console.log(`\n  Endpoint:  ${C.cyan}${config.localEndpoint}${C.reset}`);
    const now = await localStatus(config);
    console.log(`  Status:    ${now.state === "up" ? `${C.green}answering${C.reset}`
      : now.state === "down" ? `${C.yellow}not answering${C.reset} ${C.dim}(${now.reason}) · listed once it does${C.reset}`
      : `${C.red}misconfigured${C.reset} ${C.dim}${now.reason}${C.reset}`}`);
    const models = await discoverLocalModels(config);
    console.log(`  Models:    ${models.length ? models.join(", ") : `${C.yellow}none found${C.reset}`}`);
    if (models.length && now.state === "up") console.log(`  Buyers:    ${C.cyan}${models.map((m) => `local/${m}`).join(", ")}${C.reset}`);
    console.log(`  Privacy:   ${C.yellow}not blind${C.reset} ${C.dim}— requests run here, so this machine reads them${C.reset}\n`);
    return;
  }

  // Validate before saving. Writing a value that cannot serve, then reporting
  // success, would leave the user debugging a node that silently never gets work.
  let target;
  try {
    target = await resolveLocalTarget(endpoint);
  } catch (e) {
    die(`That endpoint will not work: ${e.message}`);
  }

  const res = updateSettings({ localEndpoint: endpoint, localEnabled: true });
  if (!res.ok) die(res.error);

  console.log(`\n${C.green}Lending your self-hosted model${C.reset} ${C.dim}${endpoint}${C.reset}`);

  const models = await discoverLocalModels(res.value);
  const now = await localStatus(res.value);
  if (now.state === "down") {
    // Named models used to be reported as advertised whether or not anything
    // ran them; the node now lists them only while the endpoint answers.
    console.log(`${C.yellow}Nothing answers there yet${C.reset} ${C.dim}(${now.reason}). ${models.length ? models.join(", ") : "Its models"} will be listed once it does.${C.reset}`);
  } else if (models.length) {
    console.log(`${C.dim}Advertising: ${models.join(", ")}${C.reset}`);
    console.log(`${C.dim}Buyers send: ${C.reset}${C.cyan}${models.map((m) => `local/${m}`).join(", ")}${C.reset}`);
  } else {
    console.log(`${C.yellow}Could not list models${C.reset} ${C.dim}at ${target.host}:${target.port}.${C.reset}`);
    console.log(`${C.dim}Start it, or name them: ${C.reset}${C.cyan}aile config localModels llama3,mistral${C.reset}`);
  }

  console.log(`\n${C.yellow}Worth knowing:${C.reset} this traffic is ${C.yellow}not blind${C.reset}.`);
  console.log(`${C.dim}The model runs on this machine, so this machine reads the prompts it`);
  console.log(`answers. Subscription traffic is unaffected and stays blind.${C.reset}`);
  console.log(`\nStart serving: ${C.cyan}aile start${C.reset}\n`);
}

/**
 * ===========================================================================
 * BUYING: who serves you, and what they have actually done.
 *
 * Everything above this line is about LENDING — connecting accounts, running
 * the node, being paid. These are the other half: a buyer choosing whose machine
 * answers their requests, and seeing afterwards what that cost.
 *
 * NOTHING HERE IS AN OPINION, AND THAT IS THE DESIGN. A star rating was built
 * and taken out. What a buyer sees instead is counted: `aile lenders` prints how
 * many requests each machine has relayed, and `aile spend` prints what each
 * lender has charged THIS account. Neither can be manufactured — a lender cannot
 * move the first without doing the work, and a buyer cannot move either at all —
 * so there is nothing to brigade, nothing to moderate, and no first-review
 * problem where a new lender is unrankable until somebody guesses.
 *
 * WHY A LENDER IS A HANDLE AND NOT A NODE ID. `aile lenders` prints a machine id
 * (that is what `x-aile-node` pins) and a handle beside it. They are not
 * interchangeable: a node id is minted on the lender's own machine and can be
 * remade at will, so it names a BOX. The handle is derived from the account,
 * which cannot be rotated without losing its wallet, its credentials and its
 * history, so it names a LENDER — and it is what `aile spend` keys history on,
 * because a lender who replaces a machine is still the same counterparty.
 * ===========================================================================
 */

/** `2.5` → `$2.50`. Server-formatted strings are preferred; this is the fallback. */
const usd = (n) => (n === null || n === undefined || !Number.isFinite(Number(n))
  ? "—" : `$${Number(n).toFixed(2)}`);

/** `1204` → `1,204`. Wide numbers in a column are read wrong without separators. */
const count = (n) => Number(n || 0).toLocaleString("en-US");

/** Strip colour before measuring — escapes have width 0 on screen and length in JS. */

/**
 * One lender's providers, as the same two symbols the web page uses.
 *
 * ✓ IS ATTESTATION AND · IS NOT, AND THEY ARE NOT SHADES OF ONE THING. The server
 * recomputes `verified` from its own `provider_tokens` table rather than believing
 * what a node advertised about itself — so this symbol means "a provider signed a
 * token proving this account is theirs", which is a claim no lender can make about
 * themselves. `live` is the separate, weaker fact that the credential answered a
 * probe recently. Both are shown; neither is folded into the other.
 */
function providerChips(providers = []) {
  return providers.map((p) => {
    const mark = p.verified ? `${C.green}✓${C.reset}` : `${C.dim}·${C.reset}`;
    const name = p.live ? p.provider : `${C.dim}${p.provider}${C.reset}`;
    return `${mark}${name}${p.accounts > 1 ? `${C.dim}×${p.accounts}${C.reset}` : ""}`;
  }).join(" ");
}

/**
 * Who is lending right now.
 *
 *   aile lenders                          everyone online
 *   aile lenders --model claude-opus-5    …with what each would charge for it
 *   aile lenders --max-price 8            …under $8 per million tokens, both ways
 *   aile lenders --verified               …attested subscriptions only
 *   aile lenders --provider codex         …offering that subscription
 *   aile lenders --seller L4f1a…          …one seller, whichever machine is free
 *   aile lenders --node a3f19c2…          …one specific machine
 *   aile lenders --min-served 100         …with a track record of at least 100
 *   aile lenders --free                   …with capacity free this second
 *   aile lenders --sort served            …ordered for reading, not for routing
 *   aile lenders --json                   the server's answer, for a script
 *
 * EVERY FLAG IS A QUERY PARAMETER AND NOTHING IS FILTERED LOCALLY. The server
 * applies them, echoes back what it applied, and this prints the result. A local
 * filter would quietly disagree with `/market` and with the web page over who is
 * available — three answers to one question.
 *
 * THE ORDER IS THE SERVER'S AND IS NEVER RE-SORTED HERE. By default it is also
 * THE ORDER REQUESTS ARE ROUTED IN — cheapest first, ties to the least busy
 * machine — so the top row is the machine a request goes to right now.
 * `--sort` asks the SERVER for a different order and the footer then says the
 * listing is for reading; sorting locally would print a table that disagrees
 * with what actually happens, which is worse than no table.
 *
 * --seller AND --node ARE DIFFERENT QUESTIONS. A lender may run several
 * machines: `--seller` means "this person, whichever of their machines is
 * free", `--node` means "that box". Each has its own serve-path header
 * (`x-aile-lender`, `x-aile-node`), so either choice is one you can act on.
 *
 * SERVED IS A COUNT AND NOTHING ELSE. It is requests this machine has relayed,
 * counted from the ledger, and it is the only standing signal in the listing.
 * There is deliberately no earnings figure beside it — that is a stranger's
 * income, and `aile spend` shows the half that is the reader's own business.
 * `--min-served` is offered as a FLOOR and deliberately not as the default
 * order: ranking by traffic would bury a cheap new machine under an expensive
 * established one every time, which is how a marketplace stops having new
 * entrants.
 */
async function cmdLenders(args) {
  banner();
  const config = loadConfig();
  requireToken(config);
  const server = args.server || config.serverUrl;
  const insecure = checkTransport(server, args);

  /**
   * A BAD --sort IS CAUGHT HERE RATHER THAN SENT.
   *
   * The server falls back to price for an order it does not know, which is the
   * right thing for a URL somebody edited by hand but the wrong thing for a
   * typed flag: `--sort srved` would print a price-ordered table under a heading
   * that says otherwise and never mention it. Naming the four is also the only
   * place a reader finds out what they are.
   */
  const SORTS = ["price", "served", "free", "uptime"];
  const sort = args.sort ? String(args.sort).toLowerCase() : null;
  if (sort && !SORTS.includes(sort)) {
    die(`--sort ${args.sort} is not an order. Pick one of: ${SORTS.join(", ")}`);
  }

  let res;
  try {
    res = await withSpinner("Asking who is lending…", api.market({
      serverUrl: server, token: config.renterToken, insecure,
      model: args.model || null,
      maxPrice: args["max-price"] ?? args.maxPrice ?? null,
      verified: Boolean(args.verified),
      provider: args.provider || null,
      handle: args.seller || args.lender || null,
      nodeId: args.node || args["node-id"] || null,
      minServed: args["min-served"] ?? args.minServed ?? null,
      freeOnly: Boolean(args.free || args["free-only"]),
      sort,
    }));
  } catch (e) {
    // A bad `--max-price` is a 400 with the server's own sentence, which is more
    // use than "request failed" — it names the unit the number is in.
    if (e instanceof ApiError && e.status === 400) die(e.message);
    die(...explainError(e, server));
  }

  if (args.json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  const lenders = res.lenders || [];
  const priced = Boolean(res.priced);

  if (!lenders.length) {
    /**
     * AN EMPTY TABLE MUST NAME THE THING TO RELAX.
     *
     * "No lenders" sends somebody to debug their network when the fix is one
     * number in a flag. The server echoes back the filters it applied and how
     * many machines are online, which is exactly enough to tell "nobody is
     * lending" apart from "your ceiling is below all of them" — two situations
     * with opposite responses.
     */
    const online = res.online || 0;
    if (!online) {
      console.log(`\n  ${C.dim}Nobody is lending right now.${C.reset}`);
      console.log(`  ${C.dim}Requests will fail until a machine connects.${C.reset}\n`);
      return;
    }
    console.log(`\n  ${C.yellow}${count(online)} machine${online === 1 ? " is" : "s are"} lending, but none match these filters.${C.reset}\n`);
    /**
     * ONE LINE PER FILTER THAT IS ACTUALLY ON, naming the flag to drop.
     *
     * The narrowest filters print first — pinning one seller or one machine is
     * far more often the reason a listing is empty than a price ceiling is, and
     * a reader takes the first suggestion. Everything here is read from the
     * server's echo rather than from `args`, so it describes what was applied
     * and not what was typed.
     */
    const f = res.filters || {};
    if (f.nodeId) console.log(`  ${C.dim}Drop ${C.reset}${C.cyan}--node ${f.nodeId}${C.reset}${C.dim} — that machine is not online, or not lending.${C.reset}`);
    if (f.handle) console.log(`  ${C.dim}Drop ${C.reset}${C.cyan}--seller ${f.handle}${C.reset}${C.dim} — none of their machines are online.${C.reset}`);
    if (f.maxUsdPerMtok !== null && f.maxUsdPerMtok !== undefined) {
      console.log(`  ${C.dim}Raise the ceiling: ${C.reset}${C.cyan}--max-price ${Number(f.maxUsdPerMtok) * 2}${C.reset}`);
    }
    if (f.minServed !== null && f.minServed !== undefined) {
      console.log(`  ${C.dim}Or lower ${C.reset}${C.cyan}--min-served ${f.minServed}${C.reset}${C.dim} — a new machine has served nobody yet.${C.reset}`);
    }
    if (f.freeOnly) console.log(`  ${C.dim}Or drop ${C.reset}${C.cyan}--free${C.reset}${C.dim} — busy machines free up between requests.${C.reset}`);
    if (f.verified) console.log(`  ${C.dim}Or drop ${C.reset}${C.cyan}--verified${C.reset}${C.dim}, which requires a signed provider token.${C.reset}`);
    if (f.provider) console.log(`  ${C.dim}Or drop ${C.reset}${C.cyan}--provider ${f.provider}${C.reset}`);
    if (f.model) console.log(`  ${C.dim}Or try another ${C.reset}${C.cyan}--model${C.reset}${C.dim} — nobody online serves ${f.model}.${C.reset}`);
    const anyFilter = f.maxUsdPerMtok || f.verified || f.provider || f.model
      || f.handle || f.nodeId || f.minServed || f.freeOnly;
    if (!anyFilter) {
      console.log(`  ${C.dim}None of them can be paid on this deployment, so none can take a request.${C.reset}`);
    }
    console.log();
    return;
  }

  /**
   * THE HEADING SAYS WHICH ORDER THIS IS, because only one of them is a promise.
   *
   * Cheapest-first is what the router does, so the top row is genuinely the
   * machine a request goes to. The other three are ways of reading the same
   * list and change nothing about routing — printing "listed in the same order
   * your request is routed in" over a `--sort served` table would be a lie the
   * buyer acts on by picking the top row.
   */
  const ordered = res.filters?.sort && res.filters.sort !== "price"
    ? `sorted by ${res.filters.sort} — for reading; requests still route cheapest-first`
    : "listed in the same order your request is routed in";
  console.log(`\n${C.bold}Lenders${C.reset} ${C.dim}${count(res.online || lenders.length)} online · ${ordered}${C.reset}\n`);

  // Column widths from the data, so a long provider list does not shear the table.
  const rows = lenders.map((l, i) => ({
    n: String(i + 1).padStart(2),
    machine: String(l.nodeId || "").slice(0, 20),
    // The LENDER, beside the machine. Both are printed because they answer
    // different questions: the machine is what `x-aile-node` pins, and the handle
    // is what a lender is still called after they replace it.
    handle: `${C.dim}${String(l.handle || "").slice(0, 9)}…${C.reset}`,
    providers: providerChips(l.providers),
    // A PRICE ONLY EXISTS FOR A MODEL. With none named the server sends no price
    // and this column says to name one, rather than printing a number the buyer
    // could not be charged.
    price: !priced ? `${C.dim}--model${C.reset}`
      : l.price
        ? `${l.price.inUsd || usd(l.price.in)} ${C.dim}/${C.reset} ${l.price.outUsd || usd(l.price.out)}${l.price.known ? "" : ` ${C.yellow}~${C.reset}`}`
        : `${C.dim}—${C.reset}`,
    served: count(l.served),
    free: `${l.capacity?.free ?? 0} free`,
  }));

  const w = (k, head) => Math.max(width(head), ...rows.map((r) => width(r[k])));
  const H = {
    machine: "MACHINE", handle: "LENDER", providers: "PROVIDERS",
    price: "PRICE in/out", served: "SERVED",
  };
  const wm = w("machine", H.machine), wh = w("handle", H.handle), wp = w("providers", H.providers);
  const wpr = w("price", H.price), ws = w("served", H.served);

  console.log(`  ${C.dim}${padTo("", 2)}  ${padTo(H.machine, wm)}  ${padTo(H.handle, wh)}  ${padTo(H.providers, wp)}  ${padTo(H.price, wpr)}  ${padTo(H.served, ws)}${C.reset}`);
  for (const r of rows) {
    console.log(`  ${C.cyan}${r.n}${C.reset}  ${padTo(r.machine, wm)}  ${padTo(r.handle, wh)}  ${padTo(r.providers, wp)}  ${padTo(r.price, wpr)}  ${padTo(r.served, ws)}  ${C.dim}${r.free}${C.reset}`);
  }

  console.log(`\n  ${C.green}✓${C.reset}${C.dim} a provider signed a token proving the account is theirs · ${C.reset}${C.dim}·${C.reset}${C.dim} claimed only${C.reset}`);
  console.log(`  ${C.dim}SERVED is requests actually relayed, counted from the ledger — nobody typed it.${C.reset}`);
  if (priced && rows.some((r) => r.price.includes("~"))) {
    console.log(`  ${C.yellow}~${C.reset}${C.dim} no published rate for that model — estimated from its family${C.reset}`);
  }
  if (!priced) {
    console.log(`  ${C.dim}Prices need a model: ${C.reset}${C.cyan}aile lenders --model claude-opus-5${C.reset}`);
  }

  /**
   * EVERY HEADER, PRINTED WHERE IT WILL BE PASTED, AND FILLED IN FROM ROW 1.
   *
   * A comparison you cannot act on is a table. These are the levers that make
   * this listing mean something: the buyer picks a row and then pins it. The
   * node id and handle are taken from the top row rather than shown as
   * `<machine>`, so the common case — "the one at the top, every time" — is a
   * copy rather than a substitution the reader has to perform.
   *
   * THE FLAGS WITH NO HEADER ARE NAMED AS SUCH. `--min-served`, `--free` and
   * `--sort` narrow or reorder what you READ; there is no header for them
   * because routing already goes to the cheapest machine that can answer. Saying
   * so is better than leaving a reader to invent `x-aile-sort` and wonder why
   * nothing changed.
   */
  // The body's model names its provider, or the request is a 400. Filled in from
  // row 1 like the headers below; self-hosted is listed as "self-hosted" and
  // addressed as `local/`.
  const exRow = lenders[0]?.providers?.find((p) => !res.filters?.provider || p.provider === res.filters.provider);
  const exProvider = res.filters?.provider || exRow?.provider || "<provider>";
  const exModel = `${exProvider === "self-hosted" ? "local" : exProvider}/${res.filters?.model || exRow?.models?.[0] || "<model>"}`;
  console.log(`\n  ${C.bold}Choosing one${C.reset}`);
  console.log(`  ${C.dim}Your ${C.reset}${C.cyan}/v1${C.reset}${C.dim} body's model must be <provider>/<model>: ${C.reset}${C.cyan}"model": "${exModel}"${C.reset}`);
  console.log(`  ${C.dim}Self-hosted is ${C.reset}${C.cyan}local/<model>${C.reset}${C.dim}. A bare id is a 400 unless ${C.reset}${C.cyan}x-aile-provider${C.reset}${C.dim} names it.${C.reset}`);
  console.log(`  ${C.dim}Send these headers with your ${C.reset}${C.cyan}/v1${C.reset}${C.dim} request:${C.reset}`);
  console.log(`    ${C.cyan}x-aile-node:${C.reset} ${lenders[0]?.nodeId || "<machine>"}   ${C.dim}serve only from that machine${C.reset}`);
  console.log(`    ${C.cyan}x-aile-lender:${C.reset} ${lenders[0]?.handle || "<seller>"}   ${C.dim}that seller, whichever machine of theirs is free${C.reset}`);
  console.log(`    ${C.cyan}x-aile-max-price:${C.reset} 8              ${C.dim}refuse anything above $8 per million tokens${C.reset}`);
  console.log(`    ${C.cyan}x-aile-verified:${C.reset} 1               ${C.dim}attested subscriptions only${C.reset}`);
  console.log(`    ${C.cyan}x-aile-provider:${C.reset} codex           ${C.dim}names the provider; the model goes upstream as its own id${C.reset}`);
  console.log(`  ${C.dim}Each one that matches nobody is refused with a 503 naming that header,${C.reset}`);
  console.log(`  ${C.dim}so a ceiling nobody meets never looks like an empty network.${C.reset}`);
  console.log(`  ${C.dim}${C.reset}${C.cyan}--min-served${C.reset}${C.dim}, ${C.reset}${C.cyan}--free${C.reset}${C.dim} and ${C.reset}${C.cyan}--sort${C.reset}${C.dim} change this listing only — no header, no routing change.${C.reset}`);
  // A RATE IS NOT A BILL, said where the rates are. The PRICE column is dollars
  // per million tokens, and what one request costs depends on the `max_tokens`
  // in its body — which is the one lever a buyer holds and is invisible here.
  console.log(`  ${C.dim}Prices are per million tokens. What ONE request costs depends on ${C.reset}${C.cyan}max_tokens${C.reset}${C.dim} in${C.reset}`);
  console.log(`  ${C.dim}your request body — see ${C.reset}${C.cyan}aile price ${res.filters?.model || "<model>"}${C.reset}${C.dim}.${C.reset}`);
  console.log(`\n  ${C.dim}What they have cost you so far: ${C.reset}${C.cyan}aile spend${C.reset}\n`);
}

/**
 * What one request would actually cost.
 *
 *   aile price claude-opus-5                    at every lender's rate
 *   aile price gpt-5.2 --max-tokens 1024        …with a ceiling you name
 *   aile price gpt-5.2 --in 12000               …and a longer prompt
 *   aile price gpt-5.2 --lender L4f1a…          one seller only
 *   aile price gpt-5.2 --json                   the same, for a script
 *
 * ============================================================================
 * `aile lenders` PRINTS A RATE. THIS PRINTS A BILL, AND THEY ARE NOT THE SAME
 * THING TO READ. "$15.00 per million output tokens" is a number nobody can
 * convert in their head into what the next request costs; "$0.000138" is the
 * question actually being asked.
 *
 * AND IT IS THE ONLY PLACE `max_tokens` IS EXPLAINED, WHICH IS THE POINT.
 * Output is priced at the CEILING the request authorises, not at the reply that
 * comes back — so `max_tokens` is the one lever a buyer holds over their own
 * bill, and until now nothing on either side said so. A buyer sending
 * `max_tokens: 32000` out of habit is paying for thirty-two thousand tokens of
 * headroom on a reply of four hundred.
 *
 * ----------------------------------------------------------------------------
 * THIS COMMAND SENDS NO REQUEST AND CONSTRUCTS NO REQUEST BODY, and that bound
 * is the reason it is a separate command rather than a flag on something that
 * does. The server reads `max_tokens` from the BODY and never from a header,
 * precisely so the price matches the ceiling the provider will enforce. A
 * client that injected, defaulted, or rewrote that field would be changing what
 * a buyer asked for in the one direction that changes their bill — and the
 * relay is a byte pipe that does not read bodies at all (`relay/agent.js`).
 * So `--max-tokens` here alters an ESTIMATE and nothing else. Nothing typed at
 * this command can reach a request.
 * ----------------------------------------------------------------------------
 *
 * THE ARITHMETIC IS THE SERVER'S, PERFORMED ON THE SERVER'S OWN NUMBERS. The
 * rates come from `/market`, which is the same `lenderQuote` that bills the
 * request — so a lender's own dollar price, their per-model multiplier, their
 * default and the deployment's all resolve upstream and arrive here already
 * applied. This multiplies two integers by them. There is no second pricing
 * model in this client to drift out of step with the first.
 *
 * IT IS AN ESTIMATE AND SAYS SO IN THE HEADING, NOT IN A FOOTNOTE. The output
 * side is exact — it is the ceiling, and the ceiling is what is charged. The
 * INPUT side cannot be: the real token count of a prompt is not knowable until
 * the prompt exists, so `--in` is an assumption and is printed as one.
 * ============================================================================
 */
const PRICE_DEFAULT_INPUT_TOKENS = 1500;

/**
 * The server's own assumption for a request that names no ceiling.
 *
 * DUPLICATED FROM `pricing.js` DELIBERATELY AND USED FOR ONE SENTENCE ONLY. It
 * is not what this command estimates with — that is `quoteMaxTokens`, which the
 * user owns — it is the fact that "no max_tokens" does not mean "no charge for
 * output". If the server ever changes it, this line becomes a stale sentence in
 * a footer rather than a wrong price, which is why it is safe to state.
 */
const SERVER_DEFAULT_MAX_TOKENS = 4096;

/** Micro-USDC as dollars at the precision a single request actually costs. */
const usd6 = (n) => `$${(Math.max(0, Number(n) || 0) / 1_000_000).toFixed(6)}`;

/**
 * What `priceMicros` on the server computes, for rates already in effect.
 *
 * The server's expression is `((inTok * in) + (outTok * out)) * MICRO / 1e6`
 * with the multiplier already folded into the rate — which reduces to the sum
 * below, in micro-USDC, because a dollar-per-million rate times a token count
 * IS micro-dollars. Ceiled once at the end and floored at one unit, both for
 * the same reason the server does it: a request too small to price is still a
 * request that spends somebody's quota.
 */
function oneRequestMicros(price, inTokens, outTokens) {
  if (!price) return null;
  const i = Number(price.in);
  const o = Number(price.out);
  if (!Number.isFinite(i) || !Number.isFinite(o)) return null;
  return Math.max(1, Math.ceil((inTokens * i) + (outTokens * o)));
}

async function cmdPrice(args) {
  banner();
  const config = loadConfig();
  requireToken(config);
  const server = args.server || config.serverUrl;
  const insecure = checkTransport(server, args);

  const model = args._[1] || args.model;
  if (!model) {
    // A PRICE ONLY EXISTS FOR A MODEL, and this is the same rule `aile lenders`
    // applies to its price column. Naming an example beats naming the flag:
    // somebody who has not run `aile lenders` yet does not know what a model
    // string looks like on this network.
    die(
      "Which model? A price only exists for one.",
      "Try `aile price claude-opus-5`, or `aile lenders` to see what is being served.",
    );
  }

  /**
   * THE CEILING, AND WHERE IT CAME FROM, BECAUSE THE FOOTER HAS TO SAY.
   *
   * A flag beats the setting beats the setting's default. Which one won is
   * carried through to the heading — an estimate at 8192 is a very different
   * number from one at 4096, and a reader who forgot they had configured it
   * would otherwise read the difference as the network being expensive.
   */
  const flagged = args["max-tokens"] ?? args.maxTokens ?? args.max ?? null;
  let outTokens = Number(config.quoteMaxTokens) || SERVER_DEFAULT_MAX_TOKENS;
  let source = "quoteMaxTokens";
  if (flagged !== null && flagged !== true) {
    const n = Number(flagged);
    if (!Number.isFinite(n) || n <= 0) die(`--max-tokens must be a positive number of tokens (got "${flagged}")`);
    outTokens = Math.floor(n);
    source = "flag";
  }

  const inFlag = args.in ?? args["in-tokens"] ?? null;
  let inTokens = PRICE_DEFAULT_INPUT_TOKENS;
  if (inFlag !== null && inFlag !== true) {
    const n = Number(inFlag);
    if (!Number.isFinite(n) || n <= 0) die(`--in must be a positive number of tokens (got "${inFlag}")`);
    inTokens = Math.floor(n);
  }

  let res;
  try {
    res = await withSpinner("Pricing it at every lender…", api.market({
      serverUrl: server, token: config.renterToken, insecure,
      model: String(model),
      handle: args.lender || args.seller || null,
      nodeId: args.node || null,
    }));
  } catch (e) {
    if (e instanceof ApiError && e.status === 400) die(e.message);
    die(...explainError(e, server));
  }

  const lenders = (res.lenders || []).filter((l) => l.price);
  const rows = lenders.map((l) => ({
    handle: String(l.handle || ""),
    nodeId: String(l.nodeId || ""),
    micros: oneRequestMicros(l.price, inTokens, outTokens),
    price: l.price,
  })).filter((r) => r.micros !== null);

  if (args.json) {
    console.log(JSON.stringify({
      model: String(model),
      // Named `assumed`, not `tokens`, so a script cannot mistake either figure
      // for something measured. Neither was.
      assumed: { inputTokens: inTokens, outputTokens: outTokens, outputFrom: source },
      lenders: rows.map((r) => ({
        handle: r.handle, nodeId: r.nodeId,
        estimateMicros: r.micros,
        rate: { inUsdPerMtok: r.price.in, outUsdPerMtok: r.price.out, known: r.price.known !== false },
      })),
    }, null, 2));
    return;
  }

  if (!rows.length) {
    const online = res.online || 0;
    console.log(`\n  ${C.yellow}Nobody online is serving ${model}.${C.reset}`);
    if (online) console.log(`  ${C.dim}${count(online)} machine${online === 1 ? " is" : "s are"} lending other models — see ${C.reset}${C.cyan}aile lenders${C.reset}${C.dim}.${C.reset}\n`);
    else console.log(`  ${C.dim}Nothing is lending right now.${C.reset}\n`);
    return;
  }

  // Cheapest first, which is also the order a request is routed in — so the top
  // row is what the next request actually costs, not merely the best available.
  rows.sort((a, b) => a.micros - b.micros);

  const from = source === "flag" ? "--max-tokens" : `config ${C.cyan}quoteMaxTokens${C.reset}${C.dim}`;
  console.log(`\n${C.bold}${model}${C.reset} ${C.dim}· ${rows.length} lender${rows.length === 1 ? "" : "s"} · estimate for ${count(inTokens)} in / ${count(outTokens)} out (${from})${C.reset}\n`);

  const cells = rows.map((r) => ({
    cost: `${C.green}${usd6(r.micros)}${C.reset}`,
    handle: r.handle.slice(0, 12),
    rate: `${r.price.inUsd || usd(r.price.in)} ${C.dim}in${C.reset}  ${r.price.outUsd || usd(r.price.out)} ${C.dim}out${C.reset}${r.price.known === false ? ` ${C.yellow}~${C.reset}` : ""}`,
  }));
  const w = (k) => Math.max(...cells.map((c) => width(c[k])));
  const wc = w("cost"), wh = w("handle");
  for (const c of cells) {
    console.log(`    ${padTo(c.cost, wc)}   ${padTo(c.handle, wh)}   ${c.rate} ${C.dim}per Mtok${C.reset}`);
  }

  if (rows.some((r) => r.price.known === false)) {
    console.log(`\n  ${C.yellow}~${C.reset}${C.dim} no published rate for this model — estimated from its family${C.reset}`);
  }

  /**
   * THE PARAGRAPH THIS COMMAND EXISTS FOR.
   *
   * The contrast figure is the whole lesson: the same request at a different
   * ceiling, priced at the same lender's rate, so the reader sees their own
   * `max_tokens` move their own bill rather than being told that it would.
   * Computed against the cheapest row because that is the one they will be
   * routed to.
   */
  const contrast = outTokens === 1024 ? 4096 : 1024;
  const alt = oneRequestMicros(rows[0].price, inTokens, contrast);
  console.log(`\n  ${C.dim}Output is priced at ${C.reset}${C.cyan}max_tokens${C.reset}${C.dim}, not at what the model actually returns —${C.reset}`);
  console.log(`  ${C.dim}that is the ceiling you authorised. Sending ${C.reset}${C.cyan}max_tokens: ${contrast}${C.reset}${C.dim} on this${C.reset}`);
  console.log(`  ${C.dim}request would quote ${C.reset}${C.green}${usd6(alt)}${C.reset}${C.dim} instead. A request that names no ceiling${C.reset}`);
  console.log(`  ${C.dim}at all is priced at the server's own default of ${count(SERVER_DEFAULT_MAX_TOKENS)}.${C.reset}`);
  console.log(`  ${C.dim}The input side is an assumption — change it with ${C.reset}${C.cyan}--in ${count(inTokens)}${C.reset}${C.dim}.${C.reset}`);
  console.log(`\n  ${C.dim}Who is online: ${C.reset}${C.cyan}aile lenders --model ${model}${C.reset}${C.dim} · what you have paid: ${C.reset}${C.cyan}aile spend${C.reset}\n`);
}

/**
 * What each lender has actually cost this account.
 *
 *   aile spend                         every lender you have bought from
 *   aile spend --json                  the same, for a script
 *
 * ============================================================================
 * THIS IS THE HALF OF THE MARKETPLACE THAT IS NOT PUBLIC, AND IT IS WHERE A
 * RATING WOULD HAVE GONE.
 *
 * `aile lenders` shows what a machine has carried for EVERYBODY. This shows what
 * a lender has charged YOU — which is the number that actually decides whether
 * to route to them again. A lender two cents cheaper who timed out on a third of
 * your requests looks worse here than any listing can show, because this is
 * counted from the requests that were served rather than from the price that was
 * advertised.
 *
 * NOBODY TYPED ANY OF IT. That is the whole reason there is no `aile review`
 * beside this: a request count and a settled amount cannot be manufactured by a
 * lender who did not serve the requests, and cannot be moved by a buyer at all.
 * A star average is only as trustworthy as the least verifiable thing feeding
 * it; these two numbers have nothing feeding them but the ledger.
 *
 * KEYED ON THE HANDLE, NOT THE MACHINE. A lender who replaces a box is still the
 * same counterparty and their history follows them — which is also why a lender
 * cannot shed a bad history by re-enrolling a node.
 * ============================================================================
 */
async function cmdSpend(args) {
  banner();
  const config = loadConfig();
  requireToken(config);
  const server = args.server || config.serverUrl;
  const insecure = checkTransport(server, args);

  let res;
  try {
    res = await withSpinner("Adding up what you spent…", api.spend({ serverUrl: server, token: config.renterToken, insecure }));
  } catch (e) {
    die(...explainError(e, server));
  }

  if (args.json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  const lenders = res.lenders || [];
  if (!lenders.length) {
    console.log(`\n  ${C.dim}You have not bought from anyone yet.${C.reset}`);
    console.log(`  ${C.dim}Once a request of yours is served, the lender who served it`);
    console.log(`  appears here with what they cost you.${C.reset}`);
    console.log(`\n  ${C.dim}Who is lending: ${C.reset}${C.cyan}aile lenders${C.reset}\n`);
    return;
  }

  console.log(`\n${C.bold}What you have spent, by lender${C.reset} ${C.dim}· counted from your own requests${C.reset}\n`);

  const rows = lenders.map((l, i) => ({
    n: String(i + 1).padStart(2),
    handle: String(l.handle || ""),
    requests: count(l.requests || 0),
    paid: `$${((l.micros || 0) / 1_000_000).toFixed(2)}`,
    last: l.lastAt ? String(l.lastAt).slice(0, 10) : `${C.dim}—${C.reset}`,
  }));

  const w = (k, head) => Math.max(width(head), ...rows.map((r) => width(r[k])));
  const wh = w("handle", "LENDER"), wq = w("requests", "REQUESTS"), wp = w("paid", "YOU PAID");

  console.log(`  ${C.dim}${padTo("", 2)}  ${padTo("LENDER", wh)}  ${padTo("REQUESTS", wq)}  ${padTo("YOU PAID", wp)}  LAST USED${C.reset}`);
  for (const r of rows) {
    console.log(`  ${C.cyan}${r.n}${C.reset}  ${padTo(r.handle, wh)}  ${padTo(r.requests, wq)}  ${padTo(r.paid, wp)}  ${r.last}`);
  }

  const t = res.totals || {};
  console.log(`\n  ${C.bold}${count(t.requests || 0)}${C.reset} request${t.requests === 1 ? "" : "s"} across ${lenders.length} lender${lenders.length === 1 ? "" : "s"} · ${C.green}$${((t.micros || 0) / 1_000_000).toFixed(2)}${C.reset}${C.dim} in total${C.reset}`);
  // The handle is what `aile lenders` prints beside a machine, so a buyer who
  // liked one of these can find whether they are online without retyping it.
  console.log(`  ${C.dim}Pin one you liked with ${C.reset}${C.cyan}x-aile-node${C.reset}${C.dim} — see ${C.reset}${C.cyan}aile lenders${C.reset}${C.dim} for which are online.${C.reset}\n`);
}

/**
 * What each of this account's machines actually served.
 *
 * `aile status` answers "is this machine working?" for the machine it is typed
 * on. This answers the question a lender running more than one box asks before
 * deciding which to keep online: WHICH of them is carrying the traffic. The
 * ledger has recorded `node_id` on every served request since the beginning and
 * nothing ever read it back, so a lender with three machines could see a total
 * and never a breakdown.
 *
 * It reads `/me`, which the CLI already calls — a per-machine projection on the
 * endpoint that lists the machines, rather than a second endpoint that would
 * have to be kept in step with it.
 */
async function cmdStats(args) {
  banner();
  const config = loadConfig();
  requireToken(config);
  const server = args.server || config.serverUrl;
  const insecure = checkTransport(server, args);

  let me;
  try {
    me = await withSpinner("Counting what your machines served…", api.me({ serverUrl: server, token: config.renterToken, insecure }));
  } catch (e) {
    die(...explainError(e, server));
  }

  const nodes = me.nodes || [];
  const donor = Boolean(me.renter?.donor);
  const totalRequests = nodes.reduce((a, n) => a + (n.requests || 0), 0);
  const totalMicros = nodes.reduce((a, n) => a + (n.earnedMicros || 0), 0);

  if (args.json) {
    console.log(JSON.stringify({
      machines: nodes.map((n) => ({
        nodeId: n.node_id, label: n.label ?? null,
        requests: n.requests || 0,
        // Integer micros, not a formatted string: a script comparing earnings
        // should never have to parse "$1.23" back into a float.
        earnedMicros: donor ? null : (n.earnedMicros || 0),
        lastServedAt: n.lastServedAt ?? null,
        lastSeenAt: n.last_seen_at ?? null,
      })),
      totals: { requests: totalRequests, earnedMicros: donor ? null : totalMicros },
    }, null, 2));
    return;
  }

  if (!nodes.length) {
    console.log(`\n  ${C.dim}No machines registered on this account.${C.reset}`);
    console.log(`  ${C.dim}Run ${C.reset}${C.cyan}aile start${C.reset}${C.dim} on a machine to enrol it.${C.reset}\n`);
    return;
  }

  console.log(`\n${C.bold}Your machines${C.reset}\n`);
  const here = getNodeId();
  const rows = nodes.map((n) => ({
    id: String(n.node_id || "").slice(0, 20) + (n.node_id === here ? ` ${C.cyan}(this one)${C.reset}` : ""),
    requests: count(n.requests || 0),
    earned: donor ? `${C.dim}—${C.reset}` : `$${((n.earnedMicros || 0) / 1_000_000).toFixed(2)}`,
    last: n.lastServedAt ? String(n.lastServedAt).slice(0, 10) : `${C.dim}never${C.reset}`,
  }));
  const w = (k, head) => Math.max(width(head), ...rows.map((r) => width(r[k])));
  const wi = w("id", "MACHINE"), wq = w("requests", "REQUESTS"), we = w("earned", "EARNED");

  console.log(`  ${C.dim}${padTo("MACHINE", wi)}  ${padTo("REQUESTS", wq)}  ${padTo("EARNED", we)}  LAST SERVED${C.reset}`);
  for (const r of rows) {
    console.log(`  ${padTo(r.id, wi)}  ${padTo(r.requests, wq)}  ${padTo(r.earned, we)}  ${r.last}`);
  }

  // A machine that has served nothing is a real answer and the most useful one
  // here — it is the box to look at. Said out loud rather than left to be read
  // off a zero, because a zero in a column is easy to skim past.
  const idle = nodes.filter((n) => !(n.requests > 0)).length;
  console.log(`\n  ${C.bold}${count(totalRequests)}${C.reset} request${totalRequests === 1 ? "" : "s"} served across ${nodes.length} machine${nodes.length === 1 ? "" : "s"}`);
  if (!donor) console.log(`  ${C.green}$${(totalMicros / 1_000_000).toFixed(2)}${C.reset} ${C.dim}earned in total${C.reset}`);
  else console.log(`  ${C.yellow}contributing${C.reset} ${C.dim}· nothing accrues, by your own choice${C.reset}`);
  if (idle) {
    console.log(`  ${C.dim}${idle} machine${idle === 1 ? " has" : "s have"} served nothing — check ${C.reset}${C.cyan}aile status${C.reset}${C.dim} on ${idle === 1 ? "it" : "them"}.${C.reset}`);
  }
  console.log();
}

function usage() {
  console.log(`\n${overview()}\n`);
}

/**
 * `aile update` — the interactive half of the update mechanism.
 *
 * The passive one-line notice (config/update-check.js) only ever points here; a
 * command the user typed should run, not be hijacked by a yes/no. This forces a
 * FRESH registry read rather than the once-a-day cache, so "up to date" is
 * honest the instant it is asked, then — on a terminal — confirms before it
 * touches a global install. Off a terminal (a script, a pipe) it names the
 * command instead of running an unattended `npm i -g`; `--yes` opts into that.
 */
async function cmdUpdate(args) {
  banner();
  const latest = await withSpinner("Checking for a newer version…", refreshCache({ timeoutMs: 8000 }));
  if (!latest) {
    console.log(`\n${C.dim}Could not reach the npm registry. Try again, or update manually:${C.reset}`);
    console.log(`  ${C.cyan}npm install -g aile.sh@latest${C.reset}\n`);
    process.exit(1);
  }
  if (!isNewer(latest, APP_VERSION)) {
    console.log(`\n${C.green}Up to date.${C.reset} ${C.dim}aile.sh ${APP_VERSION} is the latest.${C.reset}\n`);
    return;
  }

  console.log(`\n${C.dim}aile.sh ${APP_VERSION} → ${C.reset}${C.green}${latest}${C.reset}${C.dim} available.${C.reset}`);

  const auto = args.yes === true;
  if (!auto && !isInteractive()) {
    console.log(`${C.dim}Update with:${C.reset} ${C.cyan}npm install -g aile.sh@latest${C.reset}\n`);
    return;
  }
  if (!auto) {
    if (!(await promptConfirm("Update now?", { defaultYes: true }))) {
      console.log(`${C.dim}Left at ${APP_VERSION}. Run ${C.reset}${C.cyan}aile update${C.reset}${C.dim} when ready.${C.reset}\n`);
      return;
    }
  }

  console.log(`${C.dim}Running npm install -g aile.sh@${latest} …${C.reset}\n`);
  // The version the user was just SHOWN, not `latest` resolved a second time — see
  // runSelfUpdate. Installing something other than what they agreed to would be a
  // small dishonesty and an unnecessary moving part.
  const code = await runSelfUpdate({ tag: latest });
  if (code === 0) {
    console.log(`\n${C.green}Updated to ${latest}.${C.reset} ${C.dim}Re-run your command to use it.${C.reset}\n`);
    return;
  }
  console.log(`\n${C.red}Update failed (npm exited ${code}).${C.reset}`);
  console.log(`${C.dim}Try manually, perhaps with elevated permissions:${C.reset}`);
  console.log(`  ${C.cyan}npm install -g aile.sh@latest --prefer-online${C.reset}\n`);
  process.exit(1);
}

/**
 * Bare `aile` on a machine that has never signed in.
 *
 * The gate is deliberately narrow: only the no-argument invocation, only when
 * there is no token, only with a terminal to ask on. Anything else — a real
 * command, `--help`, a pipe — goes where it was going. A first-run experience
 * that a script can trip over is worse than no first-run experience.
 */
async function firstRun(args) {
  const server = args.server || loadConfig().serverUrl;
  const choice = await welcome({ serverUrl: server });

  if (choice === null) {
    welcomeNonInteractive();
    process.exit(0);
  }

  // Donating is a different command, not a mode of signing in, because it has its
  // own consent step — and that step must not be skipped just because the user
  // arrived at it from the welcome screen rather than by typing `aile donate`.
  if (choice === "donate") {
    await cmdDonate(args, { quiet: true });
    return;
  }

  if (choice === "setup") {
    await setupCommand({ ...args, _: ["setup"] });
    return;
  }

  await cmdLogin(args, { mode: choice === "paste" ? "paste" : "auto", quiet: true });
}

const args = parseArgs(process.argv.slice(2));

// The detached refresher that the update check spawns re-enters this same CLI
// with a hidden argv. Intercept it before any command gating: it hits the npm
// registry, writes the cache, and exits — it must never fall through to a real
// command, and it must not itself trigger another update check (that is the
// fork-bomb this early return prevents).
if (args._[0] === REFRESH_ARGV) {
  await refreshCache();
  process.exit(0);
}

// `aile run <tool> …` and `aile env <tool>` hand everything after the tool's name
// to the tool — its own `--version` and `--help` included — so they dispatch here,
// before this CLI acts on any flag of its own. `aile run codex --version` must
// print Codex's version, not ours.
if (args._[0] === "run" || args._[0] === "env") {
  const raw = process.argv.slice(2);
  try {
    if (args._[0] === "run") await runCommand(raw);
    else await envCommand(raw);
  } catch (e) {
    const [msg, hint] = explainError(e);
    die(msg, hint);
  }
  process.exit(process.exitCode ?? 0);
}

// `aile --version` / `aile version` / `aile -v`: print the baked-in version and
// leave. Must work before sign-in — it is the first thing a bug report asks for.
if (args.version || ["version", "-v", "-V"].includes(args._[0])) {
  console.log(APP_VERSION);
  process.exit(0);
}

/**
 * HELP RUNS NOTHING. `--help` or `-h` anywhere, and `aile help <command>`,
 * print help and exit before any command is dispatched — so `aile lenders
 * --help` never touches the network and `aile start -h` never starts a node.
 * Help must work before you have an account; that is when it is needed.
 */
if (args.help || args._[0] === "help") {
  const topic = args._[0] === "help" ? args._[1] : args._[0];
  if (!topic) {
    usage();
    process.exit(0);
  }
  const c = findCommand(topic);
  if (!c) {
    console.error(`\n${unknownCommand(topic)}\n`);
    process.exit(1);
  }
  console.log(`\n${commandHelp(c)}\n`);
  process.exit(0);
}

/** Has anything been set up here — to lend, or to use aile from a coding tool? */
function setUpHere() {
  const c = loadConfig();
  return Boolean(c.renterToken || c.buyerKey || Object.keys(loadManifest().tools).length);
}

/**
 * Bare `aile` on a machine that is set up: the overview, then — with a person
 * at a terminal — a menu of the things they are likely to want next. Each
 * choice runs in this process and comes back to the menu; `start` does not
 * come back, because serving is what it is for until Ctrl+C.
 */
async function home(args) {
  await cmdStatus(args, { home: true });
  if (!isInteractive()) return;

  for (;;) {
    const config = loadConfig();
    const lender = Boolean(config.renterToken);
    const items = [
      ["setup", "Set up coding tools", "Claude Code, Codex, opencode, …"],
      ["detect", "See installed tools", "what is on this machine, and where"],
      ...(lender
        ? [["connect", "Connect an AI account", "lend a subscription or an API key"],
          ["start", "Start lending", "run this machine as a relay node"],
          ["wallet", "Wallet", "balance, and where earnings land"]]
        : [["login", "Sign in to lend", "get paid for spare capacity"]]),
      ["doctor", "Check everything", "key, server and each tool"],
      ["status", "Full status", "this machine, each account, the relay"],
      ["help", "All commands", ""],
      ["quit", "Quit", ""],
    ];
    const pick = await promptChoice(
      `${heading("What would you like to do?")} ${C.dim}(${sym.up}${sym.down} or a number, enter · esc quits)${C.reset}`,
      items.map(([, label, note]) => ({ label, note })),
    );
    if (pick === null || items[pick][0] === "quit") {
      console.log();
      return;
    }
    const id = items[pick][0];
    console.log();
    const sub = { ...args, _: [id] };
    if (id === "setup") await setupCommand(sub);
    else if (id === "detect") await detectCommand(sub);
    else if (id === "connect") await cmdConnect(sub);
    else if (id === "wallet") await cmdWallet(sub);
    else if (id === "login") await cmdLogin(sub);
    else if (id === "doctor") { await doctorCommand(sub); process.exitCode = 0; }
    else if (id === "status") await cmdStatus(sub);
    else if (id === "help") usage();
    else if (id === "start") { await cmdStart(sub); return; }
  }
}

const cmd = args._[0] || (setUpHere() ? "home" : "first-run");

// A one-line "a newer aile.sh is out" notice, drawn above the command's own
// output. Cache-only and silent by default (see config/update-check.js). Held
// back where it would be noise or corrupt output: the update command (it runs
// its own, fresher check) and any --json consumer.
if (!args.json && !["update", "upgrade"].includes(cmd)) {
  printUpdateNotice();
}

try {
  switch (cmd) {
    case "first-run": await firstRun(args); break;
    case "home": await home(args); break;
    case "setup": await setupCommand(args); break;
    case "doctor": await doctorCommand(args); break;
    case "detect": case "tools": await detectCommand(args); break;
    case "login": await cmdLogin(args); break;
    case "donate": case "contribute": await cmdDonate(args); break;
    case "connect": await cmdConnect(args); break;
    case "accounts": await cmdAccounts(args); break;
    case "capacity": await cmdCapacity(args); break;
    case "label": case "rename": await cmdLabel(args); break;
    case "retest": case "recheck": await cmdRetest(args); break;
    case "usage": case "quota": await cmdUsage(args); break;
    case "nodeless": await cmdNodeless(args); break;
    case "rates": await cmdRates(args); break;
    case "disconnect": await cmdDisconnect(args); break;
    case "status": await cmdStatus(args); break;
    case "stats": await cmdStats(args); break;
    // BUYING, and the two aliases are not decoration: somebody looking for the
    // listing types `market` as often as `lenders`, and an unknown-command exit is
    // a worse answer than the table they wanted.
    case "lenders": case "market": await cmdLenders(args); break;
    case "price": case "quote": await cmdPrice(args); break;
    case "spend": await cmdSpend(args); break;
    case "start": await cmdStart(args); break;
    case "local": await cmdLocal(args); break;
    case "mcp": await mcpCommand(args); break;
    case "wallet": case "payout": await cmdWallet(args); break;
    case "config": case "settings": configCommand(args); break;
    case "update": case "upgrade": await cmdUpdate(args); break;
    case "logout": await cmdLogout(args); break;
    case "register": await cmdRegister(args); break;
    default:
      console.error(`\n${unknownCommand(cmd)}\n`);
      process.exit(1);
  }
} catch (e) {
  // ONE PLACE FOR EVERYTHING NOBODY CAUGHT. An unexpected throw used to reach
  // the user as a raw stack trace — for failures as ordinary as a dropped
  // connection. It now gets one sentence and what to do; the trace is kept for
  // whoever asks for it.
  if (process.env.AILE_DEBUG === "1") console.error(e);
  const [msg, hint] = explainError(e);
  die(msg, hint);
}

/**
 * A FINISHED COMMAND LEAVES, rather than waiting for the event loop to drain.
 *
 * On Windows a console read that a prompt cancelled — the browser sign-in
 * winning the race against "paste a token here" — can stay pending below Node,
 * in the console itself, until somebody presses Enter. Nothing in JavaScript
 * holds it (stdin is paused, not reading, and unref'd makes no difference), so
 * a finished `aile setup` sat at an empty line looking hung.
 *
 * The output is flushed first: a terminal write is asynchronous on Windows and a
 * pipe write is on POSIX, and exiting on top of either cuts the last lines off.
 * `aile start` is the one command meant to keep running, and a running relay is
 * what says so.
 */
if (!getRelayStatus().running) {
  let pending = 2;
  const leave = () => { if (--pending === 0) process.exit(process.exitCode ?? 0); };
  process.stdout.write("", leave);
  process.stderr.write("", leave);
}
