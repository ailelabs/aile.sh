/**
 * `aile rates` and a SELF-HOSTED model (`local/<id>`): read the `local` block of
 * `GET /pricing`, type a price, drop it, and switch or margin ONE exact id.
 *
 * As in provider-parity.test.js the stub records WHICH path and WHICH body each
 * request carried, because "it printed a cheerful line" is never the property under
 * test. The properties:
 *   - a `local/<id>` model sends the RAW id (case and tag kept) with provider `local`;
 *   - a dollar price on any other model dies BEFORE anything is sent;
 *   - a server with no `local` block (older) never crashes the read.
 */

import { describe, expect, it, beforeEach, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dirname, "..", "src", "cli", "index.js");
const scratches = [];

function stubServer({ pricing, refuse = null } = {}) {
  const calls = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.json().catch(() => null);
      calls.push({ path: url.pathname, query: url.search, method: req.method, body });
      if (url.pathname === "/pricing" && req.method === "GET") return Response.json({ success: true, data: pricing(), message: "" });
      if (url.pathname.startsWith("/pricing") && req.method !== "GET") {
        if (refuse) return Response.json({ success: false, message: refuse }, { status: 400 });
        return Response.json({ success: true, data: { ok: true }, message: "" });
      }
      return Response.json({ success: false, message: "not found" }, { status: 404 });
    },
  });
  return {
    calls,
    url: `http://127.0.0.1:${server.port}`,
    writes: () => calls.filter((c) => c.method !== "GET"),
    stop: () => { try { server.stop(true); } catch { /* ignore */ } },
  };
}

const BASE = (over = {}) => ({
  margin: 1, marginSet: false, modelMargins: {}, disabled: [], unitModels: {}, unitListPrices: {},
  defaults: { margin: 1, min: 0, max: 1, suggested: 0.9, maxUsdPerMtok: 1000 },
  ...over,
});
const LOCAL = {
  capMultiple: 3, maxUsdPerMtok: 1000,
  models: [
    { model: "llama3.1:8b", online: true, list: { in: 2, out: 10, cacheRead: null }, cap: { in: 6, out: 30 }, margin: 0.8, marginSet: true,
      typed: null, price: { in: 1.6, out: 8, cacheRead: null }, status: "following" },
    { model: "Llama3.1:70B", online: false, list: null, cap: null, margin: 1, marginSet: false,
      typed: { in: 0.2, out: 0.6, cacheRead: null, updatedAt: "2026-11-05T00:00:00.000Z" }, price: { in: 0.2, out: 0.6, cacheRead: null }, status: "typed" },
    { model: "mistral:7b", online: true, list: null, cap: null, margin: 1, marginSet: false, typed: null, price: null, status: "unpriced" },
    { model: "qwen3:8b", online: true, list: { in: 1, out: 2, cacheRead: null }, cap: { in: 3, out: 6 }, margin: 1, marginSet: false,
      typed: { in: 9, out: 9, cacheRead: null, updatedAt: "2026-11-05T00:00:00.000Z" }, price: null, status: "over_cap" },
    { model: "phi3:mini", online: true, list: { in: 1, out: 2, cacheRead: null }, cap: { in: 3, out: 6 }, margin: 1, marginSet: false, typed: null, price: null, status: "off" },
  ],
};

