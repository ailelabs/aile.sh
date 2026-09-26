/**
 * Relay agent lifecycle: connect, supervise, reconnect.
 *
 * An in-flight guard, exponential backoff with jitter, and a reachability gate
 * before each attempt so a laptop that sleeps overnight does not burn attempts.
 */

import dns from "node:dns/promises";
import { RelayAgent } from "./agent.js";
import { buildCapabilities } from "./attest.js";
import { loadConfig } from "./config.js";
import { getNodeId } from "./identity.js";
import { enrollNodeOrRotate } from "./enroll.js";
import { loadState, saveState, clearState } from "./state.js";
import fs from "node:fs";
import { buildMcpCapability } from "../mcp/capabilities.js";
import { MCP_CONFIG_FILE } from "../mcp/config.js";
import { reapOrphans } from "../mcp/sandbox.js";
import { localStatus } from "./local.js";
import { logger } from "../config/logger.js";
import { C } from "../cli/colors.js";
import { sym } from "../cli/ui.js";

/**
 * EVERY LINE A RUNNING NODE PRINTS CARRIES THE TIME. `aile start` runs for
 * days; "disconnected" with no time on it cannot be matched to a deploy, a
 * Wi-Fi drop or a laptop lid, which are the three things that cause it.
 */
const pad2 = (n) => String(n).padStart(2, "0");
const clock = (d = new Date()) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const stamped = {
  log: (...a) => console.log(`${C.dim}${clock()}${C.reset}  ${a.join(" ")}`),
  error: (...a) => console.error(`${C.dim}${clock()}${C.reset}  ${a.join(" ")}`),
};
const nodeLog = (level) => logger(level, stamped);

/**
 * A DROPPED LINK IS REPORTED ONCE, AND ONLY IF IT MATTERS.
 *
 * Every server deploy cuts every node's socket, and so does any Wi-Fi blip or
 * Cloudflare edge restart — several times a day, each healed in seconds by the
 * reconnect loop. Printing "disconnected (1006)" and "connected" for each one
 * made a healthy node look broken. So a drop starts a quiet window: back inside
 * it, one dim line says so; still down at its end, one line says the link is
 * lost, then a reminder every few minutes, then how long it was down.
 */
const DROP_QUIET_MS = 15_000;
// A server that announced a restart (close 1012) needs its boot time too.
const RESTART_QUIET_MS = 45_000;
const STILL_EVERY_MS = 5 * 60_000;

