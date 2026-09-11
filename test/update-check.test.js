/**
 * The update check is a convenience, not a boundary — so what this pins is that
 * it stays out of the way. It must compare versions numerically (not
 * lexically), read its answer from a cache without ever blocking, fall silent
 * when there is nothing to say or the user opted out, and never let an offline
 * registry cost a command anything.
 *
 * Two halves, like colors.test.js: the pure logic checked in-process against
 * seeded state and a stubbed `fetch`, and the real CLI run with its output
 * piped — proving the one-line notice actually reaches stdout when a newer
 * version is cached, and does not when it is silenced.
 *
 * The suite preload (test/setup.js) sets AILE_NO_UPDATE_CHECK=1 so no OTHER
 * test spawns a network refresher; this file deletes it per-test to drive the
 * enabled path, and restores it after.
 */

import { describe, expect, it, beforeEach, afterEach, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AILE_DIR } from "../src/relay/paths.js";
import { APP_VERSION } from "../src/config/version.js";
import {
  isNewer, updateCheckDisabled, pendingUpdate, refreshCache,
} from "../src/config/update-check.js";

const CACHE = path.join(AILE_DIR, "update-check.json");

/** Write the cache the way a refresh would. `ageMs` back-dates `checkedAt`. */
function seedCache(latest, ageMs = 0) {
  fs.mkdirSync(AILE_DIR, { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify({ checkedAt: Date.now() - ageMs, latest }));
}
function clearCache() { try { fs.rmSync(CACHE); } catch { /* absent */ } }
function readCacheFile() { return JSON.parse(fs.readFileSync(CACHE, "utf8")); }

const realFetch = globalThis.fetch;

/**
 * EVERY off switch, not just ours.
 *
 * `updateCheckDisabled` honours three: `AILE_NO_UPDATE_CHECK`,
 * `NO_UPDATE_NOTIFIER` and `CI`. This hook used to clear only the first, which
 * passes on a laptop and fails on a runner — GitHub Actions sets `CI=true`, so
 * `pendingUpdate()` and `refreshCache()` correctly returned null and six tests
 * that assert the enabled path failed. It surfaced on the very first real CI
 * run, at the v1.0.0 publish, where the test gate stopped the release.
 *
 * A test that drives the enabled path has to own all three, or it is really
 * asserting "the machine I happen to run on has no CI variable". The product
 * behaviour is deliberate and unchanged — a pipeline neither reads nor acts on
 * an update notice — and the switches are still covered by the explicit-env
 * test in the `updateCheckDisabled` block above.
 */
const OFF_SWITCHES = ["AILE_NO_UPDATE_CHECK", "NO_UPDATE_NOTIFIER", "CI"];
const saved = new Map();

beforeEach(() => {
  // Drive the ENABLED path. The preload turned it off for everyone else.
  for (const key of OFF_SWITCHES) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  clearCache();
});
afterEach(() => {
  // Restore exactly what was there, absent included — a test that leaves CI set
  // on a laptop, or unset on a runner, changes the next file's environment.
  for (const key of OFF_SWITCHES) {
    const was = saved.get(key);
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  process.env.AILE_NO_UPDATE_CHECK = "1";
  globalThis.fetch = realFetch;
  clearCache();
});

describe("isNewer", () => {
  it("compares numerically, field by field", () => {
    expect(isNewer("0.2.0", "0.1.9")).toBe(true);
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
    expect(isNewer("0.1.1", "0.1.0")).toBe(true);
  });

  it("is not fooled by lexical order — 0.1.10 is newer than 0.1.9", () => {
    // The whole reason this is not a string compare: "0.1.10" < "0.1.9" as text,
    // which would hide every tenth patch release.
    expect(isNewer("0.1.10", "0.1.9")).toBe(true);
  });

  it("returns false for equal or older", () => {
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("0.1.0", "0.2.0")).toBe(false);
    expect(isNewer("1.9.9", "2.0.0")).toBe(false);
  });

  it("ignores a prerelease suffix — we only nudge toward stable", () => {
    expect(isNewer("0.2.0-rc.1", "0.1.0")).toBe(true);   // newer core still wins
    expect(isNewer("0.1.0-rc.1", "0.1.0")).toBe(false);  // same core: not newer
  });
});

describe("updateCheckDisabled", () => {
  it("is off by default for a normal, semver build", () => {
    expect(updateCheckDisabled({})).toBe(false);
  });

  it("honours every off switch", () => {
    expect(updateCheckDisabled({ AILE_NO_UPDATE_CHECK: "1" })).toBe(true);
    expect(updateCheckDisabled({ NO_UPDATE_NOTIFIER: "1" })).toBe(true);
    expect(updateCheckDisabled({ CI: "true" })).toBe(true);
  });
});

describe("pendingUpdate — cache-driven, never touches the network", () => {
  it("reports a newer cached version", () => {
    seedCache("9.9.9");
    expect(pendingUpdate()).toEqual({ current: APP_VERSION, latest: "9.9.9" });
  });

  it("says nothing when the cache matches the running version", () => {
    seedCache(APP_VERSION);
    expect(pendingUpdate()).toBeNull();
  });

  it("says nothing when the last check found no version", () => {
    seedCache(null);
    expect(pendingUpdate()).toBeNull();
  });

  it("says nothing when opted out, even with a newer version cached", () => {
    seedCache("9.9.9");
    process.env.AILE_NO_UPDATE_CHECK = "1";
    expect(pendingUpdate()).toBeNull();
  });
});

describe("refreshCache — stubbed registry, always fails silent", () => {
  it("stores the latest version the registry reports", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ latest: "1.2.3" }), { status: 200 });
    const got = await refreshCache();
    expect(got).toBe("1.2.3");
    expect(readCacheFile().latest).toBe("1.2.3");
  });

  it("keeps the previous answer and re-stamps the clock when the fetch throws", async () => {
    // Offline. The point is the timestamp advances anyway, so the TTL throttles
    // the next attempt instead of retrying a doomed fetch on every command.
    seedCache("0.5.0", 48 * 60 * 60 * 1000);   // two days old
    const before = readCacheFile().checkedAt;
    globalThis.fetch = async () => { throw new Error("offline"); };

    const got = await refreshCache();
    expect(got).toBe("0.5.0");
    const after = readCacheFile();
    expect(after.latest).toBe("0.5.0");
    expect(after.checkedAt).toBeGreaterThan(before);
  });

  it("stamps the clock even when the registry 404s and nothing was known", async () => {
    globalThis.fetch = async () => new Response("not found", { status: 404 });
    const got = await refreshCache();
    expect(got).toBeNull();
    // A file with a fresh checkedAt is what stops an unpublished package from
    // spawning a refresher on every single invocation.
    expect(typeof readCacheFile().checkedAt).toBe("number");
  });
});

