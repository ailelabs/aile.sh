/**
 * llama.cpp: which build fits this machine, and how to run its server.
 *
 * The fallback engine, for when Ollama cannot or should not be installed: it
 * needs no administrator rights and no system service — aile downloads one
 * pinned `llama-server` into its own directory and runs it while `aile start`
 * runs. It serves one model at a time.
 *
 * No network here and no process control; see install.js and engine.js.
 */

import fs from "node:fs";
import path from "node:path";
import { LLAMACPP_PINS } from "./llamacpp-pins.js";

const ACCEL_NAME = { cuda: "CUDA", vulkan: "Vulkan", cpu: "CPU", metal: "Metal" };

/** `"610.88" >= "551.61"`, numerically per component. */
export function versionAtLeast(have, need) {
  const a = String(have || "").split(".").map(Number);
  const b = String(need || "").split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

/**
 * The build for `hw`. `accel` ("cuda", "vulkan", "cpu") overrides the choice
 * when that build exists for this platform.
 *
 * NVIDIA gets CUDA when its driver is new enough for the pinned CUDA runtime,
 * else Vulkan, which every current GPU driver ships. Apple silicon's build has
 * Metal built in. Anything else runs on the CPU.
 *
 * @returns {{ key: string, asset: object, accel: string, reason: string } | null}
 */
export function pickAsset(hw, { accel = null, pins = LLAMACPP_PINS } = {}) {
  const os = hw.platform === "win32" ? "win" : hw.platform === "darwin" ? "macos" : hw.platform === "linux" ? "linux" : null;
  const arch = hw.arch === "arm64" ? "arm64" : hw.arch === "x64" ? "x64" : null;
  if (!os || !arch) return null;
  const has = (k) => Boolean(pins.assets[k]);
  const out = (key, a, reason) => ({ key, asset: pins.assets[key], accel: a, reason });

  if (os === "macos") {
    const key = `macos-${arch}`;
    return has(key) ? out(key, arch === "arm64" ? "metal" : "cpu", arch === "arm64" ? "Metal" : "CPU") : null;
  }
  const base = `${os}-${arch}`;
  if (accel) {
    const key = `${base}-${accel}`;
    return has(key) ? out(key, accel, ACCEL_NAME[accel] || accel) : null;
  }
  const nvidia = hw.gpus?.find((g) => g.vendor === "nvidia");
  const cuda = pins.assets[`${base}-cuda`];
  if (nvidia && cuda && versionAtLeast(hw.driver, cuda.minDriver)) return out(`${base}-cuda`, "cuda", `CUDA on ${nvidia.name}`);
  if (hw.gpus?.length && has(`${base}-vulkan`)) return out(`${base}-vulkan`, "vulkan", `Vulkan on ${hw.gpus[0].name}`);
  return has(`${base}-cpu`) ? out(`${base}-cpu`, "cpu", "CPU") : null;
}

/** Bytes to download for a build, the CUDA runtime included. */
export const assetBytes = (asset) => (asset?.size || 0) + (asset?.extra?.size || 0);

/** The `llama-server` executable inside an extracted build, wherever the archive put it. */
export function findServerBin(dir, platform = process.platform) {
  const exe = platform === "win32" ? "llama-server.exe" : "llama-server";
  const stack = [dir];
  for (let guard = 0; stack.length && guard < 2000; guard++) {
    const d = stack.shift();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isFile() && e.name === exe) return p;
      if (e.isDirectory()) stack.push(p);
    }
  }
  return null;
}

/**
 * Arguments for `llama-server`. Loopback only, always: the relay reaches it
 * through the node, never over the network. One slot (`-np 1`) so the whole
 * context window belongs to the one request being served; `--alias` is the
 * name `/v1/models` reports, which is the name the model is sold under.
 */
export function serverArgs({ gguf, port, alias, ctx = 8192, gpu = true }) {
  if (!gguf) throw new Error("serverArgs needs a model file");
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`not a port: ${port}`);
  return [
    "-m", gguf,
    "--host", "127.0.0.1",
    "--port", String(p),
    ...(alias ? ["--alias", alias] : []),
    "-c", String(ctx),
    "-np", "1",
    "-ngl", gpu ? "999" : "0",
    "--jinja",
  ];
}

/** The port a loopback endpoint names (`http://127.0.0.1:8091` → 8091). */
export function endpointPort(endpoint, fallback = 8091) {
  try {
    const u = new URL(endpoint);
    return Number(u.port) || (u.protocol === "https:" ? 443 : 80);
  } catch {
    return fallback;
  }
}

/** The default endpoint for a managed llama-server: clear of Ollama's 11434. */
export const LLAMACPP_DEFAULT_ENDPOINT = "http://127.0.0.1:8091";
