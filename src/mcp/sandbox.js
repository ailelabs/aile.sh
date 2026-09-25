/**
 * The sandbox a rented MCP server runs in (docs/MCP-PLAN.md §5.2).
 *
 * One container per stream, stdio only, destroyed when the stream ends. The
 * renter gets a coding agent in a disposable box; nothing on this machine is
 * reachable from inside it.
 *
 * NO RUNTIME MEANS NO CAPACITY, NOT A FALLBACK
 * --------------------------------------------
 * If Docker (or Podman) is absent or not running, this node advertises no MCP
 * servers and refuses MCP_OPEN. It does NOT fall back to a bare child process.
 * §5.2 is explicit about why: a silent downgrade to "no sandbox" is worse than
 * an unavailable lender, because the lender believes the sandbox is there. The
 * three states are kept distinct — absent, installed-but-stopped, running —
 * because "start Docker Desktop" and "install Docker" are different fixes and a
 * single "unavailable" would tell a lender neither.
 *
 * SECRETS NEVER APPEAR IN ARGV
 * ----------------------------
 * `-e NAME=value` puts the value in the container runtime's command line, where
 * every other user on the machine can read it out of the process table. So
 * `buildRunArgs` emits `-e NAME` — the name-only form, which makes the runtime
 * copy the value from ITS OWN environment — and `spawnServer` puts the value in
 * the environment of the `docker` process it spawns, and nowhere else. That
 * process's env is not world-readable on either Windows or Linux.
 *
 * EGRESS: HONEST ABOUT WHAT IS AND IS NOT ENFORCED
 * ------------------------------------------------
 * `--network=none` (the default) is real, kernel-level, and complete: a server
 * with no declared hosts has no network stack at all. A server that DOES declare
 * hosts gets an ordinary bridge network, and the declared list is at present
 * **advertised, logged and not packet-enforced** — a hostname allowlist needs an
 * egress proxy that does not exist yet. That is stated here, in
 * `describeEgress()`, in what the node advertises, and on stderr at launch,
 * because a list that reads like a firewall and is not one is worse than no list.
 */

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";

/** Container name prefix. Used to find and reap our own leftovers, and nothing else's. */
export const CONTAINER_PREFIX = "aile-mcp-";

/** Runtimes tried in order. Podman's CLI is argv-compatible for everything used here. */
const RUNTIMES = ["docker", "podman"];

/**
 * Is a container runtime usable right now?
 *
 * Returns `{ ok, runtime, state, message }` where state is one of:
 *   "running"   — a daemon answered; MCP capacity may be advertised
 *   "stopped"   — the CLI exists, the daemon does not answer
 *   "absent"    — no runtime CLI on PATH
 *
 * Deliberately synchronous and cheap: it is called from the capability builder
 * on every reconnect, and an async probe there would race the hello frame.
 */
export function detectRuntime({ runtimes = RUNTIMES, run = spawnSync } = {}) {
  let sawCli = false;
  let lastMessage = "";

  for (const runtime of runtimes) {
    let res;
    try {
      res = run(runtime, ["version", "--format", "{{.Server.Version}}"], {
        encoding: "utf8",
        timeout: 10000,
        windowsHide: true,
      });
    } catch (e) {
      lastMessage = e?.message || String(e);
      continue;
    }
    // ENOENT from the spawn itself: this CLI is not installed. Keep looking.
    if (res?.error && res.error.code === "ENOENT") continue;
    sawCli = true;
    if (res?.status === 0) {
      return {
        ok: true,
        runtime,
        state: "running",
        message: `${runtime} ${String(res.stdout || "").trim() || "(version unknown)"}`,
      };
    }
    lastMessage = String(res?.stderr || res?.error?.message || "").trim().split("\n")[0] || "";
  }

  if (sawCli) {
    return {
      ok: false,
      runtime: null,
      state: "stopped",
      message:
        `a container runtime is installed but not running${lastMessage ? ` (${lastMessage})` : ""} — ` +
        `start Docker Desktop (or the docker service) before lending MCP capacity`,
      // The one-line form for a running node's log and `aile start`'s header;
      // the runtime's own error text stays in `message`, for `aile mcp`.
      short: "Docker isn't running · start Docker Desktop",
    };
  }
  return {
    ok: false,
    runtime: null,
    state: "absent",
    message:
      "no container runtime found on PATH — install Docker (or Podman). " +
      "MCP capacity is never served without a sandbox.",
    short: "no Docker or Podman installed",
  };
}

