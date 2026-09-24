/**
 * `aile capacity` — the one view that shows all three kinds at once.
 *
 * WHAT IS ACTUALLY AT RISK HERE. Two things, and neither is "does it print".
 *
 * First, the numbers. `aile accounts` numbers accounts in the server's order and
 * `aile disconnect 2` takes that number. This view regroups the same accounts by
 * how they are paid for, so if it numbered its own rows 1..n as it printed them,
 * the two listings would disagree and a lender following the second would remove
 * an account they never named. The tests below pin the numbers to the fetch
 * order, not the display order — a subscription listed second by the server
 * stays 2 even when it is printed first here.
 *
 * Second, the separations the view exists to make. A subscription stops at a
 * plan ceiling; a key does not stop at all; a self-hosted model is not blind.
 * Those three facts are the reason for the command, so each is asserted where a
 * lender would look for it rather than anywhere on the page.
 *
 * Run through the real CLI, like the other command tests: `src/cli/index.js`
 * dispatches at import time, so nothing here can be reached by importing it.
 */

import { describe, expect, it, beforeEach, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dirname, "..", "src", "cli", "index.js");
const scratches = [];

/**
 * Deliberately interleaved: a key sits between two subscriptions, so grouping
 * them for display necessarily reorders the rows. That is the case where a
 * renumbering bug would show, and a fixture in kind-order would hide it.
 */
const MIXED = [
  { id: "aaaa1111", provider: "codex", account_key: "sub-work", label: "Work", email: "work@example.com", attested: 1 },
  { id: "dddd4444", provider: "openrouter", account_key: "default", label: "Spare", email: null, attested: 0 },
  { id: "cccc3333", provider: "cursor", account_key: "default", label: null, email: null, attested: 0 },
];

function stubServer({ accounts = MIXED } = {}) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/providers" && req.method === "GET") {
        return Response.json({ success: true, data: { accounts }, message: "" });
      }
      return Response.json({ success: false, message: "not found", error: "not found" }, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => { try { server.stop(true); } catch { /* ignore */ } },
  };
}

/** A signed-in data dir, optionally lending a self-hosted model too. */
function signedInData(serverUrl, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-capacity-"));
  scratches.push(dir);
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ serverUrl, renterToken: "ail_" + "a".repeat(48), ...extra }),
  );
  return dir;
}

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

/** The line a given account's row was printed on. */
function lineWith(stdout, needle) {
  return stdout.split("\n").findIndex((l) => l.includes(needle));
}

let stub;
let data;
beforeEach(() => {
  stub?.stop();
  stub = stubServer();
  data = signedInData(stub.url);
});

