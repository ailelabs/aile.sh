/**
 * The first-run gate, tested through the real command.
 *
 * `src/cli/index.js` dispatches at import time, so there is no function to call
 * — the only honest test is to run it the way a user does and read what comes
 * back. That is also the only way to catch the failure that matters most here:
 * a gate that blocks something it was never meant to block.
 *
 * THE RULE. Bare `aile` with no token shows the welcome. Everything else —
 * `--help`, a real command, a machine that already has a token — goes where it
 * was going. The gate is one branch on one invocation, and a script must never
 * be able to reach it.
 *
 * Each case runs with the data directory pointed at a scratch path, so "has this machine
 * signed in?" is a property of the test rather than of whoever is running it.
 */

import { describe, expect, it, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dirname, "..", "src", "cli", "index.js");
const scratches = [];

/**
 * A data directory with no config — a machine that has never signed in.
 *
 * `AILE_DATA_DIR` is the override the app itself honours (src/relay/paths.js).
 * Setting HOME would not work: it is read through `os.homedir()` at import time,
 * and on Windows the path comes from APPDATA instead. Pointing the app's own
 * variable at a scratch directory is the only redirection that holds on every
 * platform.
 */
function freshData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-firstrun-"));
  scratches.push(dir);
  return dir;
}

/** A data directory that already holds a token. */
function signedInData() {
  const dir = freshData();
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ serverUrl: "https://aile.test", renterToken: "ail_" + "a".repeat(48) }),
  );
  return dir;
}

/**
 * Run the CLI with stdin closed — no terminal, which is what a pipe, a cron
 * job, or a container gives it. Nothing here may block.
 */
async function run(args, { data, timeoutMs = 15_000 } = {}) {
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
  return { code, stdout: strip(stdout), stderr: strip(stderr), all: strip(stdout + stderr) };
}

afterAll(() => {
  for (const dir of scratches) fs.rmSync(dir, { recursive: true, force: true });
});

describe("bare `aile` on a machine that has never signed in", () => {
  it("says what this is instead of printing an empty status table", async () => {
    const res = await run([], { data: freshData() });
    expect(res.all).toContain("aile.sh");
    expect(res.all).toMatch(/spare capacity/i);
  });

  it("does not hang when there is no terminal to ask on", async () => {
    // The whole point of the non-interactive path. A prompt nobody can answer
    // is a process that looks started and does nothing.
    const res = await run([], { data: freshData() });
    expect(res.code).toBe(0);
  });

  it("prints the commands to run, including the one for a headless box", async () => {
    const res = await run([], { data: freshData() });
    expect(res.all).toContain("aile login");
    expect(res.all).toContain("--paste");
    expect(res.all).toContain("--token");
  });
});

describe("what the gate must never block", () => {
  it("`--help` works before you have an account — that is when it is needed", async () => {
    const res = await run(["--help"], { data: freshData() });
    expect({ code: res.code, hasUsage: /aile login/.test(res.all) })
      .toEqual({ code: 0, hasUsage: true });
    // Help, not the welcome: the user asked a specific question.
    expect(res.all).toMatch(/aile connect/);
  });

  it("`help` as a bare word works too", async () => {
    const res = await run(["help"], { data: freshData() });
    expect({ code: res.code, hasUsage: /aile login/.test(res.all) })
      .toEqual({ code: 0, hasUsage: true });
  });

  it("a real command keeps its own guard rather than meeting the welcome", async () => {
    // `aile accounts` without a token must fail as itself — "not signed in" —
    // not silently divert into an interactive sign-in a script cannot answer.
    const res = await run(["accounts"], { data: freshData() });
    expect(res.all).toMatch(/sign|token|login/i);
    expect(res.all).not.toMatch(/How would you like to sign in/i);
  });

  it("an unknown command still says so", async () => {
    const res = await run(["definitely-not-a-command"], { data: freshData() });
    expect(res.all).toMatch(/unknown command/i);
  });
});

describe("bare `aile` on a machine that is already signed in", () => {
  it("shows status, not the welcome — the sign-in question is answered", async () => {
    const res = await run([], { data: signedInData() });
    expect(res.all).not.toMatch(/How would you like to sign in/i);
    expect(res.all).not.toMatch(/spare capacity/i);
  });
});

// Branding is deliberately NOT re-checked here. branding.test.js already scans
// every file under src/ for the upstream name, and spelling that name in a
// second file would trip its scan — so the coverage lives there, and this note
// records that the omission is intentional rather than an oversight.
