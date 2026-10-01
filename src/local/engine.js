/**
 * Keeping the model server up while this machine lends.
 *
 * `aile start` calls `ensureEngine` before it connects. For an external
 * endpoint (the default, and everything that existed before managed engines)
 * it does nothing at all. For Ollama it starts `ollama serve` if nothing
 * answers, and leaves it running afterwards — Ollama is a shared service. For
 * llama.cpp it runs `llama-server` as a child of this process, restarts it if
 * it crashes, and stops it when the node stops.
 *
 * Nothing here downloads or installs anything. The relay's own code never
 * imports this module; `aile start` does, after reading only the user's own
 * settings (`test/local-isolation.test.js`).
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { version as ollamaVersion, findOllamaBin, startServe, ollamaBase } from "./ollama.js";
import { serverArgs, endpointPort, LLAMACPP_DEFAULT_ENDPOINT } from "./llamacpp.js";
import { loadManifest, findModel } from "./manifest.js";
import { logsDir } from "./paths.js";

async function get(url, { timeoutMs = 2500, fetchImpl = fetch } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { signal: ctl.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What answers at `base`:
 *   ollama   — `/api/version` answers like Ollama
 *   llamacpp — `/health` answers like llama-server (`loading` while a model loads)
 *   openai   — something else serving `/v1/models` (vLLM, LM Studio, …)
 *   down     — nothing
 * @returns {Promise<{kind: "ollama"|"llamacpp"|"openai"|"down", version?: string, loading?: boolean, models?: string[]}>}
 */
export async function detectEngine(base, opts = {}) {
  const v = await ollamaVersion(base, opts);
  if (v) return { kind: "ollama", version: v };
  const h = await get(`${base}/health`, opts);
  if (h && (h.ok || h.status === 503)) {
    let body = null;
    try { body = await h.json(); } catch { /* not JSON */ }
    if (body && typeof body.status === "string") {
      let models = [];
      const m = await get(`${base}/v1/models`, opts);
      try { if (m?.ok) models = ((await m.json())?.data || []).map((d) => d?.id).filter(Boolean); } catch { /* none listed */ }
      return { kind: "llamacpp", loading: h.status === 503, models };
    }
  }
  const m = await get(`${base}/v1/models`, opts);
  if (m?.ok) {
    try {
      const j = await m.json();
      return { kind: "openai", models: (j?.data || []).map((d) => d?.id).filter(Boolean) };
    } catch { /* fall through */ }
  }
  return { kind: "down" };
}

/** Wait for llama-server's `/health` to say ok (it answers 503 while loading). */
export async function waitHealthy(base, { timeoutMs = 180_000, child = null, fetchImpl = fetch } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child && child.exitCode !== null) return false;
    const r = await get(`${base}/health`, { fetchImpl });
    if (r?.ok) return true;
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
}

/**
 * A supervised `llama-server`.
 *
 * Restarts after a crash with a growing pause (1 s, 2 s, 4 s … 30 s), and
 * gives up after 5 crashes inside 10 minutes — a model that cannot load will
 * not load on the sixth try either, and a crash loop hides the real error.
 * The child is killed when this process exits, however it exits.
 */
export class LlamaServer {
  constructor({ bin, args, base, logFile = null, log = () => {}, spawnImpl = spawn, backoffMs = 1000 }) {
    this.bin = bin;
    this.args = args;
    this.base = base;
    this.logFile = logFile;
    this.log = log;
    this.spawnImpl = spawnImpl;
    this.backoffMs = backoffMs;
    this.child = null;
    this.stopped = false;
    this.crashes = [];
    this.gaveUp = false;
    this._onExit = () => this.kill();
  }

