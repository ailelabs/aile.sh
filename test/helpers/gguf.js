/**
 * A minimal GGUF v3 header for tests: string and u32 key/values, and tensor
 * infos with no data behind them (one dimension of 1, type 0, offset 0).
 * Enough for `readGgufHeader` and `ggufHasMtp`; never a loadable model.
 */

import fs from "node:fs";

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const str = (s) => { const b = Buffer.from(s, "utf8"); return Buffer.concat([u64(b.length), b]); };

/** The bytes of a GGUF header holding `kv` (string or integer values), `arrays` (name → string[]) and `tensors` (names). */
export function ggufBytes({ kv = {}, arrays = {}, tensors = [] } = {}) {
  const parts = [Buffer.from("GGUF"), u32(3), u64(tensors.length), u64(Object.keys(kv).length + Object.keys(arrays).length)];
  for (const [k, v] of Object.entries(kv)) {
    parts.push(str(k), typeof v === "string" ? Buffer.concat([u32(8), str(v)]) : Buffer.concat([u32(4), u32(v)]));
  }
  for (const [k, list] of Object.entries(arrays)) parts.push(str(k), u32(9), u32(8), u64(list.length), ...list.map(str));
  for (const name of tensors) parts.push(str(name), u32(1), u64(1), u32(0), u64(0));
  return Buffer.concat(parts);
}

export function writeGguf(file, spec) {
  fs.writeFileSync(file, ggufBytes(spec));
  return file;
}
