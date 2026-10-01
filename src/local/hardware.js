/**
 * What this machine can run: memory, GPU, and free disk.
 *
 * Read-only and best-effort. Every probe has a timeout and every failure is
 * an absent value, never an error — a machine whose GPU we cannot see is
 * offered the models that fit its RAM, which is a smaller menu but a true one.
 *
 * `AILE_LOCAL_HW` (JSON) replaces any detected field, for a test or for a
 * machine whose GPU the probes miss: `{"vramBytes": 24e9, "accel": "cuda"}`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const GB = 1e9;
const MIB = 1024 * 1024;

/**
 * @typedef {{ vendor: "nvidia"|"amd"|"apple"|"other", name: string, vramBytes: number|null, freeBytes: number|null }} Gpu
 * @typedef {{
 *   platform: string, arch: string, cpus: number, ramBytes: number,
 *   gpus: Gpu[], accel: "cuda"|"metal"|"vulkan"|"cpu",
 *   vramBytes: number,        // memory a model can be offloaded into (unified budget on Apple)
 *   unified: boolean,         // GPU and CPU share RAM (Apple silicon)
 *   driver: string|null,      // NVIDIA driver version
 * }} Hardware
 */

/** `nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version --format=csv,noheader,nounits` */
export function parseNvidiaSmi(text) {
  const gpus = [];
  let driver = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    const cells = line.split(",").map((s) => s.trim());
    if (cells.length < 3 || !cells[0]) continue;
    const mib = (v) => (/^\d+(\.\d+)?$/.test(v) ? Math.round(Number(v) * MIB) : null);
    gpus.push({ vendor: "nvidia", name: cells[0], vramBytes: mib(cells[1]), freeBytes: mib(cells[2]) });
    if (!driver && cells[3] && /^\d/.test(cells[3])) driver = cells[3];
  }
  return { gpus, driver };
}

function defaultRun(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000, windowsHide: true });
    return r.status === 0 ? String(r.stdout || "") : null;
  } catch {
    return null;
  }
}

/** AMD VRAM on Linux, from the amdgpu driver's sysfs counters. */
function amdLinuxGpus(readDir = fs.readdirSync, readFile = fs.readFileSync) {
  const out = [];
  let cards = [];
  try { cards = readDir("/sys/class/drm").filter((d) => /^card\d+$/.test(d)); } catch { return out; }
  for (const card of cards) {
    try {
      const total = Number(String(readFile(`/sys/class/drm/${card}/device/mem_info_vram_total`, "utf8")).trim());
      if (Number.isFinite(total) && total > 512 * MIB) {
        out.push({ vendor: "amd", name: `AMD GPU (${card})`, vramBytes: total, freeBytes: null });
      }
    } catch { /* not an amdgpu card */ }
  }
  return out;
}

/** @returns {Hardware} */
export function detectHardware({
  run = defaultRun,
  platform = process.platform,
  arch = process.arch,
  ramBytes = os.totalmem(),
  cpus = os.cpus()?.length || 1,
  linuxGpus = amdLinuxGpus,
  env = process.env,
} = {}) {
  /** @type {Hardware} */
  const hw = { platform, arch, cpus, ramBytes, gpus: [], accel: "cpu", vramBytes: 0, unified: false, driver: null };

  if (platform === "darwin") {
    if (arch === "arm64") {
      // Apple silicon: the GPU reads the same RAM. macOS lets it wire about
      // two thirds to three quarters of it, the rest stays with the system.
      hw.unified = true;
      hw.accel = "metal";
      hw.vramBytes = Math.floor(ramBytes * (ramBytes > 36 * GB ? 0.75 : 0.7));
      hw.gpus = [{ vendor: "apple", name: "Apple GPU", vramBytes: hw.vramBytes, freeBytes: null }];
    }
  } else {
    const smi = run("nvidia-smi", ["--query-gpu=name,memory.total,memory.free,driver_version", "--format=csv,noheader,nounits"]);
    if (smi) {
      const { gpus, driver } = parseNvidiaSmi(smi);
      hw.gpus = gpus;
      hw.driver = driver;
    }
    if (!hw.gpus.length && platform === "linux") hw.gpus = linuxGpus();
    const best = hw.gpus.reduce((a, g) => ((g.vramBytes || 0) > (a?.vramBytes || 0) ? g : a), null);
    if (best?.vramBytes) {
      hw.vramBytes = best.vramBytes;
      hw.accel = best.vendor === "nvidia" ? "cuda" : "vulkan";
    }
  }

  if (env.AILE_LOCAL_HW) {
    try {
      const o = JSON.parse(env.AILE_LOCAL_HW);
      if (o && typeof o === "object") Object.assign(hw, o);
    } catch { /* ignored: a bad override must not stop the command */ }
  }
  return hw;
}

