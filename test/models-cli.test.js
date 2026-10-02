/**
 * `aile models`, `aile test` and `aile check-key`, through the real CLI.
 *
 * WHAT IS AT RISK. A model lists only after the model test passes, and the test
 * SPENDS THE LENDER'S OWN QUOTA. So the failures that matter are all about the
 * test being run more than once, or on the wrong things: a timeout that re-sent
 * the call (the server may still be dialling, so that is a second spend), a
 * `deferred` list that was dropped (models silently never tested) or re-sent for
 * ever, and a render model swept up by a bare `aile test 2` (an image bill nobody
 * asked for). The stub therefore records every body it was sent, and the
 * assertions are about WHICH models went on the wire and how many calls it took.
 *
 * As in accounts-cli.test.js the CLI runs with stdin closed, which is the shape of
 * a pipe or a cron job: nothing here may wait on a prompt.
 */

import { describe, expect, it, beforeEach, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dirname, "..", "src", "cli", "index.js");
const scratches = [];

const ACCOUNTS = [
  { id: "aaaa1111", provider: "codex", account_key: "default", label: "Work", email: null, attested: 1, probe_ok: 1 },
  { id: "dddd4444", provider: "openrouter", account_key: "default", label: "Key", email: null, attested: 0, probe_ok: 1 },
];

const UNTESTED = "Not listed until it passes a test.";
const row = (model, status, over = {}) => ({
  model, enabled: status !== "off", status, reason: null, note: status === "untested" ? UNTESTED : null,
  testOk: status === "listed" ? true : null, testedAt: null, testError: null, ...over,
});

/** One of each status, two untested chat rows and one untested render. */
const ROWS = [
  row("gpt-5.5", "listed"),
  row("gpt-5.4", "listed"),
  row("gpt-5.3", "untested"),
  row("gpt-5.2", "untested"),
  row("gpt-image-1", "untested", { surface: "image" }),
  row("gpt-4o", "failed", { reason: "test_failed", note: "model_not_found", testOk: false }),
  row("gpt-4o-mini", "failed", { reason: "refused", note: "The provider says this account can't serve it right now." }),
  row("o3", "cannot_sell", { reason: "no_price", note: "No published price." }),
  row("sora-2", "off", { surface: "video" }),
];

/** `n` untested chat rows, m01…. */
const many = (n) => Array.from({ length: n }, (_, i) => row(`m${String(i + 1).padStart(2, "0")}`, "untested"));

const okResults = (models) => models.map((model) => ({ model, status: "ok" }));

/**
 * An aile.sh that records every request body. `onTest(body, callIndex)` answers
 * a model test; the default passes everything it is given.
 */
function stubServer({ accounts = ACCOUNTS, rows = ROWS, onTest = null, delayMs = 0, models: modelsRes = {} } = {}) {
  const calls = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.json().catch(() => null);
      calls.push({ path: url.pathname, method: req.method, body });
      const ok = (data) => Response.json({ success: true, data, message: "" });

      if (url.pathname === "/providers" && req.method === "GET") return ok({ accounts, maxAccountsPerProvider: 10 });
      const m = url.pathname.match(/^\/providers\/([^/]+)\/(models|probe|models\/test)$/);
      if (m && !accounts.some((a) => a.id === m[1])) {
        return Response.json({ success: false, message: "not found", error: "not found" }, { status: 404 });
      }
      if (m && m[2] === "models" && req.method === "GET") {
        return ok({ provider: "codex", allowNodeless: false, models: rows, ...modelsRes });
      }
      if (m && m[2] === "models/test" && req.method === "POST") {
        const index = calls.filter((c) => c.path.endsWith("/models/test")).length - 1;
        const wait = typeof delayMs === "function" ? delayMs(index) : delayMs;
        if (wait) await Bun.sleep(wait);
        const answer = onTest ? onTest(body, index) : {};
        return ok({ results: okResults(body.models), stoppedEarly: false, models: rows, ...answer });
      }
      if (m && m[2] === "probe" && req.method === "POST") return ok({ account: accounts[0], probe: { ok: true, reason: "ok" } });
      return Response.json({ success: false, message: "not found", error: "not found" }, { status: 404 });
    },
  });
  return {
    calls,
    url: `http://127.0.0.1:${server.port}`,
    /** The bodies of every model test the CLI sent, in order. */
    tests: () => calls.filter((c) => c.path.endsWith("/models/test")).map((c) => c.body.models),
    stop: () => { try { server.stop(true); } catch { /* ignore */ } },
  };
}

function signedInData(serverUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-models-"));
  scratches.push(dir);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ serverUrl, renterToken: "ail_" + "a".repeat(48) }));
  return dir;
}

