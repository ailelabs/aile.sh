/**
 * The four things the dashboard could do to a linked account and this client could
 * not: re-test it, read its quota, opt it into serving with no machine, and set
 * what it charges.
 *
 * WHY THAT GAP MATTERED. The CLI is the tool for a headless box — the machine with
 * no browser is exactly the one that cannot fall back to the dashboard. A lender
 * whose credential went stale could only refresh the verdict by re-running the whole
 * OAuth link, and one who linked a key from a terminal got an account that silently
 * could not serve nodeless while the same key linked in a browser could.
 *
 * As in accounts-cli.test.js, the stub records WHICH id and WHICH body each request
 * carried, because "it printed a cheerful line" is never the property under test.
 */

import { describe, expect, it, beforeEach, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dirname, "..", "src", "cli", "index.js");
const scratches = [];

// `openrouter` is an api-key provider; `codex` is a subscription. The difference is
// load-bearing for nodeless and is asserted in both directions below.
const ACCOUNTS = [
  { id: "aaaa1111", provider: "codex", account_key: "default", label: "Sub", email: null, attested: 0, probe_ok: 1 },
  { id: "dddd4444", provider: "openrouter", account_key: "default", label: "Key", email: null, attested: 0, probe_ok: 1 },
];

function stubServer({ accounts = ACCOUNTS, usage = null, pricing = null, probe = { ok: true, reason: "ok" } } = {}) {
  const calls = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.json().catch(() => null);
      calls.push({ path: url.pathname, method: req.method, body });
      const ok = (data) => Response.json({ success: true, data, message: "" });

      if (url.pathname === "/providers" && req.method === "GET") {
        return ok({ accounts, maxAccountsPerProvider: 10 });
      }
      if (url.pathname === "/providers/usage") {
        return ok({ accounts: usage ?? accounts.map((a) => ({ accountId: a.id, provider: a.provider, usage: null, stale: false })) });
      }
      if (url.pathname.endsWith("/probe") && req.method === "POST") {
        const id = url.pathname.slice("/providers/".length, -"/probe".length);
        const account = accounts.find((a) => a.id === id);
        return account ? ok({ account, probe }) : Response.json({ success: false, message: "no" }, { status: 404 });
      }
      if (url.pathname.startsWith("/providers/") && req.method === "PATCH") {
        const id = url.pathname.slice("/providers/".length);
        const account = accounts.find((a) => a.id === id);
        return account ? ok({ account: { ...account, ...body } }) : Response.json({ success: false, message: "no" }, { status: 404 });
      }
      if (url.pathname === "/pricing" && req.method === "GET") {
        return ok(pricing ?? PRICING());
      }
      if (url.pathname.startsWith("/pricing") && req.method !== "GET") return ok({ ok: true });
      return Response.json({ success: false, message: "not found", error: "not found" }, { status: 404 });
    },
  });
  return {
    calls,
    url: `http://127.0.0.1:${server.port}`,
    patches: () => calls.filter((c) => c.method === "PATCH"),
    stop: () => { try { server.stop(true); } catch { /* ignore */ } },
  };
}

/**
 * The server's `GET /pricing` for an untouched lender. `models` and the dollar cap
 * are the compat fields the server still sends for one release; they are here so
 * a test can prove the CLI no longer reads them.
 */
const PRICING = (over = {}) => ({
  margin: 1, marginSet: false, modelMargins: {}, disabled: [], unitModels: {}, unitListPrices: {},
  defaults: { margin: 1, min: 0, max: 1, suggested: 0.9, maxUsdPerMtok: 1000 },
  models: {},
  ...over,
});

function signedInData(serverUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-parity-"));
  scratches.push(dir);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ serverUrl, renterToken: "ail_" + "a".repeat(48) }));
  return dir;
}

