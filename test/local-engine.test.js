/**
 * Keeping the model server up while the node lends: recognising what answers
 * at an endpoint, a supervised llama-server that restarts and then gives up,
 * and `ensureEngine` doing nothing at all for an external server.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { EventEmitter } from "node:events";
import { detectEngine, LlamaServer, ensureEngine, stopManagedEngine } from "../src/local/engine.js";
import { saveManifest, emptyManifest } from "../src/local/manifest.js";
import { startStubOllama } from "./helpers/stub-ollama.js";

const FAKE = path.join(import.meta.dirname, "helpers", "fake-llama-server.js");
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

const ollama = startStubOllama();
const openai = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (new URL(req.url).pathname === "/v1/models" ? Response.json({ data: [{ id: "lm-model" }] }) : new Response("no", { status: 404 })) });
afterAll(() => { ollama.stop(); openai.stop(true); });
afterEach(() => stopManagedEngine());

describe("detectEngine", () => {
  test("Ollama, any other OpenAI server, or nothing", async () => {
    expect(await detectEngine(ollama.url)).toMatchObject({ kind: "ollama", version: "0.12.3" });
    expect(await detectEngine(`http://127.0.0.1:${openai.port}`)).toEqual({ kind: "openai", models: ["lm-model"] });
    expect((await detectEngine(`http://127.0.0.1:${await freePort()}`)).kind).toBe("down");
  });
});

describe("LlamaServer", () => {
  test("starts, is recognised as llama.cpp, and stops", async () => {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const s = new LlamaServer({ bin: FAKE, base, args: ["--port", String(port), "--alias", "x/y"] });
    expect(await s.start({ timeoutMs: 15_000 })).toBe(true);
    expect((await detectEngine(base)).kind).toBe("llamacpp");
    s.kill();
    for (let i = 0; i < 40 && (await detectEngine(base)).kind !== "down"; i++) await Bun.sleep(100);
    expect((await detectEngine(base)).kind).toBe("down");
  }, 30_000);

  test("restarts after a crash, then gives up after five in ten minutes", async () => {
    const spawned = [];
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.kill = () => {};
      spawned.push(child);
      setTimeout(() => { child.exitCode = 3; child.emit("exit", 3, null); }, 1);
      return child;
    };
    const logs = [];
    const s = new LlamaServer({ bin: "/bin/llama-server", base: "http://127.0.0.1:1", args: [], spawnImpl, backoffMs: 1, log: (m) => logs.push(m) });
    const up = await s.start({ timeoutMs: 2000 });
    expect(up).toBe(false);
    for (let i = 0; i < 100 && !s.gaveUp; i++) await Bun.sleep(20);
    expect(s.gaveUp).toBe(true);
    expect(spawned.length).toBe(5);
    expect(logs.at(-1)).toMatch(/giving up/);
    s.kill();
  });

  test("kill stops restarts", async () => {
    const spawned = [];
    const spawnImpl = () => { const c = new EventEmitter(); c.exitCode = null; c.kill = () => { c.exitCode = 0; c.emit("exit", 0, null); }; spawned.push(c); return c; };
    const s = new LlamaServer({ bin: "/bin/llama-server", base: "http://127.0.0.1:1", args: [], spawnImpl, backoffMs: 1 });
    s._spawn();
    s.kill();
    await Bun.sleep(50);
    expect(spawned.length).toBe(1);
  });
});

describe("ensureEngine", () => {
  test("does nothing for an external server, or when lending is off", async () => {
    expect(await ensureEngine({ localEnabled: true, localEngine: "external", localEndpoint: "http://127.0.0.1:1" })).toEqual({ engine: "external", note: null, error: null });
    expect((await ensureEngine({ localEnabled: false, localEngine: "llamacpp" })).note).toBeNull();
  });

  test("Ollama already running is left alone", async () => {
    expect(await ensureEngine({ localEnabled: true, localEngine: "ollama", localEndpoint: ollama.url })).toEqual({ engine: "ollama", note: null, error: null });
  });

  test("llama.cpp with nothing installed says what to run", async () => {
    saveManifest(emptyManifest());
    const r = await ensureEngine({ localEnabled: true, localEngine: "llamacpp", localEndpoint: "http://127.0.0.1:1" });
    expect(r.error).toMatch(/aile local setup --engine llamacpp/);
  });

  test("llama.cpp starts the active model under its sell id, and stops with the node", async () => {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const gguf = path.join(process.env.AILE_DATA_DIR, "m.gguf");
    fs.writeFileSync(gguf, "weights");
    saveManifest({
      ...emptyManifest(),
      engines: { llamacpp: { tag: "b1", key: "x", dir: path.dirname(FAKE), bin: FAKE } },
      models: [{ id: "qwen/qwen3-8b", engine: "llamacpp", files: [{ path: gguf }], ctx: 8192, gpu: false }],
      active: "qwen/qwen3-8b",
    });
    const r = await ensureEngine({ localEnabled: true, localEngine: "llamacpp", localEndpoint: base, localContext: 8192, localModelDir: process.env.AILE_DATA_DIR });
    expect(r.error).toBeNull();
    expect(r.note).toMatch(/qwen\/qwen3-8b/);
    const models = await (await fetch(`${base}/v1/models`)).json();
    expect(models.data[0].id).toBe("qwen/qwen3-8b");

    // A second call finds it running and adopts it rather than starting another.
    expect((await ensureEngine({ localEnabled: true, localEngine: "llamacpp", localEndpoint: base })).note).toMatch(/already running/);

    stopManagedEngine();
    for (let i = 0; i < 40 && (await detectEngine(base)).kind !== "down"; i++) await Bun.sleep(100);
    expect((await detectEngine(base)).kind).toBe("down");
  }, 30_000);

  test("a llama-server left running with a different model is not adopted", async () => {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const stale = new LlamaServer({ bin: FAKE, base, args: ["--port", String(port), "--alias", "old/model"] });
    expect(await stale.start({ timeoutMs: 15_000 })).toBe(true);
    try {
      const gguf = path.join(process.env.AILE_DATA_DIR, "m.gguf");
      fs.writeFileSync(gguf, "weights");
      saveManifest({
        ...emptyManifest(),
        engines: { llamacpp: { tag: "b1", key: "x", dir: path.dirname(FAKE), bin: FAKE } },
        models: [{ id: "new/model", engine: "llamacpp", files: [{ path: gguf }] }],
        active: "new/model",
      });
      const r = await ensureEngine({ localEnabled: true, localEngine: "llamacpp", localEndpoint: base });
      expect(r.error).toMatch(/serving old\/model already holds/);
    } finally {
      stale.kill();
    }
  }, 30_000);

  test("something else holding the port is reported, not fought", async () => {
    const gguf = path.join(process.env.AILE_DATA_DIR, "m.gguf");
    fs.writeFileSync(gguf, "weights");
    saveManifest({
      ...emptyManifest(),
      engines: { llamacpp: { tag: "b1", key: "x", dir: path.dirname(FAKE), bin: FAKE } },
      models: [{ id: "a/b", engine: "llamacpp", files: [{ path: gguf }] }],
      active: "a/b",
    });
    const r = await ensureEngine({ localEnabled: true, localEngine: "llamacpp", localEndpoint: ollama.url });
    expect(r.error).toMatch(/something else \(ollama\)/);
  });
});