function human(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${pad2(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${pad2(m % 60)}m`;
}

/** Why the socket closed, in words; null for a takeover the agent already explained. */
function closeReason(info) {
  const code = info?.code;
  if (code === 4001) return null;
  if (info?.stale) return "the link went silent";
  if (code === 1012 || code === 1001) return "server restarting";
  if (!code || code === 1006) return "network drop";
  if (code === 1000) return info?.reason ? `closed by the server: ${info.reason}` : "closed by the server";
  return `closed by the server (${code}${info?.reason ? `: ${info.reason}` : ""})`;
}

const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };

/**
 * THE SELF-HOSTED MODEL IS LISTED ONLY WHILE SOMETHING ANSWERS FOR IT, and the
 * node re-checks on this cadence — so starting Ollama after `aile start` lists
 * the model within a minute, and stopping it unlists it, without a restart.
 * Each change re-sends the hello, which the server answers with an account
 * probe, so this is also the floor between two of those.
 */
const LOCAL_CHECK_MS = 60_000;

const listNames = (models) => (models?.length ? models.join(", ") : "its models");

/**
 * The one line a CHANGE in the self-hosted model's state is worth, or null.
 * `prev` is the last state reported (null before the first); `aile start`'s
 * header seeds it, so the log does not repeat what the header just said.
 */
export function localTransition(prev, status, endpoint) {
  const now = status?.state;
  if (!now || now === "off" || now === prev) return null;
  // "Nothing is listening" is the usual reason and the address says it; any
  // other (a timeout, an unreachable host) is worth the words.
  const where = hostOf(endpoint || "") + (status.reason && status.reason !== "nothing is listening" ? ` (${status.reason})` : "");
  if (now === "up") {
    return prev === null ? null
      : `${C.green}${sym.ok}${C.reset} Local AI answering ${C.dim}· ${listNames(status.models)} listed · this machine reads those prompts${C.reset}`;
  }
  if (now === "down") {
    return prev === "up"
      ? `${C.yellow}${sym.warn}${C.reset} Local AI stopped answering ${C.dim}· ${where} · ${listNames(status.models)} unlisted until it's back${C.reset}`
      : `${C.yellow}${sym.warn}${C.reset} Local AI not answering ${C.dim}· ${where} · ${listNames(status.models)} listed once it does${C.reset}`;
  }
  return `${C.red}${sym.fail}${C.reset} Local AI misconfigured ${C.dim}· ${status.reason}${C.reset}`;
}

/** What `aile start`'s header already said about the self-hosted model. */
export function seedLocalState(status) {
  if (status?.state && status.state !== "off") state.localState = status.state;
}

function noteLocal(status, config, log) {
  const line = localTransition(state.localState, status, config.localEndpoint);
  if (line) (status.state === "up" ? log.info : log.warn)(line);
  state.localState = status.state === "off" ? null : status.state;
}

/**
 * How often the MCP declaration file is stat'd, and the floor between the
 * re-advertisements a change to it triggers.
 *
 * The floor is the load-bearing number. The server's hello handler fires
 * `probeNodeAccounts` on EVERY hello, so an unthrottled watcher turns an editor
 * that writes a file twice on save — most of them — into two probe sweeps
 * against the lender's own provider accounts. 60s is far below any human's
 * editing cadence and far above any editor's.
 */
const MCP_WATCH_INTERVAL_MS = 5000;
const MCP_READVERTISE_MIN_MS = 60000;

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60000;

const state = {
  agent: null,
  connecting: false,
  stopped: true,
  attempt: 0,
  retryTimer: null,
  lastError: null,
  lastConnectedAt: null,
  // Set when the server has refused this machine's credentials and re-enrolling
  // did not help. Retrying past that point is noise, so the loop stops.
  fatal: null,
  // One repair attempt per run. Without the latch a server that refuses every
  // node would have us minting a fresh identity on every backoff tick.
  repaired: false,
  // The mcp-servers.json watcher, and when it last acted. Both live here rather
  // than in module scope so `stopRelayAgent` can tear the watcher down and a
  // test can read the timestamp.
  mcpWatching: false,
  mcpLastReadvertiseAt: 0,
  mcpPending: false,
  mcpPendingTimer: null,
  // The link's story, for the one-line-per-event reporting above.
  everConnected: false,
  dropAt: null,
  dropWhy: null,
  lostAnnounced: false,
  lostTimer: null,
  failSince: null,
  stillAt: 0,
  // The self-hosted model's last reported state ("up" | "down" | "misconfigured").
  localState: null,
  localTimer: null,
  localChecking: false,
};

/** The socket closed under a running node: start the quiet window. */
function noteDrop(info, log) {
  if (state.stopped || state.dropAt !== null) return;
  const why = closeReason(info);
  if (why === null) return;
  state.dropAt = Date.now();
  state.dropWhy = why;
  state.lostAnnounced = false;
  const quiet = info?.code === 1012 || info?.code === 1001 ? RESTART_QUIET_MS : DROP_QUIET_MS;
  if (state.lostTimer) clearTimeout(state.lostTimer);
  state.lostTimer = setTimeout(() => {
    state.lostTimer = null;
    if (state.stopped || state.dropAt === null) return;
    state.lostAnnounced = true;
    state.stillAt = Date.now();
    log.warn(`${C.yellow}${sym.warn}${C.reset} connection lost ${C.dim}(${state.dropWhy}) · reconnecting…${C.reset}`);
  }, quiet);
  if (state.lostTimer.unref) state.lostTimer.unref();
}

/** A connect attempt that failed on the way there, not a refusal. */
function noteFailure(err, config, log) {
  const what = err.message === "websocket error" ? `can't reach ${hostOf(config.serverUrl)}` : err.message;
  const now = Date.now();
  if (state.dropAt !== null) {
    // Inside a drop the quiet window speaks for it; after that, a reminder.
    if (state.lostAnnounced && now - state.stillAt >= STILL_EVERY_MS) {
      state.stillAt = now;
      log.warn(`${C.yellow}${sym.warn}${C.reset} still reconnecting ${C.dim}· down ${human(now - state.dropAt)} · ${what}${C.reset}`);
    }
    return;
  }
  if (state.failSince === null) {
    // Never connected yet this run: the first failure is news.
    state.failSince = now;
    state.stillAt = now;
    log.error(`${C.red}${sym.fail}${C.reset} ${what} ${C.dim}· retrying${C.reset}`);
    return;
  }
  if (now - state.stillAt >= STILL_EVERY_MS) {
    state.stillAt = now;
    log.warn(`${C.yellow}${sym.warn}${C.reset} still trying ${C.dim}· ${human(now - state.failSince)} · ${what}${C.reset}`);
  }
}

/** Connected: close whatever story was open, in one line. */
function noteConnected(nodeId, log) {
  if (state.lostTimer) { clearTimeout(state.lostTimer); state.lostTimer = null; }
  if (state.dropAt !== null) {
    const down = human(Date.now() - state.dropAt);
    log.info(state.lostAnnounced
      ? `${C.green}${sym.ok}${C.reset} reconnected after ${down}`
      : `${C.dim}${sym.ok} reconnected in ${down} · ${state.dropWhy}${C.reset}`);
  } else if (state.failSince !== null && state.everConnected === false) {
    log.info(`${C.green}${sym.live}${C.reset} connected as node ${nodeId} ${C.dim}after ${human(Date.now() - state.failSince)}${C.reset}`);
  } else {
    log.info(`${C.green}${sym.live}${C.reset} connected as node ${nodeId}`);
  }
  state.everConnected = true;
  state.dropAt = null;
  state.dropWhy = null;
  state.lostAnnounced = false;
  state.failSince = null;
}

export function backoffDelay(attempt, { min = BACKOFF_MIN_MS, max = BACKOFF_MAX_MS } = {}) {
  const base = Math.min(min * 2 ** attempt, max);
  return base / 2 + Math.random() * (base / 2); // jitter → avoid thundering herd
}

async function isOnline() {
  try {
    await dns.lookup("api.aile.sh");
    return true;
  } catch {
    try {
      await dns.lookup("cloudflare.com");
      return true;
    } catch {
      return false;
    }
  }
}

export function getRelayStatus() {
  return {
    running: !state.stopped,
    connected: state.agent?.getStats?.().connected === true,
    attempt: state.attempt,
    lastError: state.lastError,
    fatal: state.fatal,
    lastConnectedAt: state.lastConnectedAt,
    stats: state.agent?.getStats?.() || null,
    nodeId: getNodeId(),
    nodeState: loadState(),
  };
}

export async function startRelayAgent() {
  const config = loadConfig();
  if (!config.serverUrl) throw new Error("serverUrl is not configured");
  if (!config.renterToken) throw new Error("not signed in — run `aile login` first");

  state.stopped = false;
  state.fatal = null;
  state.repaired = false;

  // A node killed mid-session leaves a rented container running with somebody
  // else's work inside it. Reaping at start bounds that to one crash rather
  // than one per crash; the name prefix scopes it to our own containers.
  try { reapOrphans({ log: nodeLog(config.logLevel) }); } catch { /* no runtime, nothing to reap */ }
  await connectOnce(config);
  return getRelayStatus();
}

/**
 * Try to make a refused machine acceptable again, once.
 *
 * The refusal that matters is a node id the server associates with a different
 * account — the residue of signing into a second account on a machine whose
 * identity files deliberately survive `aile logout`. Enrolment answers 409 for
 * that, and `enrollNodeOrRotate` responds by taking a fresh identity, which is
 * safe: the id is a random secret this machine generated, not a claim about
 * anything, and the other account's node row is left untouched.
 *
 * It also repairs the duller case — a node the server has simply never heard of
 * (its row was deleted, or the machine was restored from a backup taken before
 * enrolment). That needs no rotation, just an enrol.
 *
 * `login` now does this at sign-in, so a fresh install never reaches here. This
 * exists for the installs that were already broken before that fix shipped, and
 * for a node deleted server-side while the agent was running — neither of which
 * a re-login should be required to survive.
 */
async function repairIdentity(config, log) {
  const before = getNodeId();
  const res = await enrollNodeOrRotate({
    serverUrl: config.serverUrl,
    renterToken: config.renterToken,
    log: (m) => log.info(m.trim()),
  });
  const after = getNodeId();
  if (res.rotated) log.info(`machine re-registered as ${after} (was ${before})`);
  else log.info(`machine re-registered as ${after}`);
  return res;
}

async function connectOnce(config) {
  if (state.connecting || state.stopped) return;
  if (state.agent?.getStats?.().connected) return;
  state.connecting = true;
  const log = nodeLog(config.logLevel);

  try {
    const nodeId = getNodeId();
    // Built here rather than inside buildCapabilities so ONE runtime probe
    // answers both questions: what to advertise, and what the agent spawns with.
    const mcp = buildMcpCapability({ log });
    // Checked here and handed down, so the log line and the advertisement are
    // the same answer.
    const local = await localStatus(config);
    noteLocal(local, config, log);
    const capabilities = await buildCapabilities({
      nodeId,
      maxConcurrent: config.maxConcurrent,
      mcp,
      local,
    });

    const agent = new RelayAgent({
      serverUrl: config.serverUrl,
      renterToken: config.renterToken,
      nodeId,
      maxConcurrent: config.maxConcurrent,
      // Only pass the endpoint when lending it is actually switched on, so a
      // leftover value in the config file cannot serve traffic by itself.
      localEndpoint: config.localEnabled ? config.localEndpoint : "",
      // null when no runtime answered, which is also when `mcp.servers` is
      // empty — so the server never sends MCP_OPEN to a node that could not
      // sandbox it, and a stream that somehow arrives anyway is refused.
      mcpRuntime: mcp.runtime?.runtime || null,
      pingIntervalMs: config.pingIntervalMs,
      pongTimeoutMs: config.pongTimeoutMs,
      connectTimeoutMs: config.connectTimeoutMs,
      idleTimeoutMs: config.idleTimeoutMs,
      maxPendingBytes: config.maxPendingBytes,
      log,
      onStatus: (s, _stats, info) => {
        if (s !== "disconnected") return;
        // Only a socket that had OPENED is a drop; a failed dial reports
        // itself through the catch below.
        if (info?.opened) noteDrop(info, log);
        scheduleReconnect();
      },
    });

    await agent.connect(capabilities);
    state.agent = agent;
    // Only once connected: a watcher on a node that never comes up has nothing
    // to re-advertise to, and the connect path already reads the file itself.
    watchMcpConfig(log);
    watchLocal(log);
    state.attempt = 0;
    state.lastError = null;
    state.lastConnectedAt = new Date().toISOString();
    saveState({ nodeId, lastConnectedAt: state.lastConnectedAt, serverUrl: config.serverUrl });
    noteConnected(nodeId, log);
  } catch (err) {
    state.lastError = err.message;
    // A refusal is loud every time; a failed dial — the server not there, or
    // not yet back — goes through the quiet reporting above. A bare
    // "websocket error" is all a failed upgrade says when the server could not
    // be asked why, i.e. it was not there, so it is named as unreachable.
    if (err.blocked || err.rejected) log.error(`connect failed: ${err.message}`);
    else noteFailure(err, config, log);

    // NOTHING REACHED THE SERVER. An access proxy, a captive portal, a corporate
    // gateway — the relay never saw the request, so it has no opinion to change and
    // no repair applies: re-registering goes through the same closed door. Stop,
    // rather than reprinting this paragraph every few seconds until someone notices.
    if (err.blocked) {
      state.fatal = err.message;
      log.error(`giving up — nothing this node does can get past that.`);
      return;
    }

    // A refusal is not a flaky network. Backoff is the right answer to a server
    // that is down and the wrong answer to a server that has decided about us —
    // the same request will be refused identically at one second and at sixty,
    // and the loop just prints the same line forever while the node earns
    // nothing. So try the one repair that can change the answer, then stop.
    if (err.rejected) {
      if (state.repaired) {
        state.fatal = err.message;
        log.error(`this machine is not accepted by ${config.serverUrl}. Run \`aile login\` to sign in again.`);
        return;
      }
      state.repaired = true;
      try {
        await repairIdentity(config, log);
        state.attempt = 0;   // a repaired identity deserves a fresh attempt, not a minute of backoff
      } catch (e) {
        // Re-enrolling failed too. If the *token* is what the server rejects,
        // no identity fixes that and only a sign-in will.
        state.fatal = `${err.message} (re-registering failed: ${e.message})`;
        log.error(`could not re-register this machine: ${e.message}`);
        log.error(`run \`aile login\` to sign in again.`);
        return;
      }
    }

    scheduleReconnect();
  } finally {
    state.connecting = false;
  }
}

/**
 * Re-advertise MCP capacity when the lender edits their declaration file.
 *
 * WHY A WATCHER RATHER THAN "RESTART THE NODE". `aile mcp` will happily tell a
 * lender their new server is valid and their runtime is up, while the running
 * agent goes on advertising the list it built at connect time — so the server
 * refuses that serverId and the lender is looking at two commands that
 * disagree. Nothing about that says "restart".
 *
 * `fs.watchFile` and not `fs.watch`: this polls, which is what we want. It
 * works when the file does not exist yet (the common case — most lenders create
 * it after installing), it fires on the delete-and-rename most editors do, and
 * it has no per-platform inotify behaviour to get wrong. A 5s stat of one path
 * costs nothing next to the WebSocket it lives beside.
 *
 * THE RATE LIMIT IS NOT COSMETIC — see MCP_READVERTISE_MIN_MS. A change inside
 * the window is not dropped: it is deferred to the end of it, so the last state
 * of the file always reaches the server, exactly once.
 */
function watchMcpConfig(log) {
  if (state.mcpWatching) return;
  state.mcpWatching = true;
  fs.watchFile(MCP_CONFIG_FILE, { interval: MCP_WATCH_INTERVAL_MS, persistent: false }, (curr, prev) => {
    // Both zero means the file is still absent — watchFile reports that as a
    // "change" on the first tick after a delete, and on a path never created.
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
    onMcpConfigChanged(log);
  });
}

function unwatchMcpConfig() {
  if (state.mcpWatching) {
    fs.unwatchFile(MCP_CONFIG_FILE);
    state.mcpWatching = false;
  }
  if (state.mcpPendingTimer) {
    clearTimeout(state.mcpPendingTimer);
    state.mcpPendingTimer = null;
  }
  state.mcpPending = false;
}

function onMcpConfigChanged(log) {
  const since = Date.now() - state.mcpLastReadvertiseAt;
  if (since < MCP_READVERTISE_MIN_MS) {
    // Coalesce. One timer, however many writes land inside the window.
    if (state.mcpPending) return;
    state.mcpPending = true;
    state.mcpPendingTimer = setTimeout(() => {
      state.mcpPendingTimer = null;
      state.mcpPending = false;
      onMcpConfigChanged(log);
    }, MCP_READVERTISE_MIN_MS - since);
    if (state.mcpPendingTimer.unref) state.mcpPendingTimer.unref();
    return;
  }
  readvertiseMcp(log).catch((e) => log?.warn?.(`[MCP] re-advertise failed: ${e.message}`));
}

async function readvertiseMcp(log) {
  const agent = state.agent;
  if (!agent?.getStats?.().connected) return;

  const mcp = buildMcpCapability({ log });
  const capabilities = await buildCapabilities({
    nodeId: getNodeId(),
    maxConcurrent: loadConfig().maxConcurrent,
    mcp,
  });
  if (!agent.readvertise(capabilities)) return;
  state.mcpLastReadvertiseAt = Date.now();

  // The RUNTIME the agent spawns with is decided at connect time, and a lender
  // who starts Docker after the node is up has changed it. Update it here too,
  // or the node advertises servers it will then refuse to start.
  agent.mcpRuntime = mcp.runtime?.runtime || null;

  log?.info?.(mcp.servers.length
    ? `[MCP] re-advertised ${mcp.servers.length} server(s) after a config change`
    : `[MCP] re-advertised: nothing is served${mcp.reason ? ` — ${mcp.reason}` : ""}`);
}

/**
 * Re-check the self-hosted model every LOCAL_CHECK_MS while lending it, and
 * re-advertise when it comes up or goes away. Idempotent; stopped with the node.
 */
function watchLocal(log) {
  if (state.localTimer) return;
  state.localTimer = setInterval(() => {
    recheckLocal(log).catch((e) => log?.debug?.(`local re-check failed: ${e.message}`));
  }, LOCAL_CHECK_MS);
  if (state.localTimer.unref) state.localTimer.unref();
}

function unwatchLocal() {
  if (state.localTimer) clearInterval(state.localTimer);
  state.localTimer = null;
}

/** One re-check now. Exported so a test need not wait out LOCAL_CHECK_MS. */
export async function recheckLocal(log = nodeLog(loadConfig().logLevel)) {
  if (state.localChecking || state.stopped) return;
  const config = loadConfig();
  if (!config.localEnabled) return;
  state.localChecking = true;
  try {
    const status = await localStatus(config);
    const before = state.localState;
    if (status.state === before) return;
    noteLocal(status, config, log);
    // Only a change in what is ADVERTISED needs a new hello: "down" and
    // "misconfigured" both advertise nothing.
    if ((before === "up") === (status.state === "up")) return;
    const agent = state.agent;
    if (!agent?.getStats?.().connected) return;   // the next connect advertises it
    const mcp = buildMcpCapability({ log });
    const capabilities = await buildCapabilities({
      nodeId: getNodeId(),
      maxConcurrent: config.maxConcurrent,
      mcp,
      local: status,
    });
    if (agent.readvertise(capabilities)) agent.mcpRuntime = mcp.runtime?.runtime || null;
  } finally {
    state.localChecking = false;
  }
}

function scheduleReconnect() {
  if (state.stopped || state.retryTimer || state.fatal) return;

  const config = loadConfig();
  if (config.autoReconnect === false) {
    // Opting out is legitimate — under a supervisor (systemd, pm2) the restart
    // policy belongs there, and two competing retry loops fight each other.
    state.lastError = state.lastError || "disconnected (autoReconnect is off)";
    return;
  }

  const delay = backoffDelay(state.attempt++, {
    min: config.reconnectMinMs,
    max: config.reconnectMaxMs,
  });
  state.retryTimer = setTimeout(async () => {
    state.retryTimer = null;
    if (state.stopped) return;
    try {
      if (!(await isOnline())) {
        scheduleReconnect();
        return;
      }
      await connectOnce(loadConfig());
    } catch (e) {
      state.lastError = e.message;
      scheduleReconnect();
    }
  }, delay);
  if (state.retryTimer.unref) state.retryTimer.unref();
}

export function stopRelayAgent(reason = "manual stop") {
  state.stopped = true;
  unwatchMcpConfig();
  unwatchLocal();
  if (state.retryTimer) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
  state.agent?.stop(reason);
  state.agent = null;
  state.attempt = 0;
  if (state.lostTimer) { clearTimeout(state.lostTimer); state.lostTimer = null; }
  state.everConnected = false;
  state.dropAt = null;
  state.dropWhy = null;
  state.lostAnnounced = false;
  state.failSince = null;
  state.localState = null;
  state.fatal = null;
  state.repaired = false;
  clearState();
  return getRelayStatus();
}

export { state as __supervisorState };
