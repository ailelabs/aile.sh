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
import { logger } from "../config/logger.js";

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
};

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
  try { reapOrphans({ log: logger(config.logLevel) }); } catch { /* no runtime, nothing to reap */ }
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
  if (res.rotated) log.info(`[aile] machine re-registered as ${after} (was ${before})`);
  else log.info(`[aile] machine re-registered as ${after}`);
  return res;
}

async function connectOnce(config) {
  if (state.connecting || state.stopped) return;
  if (state.agent?.getStats?.().connected) return;
  state.connecting = true;
  const log = logger(config.logLevel);

  try {
    const nodeId = getNodeId();
    // Built here rather than inside buildCapabilities so ONE runtime probe
    // answers both questions: what to advertise, and what the agent spawns with.
    const mcp = buildMcpCapability({ log });
    const capabilities = await buildCapabilities({
      nodeId,
      maxConcurrent: config.maxConcurrent,
      mcp,
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
      onStatus: (s) => {
        if (s === "disconnected") scheduleReconnect();
      },
    });

    await agent.connect(capabilities);
    state.agent = agent;
    // Only once connected: a watcher on a node that never comes up has nothing
    // to re-advertise to, and the connect path already reads the file itself.
    watchMcpConfig(log);
    state.attempt = 0;
    state.lastError = null;
    state.lastConnectedAt = new Date().toISOString();
    saveState({ nodeId, lastConnectedAt: state.lastConnectedAt, serverUrl: config.serverUrl });
    log.info(`[aile] connected as node ${nodeId}`);
  } catch (err) {
    state.lastError = err.message;
    log.error(`[aile] connect failed: ${err.message}`);

    // NOTHING REACHED THE SERVER. An access proxy, a captive portal, a corporate
    // gateway — the relay never saw the request, so it has no opinion to change and
    // no repair applies: re-registering goes through the same closed door. Stop,
    // rather than reprinting this paragraph every few seconds until someone notices.
    if (err.blocked) {
      state.fatal = err.message;
      log.error(`[aile] giving up — nothing this node does can get past that.`);
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
        log.error(`[aile] this machine is not accepted by ${config.serverUrl}. Run \`aile login\` to sign in again.`);
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
        log.error(`[aile] could not re-register this machine: ${e.message}`);
        log.error(`[aile] run \`aile login\` to sign in again.`);
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
  if (state.retryTimer) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
  state.agent?.stop(reason);
  state.agent = null;
  state.attempt = 0;
  state.fatal = null;
  state.repaired = false;
  clearState();
  return getRelayStatus();
}

export { state as __supervisorState };