/** A per-stream container name. Random, so two streams for one server never collide. */
export function containerName(serverId, streamId) {
  return `${CONTAINER_PREFIX}${serverId}-${streamId}-${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * The full argv for one sandboxed run — a PURE FUNCTION of the declaration.
 *
 * Pure on purpose: every flag below is a security property, and a test that has
 * to start a container to check one is a test nobody runs. `sandbox.test.js`
 * asserts this list directly.
 */
export function buildRunArgs(server, { name, runtime = "docker" } = {}) {
  const args = [
    "run",
    "--rm",
    "--interactive",          // stdin stays open: this IS the transport
    "--name", name,
    // No TTY. A TTY would line-edit and echo the JSON-RPC stream.
    "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", String(server.pids),
    "--memory", `${server.memoryMb}m`,
    // Denying swap as well: without it a memory cap is advisory, because the
    // kernel will happily swap the container's way past it.
    "--memory-swap", `${server.memoryMb}m`,
    "--cpus", String(server.cpus),
  ];

  // Egress. Empty list → no network stack at all.
  if (server.egress.length === 0) args.push("--network", "none");

  // Name-only env: the VALUE is passed through the spawned runtime's own
  // environment, never through argv. See the header.
  for (const key of Object.keys(server.env)) args.push("--env", key);

  args.push(server.image);
  for (const a of server.command) args.push(a);

  // `runtime` is accepted so a caller can build podman argv explicitly; every
  // flag above is common to both, so it currently changes nothing. Kept in the
  // signature because a future podman-only flag must not need a new call site.
  void runtime;
  return args;
}

/** What this node can honestly say about a server's egress. */
export function describeEgress(server) {
  if (server.egress.length === 0) return { hosts: [], enforced: true, mode: "none" };
  return {
    hosts: [...server.egress],
    // NOT a firewall yet. Said out loud everywhere this value travels.
    enforced: false,
    mode: "open",
  };
}

/**
 * Start one sandboxed MCP server and hand back its stdio.
 *
 * Returns `{ child, name, kill }`. The caller owns the byte pumping — this
 * module's whole job is the box, not the protocol.
 */
export function spawnServer(server, { streamId, runtime, spawnImpl = spawn, detect = detectRuntime, log = console } = {}) {
  // `detect` is injectable so the no-runtime refusal can be tested on a machine
  // where Docker happens to be running. A test whose verdict depends on the
  // developer's daemon is not a test of this rule.
  const detected = runtime ? { ok: true, runtime } : detect();
  if (!detected.ok) throw new Error(detected.message);
  const bin = detected.runtime;

  const name = containerName(server.id, streamId);
  const args = buildRunArgs(server, { name, runtime: bin });

  if (server.egress.length > 0) {
    log?.warn?.(
      `[MCP] "${server.id}" is declared with network access to ${server.egress.join(", ")}. ` +
      `That list is advertised, not packet-enforced — the container has ordinary outbound ` +
      `network. Declare no hosts to run it with --network=none.`,
    );
  }

  const child = spawnImpl(bin, args, {
    // The ONLY environment the runtime process gets: PATH so the binary can
    // find its own helpers, plus this server's declared values. Not the node's
    // environment, which holds this machine's account token.
    env: { PATH: process.env.PATH, ...server.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let killed = false;
  const kill = (reason = "stream closed") => {
    if (killed) return;
    killed = true;
    // `docker run --rm` removes the container when it exits, but only if the
    // CLI process is the one that noticed. Killing the container by name is
    // what actually stops the workload — killing the CLI alone can leave it
    // running detached.
    try {
      spawnSync(bin, ["kill", name], { timeout: 10000, windowsHide: true, stdio: "ignore" });
    } catch { /* the container is already gone */ }
    try { child.kill(); } catch { /* already exited */ }
    log?.debug?.(`[MCP] ${name} stopped: ${reason}`);
  };

  return { child, name, runtime: bin, kill };
}

/**
 * Remove containers this node left behind.
 *
 * A node killed with SIGKILL, or a machine that lost power mid-session, leaves
 * a container running with a renter's session inside it. Reaping at startup
 * bounds that to one crash rather than one per crash, and the name prefix
 * scopes it strictly to our own — nothing else on the machine is touched.
 */
export function reapOrphans({ runtime = null, run = spawnSync, log = console } = {}) {
  const detected = runtime ? { ok: true, runtime } : detectRuntime({ run });
  if (!detected.ok) return { reaped: [], skipped: detected.state };

  const listed = run(detected.runtime, ["ps", "-q", "--filter", `name=^${CONTAINER_PREFIX}`], {
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  });
  if (listed?.status !== 0) return { reaped: [], skipped: "list-failed" };

  const ids = String(listed.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const reaped = [];
  for (const id of ids) {
    const res = run(detected.runtime, ["kill", id], { timeout: 15000, windowsHide: true, encoding: "utf8" });
    if (res?.status === 0) reaped.push(id);
  }
  if (reaped.length) log?.warn?.(`[MCP] reaped ${reaped.length} orphaned sandbox container(s)`);
  return { reaped, skipped: null };
}