// ---- the real CLI, output piped (mirrors colors.test.js) ----

const CLI = path.join(import.meta.dirname, "..", "src", "cli", "index.js");
const scratches = [];

function freshData(cache) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-upd-"));
  scratches.push(dir);
  if (cache) fs.writeFileSync(path.join(dir, "update-check.json"), JSON.stringify(cache));
  return dir;
}

async function run(args, { env = {}, cache = null } = {}) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: {
      ...process.env,
      AILE_DATA_DIR: freshData(cache),
      AILE_NO_UPDATE_CHECK: undefined,   // enabled unless a test overrides
      NO_COLOR: "1",                     // plain text, so substrings are stable
      FORCE_COLOR: undefined,
      ...env,
    },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return out + err;
}

afterAll(() => {
  for (const dir of scratches) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

describe("the real CLI", () => {
  it("prints the baked-in version on --version", async () => {
    const out = await run(["--version"]);
    expect(out.trim()).toBe(APP_VERSION);
  });

  it("shows the notice above a command when a newer version is cached", async () => {
    // A FRESH cache: the CLI reads it and prints, and does not spawn a refresher.
    const out = await run(["config"], { cache: { checkedAt: Date.now(), latest: "9.9.9" } });
    expect(out).toMatch(/→\s*9\.9\.9/);
    expect(out).toContain("aile update");
  });

  it("stays silent when opted out, even with a newer version cached", async () => {
    const out = await run(["config"], {
      cache: { checkedAt: Date.now(), latest: "9.9.9" },
      env: { AILE_NO_UPDATE_CHECK: "1" },
    });
    expect(out).not.toContain("9.9.9");
  });
});
