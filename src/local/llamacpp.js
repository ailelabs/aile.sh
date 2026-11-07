/**
 * llama.cpp: which build fits this machine, and how to run its server.
 *
 * The fallback engine, for when Ollama cannot or should not be installed: it
 * needs no administrator rights and no system service — aile downloads one
 * pinned `llama-server` into its own directory and runs it while `aile start`
 * runs. It serves one model at a time, to `localSlots` callers at once.
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
 * through the node, never over the network. `slots` callers are served at
 * once (`-np`); llama-server splits `-c` evenly across its slots, so it is
 * given `ctx × slots` and every caller keeps the whole `ctx`. `--alias` is the
 * name `/v1/models` reports, which is the name the model is sold under. `mtp`
 * (the file carries an MTP head, `ggufHasMtp`) turns on drafting with it.
 */
export function serverArgs({ gguf, port, alias, ctx = 8192, gpu = true, slots = 1, mtp = false }) {
  if (!gguf) throw new Error("serverArgs needs a model file");
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`not a port: ${port}`);
  const n = Number.isInteger(slots) && slots > 0 ? slots : 1;
  return [
    "-m", gguf,
    "--host", "127.0.0.1",
    "--port", String(p),
    ...(alias ? ["--alias", alias] : []),
    "-c", String(ctx * n),
    "-np", String(n),
    "-ngl", gpu ? "999" : "0",
    "--jinja",
    // ponytail: 2 drafted tokens, the n-max the model cards that ship MTP heads recommend.
    ...(mtp ? ["--spec-type", "draft-mtp", "--spec-draft-n-max", "2"] : []),
  ];
}

/** GGUF value types whose size is fixed, in bytes (gguf.h `gguf_type`). */
const GGUF_FIXED = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
const GGUF_STRING = 8;
const GGUF_ARRAY = 9;
/** A header past this many bytes is not read further (a large vocabulary is a few MB). */
const GGUF_HEADER_MAX = 64 * 1024 * 1024;

/**
 * Read a GGUF file's header: its key/values (strings and numbers kept, arrays
 * skipped) and its tensor names. Headers only, never tensor data. Throws on
 * anything that is not a readable GGUF v2+ header within `max` bytes.
 */
export function readGgufHeader(file, { max = GGUF_HEADER_MAX } = {}) {
  const fd = fs.openSync(file, "r");
  let buf = Buffer.alloc(0);
  let base = 0; // file offset of buf[0]
  let pos = 0; // file offset of the next byte to read
  const need = (n) => {
    if (pos < base || pos > base + buf.length) { base = pos; buf = Buffer.alloc(0); }
    while (pos + n > base + buf.length) {
      const end = base + buf.length;
      if (end >= max) throw new Error("GGUF header too large");
      const chunk = Buffer.alloc(Math.max(1 << 20, n));
      const got = fs.readSync(fd, chunk, 0, chunk.length, end);
      if (!got) throw new Error("GGUF header truncated");
      buf = Buffer.concat([buf.subarray(pos - base), chunk.subarray(0, got)]);
      base = pos;
    }
    const at = pos - base;
    pos += n;
    return at;
  };
  // `need` may swap `buf`, so it runs before `buf` is read, never inside `buf.readX(need(n))`.
  const read = (n, f) => { const at = need(n); return f(buf, at); };
  const u32 = () => read(4, (b, at) => b.readUInt32LE(at));
  const u64 = () => {
    const v = read(8, (b, at) => b.readBigUInt64LE(at));
    if (v > BigInt(max)) throw new Error("GGUF count out of range");
    return Number(v);
  };
  const str = () => { const n = u64(); return read(n, (b, at) => b.toString("utf8", at, at + n)); };
  const scalar = (type) => {
    switch (type) {
      case 0: return read(1, (b, at) => b.readUInt8(at));
      case 1: return read(1, (b, at) => b.readInt8(at));
      case 2: return read(2, (b, at) => b.readUInt16LE(at));
      case 3: return read(2, (b, at) => b.readInt16LE(at));
      case 4: return read(4, (b, at) => b.readUInt32LE(at));
      case 5: return read(4, (b, at) => b.readInt32LE(at));
      case 6: return read(4, (b, at) => b.readFloatLE(at));
      case 7: return read(1, (b, at) => b.readUInt8(at) !== 0);
      case 10: return Number(read(8, (b, at) => b.readBigUInt64LE(at)));
      case 11: return Number(read(8, (b, at) => b.readBigInt64LE(at)));
      case 12: return read(8, (b, at) => b.readDoubleLE(at));
      case GGUF_STRING: return str();
      default: throw new Error(`GGUF value type ${type}`);
    }
  };
  const skipArray = () => {
    const type = u32();
    const n = u64();
    if (GGUF_FIXED[type]) { pos += n * GGUF_FIXED[type]; return; }
    if (type !== GGUF_STRING) throw new Error(`GGUF array of type ${type}`);
    for (let i = 0; i < n; i++) { const len = u64(); pos += len; } // not `pos += u64()`: that reads pos first
  };
  try {
    if (read(4, (b, at) => b.toString("latin1", at, at + 4)) !== "GGUF") throw new Error("not a GGUF file");
    if (u32() < 2) throw new Error("GGUF v1 is not read");
    const tensorCount = u64();
    const kvCount = u64();
    const kv = {};
    for (let i = 0; i < kvCount; i++) {
      const key = str();
      const type = u32();
      if (type === GGUF_ARRAY) skipArray();
      else kv[key] = scalar(type);
    }
    const tensors = new Set();
    for (let i = 0; i < tensorCount; i++) {
      tensors.add(str());
      const dims = u32();
      pos += dims * 8 + 4 + 8; // its dims, then its type and data offset
    }
    return { kv, tensors };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Does a model carry an MTP head llama.cpp can draft with? llama.cpp's own
 * rule (common/speculative.cpp::common_speculative_types_from_gguf): a tensor
 * `blk.<block_count - 1>.nextn.eh_proj.weight`. A split model's key/values are
 * read from its first file and its tensor names from every file. Anything
 * unreadable answers false, so llama-server starts with no drafting flags.
 */
export function ggufHasMtp(files) {
  try {
    const paths = (files || []).filter(Boolean);
    if (!paths.length) return false;
    const first = readGgufHeader(paths[0]);
    const arch = first.kv["general.architecture"];
    const blocks = first.kv[`${arch}.block_count`];
    if (typeof arch !== "string" || !Number.isInteger(blocks) || blocks < 1) return false;
    const head = `blk.${blocks - 1}.nextn.eh_proj.weight`;
    if (first.tensors.has(head)) return true;
    return paths.slice(1).some((p) => readGgufHeader(p).tensors.has(head));
  } catch {
    return false;
  }
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
