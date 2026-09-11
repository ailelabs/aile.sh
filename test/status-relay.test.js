/**
 * What `aile status` says about whether this machine is serving.
 *
 * THE CONTRADICTION THIS FIXES, seen for real: `aile start` refused with "already
 * running on this machine (pid N)" while `aile status`, typed into the terminal
 * beside it, printed no relay line at all. Two commands disagreeing about whether
 * the node is up is worse than either answer alone — the honest reading of that
 * pair is that something is broken, when nothing was.
 *
 * The cause is that `getRelayStatus()` reads memory belonging to a running agent.
 * It is complete inside that process and blank everywhere else — including in the
 * second terminal, which is how `aile status` is almost always run.
 *
 * So status now falls back to the lock file, and these tests pin the three states a
 * user can actually be in. They drive the real CLI: `src/cli/index.js` dispatches at
 * import time, so nothing here is reachable by importing it.
 */

import { describe, expect, it, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dirname, "..", "src", "cli", "index.js");
const scratches = [];

/** A signed-in machine, so status gets far enough to print the relay line. */
function dataDir({ lock = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-status-relay-"));
  scratches.push(dir);
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ serverUrl: "http://127.0.0.1:1", renterToken: `ail_${"a".repeat(48)}` }),
  );
  if (lock) fs.writeFileSync(path.join(dir, "agent.lock"), JSON.stringify(lock));
  return dir;
}

async function run(args, { data, timeoutMs = 20_000 } = {}) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, AILE_DATA_DIR: data, NO_COLOR: "1" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const strip = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  return { code, stdout: strip(stdout), all: strip(stdout + stderr) };
}

afterAll(() => {
  for (const d of scratches) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

// ---------------------------------------------------------------------------

describe("nothing is running", () => {
  it("says so, rather than leaving the line out", async () => {
    // An absent line reads as "fine" next to "Signed in: YES" and a connected
    // account — which describes a machine that is earning, and it is not.
    const res = await run(["status"], { data: dataDir() });
    expect(res.stdout).toMatch(/Relay:\s+not running/i);
  });

  it("names the command that would start it", async () => {
    const res = await run(["status"], { data: dataDir() });
    expect(res.stdout).toContain("aile start");
  });
});

describe("an agent is running in another process", () => {
  it("REPORTS IT, instead of contradicting `aile start`", async () => {
    // The regression: `start` refuses because the lock is held, `status` said
    // nothing, and the two together read as a broken install.
    const res = await run(["status"], {
      data: dataDir({ lock: { pid: process.pid, startedAt: Date.now() - 60_000, at: "2026-07-30T13:19:54.602Z" } }),
    });

    expect(res.stdout).toMatch(/Relay:\s+RUNNING/);
    expect(res.stdout).toContain(`pid ${process.pid}`);
  });

  it("says where it came from, so the user knows where to stop it", async () => {
    const res = await run(["status"], {
      data: dataDir({ lock: { pid: process.pid, startedAt: Date.now() - 60_000, at: "2026-07-30T13:19:54.602Z" } }),
    });
    expect(res.stdout).toMatch(/another process/i);
    expect(res.stdout).toContain("2026-07-30T13:19:54.602Z");
  });

  it("does not claim stream counts it cannot see across a process boundary", async () => {
    // Less detail is available from a lock file than from memory. Inventing a
    // "0 active" would read as an idle node rather than an unknown one.
    const res = await run(["status"], {
      data: dataDir({ lock: { pid: process.pid, startedAt: Date.now() - 60_000, at: "x" } }),
    });
    expect(res.stdout).not.toMatch(/Streams:/);
  });
});

describe("a stale lock", () => {
  it("is not reported as a running agent", async () => {
    // A force-killed agent leaves its file behind; `lockHolder` already refuses to
    // believe a dead pid, and status must not resurrect it. This is exactly the
    // state a Ctrl-C-less kill leaves on Windows.
    const dead = 999_999_999;   // far above any live pid
    const res = await run(["status"], {
      data: dataDir({ lock: { pid: dead, startedAt: Date.now() - 60_000, at: "x" } }),
    });

    expect(res.stdout).toMatch(/Relay:\s+not running/i);
    expect(res.stdout).not.toContain(String(dead));
  });

  it("survives a corrupt lock file rather than failing the command", async () => {
    const dir = dataDir();
    fs.writeFileSync(path.join(dir, "agent.lock"), "{ not json");
    const res = await run(["status"], { data: dir });
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/Relay:\s+not running/i);
  });
});