function signedInData(serverUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-rates-local-"));
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
function start(pricing = () => BASE({ local: LOCAL }), opts = {}) {
  stub?.stop();
  stub = stubServer({ pricing, ...opts });
  data = signedInData(stub.url);
}
beforeEach(() => start());
afterAll(() => { stub?.stop(); for (const d of scratches) fs.rmSync(d, { recursive: true, force: true }); });

describe("aile rates — the self-hosted section", () => {
  it("lists each raw id with its status in words, the price a caller pays and the list", async () => {
    const { stdout, code } = await run(["rates"], { data });
    expect(code).toBe(0);
    expect(stub.writes()).toHaveLength(0);
    expect(stdout).toMatch(/Self-hosted models \(5\)/);
    expect(stdout).toMatch(/local\/llama3\.1:8b\s+online\s+follows list × your margin/);
    expect(stdout).toMatch(/callers pay \$1\.6 in \/ \$8 out per Mtok\s+· list \$2 \/ \$10, margin ×0\.8 \(20% below list\) \(this model\)/);
    expect(stdout).toMatch(/local\/Llama3\.1:70B\s+offline\s+your price/);
    expect(stdout).toMatch(/callers pay \$0\.2 in \/ \$0\.6 out per Mtok\s+· list no list, margin ×1 \(list price\)/);
    expect(stdout).toMatch(/local\/mistral:7b\s+online\s+not sold: no list price — type one/);
    expect(stdout).toMatch(/local\/qwen3:8b\s+online\s+not offered: above 3× the new list price/);
    expect(stdout).toMatch(/local\/phi3:mini\s+online\s+off/);
    // A model that is not offered shows no price.
    expect(stdout).toMatch(/local\/mistral:7b[^\n]*\n\s+callers pay —/);
  });

  it("names the two verbs that change a price, only when there is something to price", async () => {
    const { stdout } = await run(["rates"], { data });
    expect(stdout).toContain("aile rates set local/<id> --in 0.2 --out 0.6");
    expect(stdout).toContain("aile rates follow local/<id>");
  });

  it("an older server with no `local` block prints nothing extra and does not crash", async () => {
    start(() => BASE());
    const { stdout, code } = await run(["rates"], { data });
    expect(code).toBe(0);
    expect(stdout).toMatch(/What you charge/);
    expect(stdout).not.toMatch(/Self-hosted/i);
    expect(stdout).not.toMatch(/--in|--out/);
  });

  it("a `local: null` block says once that it could not be read", async () => {
    start(() => BASE({ local: null }));
    const { stdout, code } = await run(["rates"], { data });
    expect(code).toBe(0);
    expect(stdout).toMatch(/Self-hosted prices could not be read just now/);
    expect(stdout).not.toMatch(/Self-hosted models \(/);
  });

  it("an empty block prints no section, and --json prints the server body untouched", async () => {
    start(() => BASE({ local: { capMultiple: 3, maxUsdPerMtok: 1000, models: [] } }));
    expect((await run(["rates"], { data })).stdout).not.toMatch(/Self-hosted models/);
    start();
    const { stdout } = await run(["rates", "--json"], { data });
    expect(JSON.parse(stdout).local.models).toHaveLength(5);
  });

  it("survives a hand-written junk row", async () => {
    start(() => BASE({ local: { models: [null, { model: 5 }, { model: "ok:1b", status: "weird", online: true }] } }));
    const { code, stdout } = await run(["rates"], { data });
    expect(code).toBe(0);
    expect(stdout).toContain("local/ok:1b");
  });
});

describe("aile rates set local/<id> --in --out", () => {
  it("types a price on the RAW id with provider local, case and tag kept", async () => {
    const { code, stdout } = await run(["rates", "set", "local/Llama3.1:70B", "--in", "0.2", "--out", "0.6"], { data });
    expect(code).toBe(0);
    expect(stub.writes()).toEqual([{ path: "/pricing/model", query: "", method: "PUT", body: { model: "Llama3.1:70B", provider: "local", inUsd: 0.2, outUsd: 0.6 } }]);
    expect(stdout).toMatch(/Set\. local\/Llama3\.1:70B now sells at \$0\.2 in \/ \$0\.6 out per million tokens/);
    expect(stdout).toContain("aile rates follow local/Llama3.1:70B");
  });

  it("sends a cache read only when asked", async () => {
    await run(["rates", "set", "local/x:1b", "--in", "1", "--out", "2", "--cache-read", "0.5"], { data });
    expect(stub.writes()[0].body).toEqual({ model: "x:1b", provider: "local", inUsd: 1, outUsd: 2, cacheReadUsd: 0.5 });
    expect(stub.writes()[0].body).not.toHaveProperty("cacheReadUsd", undefined);
  });

  it("accepts a $ and the = form, and a free price of 0", async () => {
    await run(["rates", "set", "local/x:1b", "--in=$0", "--out", "$0"], { data });
    expect(stub.writes()[0].body).toMatchObject({ inUsd: 0, outUsd: 0 });
  });

  it("is case-insensitive on the `local/` prefix only", async () => {
    await run(["rates", "set", "LOCAL/Foo:Bar", "--in", "1", "--out", "1"], { data });
    expect(stub.writes()[0].body.model).toBe("Foo:Bar");
  });

  it("needs both --in and --out, and numbers of 0 or more, before anything is sent", async () => {
    for (const args of [
      ["rates", "set", "local/x", "--in", "1"],
      ["rates", "set", "local/x", "--out", "1"],
      ["rates", "set", "local/x", "--in", "abc", "--out", "1"],
      ["rates", "set", "local/x", "--in", "-1", "--out", "1"],
      ["rates", "set", "local/x", "--in", "1", "--out", "1", "--cache-read", "no"],
      ["rates", "set", "local/x", "--in", "--out", "1"],
    ]) {
      const { code } = await run(args, { data });
      expect(code).not.toBe(0);
    }
    expect(stub.calls).toHaveLength(0);
  });

  it("refuses a price beside --model-margin, before sending", async () => {
    const { code, all } = await run(["rates", "set", "local/x", "--in", "1", "--out", "1", "--model-margin", "0.5"], { data });
    expect(code).not.toBe(0);
    expect(all).toMatch(/Either a margin or a price, not both/);
    expect(stub.calls).toHaveLength(0);
  });

  it("shows the server's own words when it refuses (the cap)", async () => {
    start(() => BASE(), { refuse: "the most you can charge for local/x is 3x its list price: $6 in and $30 out per million tokens" });
    const { code, all } = await run(["rates", "set", "local/x", "--in", "9", "--out", "9"], { data });
    expect(code).not.toBe(0);
    expect(all).toContain("the most you can charge for local/x is 3x its list price");
  });

  it("local/ with nothing after it names no model", async () => {
    const { code } = await run(["rates", "set", "local/", "--in", "1", "--out", "1"], { data });
    expect(code).not.toBe(0);
    expect(stub.calls).toHaveLength(0);
  });

  it("MUST-NOT: --in / --out on a model that is not self-hosted dies before any request", async () => {
    for (const args of [
      ["rates", "set", "claude-opus-5", "--in", "3", "--out", "15"],
      ["rates", "set", "openrouter/google/lyria-3-pro-preview", "--in", "1", "--out", "1"],
      ["rates", "set", "claude-opus-5", "--cache-read", "1"],
      ["rates", "--in", "3"],
      ["rates", "off", "local/x", "--in", "1"],
    ]) {
      const { code, all } = await run(args, { data });
      expect(code).not.toBe(0);
      expect(all).toContain("Dollar prices are for self-hosted models only — use --model-margin (0 = free, 1 = list), or name one as local/<id>.");
    }
    expect(stub.calls).toHaveLength(0);
  });
});

describe("aile rates follow, and the other verbs on a local/ id", () => {
  it("follow clears the typed price: null in and out, provider local, raw id", async () => {
    const { code, stdout } = await run(["rates", "follow", "local/llama3.1:8b"], { data });
    expect(code).toBe(0);
    expect(stub.writes()).toEqual([{ path: "/pricing/model", query: "", method: "PUT", body: { model: "llama3.1:8b", provider: "local", inUsd: null, outUsd: null } }]);
    expect(stdout).toMatch(/Following the list\. local\/llama3\.1:8b/);
  });

  it("follow needs a self-hosted model", async () => {
    for (const args of [["rates", "follow"], ["rates", "follow", "claude-opus-5"]]) {
      expect((await run(args, { data })).code).not.toBe(0);
    }
    expect(stub.calls).toHaveLength(0);
  });

  it("off / on switch exactly that raw id", async () => {
    await run(["rates", "off", "local/llama3.1:8b"], { data });
    await run(["rates", "on", "local/Llama3.1:70B"], { data });
    expect(stub.writes().map((c) => [c.path, c.body])).toEqual([
      ["/pricing/model/disabled", { model: "llama3.1:8b", disabled: true, provider: "local" }],
      ["/pricing/model/disabled", { model: "Llama3.1:70B", disabled: false, provider: "local" }],
    ]);
  });

  it("a margin for one self-hosted id names provider local; clear drops that id's margin", async () => {
    await run(["rates", "set", "local/llama3.1:8b", "--model-margin", "0.9"], { data });
    await run(["rates", "clear", "local/llama3.1:8b"], { data });
    expect(stub.writes().map((c) => [c.method, c.path, c.query, c.body])).toEqual([
      ["PUT", "/pricing/model", "", { model: "llama3.1:8b", margin: 0.9, provider: "local" }],
      ["DELETE", "/pricing/model/llama3.1%3A8b", "?provider=local", null],
    ]);
  });

  it("MUST-NOT: a provider-served model sends exactly what it always did", async () => {
    await run(["rates", "set", "claude-opus-5", "--model-margin", "0.8"], { data });
    await run(["rates", "off", "claude-opus-5"], { data });
    await run(["rates", "clear", "claude-opus-5"], { data });
    expect(stub.writes().map((c) => [c.method, c.path, c.query, c.body])).toEqual([
      ["PUT", "/pricing/model", "", { model: "claude-opus-5", margin: 0.8 }],
      ["PUT", "/pricing/model/disabled", "", { model: "claude-opus-5", disabled: true }],
      ["DELETE", "/pricing/model/claude-opus-5", "", null],
    ]);
  });
});