  _spawn() {
    let out = "ignore";
    if (this.logFile) {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      out = fs.openSync(this.logFile, "a");
    }
    // `bin`.js is a test stand-in, run by this same runtime.
    const [cmd, args] = /\.[cm]?js$/.test(this.bin) ? [process.execPath, [this.bin, ...this.args]] : [this.bin, this.args];
    const child = this.spawnImpl(cmd, args, { stdio: ["ignore", out, out], windowsHide: true });
    if (typeof out === "number") fs.closeSync(out);
    this.child = child;
    child.on("error", (e) => this.log(`llama-server could not start: ${e.message}`));
    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.stopped) return;
      const now = Date.now();
      this.crashes = [...this.crashes.filter((t) => now - t < 10 * 60_000), now];
      if (this.crashes.length >= 5) {
        this.gaveUp = true;
        this.log(`llama-server keeps stopping (last: ${signal || `exit ${code}`}); giving up. See ${this.logFile || "its output"}.`);
        return;
      }
      const wait = Math.min(30_000, this.backoffMs * 2 ** (this.crashes.length - 1));
      this.log(`llama-server stopped (${signal || `exit ${code}`}); restarting in ${Math.max(1, Math.round(wait / 1000))}s`);
      setTimeout(() => { if (!this.stopped) this._spawn(); }, wait).unref?.();
    });
    return child;
  }

  /** Start and wait until it serves. Resolves true when healthy. */
  async start({ timeoutMs = 180_000 } = {}) {
    process.on("exit", this._onExit);
    const child = this._spawn();
    return waitHealthy(this.base, { timeoutMs, child });
  }

  kill() {
    this.stopped = true;
    process.off("exit", this._onExit);
    const c = this.child;
    this.child = null;
    if (c && c.exitCode === null) {
      try { c.kill(); } catch { /* already gone */ }
    }
  }
}

let managed = null;

/**
 * Bring up the engine `config` names, for `aile start`.
 * @returns {Promise<{ engine: string, note: string|null, error: string|null }>}
 */
export async function ensureEngine(config, { log = () => {} } = {}) {
  const engine = config.localEngine || "external";
  if (!config.localEnabled || engine === "external") return { engine, note: null, error: null };

  if (engine === "ollama") {
    const base = ollamaBase(config);
    if (await ollamaVersion(base)) return { engine, note: null, error: null };
    const bin = findOllamaBin();
    if (!bin) return { engine, note: null, error: "Ollama is not running and its binary was not found; start Ollama, or run `aile local setup`" };
    const up = await startServe({ bin, base, logFile: path.join(logsDir(config), "ollama.log") });
    return up
      ? { engine, note: "started Ollama", error: null }
      : { engine, note: null, error: `started Ollama but it did not answer at ${base}` };
  }

  if (engine === "llamacpp") {
    const base = String(config.localEndpoint || LLAMACPP_DEFAULT_ENDPOINT).replace(/\/+$/, "");
    const manifest = loadManifest();
    const bin = manifest.engines.llamacpp?.bin;
    const model = manifest.active ? findModel(manifest, manifest.active, "llamacpp") : null;
    if (!bin || !fs.existsSync(bin)) return { engine, note: null, error: "llama.cpp is not installed; run `aile local setup --engine llamacpp`" };
    if (!model) return { engine, note: null, error: "no model chosen for llama.cpp; run `aile local pull <model>`" };
    const gguf = model.files?.[0]?.path;
    if (!gguf || !fs.existsSync(gguf)) return { engine, note: null, error: `the model file for ${model.id} is missing; run \`aile local pull ${model.id}\`` };

    const now = await detectEngine(base);
    // Left running by an earlier `aile start` whose terminal was closed: reuse it
    // only when it serves the model chosen now, never a stale one.
    if (now.kind === "llamacpp" && (now.loading || !now.models.length || now.models.includes(model.id))) {
      return { engine, note: "llama-server already running", error: null };
    }
    if (now.kind === "llamacpp") {
      return { engine, note: null, error: `a llama-server serving ${now.models.join(", ")} already holds ${base}; stop it, then run \`aile start\` again` };
    }
    if (now.kind !== "down") return { engine, note: null, error: `something else (${now.kind}) is listening at ${base}` };

    const args = serverArgs({ gguf, port: endpointPort(base), alias: model.id, ctx: model.ctx || config.localContext || 8192, gpu: model.gpu !== false });
    managed = new LlamaServer({ bin, args, base, logFile: path.join(logsDir(config), "llama-server.log"), log });
    const ok = await managed.start();
    return ok
      ? { engine, note: `started llama-server with ${model.id}`, error: null }
      : { engine, note: null, error: `llama-server did not come up; see ${managed.logFile}` };
  }
  return { engine, note: null, error: `unknown engine "${engine}"` };
}

/** Stop the llama-server `ensureEngine` started, if any. Ollama is left running. */
export function stopManagedEngine() {
  managed?.kill();
  managed = null;
}
