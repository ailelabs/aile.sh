/**
 * The single-instance lock.
 *
 * What this protects against is not hypothetical: two agents ran on one machine,
 * each superseded the other's socket ~1.5s apart, and every buyer request that
 * landed mid-swap failed with "node disconnected" while every status view showed
 * a connected node.
 *
 * The interesting cases are the ones where refusing is WRONG — a crashed holder,
 * a recycled pid — because a lock that refuses forever is worse than the bug it
 * prevents.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AILE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aile-lock-"));

const { acquireLock, releaseLock, lockHolder, LOCK_FILE } = await import("../src/relay/lock.js");

/** A pid that is real but is certainly not a live process. */
function deadPid() {
  // Spawn nothing; instead use a pid far above any plausible live one. On both
  // platforms this is free of the race a spawn-then-kill would introduce.
  return 0x7ffffffe;
}

function writeLock(obj) {
  fs.writeFileSync(LOCK_FILE, JSON.stringify(obj));
}

beforeEach(() => {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* fine */ }
});

afterEach(() => {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* fine */ }
});

describe("acquireLock", () => {
  it("succeeds when no lock exists", () => {
    expect(acquireLock().ok).toBe(true);
    expect(fs.existsSync(LOCK_FILE)).toBe(true);
  });

  it("records this process, so a holder can be identified", () => {
    acquireLock();
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
    expect(lock.pid).toBe(process.pid);
    expect(typeof lock.startedAt).toBe("number");
  });

  it("REFUSES a second process while a live one holds it", async () => {
    // The whole point of the lock, so it is proven against a genuinely live
    // process rather than a stand-in. A real child is spawned and left running:
    // its pid is alive, is not ours, and started before the lock was written —
    // exactly the situation a second `aile start` finds.
    const child = Bun.spawn([process.execPath, "-e", "setTimeout(()=>{}, 60000)"], {
      stdout: "ignore", stderr: "ignore",
    });
    try {
      // Wait for the child to actually exist before recording it.
      await Bun.sleep(150);
      writeLock({ pid: child.pid, startedAt: Date.now() });

      const holder = lockHolder();
      expect(holder).not.toBe(null);
      expect(holder.pid).toBe(child.pid);

      const res = acquireLock();
      expect(res.ok).toBe(false);
      expect(res.holder.pid).toBe(child.pid);
    } finally {
      child.kill();
    }
  });

  it("is re-entrant for the process that already holds it", () => {
    expect(acquireLock().ok).toBe(true);
    expect(acquireLock().ok).toBe(true);
  });
});

describe("stale locks — the case where refusing would be wrong", () => {
  it("ignores a lock whose process is gone", () => {
    writeLock({ pid: deadPid(), startedAt: Date.now() - 60_000 });
    expect(lockHolder()).toBe(null);
    expect(acquireLock().ok).toBe(true);
  });

  it("ignores a RECYCLED pid — alive, but started after the lock was written", () => {
    // The lock claims to have been taken long before this process began, yet
    // names this process's pid. That combination can only be a recycled pid, and
    // treating it as the original holder is how a lock wedges the CLI forever.
    writeLock({ pid: process.pid, startedAt: Date.now() - 10 * 60 * 1000 });
    expect(lockHolder()).toBe(null);
  });

  it("ignores a corrupt lock file rather than throwing", () => {
    fs.writeFileSync(LOCK_FILE, "{not json");
    expect(lockHolder()).toBe(null);
    expect(acquireLock().ok).toBe(true);
  });

  it("ignores a lock file with no pid", () => {
    writeLock({ startedAt: Date.now() });
    expect(lockHolder()).toBe(null);
  });

  it("falls back to a plain pid check when the file carries no startedAt", () => {
    // Written by an older build. Discarding it would silently disable the lock
    // across an upgrade, which is the moment two agents are most likely to run.
    writeLock({ pid: deadPid() });
    expect(lockHolder()).toBe(null);        // dead → free, as before
  });
});

describe("releaseLock", () => {
  it("removes a lock this process holds", () => {
    acquireLock();
    releaseLock();
    expect(fs.existsSync(LOCK_FILE)).toBe(false);
  });

  it("REFUSES to remove another process's lock", () => {
    // Otherwise a second agent exiting — the one that was correctly refused —
    // would delete the running agent's lock on its way out, and the next start
    // would be allowed to fight it.
    writeLock({ pid: deadPid(), startedAt: Date.now() });
    releaseLock();
    expect(fs.existsSync(LOCK_FILE)).toBe(true);
  });

  it("is silent when no lock exists", () => {
    expect(() => releaseLock()).not.toThrow();
  });
});
