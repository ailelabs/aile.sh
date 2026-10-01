/**
 * `aile local` end to end, through the real CLI.
 *
 * Every outside party is a stub on loopback: Ollama (OLLAMA_HOST), the relay's
 * price check (the config's serverUrl), Hugging Face (AILE_HF_URL), and
 * llama-server (AILE_LLAMA_SERVER_BIN, a script). The test preload sets
 * AILE_LOCAL_NO_INSTALL, so nothing here can run a package manager.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { startStubOllama } from "./helpers/stub-ollama.js";

const CLI = path.join(import.meta.dirname, "..", "src", "cli", "index.js");
const FAKE_LLAMA = path.join(import.meta.dirname, "helpers", "fake-llama-server.js");
// Fixed hardware AND free disk, so no test depends on the machine running it.
const HW = JSON.stringify({ platform: process.platform, arch: "x64", ramBytes: 32e9, vramBytes: 24e9, accel: "cuda", unified: false, gpus: [{ vendor: "nvidia", name: "Test GPU", vramBytes: 24e9 }], driver: "600.0", diskFreeBytes: 500e9 });

const ollama = startStubOllama();

// The relay's `GET /catalog/self-hosted`: the curated ids price, nothing else does.
let priceUp = true;
const priced = new Set(["meta-llama/llama-3.1-8b-instruct", "qwen/qwen3-8b", "meta-llama/llama-3.2-1b-instruct"]);
const api = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/catalog/self-hosted" && priceUp) {
      const ids = url.searchParams.get("ids").split(",");
      return Response.json({ success: true, message: "", data: { models: ids.map((id) => priced.has(id)
        ? { id, priced: true, inPerMtok: 0.05, outPerMtok: 0.08, contextTokens: 131072, source: "catalogue" }
        : { id, priced: false, inPerMtok: null, outPerMtok: null, contextTokens: null, source: null }) } });
    }
    return Response.json({ success: false, message: "not found" }, { status: 404 });
  },
});
const API = `http://127.0.0.1:${api.port}`;

// Hugging Face, for the llama.cpp path.
const GGUF = Buffer.from("pretend gguf weights");
const hf = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/api/models/bartowski/Llama-3.2-1B-Instruct-GGUF/tree/main") {
      return Response.json([{ type: "file", path: "Llama-3.2-1B-Instruct-Q4_K_M.gguf", size: 1, lfs: { oid: crypto.createHash("sha256").update(GGUF).digest("hex"), size: GGUF.length } }]);
    }
    if (pathname.endsWith("/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf")) return new Response(GGUF);
    return new Response("no", { status: 404 });
  },
});

const scratches = [];
afterAll(() => {
  ollama.stop(); api.stop(true); hf.stop(true);
  for (const d of scratches) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});
beforeEach(() => { priceUp = true; ollama.state.calls = []; });

function dataDir(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-localcli-"));
  scratches.push(dir);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ serverUrl: API, ...extra }));
  return dir;
}
const readConfig = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

async function run(args, { data, env = {}, timeoutMs = 30_000 } = {}) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: {
      ...process.env, AILE_DATA_DIR: data, NO_COLOR: "1", AILE_NO_SPINNER: "1",
      OLLAMA_HOST: ollama.url, AILE_HF_URL: `http://127.0.0.1:${hf.port}`, AILE_LOCAL_HW: HW, ...env,
    },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr, all: stdout + stderr };
}

describe("aile local models", () => {
  test("lists the curated models with live list prices", async () => {
    const { stdout, code } = await run(["local", "models", "--json"], { data: dataDir() });
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.prices).toBe("live");
    const llama = out.models.find((m) => m.id === "meta-llama/llama-3.1-8b-instruct");
    expect(llama).toMatchObject({ priced: true, inPerMtok: 0.05, fit: "gpu" });
  });

  test("an older server: prices are unknown, and the command still works", async () => {
    priceUp = false;
    const { stdout, code } = await run(["local", "models"], { data: dataDir() });
    expect(code).toBe(0);
    expect(stdout).toContain("price unknown");
    expect(stdout).toContain("does not answer price checks");
  });

  test("a search narrows the list", async () => {
    const { stdout } = await run(["local", "models", "gemma", "--json"], { data: dataDir() });
    expect(JSON.parse(stdout).models.every((m) => m.id.startsWith("google/gemma"))).toBe(true);
  });
});

describe("aile local pull (Ollama)", () => {
  test("a curated tag is pulled, saved under its priced id, and named for lending", async () => {
    const data = dataDir();
    const { all, code } = await run(["local", "pull", "llama3.1:8b"], { data });
    expect(code).toBe(0);
    expect(ollama.state.calls.find((c) => c.path === "/api/pull").body.model).toBe("llama3.1:8b");
    const create = ollama.state.calls.find((c) => c.path === "/api/create");
    expect(create.body).toMatchObject({ model: "meta-llama/llama-3.1-8b-instruct", from: "llama3.1:8b", parameters: { num_ctx: 8192 } });
    expect(all).toContain("Sells as local/meta-llama/llama-3.1-8b-instruct");
    const cfg = readConfig(data);
    expect(cfg).toMatchObject({ localEngine: "ollama", localEndpoint: ollama.url, localModels: "meta-llama/llama-3.1-8b-instruct" });
    expect(cfg.localEnabled).toBeUndefined();
    expect(all).toContain("aile local on");
  });

  test("a model with no list price runs, is said not to sell, and is not named for lending", async () => {
    const data = dataDir();
    const { all, code } = await run(["local", "pull", "mistral:7b"], { data });
    expect(code).toBe(0);
    expect(all).toContain("Not sellable: mistral:7b has no published list price");
    expect(readConfig(data).localModels).toBeUndefined();
  });

  test("a pull never moves lending that points at another server", async () => {
    const data = dataDir({ localEnabled: true, localEndpoint: "http://127.0.0.1:1234", localModels: "lm" });
    const { all, code } = await run(["local", "pull", "qwen3:8b"], { data });
    expect(code).toBe(0);
    expect(all).toContain("points at http://127.0.0.1:1234");
    expect(readConfig(data)).toMatchObject({ localEndpoint: "http://127.0.0.1:1234", localModels: "lm" });
  });

  test("an unknown engine flag, and an Ollama that is not running, are refused clearly", async () => {
    expect((await run(["local", "pull", "x:1", "--engine", "vllm"], { data: dataDir() })).all).toMatch(/--engine must be ollama or llamacpp/);
    const down = await run(["local", "pull", "x:1", "--engine", "ollama"], { data: dataDir(), env: { OLLAMA_HOST: `127.0.0.1:${await freePort()}` } });
    expect(down.code).toBe(1);
    expect(down.all).toMatch(/Ollama is not running/);
  });
});

describe("aile local list / rm / run / on", () => {
  test("list shows what Ollama has, with prices", async () => {
    const data = dataDir();
    await run(["local", "pull", "llama3.1:8b"], { data });
    const { stdout } = await run(["local", "list", "--json"], { data });
    const ids = JSON.parse(stdout).models.map((m) => m.id);
    expect(ids).toContain("meta-llama/llama-3.1-8b-instruct");
  });

  test("rm asks for --yes without a terminal, then deletes the alias and the download it shares", async () => {
    const data = dataDir();
    await run(["local", "pull", "llama3.1:8b"], { data });
    const refused = await run(["local", "rm", "meta-llama/llama-3.1-8b-instruct"], { data });
    expect(refused.code).toBe(1);
    expect(refused.all).toContain("--yes");
    ollama.state.calls = [];
    const { code, all } = await run(["local", "rm", "meta-llama/llama-3.1-8b-instruct", "--yes"], { data });
    expect(code).toBe(0);
    expect(all).toContain("Deleted meta-llama/llama-3.1-8b-instruct");
    const deleted = ollama.state.calls.filter((c) => c.path === "/api/delete").map((c) => c.body.model);
    expect(deleted).toEqual(["meta-llama/llama-3.1-8b-instruct", "llama3.1:8b"]);
    expect(readConfig(data).localModels ?? "").toBe("");
  });

  test("run streams the reply to stdout", async () => {
    const { stdout, code } = await run(["local", "run", "llama3.1:8b", "say", "hi"], { data: dataDir() });
    expect(code).toBe(0);
    expect(stdout).toBe("Hello!\n");
    const chat = ollama.state.calls.find((c) => c.path === "/v1/chat/completions");
    expect(chat.body).toMatchObject({ model: "meta-llama/llama-3.1-8b-instruct", stream: true, messages: [{ role: "user", content: "say hi" }] });
  });

  test("on needs something to lend", async () => {
    const none = await run(["local", "on"], { data: dataDir() });
    expect(none.code).toBe(1);
    expect(none.all).toMatch(/aile local setup/);
    const data = dataDir({ localEndpoint: ollama.url });
    const { code, stdout } = await run(["local", "on"], { data });
    expect(code).toBe(0);
    expect(stdout).toContain("not blind");
    expect(readConfig(data).localEnabled).toBe(true);
  });

  test("a download bigger than the free disk is refused before anything is fetched", async () => {
    const tight = JSON.stringify({ ...JSON.parse(HW), diskFreeBytes: 2e9 });
    const { code, all } = await run(["local", "pull", "llama3.1:8b"], { data: dataDir(), env: { AILE_LOCAL_HW: tight } });
    expect(code).toBe(1);
    expect(all).toMatch(/Not enough disk space: this needs 4\.9 GB, and 2.0 GB is free/);
    expect(ollama.state.calls.filter((c) => c.path === "/api/pull")).toEqual([]);
  });

  test("a typo gets a suggestion, not an endpoint error", async () => {
    const { code, all } = await run(["local", "stup"], { data: dataDir() });
    expect(code).toBe(1);
    expect(all).toContain("Did you mean aile local setup");
  });
});

describe("aile local setup", () => {
  test("without a terminal it asks for --yes and changes nothing", async () => {
    const data = dataDir();
    const { code, all } = await run(["local", "setup"], { data });
    expect(code).toBe(1);
    expect(all).toContain("--yes --model");
    expect(ollama.state.calls.filter((c) => c.path === "/api/pull")).toEqual([]);
  });

  test("--yes on Ollama: pull, save as the priced id, test it, lend it", async () => {
    const data = dataDir();
    const { code, all } = await run(["local", "setup", "--yes", "--engine", "ollama", "--model", "qwen/qwen3-8b"], { data });
    expect(code).toBe(0);
    expect(all).toContain("It answers");
    expect(all).toContain("Lending local/qwen/qwen3-8b");
    expect(all).toContain("aile login");
    expect(readConfig(data)).toMatchObject({ localEnabled: true, localEngine: "ollama", localModels: "qwen/qwen3-8b" });
  });

  test("--yes on llama.cpp: downloads the GGUF, runs it under its id, lends it", async () => {
    const port = await freePort();
    const data = dataDir({ localEngine: "llamacpp", localEndpoint: `http://127.0.0.1:${port}` });
    const { code, all } = await run(["local", "setup", "--yes", "--engine", "llamacpp", "--model", "meta-llama/llama-3.2-1b-instruct"], {
      data, env: { AILE_LLAMA_SERVER_BIN: FAKE_LLAMA },
    });
    expect(code).toBe(0);
    expect(all).toContain("Using your own llama-server");
    expect(all).toContain("It answers");
    expect(all).toContain("Lending local/meta-llama/llama-3.2-1b-instruct");
    const cfg = readConfig(data);
    expect(cfg).toMatchObject({ localEnabled: true, localEngine: "llamacpp", localModels: "meta-llama/llama-3.2-1b-instruct" });
    const manifest = JSON.parse(fs.readFileSync(path.join(data, "local.json"), "utf8"));
    expect(manifest.active).toBe("meta-llama/llama-3.2-1b-instruct");
    expect(fs.readFileSync(manifest.models[0].files[0].path).equals(GGUF)).toBe(true);
    // The temporary server for the test is gone again: `aile start` owns it from here.
    const stillUp = await fetch(`http://127.0.0.1:${port}/health`).then(() => true, () => false);
    expect(stillUp).toBe(false);
  }, 60_000);
});

describe("aile local status", () => {
  test("names the engine, the state, and what buyers send", async () => {
    const data = dataDir();
    await run(["local", "setup", "--yes", "--engine", "ollama", "--model", "llama3.1:8b"], { data });
    const { stdout, code } = await run(["local"], { data });
    expect(code).toBe(0);
    expect(stdout).toContain("Ollama 0.12.3");
    expect(stdout).toContain("local/meta-llama/llama-3.1-8b-instruct");
    expect(stdout).toContain("$0.05 / $0.08");
    const json = JSON.parse((await run(["local", "--json"], { data })).stdout);
    expect(json).toMatchObject({ engine: "ollama", lending: true, state: "up" });
    expect(json.models.find((m) => m.id === "meta-llama/llama-3.1-8b-instruct")).toMatchObject({ offered: true, priced: true });
  });
});