async function run(args, { data, timeoutMs = 20_000 } = {}) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, AILE_DATA_DIR: data, NO_COLOR: "1" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  clearTimeout(timer);
  const strip = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  return { code, stdout: strip(stdout), stderr: strip(stderr), all: strip(stdout + stderr) };
}

let stub;
let data;
const serve = (opts) => { stub?.stop(); stub = stubServer(opts); data = signedInData(stub.url); };
beforeEach(() => serve());
afterAll(() => { stub?.stop(); for (const d of scratches) fs.rmSync(d, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------

describe("aile models <account>", () => {
  it("groups the rows by the server's status, in the order a lender reads them", async () => {
    const { stdout, code } = await run(["models", "1"], { data });
    expect(code).toBe(0);
    const at = (title) => stdout.indexOf(title);
    expect(at("Listed (2)")).toBeGreaterThan(-1);
    expect(at("Listed (2)")).toBeLessThan(at("Untested (3)"));
    expect(at("Untested (3)")).toBeLessThan(at("Failed (2)"));
    expect(at("Failed (2)")).toBeLessThan(at("Can't sell (1)"));
    expect(at("Can't sell (1)")).toBeLessThan(at("Off (1)"));
    // Each model sits under ITS group, not just somewhere on the screen.
    const lines = stdout.split("\n");
    const under = (model) => lines.slice(0, lines.findIndex((l) => l.trim().startsWith(model))).filter((l) => /^ {2}\S.*\(\d+\)/.test(l)).pop();
    expect(under("gpt-5.5")).toMatch(/Listed/);
    expect(under("gpt-5.3")).toMatch(/Untested/);
    expect(under("gpt-4o ")).toMatch(/Failed/);
    expect(under("o3")).toMatch(/Can't sell/);
    expect(under("sora-2")).toMatch(/Off/);
  });

  it("prints the server's note as it came, once when a whole group shares it", async () => {
    const { stdout } = await run(["models", "1"], { data });
    // Three untested rows say the same sentence; said once, on the heading.
    expect(stdout.split(UNTESTED)).toHaveLength(2);
    expect(stdout).toMatch(new RegExp(`Untested \\(3\\) · ${UNTESTED}`));
    // Differing notes stay on their own rows.
    const failed = stdout.split("\n").find((l) => l.includes("gpt-4o ") || /gpt-4o\s{2}/.test(l));
    expect(failed).toContain("model_not_found");
    expect(stdout.split("\n").find((l) => l.includes("gpt-4o-mini"))).toContain("can't serve it right now");
  });

  it("names a non-chat row's surface", async () => {
    const { stdout } = await run(["models", "1"], { data });
    expect(stdout.split("\n").find((l) => l.includes("gpt-image-1"))).toContain("[image]");
    expect(stdout.split("\n").find((l) => l.includes("sora-2"))).toContain("[video]");
  });

  it("asks for an account, and calls nothing, when none is named", async () => {
    // The count across accounts is `aile accounts`; a listing of every model of
    // every account is hundreds of rows.
    const { code, all } = await run(["models"], { data });
    expect(code).not.toBe(0);
    expect(all).toContain("Name an account.");
    expect(all).toContain("aile accounts");
    expect(stub.calls).toHaveLength(0);
  });

  it("reads the account the number names", async () => {
    await run(["models", "2"], { data });
    expect(stub.calls.map((c) => c.path)).toEqual(["/providers", "/providers/dddd4444/models"]);
  });

  it("refuses a number past the end", async () => {
    const { code, all } = await run(["models", "9"], { data });
    expect(code).toBe(1);
    expect(all).toMatch(/no account 9/i);
  });

  it("points at the test when something is untested", async () => {
    const { stdout } = await run(["models", "2"], { data });
    expect(stdout).toContain("aile test 2");
  });

  it("emits the server's own shape under --json, and nothing else", async () => {
    const { stdout } = await run(["models", "1", "--json"], { data });
    const parsed = JSON.parse(stdout);
    expect(parsed.models).toEqual(ROWS);
  });

  it("treats a row with no status (an older API) as untested rather than dropping it", async () => {
    serve({ rows: [{ model: "legacy-model", enabled: true, entitlement: "entitled", listed: true }] });
    const { stdout } = await run(["models", "1"], { data });
    expect(stdout).toContain("Untested (1)");
    expect(stdout).toContain("legacy-model");
  });
});

describe("aile test <account>", () => {
  it("says up front that it spends the account's own quota", async () => {
    const { stdout } = await run(["test", "1"], { data });
    expect(stdout).toMatch(/spends this account's own quota/);
    // …before any result line.
    expect(stdout.indexOf("spends this account's own quota")).toBeLessThan(stdout.indexOf("passed"));
  });

  it("asks for an account, and calls nothing, when none is named", async () => {
    const { code, all } = await run(["test"], { data });
    expect(code).not.toBe(0);
    expect(all).toContain("Name an account.");
    expect(stub.calls).toHaveLength(0);
  });

  it("with no models named, tests the untested chat rows and never a render", async () => {
    const { code, stdout } = await run(["test", "1"], { data });
    expect(code).toBe(0);
    // gpt-image-1 is untested too, but a test of it is a paid render.
    expect(stub.tests()).toEqual([["gpt-5.3", "gpt-5.2"]]);
    expect(stdout).toMatch(/2 passed/);
  });

  it("tests exactly the models it is named", async () => {
    await run(["test", "1", "gpt-4o", "gpt-5.5"], { data });
    expect(stub.tests()).toEqual([["gpt-4o", "gpt-5.5"]]);
  });

  it("prints a line per model, and says what a failure and a retry were", async () => {
    serve({
      onTest: () => ({
        results: [
          { model: "gpt-5.3", status: "ok" },
          { model: "gpt-5.2", status: "failed", error: "model_not_found" },
          { model: "gpt-4o", status: "transient", error: "rate limited", soft: true },
        ],
      }),
    });
    const { stdout } = await run(["test", "1", "gpt-5.3", "gpt-5.2", "gpt-4o"], { data });
    const line = (m) => stdout.split("\n").find((l) => l.includes(m) && !l.includes("Testing"));
    expect(line("gpt-5.3")).toMatch(/ok\s+gpt-5\.3/);
    expect(line("gpt-5.2")).toMatch(/failed\s+gpt-5\.2\s+model_not_found/);
    expect(line("gpt-4o")).toMatch(/retry\s+gpt-4o\s+rate limited/);
    expect(stdout).toMatch(/1 passed · 1 failed · 1 to retry/);
  });

  it("ends on the account's roll-up after the run, and where to read the rows", async () => {
    const { stdout } = await run(["test", "1"], { data });
    expect(stdout).toMatch(/Now 2 listed · 3 untested · 2 failed · 1 can't sell · 1 off/);
    expect(stdout).toContain("aile models 1");
  });

  it("splits into batches of 25", async () => {
    serve({ rows: many(30) });
    await run(["test", "1", "--yes"], { data });
    expect(stub.tests().map((b) => b.length)).toEqual([25, 5]);
  });

  // An aggregator offers hundreds of models: a long implicit list is a real spend on the quota.
  it("asks for --yes before testing more than 25 models it was not named, and tests nothing without it", async () => {
    serve({ rows: many(26) });
    const refused = await run(["test", "1"], { data });
    expect(refused.code).toBe(1);
    expect(refused.all).toContain("That would test 26 models");
    expect(refused.all).toContain("aile test 1 --yes");
    expect(stub.tests()).toEqual([]);
    // 25 is under the line, and a list the lender NAMED is their own decision.
    serve({ rows: many(25) });
    expect((await run(["test", "1"], { data })).code).toBe(0);
    serve({ rows: many(30) });
    const named = await run(["test", "1", ...many(30).map((r) => r.model)], { data });
    expect(named.code).toBe(0);
    expect(stub.tests().map((b) => b.length)).toEqual([25, 5]);
  });

  it("sends `deferred` again until none are left, each model tested once", async () => {
    serve({
      rows: many(30),
      // The server ran out of wall clock after 20 of the first 25 and says so.
      onTest: (body, i) => i === 0
        ? { results: okResults(body.models.slice(0, 20)), deferred: body.models.slice(20) }
        : {},
    });
    const { code, stdout } = await run(["test", "1", "--yes"], { data });
    expect(code).toBe(0);
    const bodies = stub.tests();
    // The deferred five go FIRST on the next call, ahead of the five still waiting.
    expect(bodies[1]).toEqual(["m21", "m22", "m23", "m24", "m25", "m26", "m27", "m28", "m29", "m30"]);
    expect(bodies).toHaveLength(2);
    // 20 answered by the first call and 10 by the second: every model tested once.
    expect(stdout).toMatch(/30 passed/);
  });

  it("does not loop for ever on a server that defers everything and dials nothing", async () => {
    serve({
      rows: many(3),
      onTest: (body) => ({ results: [], deferred: body.models }),
    });
    const { code, stdout } = await run(["test", "1"], { data });
    expect(stub.tests()).toHaveLength(1);
    expect(code).toBe(1);
    expect(stdout).toMatch(/3 not tested/);
  });

  it("stops when the server says the credential is the problem, and prints why", async () => {
    serve({
      rows: many(60),
      onTest: (body) => ({
        results: [{ model: body.models[0], status: "failed", error: "401" }],
        stoppedEarly: true, stopReason: "credential",
        stopDetail: "The provider refused this key. Run `aile check-key`.",
      }),
    });
    const { code, stdout } = await run(["test", "1", "--yes"], { data });
    // Not a second batch: stopping is the point, since every further call spends quota on a dead key.
    expect(stub.tests()).toHaveLength(1);
    expect(code).toBe(1);
    expect(stdout).toContain("The provider refused this key.");
  });

  it("calls an unknown model skipped rather than failed", async () => {
    serve({ onTest: (body) => ({ results: [], skipped: body.models, stoppedEarly: true, stopReason: "unknown_models", stopDetail: "Not one of this account's models." }) });
    const { stdout } = await run(["test", "1", "gpt-nope"], { data });
    expect(stdout).toMatch(/skipped\s+gpt-nope/);
    expect(stdout).toMatch(/1 skipped/);
  });

  it("says there is nothing to test, and how to reach the renders, when only those are untested", async () => {
    serve({ rows: [row("gpt-5.5", "listed"), row("gpt-image-1", "untested", { surface: "image" })] });
    const { code, stdout } = await run(["test", "1"], { data });
    expect(code).toBe(0);
    expect(stdout).toContain("Nothing untested to test.");
    expect(stdout).toContain("aile test 1 <model>");
    expect(stub.tests()).toEqual([]);
  });

  it("will not render a lone image, video or music model without --yes", async () => {
    const { code, all } = await run(["test", "1", "gpt-image-1"], { data });
    expect(code).toBe(1);
    expect(all).toMatch(/renders output and bills the account/);
    expect(all).toContain("--yes");
    expect(stub.tests()).toEqual([]);
  });

  it("renders it with --yes", async () => {
    const { code } = await run(["test", "1", "gpt-image-1", "--yes"], { data });
    expect(code).toBe(0);
    expect(stub.tests()).toEqual([["gpt-image-1"]]);
  });

  it("leaves a render sent with others to the server to refuse", async () => {
    // No client-side batch check: the server answers that one with a soft result.
    serve({
      onTest: () => ({
        results: [
          { model: "gpt-image-1", status: "transient", error: "Renders are tested alone.", soft: true },
          { model: "gpt-5.3", status: "ok" },
        ],
      }),
    });
    const { stdout } = await run(["test", "1", "gpt-image-1", "gpt-5.3"], { data });
    expect(stub.tests()).toEqual([["gpt-image-1", "gpt-5.3"]]);
    expect(stdout).toContain("Renders are tested alone.");
  });

  it("on a client timeout says the server may still be testing, and does NOT send it again", async () => {
    // A re-send would spend the lender's quota twice for one test.
    serve({ delayMs: 3_000 });
    const { code, all } = await run(["test", "1", "--timeout", "0.4"], { data });
    expect(code).toBe(1);
    expect(all).toContain("The server may still be testing.");
    expect(all).toContain("aile models 1");
    expect(stub.tests()).toHaveLength(1);
  }, 30_000);

  it("keeps what an earlier batch printed when a later one times out", async () => {
    // The first call answers at once, the second hangs past the client's wait.
    serve({ rows: many(30), delayMs: (i) => (i === 0 ? 0 : 3_000) });
    const { code, stdout, all } = await run(["test", "1", "--timeout", "0.4", "--yes"], { data });
    expect(code).toBe(1);
    expect(stdout).toMatch(/ok\s+m25/);
    expect(all).toContain("The server may still be testing.");
    expect(stub.tests().map((b) => b.length)).toEqual([25, 5]);
  }, 30_000);

  it("answers a missing account the way every account command does", async () => {
    const { code, all } = await run(["test", "9"], { data });
    expect(code).toBe(1);
    expect(all).toMatch(/no account 9/i);
    expect(stub.tests()).toEqual([]);
  });
});

describe("aile check-key", () => {
  const probes = () => stub.calls.filter((c) => c.path.endsWith("/probe")).map((c) => c.path);

  it("checks the key of the account the number names", async () => {
    const { code, stdout } = await run(["check-key", "2"], { data });
    expect(code).toBe(0);
    expect(probes()).toEqual(["/providers/dddd4444/probe"]);
    expect(stdout).toMatch(/Checking key/);
  });

  it("says it does not test models, and what does", async () => {
    const { stdout } = await run(["check-key", "1"], { data });
    expect(stdout).toContain("This does not test models. Run aile test.");
  });

  it("is still reachable as retest and recheck", async () => {
    for (const alias of ["retest", "recheck"]) {
      stub.calls.length = 0;
      const { code } = await run([alias, "2"], { data });
      expect({ alias, code, probes: probes() }).toEqual({ alias, code: 0, probes: ["/providers/dddd4444/probe"] });
    }
  });

  it("checks every account when given no number", async () => {
    await run(["check-key"], { data });
    expect(probes()).toHaveLength(2);
  });
});