/**
 * Free bytes on the volume holding `dir` (or its nearest existing parent).
 * `AILE_LOCAL_HW`'s `diskFreeBytes` replaces the reading, like every other field.
 */
export function diskFree(dir, env = process.env) {
  if (env.AILE_LOCAL_HW) {
    try {
      const o = JSON.parse(env.AILE_LOCAL_HW);
      if (Number.isFinite(o?.diskFreeBytes)) return o.diskFreeBytes;
    } catch { /* ignored, as in detectHardware */ }
  }
  let d = path.resolve(dir);
  for (let i = 0; i < 64; i++) {
    try {
      const s = fs.statfsSync(d);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      const up = path.dirname(d);
      if (up === d) return null;
      d = up;
    }
  }
  return null;
}

/**
 * Memory a model needs to run: its weights, plus the KV cache for `ctx`
 * tokens and the runtime's own overhead. A coarse rule, deliberately on the
 * generous side — telling somebody a model fits and then watching it page to
 * disk is worse than suggesting the next size down.
 */
export function estimateNeedBytes(sizeBytes, ctx = 8192) {
  const kvPer8k = sizeBytes >= 30 * GB ? 2.5 * GB : sizeBytes >= 12 * GB ? 1.5 * GB : 1 * GB;
  return Math.round(sizeBytes * 1.05 + 0.6 * GB + kvPer8k * (ctx / 8192));
}

/**
 * Where a model of `sizeBytes` would run on `hw`:
 *   "gpu"     — entirely in GPU memory (fast)
 *   "partial" — split between GPU and system RAM (usable)
 *   "cpu"     — system RAM only (slow, but it works)
 *   "no"      — does not fit
 */
export function fit(sizeBytes, hw, ctx = 8192) {
  const need = estimateNeedBytes(sizeBytes, ctx);
  const ramBudget = hw.unified ? 0 : hw.ramBytes * 0.75;
  if (hw.vramBytes && need <= hw.vramBytes) return "gpu";
  if (hw.vramBytes && !hw.unified && need <= hw.vramBytes + ramBudget * 0.8) return "partial";
  if (!hw.unified && need <= ramBudget) return "cpu";
  return "no";
}

export const FIT_LABEL = {
  gpu: "fits GPU",
  partial: "GPU + RAM",
  cpu: "CPU only",
  no: "too big",
};

export const FIT_RANK = { gpu: 0, partial: 1, cpu: 2, no: 3 };

/** One line for humans: "RTX 4060 · 8.6 GB VRAM · 16 GB RAM". */
export function describeHardware(hw) {
  const fmt = (n) => `${Math.round((n / GB) * 10) / 10} GB`;
  const parts = [];
  const g = hw.gpus[0];
  if (hw.unified) parts.push(`Apple silicon · ${fmt(hw.vramBytes)} usable by the GPU`);
  else if (g) parts.push(`${g.name}${g.vramBytes ? ` · ${fmt(g.vramBytes)} VRAM` : ""}`);
  else parts.push("no supported GPU found");
  parts.push(`${fmt(hw.ramBytes)} RAM`);
  return parts.join(" · ");
}