afterAll(() => {
  stub?.stop();
  for (const dir of scratches) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("the three kinds are shown apart", () => {
  it("puts subscriptions and keys under their own headings", async () => {
    const { stdout, code } = await run(["capacity"], { data });
    expect(code).toBe(0);
    expect(stdout).toMatch(/Subscriptions/);
    expect(stdout).toMatch(/API keys/);
  });

  it("groups the rows under the right heading, not just prints both headings", async () => {
    // The fixture interleaves them, so this fails on any implementation that
    // prints headings over the server's original order.
    const { stdout } = await run(["capacity"], { data });
    const subsAt = lineWith(stdout, "Subscriptions");
    const keysAt = lineWith(stdout, "API keys");
    for (const sub of ["Work", "Cursor"]) {
      expect(lineWith(stdout, sub)).toBeGreaterThan(subsAt);
      expect(lineWith(stdout, sub)).toBeLessThan(keysAt);
    }
    expect(lineWith(stdout, "Spare")).toBeGreaterThan(keysAt);
  });

  it("counts each kind, because that is the number a lender is checking", async () => {
    const { stdout } = await run(["capacity"], { data });
    expect(stdout).toMatch(/Subscriptions\s*\(2\)/);
    expect(stdout).toMatch(/API keys\s*\(1\)/);
  });
});

/**
 * The regrouping hazard. These numbers are commands, not decoration: whatever
 * this view prints beside an account is what `aile disconnect` will act on.
 */
describe("the numbers still mean what disconnect takes", () => {
  it("keeps the server's position even though the rows are reordered", async () => {
    const { stdout } = await run(["capacity"], { data });
    const lines = stdout.split("\n");
    // openrouter is the server's second account and is printed third here.
    expect(lines[lineWith(stdout, "Spare")]).toMatch(/\s2\s/);
    expect(lines[lineWith(stdout, "Work")]).toMatch(/\s1\s/);
  });

  it("agrees with `aile accounts` row for row", async () => {
    // The strongest form of the property: the same id carries the same number
    // in both listings, whatever either one does with grouping.
    const cap = await run(["capacity"], { data });
    const acc = await run(["accounts"], { data });
    const numberFor = (out, name) => {
      const lines = out.split("\n");
      const at = lines.findIndex((l) => l.includes(name));
      expect(at).toBeGreaterThan(-1);
      const n = lines[at].match(/\s(\d+)\s/)?.[1];
      expect(n).toBeDefined();   // a row with no number would pass undefined===undefined
      return n;
    };
    for (const name of ["Work", "Spare"]) {
      expect(numberFor(cap.stdout, name)).toBe(numberFor(acc.stdout, name));
    }
  });
});

/**
 * What separates the kinds is not the provider's name — it is what stops them.
 * A lender deciding what to lend needs the ceiling, the invoice and the privacy
 * property, and each has to appear where they would look for it.
 */
describe("it says what makes each kind different", () => {
  it("says a subscription stops at its plan's ceiling", async () => {
    const { stdout } = await run(["capacity"], { data });
    expect(stdout).toMatch(/monthly ceiling/i);
  });

  it("says a key has no ceiling and bills the lender", async () => {
    const { stdout } = await run(["capacity"], { data });
    expect(stdout).toMatch(/no ceiling/i);
    expect(stdout).toMatch(/billed to you per token/i);
  });

  it("says both relayed kinds are blind", async () => {
    const { stdout } = await run(["capacity"], { data });
    const subsAt = lineWith(stdout, "Subscriptions");
    const keysAt = lineWith(stdout, "API keys");
    const blindLines = stdout.split("\n")
      .map((l, i) => ({ l, i })).filter(({ l }) => /\bblind\b/.test(l) && !/not blind/i.test(l));
    expect(blindLines.some(({ i }) => i > subsAt && i < keysAt)).toBe(true);
    expect(blindLines.some(({ i }) => i > keysAt)).toBe(true);
  });
});

describe("a self-hosted model is capacity too", () => {
  const withLocal = (accounts) => {
    stub.stop();
    stub = stubServer({ accounts });
    return signedInData(stub.url, {
      localEnabled: true,
      localEndpoint: "http://127.0.0.1:11434",
      localModels: "llama3,mistral",
    });
  };

  it("appears beside the accounts rather than behind its own command", async () => {
    const { stdout } = await run(["capacity"], { data: withLocal(MIXED) });
    expect(stdout).toMatch(/Self-hosted/);
    expect(stdout).toContain("http://127.0.0.1:11434");
    expect(stdout).toContain("llama3");
  });

  it("says this one is NOT blind, which is the whole reason to separate it", async () => {
    // A lender who assumes the blind guarantee covers this has assumed wrong,
    // and this line is the only place the listing can correct them.
    const { stdout } = await run(["capacity"], { data: withLocal(MIXED) });
    const at = lineWith(stdout, "Self-hosted");
    const not = stdout.split("\n").findIndex((l) => /not blind/i.test(l));
    expect(not).toBeGreaterThan(at);
  });

  it("offers `aile local --off`, not a disconnect number it has no number for", async () => {
    // With no accounts there is nothing numbered and nothing `aile disconnect`
    // can act on — the self-hosted model is not removed that way. Printing it
    // anyway names a command that can only fail.
    const { stdout } = await run(["capacity"], { data: withLocal([]) });
    expect(stdout).toMatch(/aile local --off/);
    expect(stdout).not.toMatch(/aile disconnect/);
    expect(stdout).not.toMatch(/numbers match/i);
  });

  it("does not count an unreachable endpoint as a source it just called not serving", async () => {
    // Counted against the 3 accounts the stub serves: the total must be those
    // three and not four, or the footer contradicts the line above it.
    const data = signedInData(stub.url, {
      localEnabled: true, localEndpoint: "http://nope.invalid:11434",
    });
    const { stdout } = await run(["capacity"], { data });
    expect(stdout).toMatch(/not serving/i);
    expect(stdout).toMatch(/3 sources of capacity/);
  }, 20_000);

  it("is shown even when there are no accounts at all", async () => {
    // The bug this pins: a machine lending only a local model used to be told
    // it had nothing connected, which is false in the one direction that makes
    // a lender give up and uninstall.
    const { stdout, code } = await run(["capacity"], { data: withLocal([]) });
    expect(code).toBe(0);
    expect(stdout).toMatch(/Self-hosted/);
    expect(stdout).not.toMatch(/not lending anything/i);
  });

  it("says an unreachable endpoint is not serving, rather than showing it as capacity", async () => {
    // Enabled and unreachable looks identical to enabled and working
    // everywhere else in the CLI, so a mistyped port is invisible until no
    // traffic arrives. `.invalid` is reserved, so this fails on DNS rather
    // than hanging on a connect.
    const data = signedInData(stub.url, {
      localEnabled: true, localEndpoint: "http://nope.invalid:11434",
    });
    const { stdout } = await run(["capacity"], { data });
    expect(stdout).toMatch(/not serving/i);
  }, 20_000);
});

describe("nothing lent yet", () => {
  it("says so once, and names both ways to start", async () => {
    stub.stop();
    stub = stubServer({ accounts: [] });
    const { stdout } = await run(["capacity"], { data: signedInData(stub.url) });
    expect(stdout).toMatch(/not lending anything/i);
    expect(stdout).toMatch(/aile connect/);
    expect(stdout).toMatch(/aile local/);
    expect(stdout).toContain("local/<model>");
  });
});

describe("aile local — how buyers reach it", () => {
  it("prints the local/ id buyers send, beside the raw id the node advertises", async () => {
    const data = signedInData(stub.url, { localModels: "llama3,mistral" });
    const { stdout, code } = await run(["local", "http://127.0.0.1:11434"], { data });
    expect(code).toBe(0);
    expect(stdout).toContain("Advertising: llama3, mistral");
    expect(stdout).toContain("local/llama3, local/mistral");
  });

  it("shows the same on the state view", async () => {
    const data = signedInData(stub.url, {
      localEnabled: true, localEndpoint: "http://127.0.0.1:11434", localModels: "llama3",
    });
    const { stdout } = await run(["local"], { data });
    expect(stdout).toContain("local/llama3");
  });
});

describe("--json", () => {
  it("splits the kinds in the payload, not only in the printout", async () => {
    const { stdout } = await run(["capacity", "--json"], { data });
    const out = JSON.parse(stdout);
    expect(out.subscriptions.map((a) => a.id)).toEqual(["aaaa1111", "cccc3333"]);
    expect(out.apiKeys.map((a) => a.id)).toEqual(["dddd4444"]);
  });

  it("carries the position, so a script does not have to count either", async () => {
    const { stdout } = await run(["capacity", "--json"], { data });
    const out = JSON.parse(stdout);
    expect(out.subscriptions.find((a) => a.id === "aaaa1111").n).toBe(1);
    expect(out.apiKeys.find((a) => a.id === "dddd4444").n).toBe(2);
  });

  it("reports selfHosted as null when there is none", async () => {
    const { stdout } = await run(["capacity", "--json"], { data });
    expect(JSON.parse(stdout).selfHosted).toBeNull();
  });

  it("marks the self-hosted entry not blind in the payload too", async () => {
    stub.stop();
    stub = stubServer({ accounts: [] });
    const data = signedInData(stub.url, {
      localEnabled: true, localEndpoint: "http://127.0.0.1:11434", localModels: "llama3",
    });
    const { stdout } = await run(["capacity", "--json"], { data });
    const { selfHosted } = JSON.parse(stdout);
    // A consumer that only reads `models` must still be able to see that this
    // capacity carries a different privacy property.
    expect(selfHosted).toEqual({ endpoint: "http://127.0.0.1:11434", models: ["llama3"], blind: false });
  });

  it("puts NOTHING but the JSON on stdout", async () => {
    const { stdout } = await run(["capacity", "--json"], { data });
    expect(stdout.trim().startsWith("{")).toBe(true);
    expect(stdout).not.toMatch(/aile\.sh/);
  });
});

describe("a machine that is not set up", () => {
  it("says so instead of calling the server", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "aile-capacity-out-"));
    scratches.push(empty);
    const { code, all } = await run(["capacity", "--server", stub.url], { data: empty });
    expect(code).toBe(1);
    expect(all).toMatch(/not set up/i);
    expect(all).toMatch(/aile donate/);
  });
});
