/**
 * Ollama, driven through its HTTP API.
 *
 * Only the API, never the `ollama` CLI: the API is the stable contract, it
 * reports pull progress as data rather than as terminal art, and it works the
 * same whichever way Ollama was installed (app, package, script, container).
 * The binary is looked for only to START a server that is not running.
 *
 * Two names matter for selling, and they are different. Ollama pulls
 * `llama3.1:8b`; the relay prices `meta-llama/llama-3.1-8b-instruct`. `alias`
 * saves the pulled model under the priced name (sharing its weights, so it
 * costs no disk), and that is the name buyers reach.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export const OLLAMA_DEFAULT = "http://127.0.0.1:11434";

export class OllamaError extends Error {
  constructor(message, { status = null } = {}) { super(message); this.name = "OllamaError"; this.status = status; }
}

/**
 * Where Ollama listens: the configured endpoint when Ollama is the engine,
 * else `OLLAMA_HOST` (as Ollama itself reads it — `0.0.0.0` means "every
 * interface", which we reach on loopback), else its default.
 */
export function ollamaBase(config = {}, env = process.env) {
  if (config.localEngine === "ollama" && config.localEndpoint) return String(config.localEndpoint).replace(/\/+$/, "");
  const raw = String(env.OLLAMA_HOST || "").trim();
  if (!raw) return OLLAMA_DEFAULT;
  let s = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const u = new URL(s);
    if (u.hostname === "0.0.0.0" || u.hostname === "") u.hostname = "127.0.0.1";
    if (!u.port) u.port = "11434";
    s = `${u.protocol}//${u.host}`;
  } catch {
    return OLLAMA_DEFAULT;
  }
  return s;
}

