/**
 * What this node advertises about its MCP servers.
 *
 * ADVERTISE ONLY WHAT COULD ACTUALLY BE SERVED. The server reads this list at
 * dial time and refuses any serverId absent from it, so an entry here is a
 * promise the node has to be able to keep. Two things can make a declared
 * server unservable, and both drop it from the list rather than being reported
 * as a healthy listing that fails on first rent:
 *
 *   - no container runtime (§5.2 — no sandbox, no capacity, no fallback);
 *   - the declaration is disabled by its owner.
 *
 * A THIRD THING IS DELIBERATELY *NOT* CHECKED HERE: whether the image exists.
 * Pulling or inspecting an image is a network round trip inside the handshake
 * path, on every reconnect, and a slow registry would then delay or fail the
 * whole node — including its provider relaying, which has nothing to do with
 * MCP. A missing image surfaces as a failed session for that one server, which
 * is the smaller blast radius.
 *
 * NOTHING HERE IS EVIDENCE. Tool names are a lender's claim; the server
 * rediscovers them over a real MCP session before selling anything, and
 * sanitizes them before showing them to a renter.
 */

import { enabledMcpServers } from "./config.js";
import { detectRuntime, describeEgress } from "./sandbox.js";

/**
 * The last reason we printed, so a standing condition is stated ONCE rather
 * than on every handshake.
 *
 * `buildMcpCapability` runs on every hello — and the node reconnects on its own
 * schedule, so "Docker is not running" scrolled past a lender dozens of times
 * for a fact that had not changed since the first line. The warning is correct
 * and worth printing; repeating it is what made the node's log unreadable and
 * trained its owner to ignore it.
 *
 * KEYED BY THE MESSAGE, not by a boolean, so a reason that CHANGES (runtime
 * missing → runtime present but unreachable → config error) is still reported.
 * Cleared on success, so a recurrence after a recovery is announced again — the
 * silence only ever covers an unbroken run of the identical condition.
 */
let lastWarnedReason = null;

function warnOnce(log, reason) {
  if (reason === lastWarnedReason) return;
  lastWarnedReason = reason;
  log?.warn?.(reason);
}

/** Test helper — forget what has been warned about. */
export function __resetMcpWarnState() {
  lastWarnedReason = null;
}

/**
 * The `mcpServers` array for the hello payload, plus why it is empty when it is.
 *
 * Returns `{ servers, runtime, reason }`. `reason` is null when servers are
 * being advertised, and otherwise carries the sentence a lender needs to see —
 * `aile status` prints it, because "my MCP server is not listed" with no
 * explanation is the failure mode this whole module exists to avoid.
 */
export function buildMcpCapability({ detect = detectRuntime, load = enabledMcpServers, log = console } = {}) {
  let declared;
  try {
    declared = load();
  } catch (e) {
    // A malformed config must not take down the node's provider relaying. It
    // is loud on the node's own log and invisible on the wire.
    warnOnce(log, `[MCP] ignoring mcp-servers.json: ${e.message}`);
    return { servers: [], runtime: null, reason: e.message };
  }
  if (declared.length === 0) {
    lastWarnedReason = null;
    return { servers: [], runtime: null, reason: null };
  }

  const runtime = detect();
  if (!runtime.ok) {
    warnOnce(log, `MCP: ${declared.length} server${declared.length === 1 ? "" : "s"} not served · ${runtime.short ?? runtime.message}`);
    return { servers: [], runtime, reason: runtime.message };
  }

  // Advertising again — a later relapse is news, so let it be said out loud.
  lastWarnedReason = null;

  return {
    servers: declared.map((s) => {
      const egress = describeEgress(s);
      return {
        id: s.id,
        name: s.name,
        tools: s.tools,
        // Both fields travel together on purpose: a host list with no
        // `egressEnforced` beside it reads as a firewall, and it is not one yet.
        egress: egress.hosts,
        egressEnforced: egress.enforced,
        // The renter is buying compute on somebody else's machine. Saying so in
        // the advertisement means the server never has to infer it.
        blind: false,
      };
    }),
    runtime,
    reason: null,
  };
}

/** Human-readable state for `aile status` / `aile mcp`. */
export function mcpStatus(opts = {}) {
  const load = opts.load || enabledMcpServers;
  const detect = opts.detect || detectRuntime;

  let declared = [];
  let configError = null;
  try {
    declared = load();
  } catch (e) {
    configError = e.message;
  }
  const runtime = detect();
  return {
    declared: declared.map((s) => ({
      id: s.id,
      name: s.name,
      image: s.image,
      egress: s.egress,
      egressEnforced: describeEgress(s).enforced,
    })),
    configError,
    runtime: { state: runtime.state, message: runtime.message, short: runtime.short ?? null, ok: runtime.ok },
    advertising: !configError && runtime.ok ? declared.length : 0,
  };
}
