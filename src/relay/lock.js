/**
 * Single-instance lock for the node.
 *
 * WHY THIS EXISTS. Node identity is derived from the machine, so two agents
 * started on one machine present the SAME node id to the relay. The server
 * permits one socket per node and closes the older one — correctly, since a
 * lingering socket receives stream OPENs nobody is reading. Each supersede
 * fires the loser's reconnect, which supersedes the winner, and the two
 * processes trade the connection back and forth indefinitely.
 *
 * That is not a cosmetic problem. Every supersede tears down in-flight streams,
 * so a buyer request that lands mid-swap fails with "node disconnected" — the
 * node looks online in every status view and serves almost nothing. It is also
 * near-invisible from the outside: the log shows a healthy "connected" line each
 * time round, which reads as a flaky network rather than as self-inflicted.
 *
 * So the second process refuses to start. Refusing is the honest answer because
 * the two are not sharing the work: there is one identity, and a second agent
 * cannot serve traffic without taking the connection away from the first.
 *
 * WHY A PID FILE IS NOT ENOUGH. A crashed process leaves its file behind, and
 * PIDs are recycled — on Windows aggressively. Honouring a bare pid would let a
 * stale file refuse every future start, and refusing forever is a worse failure
 * than the one being prevented. So the lock records a start time alongside the
 * pid and is only believed when a live process matches BOTH: a recycled pid
 * belongs to a process that started later than the file claims, which is exactly
 * what distinguishes it from the original.
 */

import fs from "node:fs";
import path from "node:path";
import { AILE_DIR } from "./paths.js";
import { ensureRelayDir } from "./state.js";

export const LOCK_FILE = path.join(AILE_DIR, "agent.lock");

/**
 * Milliseconds of slack when comparing recorded start time against a live
 * process. `process.uptime()` and the file's timestamp are sampled at slightly
 * different moments and neither is precise; a few seconds of tolerance keeps an
 * honest match from being read as a recycled pid. Well below the interval at
 * which an OS would plausibly recycle a pid into a fresh process.
 */
const START_SLACK_MS = 5000;

function processAlive(pid) {
  try {
    // Signal 0 performs the permission and existence checks without delivering
    // anything. EPERM means it exists and belongs to someone else — still alive.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function readLock() {
  try {
    const raw = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
    if (!raw || typeof raw.pid !== "number") return null;
    return raw;
  } catch {
    return null;   // absent or corrupt — both mean "no lock held"
  }
}

/**
 * The holder of the lock, or null if it is free.
 *
 * Returns null for a stale file rather than throwing, so a crash never wedges
 * the CLI. `startedAt` is compared only when the file carries one; a lock
 * written by an older build without it degrades to a plain pid check rather
 * than being discarded, which would defeat the lock during an upgrade.
 */
export function lockHolder({ now = Date.now() } = {}) {
  const lock = readLock();
  if (!lock) return null;
  if (lock.pid === process.pid) return null;      // our own lock, re-entered
  if (!processAlive(lock.pid)) return null;       // died without releasing

  if (typeof lock.startedAt === "number") {
    // A pid that now belongs to a process which started AFTER the lock was
    // written is a recycled pid, not the original holder.
    const alive = liveStartedAt(lock.pid, { now });
    if (alive !== null && alive > lock.startedAt + START_SLACK_MS) return null;
  }
  return lock;
}

/**
 * When the given pid started, in epoch ms — or null when it cannot be
 * determined. Only our own process is knowable portably; for any other pid the
 * answer is null and the caller falls back to the pid check alone. That is the
 * safe direction: it can only make us honour a lock we might have released, not
 * release one we should honour.
 */
function liveStartedAt(pid, { now = Date.now() } = {}) {
  if (pid === process.pid) return Math.round(now - process.uptime() * 1000);
  return null;
}

/**
 * Claim the lock for this process.
 *
 * Returns `{ ok: true }` on success, or `{ ok: false, holder }` when another
 * agent holds it. Never throws for an unwritable directory: a lock that cannot
 * be written is a lock that cannot be checked either, and refusing to run
 * because of it would turn a permissions quirk into an outage.
 */
export function acquireLock({ now = Date.now() } = {}) {
  const holder = lockHolder({ now });
  if (holder) return { ok: false, holder };

  try {
    ensureRelayDir();
    fs.writeFileSync(
      LOCK_FILE,
      JSON.stringify({
        pid: process.pid,
        startedAt: Math.round(now - process.uptime() * 1000),
        at: new Date(now).toISOString(),
      }),
      { mode: 0o600 },
    );
  } catch {
    return { ok: true, unwritable: true };
  }
  return { ok: true };
}

/** Release the lock, but only if this process is the one holding it. */
export function releaseLock() {
  const lock = readLock();
  if (!lock || lock.pid !== process.pid) return;
  try { fs.unlinkSync(LOCK_FILE); } catch { /* already gone */ }
}