async function call(base, pathname, { method = "GET", body, timeoutMs = 10_000, fetchImpl = fetch, signal } = {}) {
  const ctl = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  const onAbort = () => ctl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await fetchImpl(`${base}${pathname}`, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function errorText(res) {
  try {
    const t = await res.text();
    try { return JSON.parse(t).error || t; } catch { return t; }
  } catch {
    return "";
  }
}

/** Ollama's version, or null when nothing (or something else) answers. */
export async function version(base, opts = {}) {
  try {
    const res = await call(base, "/api/version", { timeoutMs: 2500, ...opts });
    if (!res.ok) return null;
    const j = await res.json();
    return typeof j?.version === "string" ? j.version : null;
  } catch {
    return null;
  }
}

/** Installed models: `[{name, size, digest, details}]`. */
export async function tags(base, opts = {}) {
  const res = await call(base, "/api/tags", opts);
  if (!res.ok) throw new OllamaError(`Ollama answered HTTP ${res.status} listing models`, { status: res.status });
  const j = await res.json();
  return Array.isArray(j?.models) ? j.models : [];
}

/** True when `name` (with or without `:latest`) is installed. */
export function hasModel(list, name) {
  const want = String(name).toLowerCase();
  const full = want.includes(":") ? want : `${want}:latest`;
  return list.some((m) => {
    const n = String(m.name || m.model || "").toLowerCase();
    return n === want || n === full;
  });
}

/**
 * Pull `tag`, reporting `{status, done, total}` as layers arrive. Ollama
 * streams one JSON object per line, one stream of counters per layer; the
 * total is the sum over every layer seen so far.
 */
export async function pull(base, tag, { onProgress = () => {}, signal, fetchImpl = fetch } = {}) {
  const res = await call(base, "/api/pull", { method: "POST", body: { model: tag, name: tag, stream: true }, timeoutMs: 0, signal, fetchImpl });
  if (!res.ok) throw new OllamaError(`could not pull ${tag}: ${await errorText(res) || `HTTP ${res.status}`}`, { status: res.status });
  const layers = new Map();
  const decoder = new TextDecoder();
  let buf = "";
  let last = null;
  const handle = (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.error) throw new OllamaError(`could not pull ${tag}: ${msg.error}`);
    last = msg.status || last;
    if (msg.digest && Number(msg.total) > 0) layers.set(msg.digest, { total: Number(msg.total), done: Number(msg.completed) || 0 });
    let total = 0;
    let done = 0;
    for (const l of layers.values()) { total += l.total; done += Math.min(l.done, l.total); }
    onProgress({ status: msg.status || "", done, total: total || null });
  };
  const reader = res.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      handle(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  handle(buf);
  if (last !== "success") throw new OllamaError(`the pull of ${tag} ended before it finished (${last || "no status"})`);
}

/**
 * Save `from` under the name `to`, with a context window of `ctx` tokens.
 *
 * Three ways, newest first, because Ollama's create API changed shape: the
 * `{from, parameters}` body (0.5.5+), the Modelfile body older servers take,
 * and finally a plain copy — which works everywhere but cannot set the
 * context window, so the caller is told which one happened.
 *
 * @returns {Promise<"create"|"modelfile"|"copy">}
 */
export async function alias(base, from, to, { ctx = null, fetchImpl = fetch } = {}) {
  const tries = [
    ["create", { model: to, from, ...(ctx ? { parameters: { num_ctx: ctx } } : {}), stream: false }],
    ["modelfile", { name: to, modelfile: `FROM ${from}${ctx ? `\nPARAMETER num_ctx ${ctx}` : ""}`, stream: false }],
  ];
  let lastErr = "";
  for (const [how, body] of tries) {
    const res = await call(base, "/api/create", { method: "POST", body, timeoutMs: 120_000, fetchImpl });
    if (res.ok) {
      const t = await res.text();
      if (!/"error"/.test(t)) return how;
      lastErr = t;
    } else {
      lastErr = await errorText(res);
    }
  }
  const res = await call(base, "/api/copy", { method: "POST", body: { source: from, destination: to }, fetchImpl });
  if (res.ok) return "copy";
  throw new OllamaError(`could not save ${from} as ${to}: ${(await errorText(res)) || lastErr || `HTTP ${res.status}`}`, { status: res.status });
}

/** Delete `name`. False when it was not installed. */
export async function remove(base, name, { fetchImpl = fetch } = {}) {
  const res = await call(base, "/api/delete", { method: "DELETE", body: { model: name, name }, fetchImpl });
  if (res.status === 404) return false;
  if (!res.ok) throw new OllamaError(`could not delete ${name}: ${(await errorText(res)) || `HTTP ${res.status}`}`, { status: res.status });
  return true;
}

/**
 * The `ollama` binary: on PATH, else where its installers put it. Checked
 * after an install too, because the shell that ran the installer — this
 * process — still has the PATH it started with.
 */
export function findOllamaBin({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  const exe = platform === "win32" ? "ollama.exe" : "ollama";
  const dirs = String(env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  const known = platform === "win32"
    ? [path.join(env.LOCALAPPDATA || "", "Programs", "Ollama"), path.join(env.ProgramFiles || "C:\\Program Files", "Ollama")]
    : platform === "darwin"
      ? ["/Applications/Ollama.app/Contents/Resources", "/opt/homebrew/bin", "/usr/local/bin"]
      : ["/usr/local/bin", "/usr/bin", "/opt/ollama/bin"];
  for (const d of [...dirs, ...known]) {
    const p = path.join(d, exe);
    if (d && exists(p)) return p;
  }
  return null;
}

/**
 * Start `ollama serve` in the background, bound to `base`'s address, and wait
 * until it answers. Detached and unreferenced: Ollama is a shared service the
 * user may use for other things, so it outlives this command.
 */
export async function startServe({ bin, base = OLLAMA_DEFAULT, logFile = null, waitMs = 20_000 }) {
  const u = new URL(base);
  let out = "ignore";
  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    out = fs.openSync(logFile, "a");
  }
  const child = spawn(bin, ["serve"], {
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
    env: { ...process.env, OLLAMA_HOST: `${u.hostname}:${u.port || 11434}` },
  });
  child.on("error", () => { /* reported by the wait below */ });
  child.unref();
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    if (await version(base)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