async function run(args, { data, timeoutMs = 15_000 } = {}) {
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
beforeEach(() => { stub?.stop(); stub = stubServer(); data = signedInData(stub.url); });
afterAll(() => { stub?.stop(); for (const d of scratches) fs.rmSync(d, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------

describe("aile retest — ask the server to re-check a credential", () => {
  it("probes the account the number names, and only that one", async () => {
    const { code } = await run(["retest", "2"], { data });
    expect(code).toBe(0);
    const probes = stub.calls.filter((c) => c.path.endsWith("/probe"));
    expect(probes.map((c) => c.path)).toEqual(["/providers/dddd4444/probe"]);
  });

  it("re-checks every account when given no number", async () => {
    await run(["retest"], { data });
    expect(stub.calls.filter((c) => c.path.endsWith("/probe"))).toHaveLength(2);
  });

  it("reports a rejection as rejected", async () => {
    stub.stop();
    stub = stubServer({ probe: { ok: false, reason: "provider returned 401" } });
    const { stdout } = await run(["retest", "1"], { data: signedInData(stub.url) });
    expect(stdout).toMatch(/rejected/);
    expect(stdout).toContain("provider returned 401");
  });

  it("does NOT call a null verdict a failure", async () => {
    // `ok: null` is the server saying it had no healthy egress to test through, so
    // it learned nothing. Rendering that as rejected sends a lender off to re-link
    // a credential that was never in question.
    stub.stop();
    stub = stubServer({ probe: { ok: null, reason: "no healthy proxy" } });
    const { stdout } = await run(["retest", "1"], { data: signedInData(stub.url) });
    expect(stdout).toMatch(/no answer/);
    expect(stdout).not.toMatch(/rejected/);
  });

  it("says plainly that it cannot make an account verified", async () => {
    // The next thing a lender tries. Attestation is bound to a nonce issued during
    // the link, so no amount of re-probing can produce it.
    const { stdout } = await run(["retest", "1"], { data });
    expect(stdout).toMatch(/cannot make an account/i);
    expect(stdout).toMatch(/re-link/i);
  });

  it("refuses a number past the end without probing anything", async () => {
    const { code } = await run(["retest", "9"], { data });
    expect(code).not.toBe(0);
    expect(stub.calls.filter((c) => c.path.endsWith("/probe"))).toHaveLength(0);
  });
});

describe("aile usage — quota, including when there is none", () => {
  it("says so per account rather than drawing an empty meter", async () => {
    // Every provider in this fixture reports null, which is the common case live.
    // An empty meter reads as "you have used it all" or "this is broken".
    const { stdout, code } = await run(["usage"], { data });
    expect(code).toBe(0);
    expect(stdout.match(/no quota reported by this provider/g)).toHaveLength(2);
  });

  it("says once, at the end, that reporting nothing is normal", async () => {
    const { stdout } = await run(["usage"], { data });
    expect(stdout).toMatch(/That is normal/i);
  });

  it("renders a window a provider did report", async () => {
    stub.stop();
    stub = stubServer({
      usage: [
        { accountId: "aaaa1111", provider: "codex", usage: { windows: [{ label: "5h", usedPercent: 42 }] }, stale: false },
        { accountId: "dddd4444", provider: "openrouter", usage: null, stale: false },
      ],
    });
    const { stdout } = await run(["usage"], { data: signedInData(stub.url) });
    expect(stdout).toContain("5h: 42% used");
    expect(stdout).not.toMatch(/That is normal/i);   // one of them did report
  });

  it("flags a stale reading instead of presenting it as current", async () => {
    stub.stop();
    stub = stubServer({
      usage: [{ accountId: "aaaa1111", provider: "codex", usage: { windows: [{ label: "5h", usedPercent: 10 }] }, stale: true }],
    });
    const { stdout } = await run(["usage"], { data: signedInData(stub.url) });
    expect(stdout).toMatch(/stale/);
  });

  it("numbers rows the same way aile accounts does", async () => {
    // The numbers are what `disconnect` and `nodeless` take. A listing that
    // re-sorted would make them mean something else here than there.
    const { stdout } = await run(["usage"], { data });
    const at = (n) => stdout.indexOf(` ${n}  `);
    expect(at(1)).toBeGreaterThan(-1);
    expect(at(2)).toBeGreaterThan(at(1));
  });

  it("emits the server's shape and nothing else under --json", async () => {
    const { stdout } = await run(["usage", "--json"], { data });
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ n: 1, id: "aaaa1111", usage: null });
  });
});

describe("aile nodeless — serving with no machine in the path", () => {
  it("turns an API-key account on, naming that account", async () => {
    const { code } = await run(["nodeless", "2", "on"], { data });
    expect(code).toBe(0);
    expect(stub.patches()).toEqual([
      { path: "/providers/dddd4444", method: "PATCH", body: { allowNodeless: true } },
    ]);
  });

  it("turns one off again", async () => {
    await run(["nodeless", "2", "off"], { data });
    expect(stub.patches()[0].body).toEqual({ allowNodeless: false });
  });

  it("REFUSES a subscription, and sends no PATCH", async () => {
    // The serve path ignores the flag on a subscription (ROUTER-PLAN §6.6) and the
    // server stores it verbatim rather than coercing it — so accepting it here
    // would write a setting that can never do anything, and say nothing about that.
    const { code, all } = await run(["nodeless", "1", "on"], { data });
    expect(code).not.toBe(0);
    expect(all).toMatch(/cannot serve without this machine/i);
    expect(stub.patches()).toHaveLength(0);
  });

  it("says the kill switch is gone when turning one on", async () => {
    // A nodeless account keeps earning with the node off, which is the selling
    // point and also the thing that surprises people.
    const { stdout } = await run(["nodeless", "2", "on"], { data });
    expect(stdout).toMatch(/while this machine is off/i);
  });

  it("refuses a missing or nonsense verb without patching", async () => {
    for (const args of [["nodeless", "2"], ["nodeless", "2", "maybe"], ["nodeless"]]) {
      const { code } = await run(args, { data });
      expect(code).not.toBe(0);
    }
    expect(stub.patches()).toHaveLength(0);
  });
});

describe("aile rates — what this lender charges", () => {
  it("reads the sheet without changing anything", async () => {
    const { stdout, code } = await run(["rates"], { data });
    expect(code).toBe(0);
    expect(stub.calls.every((c) => c.method === "GET")).toBe(true);
    expect(stdout).toMatch(/What you charge/);
  });

  it("explains that an unset margin is the default, not free", async () => {
    // `marginSet: false` means the deployment default applies; the server has
    // already put it in `margin`, so the number is right and only its origin needs saying.
    const { stdout } = await run(["rates"], { data });
    expect(stdout).toMatch(/you have not set one/i);
    expect(stdout).toContain("×1 (list price)");
  });

  it("prints the bounds, and no dollar cap", async () => {
    // `defaults.maxUsdPerMtok` is a compat field for the old web bundle; there is
    // no dollar price for it to bound any more.
    const { stdout } = await run(["rates"], { data });
    expect(stdout).toMatch(/Allowed: 0 to 1$/m);
    expect(stdout).not.toMatch(/per million tokens/);
  });

  it("says what a margin means next to the number", async () => {
    stub.stop();
    stub = stubServer({ pricing: PRICING({ margin: 0.9, marginSet: true }) });
    const { stdout } = await run(["rates"], { data: signedInData(stub.url) });
    expect(stdout).toContain("×0.9 (10% below list)");
    expect(stdout).not.toMatch(/you have not set one/i);
  });

  it("sets the global margin", async () => {
    const { stdout } = await run(["rates", "--margin", "0.9"], { data });
    expect(stub.calls.find((c) => c.method === "PATCH")).toMatchObject({
      path: "/pricing", body: { margin: 0.9 },
    });
    expect(stdout).toMatch(/Applies to every model with no margin of its own/);
  });

  it("sets a margin of 0, which is free", async () => {
    const { stdout } = await run(["rates", "--margin", "0"], { data });
    expect(stub.calls.find((c) => c.method === "PATCH")).toMatchObject({
      path: "/pricing", body: { margin: 0 },
    });
    expect(stdout).toContain("×0 (free)");
  });

  it("refuses a margin above list price, with a reason, without writing", async () => {
    // The server's MAX_MARGIN is 1: nobody sells above retail.
    const { code, all } = await run(["rates", "--margin", "1.2"], { data });
    expect(code).not.toBe(0);
    expect(all).toMatch(/0 to 1/);
    expect(stub.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("refuses a negative margin without writing", async () => {
    const { code } = await run(["rates", "--margin=-0.5"], { data });
    expect(code).not.toBe(0);
    expect(stub.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("refuses a per-model margin above list price without writing", async () => {
    const { code, all } = await run(["rates", "set", "claude-opus-5", "--model-margin", "1.5"], { data });
    expect(code).not.toBe(0);
    expect(all).toMatch(/0 to 1/);
    expect(stub.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("shows a margin deliberately set to 0 as free, not as the default", async () => {
    stub.stop();
    stub = stubServer({ pricing: PRICING({ margin: 0, marginSet: true }) });
    const { stdout } = await run(["rates"], { data: signedInData(stub.url) });
    expect(stdout).toContain("×0 (free)");
    expect(stdout).not.toMatch(/you have not set one/i);
  });

  it("lists per-model margins from modelMargins", async () => {
    stub.stop();
    stub = stubServer({ pricing: PRICING({ modelMargins: { "claude-opus-5": 0.8, "lyria-3-pro-preview": 0 } }) });
    const { stdout } = await run(["rates"], { data: signedInData(stub.url) });
    expect(stdout).toMatch(/Per-model margins \(2\)/);
    expect(stdout).toMatch(/claude-opus-5\s+×0\.8 \(20% below list\)/);
    expect(stdout).toMatch(/lyria-3-pro-preview\s+×0 \(free\)/);
    expect(stdout).not.toMatch(/every model follows the margin above/);
  });

  it("says every model follows the margin only when there are no per-model margins", async () => {
    // The compat `models` field is left non-empty on purpose: the CLI must not read it.
    stub.stop();
    stub = stubServer({ pricing: PRICING({ models: { "claude-opus-5": { in: 3, out: 15 } } }) });
    const { stdout } = await run(["rates"], { data: signedInData(stub.url) });
    expect(stdout).toMatch(/Per-model margins \(0\)/);
    expect(stdout).toMatch(/None — every model follows the margin above/);
    expect(stdout).not.toContain("$3");
  });

  it("says per-unit models sell by default, and how to stop one", async () => {
    const { stdout } = await run(["rates"], { data });
    expect(stdout).toMatch(/Per-unit models with a published list sell at list × margin by default/);
    expect(stdout).toMatch(/aile rates off <model> stops one/);
  });

  it("hints at --model-margin, never at a dollar price", async () => {
    const { stdout } = await run(["rates"], { data });
    expect(stdout).toContain("aile rates set <model> --model-margin 0.8");
    expect(stdout).not.toMatch(/--in|--out/);
  });

  it("sets a per-model margin, sending only the model and the margin", async () => {
    const { code } = await run(["rates", "set", "claude-opus-5", "--model-margin", "0.8"], { data });
    expect(code).toBe(0);
    const put = stub.calls.find((c) => c.path === "/pricing/model");
    expect(put.method).toBe("PUT");
    expect(put.body).toEqual({ model: "claude-opus-5", margin: 0.8 });
  });

  it("accepts a full per-unit id as the model", async () => {
    await run(["rates", "set", "openrouter/google/lyria-3-pro-preview", "--model-margin", "0.5"], { data });
    expect(stub.calls.find((c) => c.path === "/pricing/model")?.body).toEqual({
      model: "openrouter/google/lyria-3-pro-preview", margin: 0.5,
    });
  });

  it("refuses --in / --out as retired, and sends nothing", async () => {
    // The server 400s any dollar price; refusing here means the request never leaves.
    for (const args of [
      ["rates", "set", "claude-opus-5", "--in", "3", "--out", "15"],
      ["rates", "set", "claude-opus-5", "--out", "15"],
      ["rates", "set", "claude-opus-5", "--in=3", "--model-margin", "0.8"],
    ]) {
      const { code, all } = await run(args, { data });
      expect(code).not.toBe(0);
      expect(all).toMatch(/Dollar prices are retired — use --model-margin/);
    }
    expect(stub.calls).toHaveLength(0);
  });

  it("stops serving one model", async () => {
    await run(["rates", "off", "claude-opus-5"], { data });
    expect(stub.calls.find((c) => c.path === "/pricing/model/disabled")).toMatchObject({
      method: "PUT", body: { model: "claude-opus-5", disabled: true },
    });
  });

  it("clears a per-model margin, back to the global one", async () => {
    const { stdout } = await run(["rates", "clear", "claude-opus-5"], { data });
    expect(stub.calls.find((c) => c.method === "DELETE")?.path).toBe("/pricing/model/claude-opus-5");
    expect(stdout).toMatch(/is back on your global margin/);
  });

  it("refuses `set` with nothing to set, and sends no write", async () => {
    const { code } = await run(["rates", "set", "claude-opus-5"], { data });
    expect(code).not.toBe(0);
    expect(stub.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("refuses a non-numeric margin without writing", async () => {
    const { code } = await run(["rates", "--margin", "cheap"], { data });
    expect(code).not.toBe(0);
    expect(stub.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("takes no account number — pricing is per model, never per account", async () => {
    // Two keys of one provider share a price sheet. A command that accepted an
    // account would imply a control the server does not have.
    const { all } = await run(["rates", "2", "on"], { data });
    expect(all).toMatch(/Unknown/i);
  });
});
