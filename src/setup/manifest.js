/**
 * What `aile setup` changed on this machine, so `aile setup --remove` can undo
 * exactly that.
 *
 * One file in the aile data directory, 0600 — it can hold the values a key
 * replaced, and those may be somebody's other credentials.
 *
 * THE FIRST RECORD FOR A KEY WINS. Running setup twice must not make the second
 * run's "previous value" (which is our own first write) the thing an undo
 * restores; the user's pre-aile value is the one worth keeping. So a re-run
 * merges into what is recorded instead of replacing it.
 */

import fs from "node:fs";
import path from "node:path";
import { AILE_DIR } from "../relay/paths.js";

export const MANIFEST_FILE = path.join(AILE_DIR, "integrations.json");

export function loadManifest(file = MANIFEST_FILE) {
  try {
    const m = JSON.parse(fs.readFileSync(file, "utf8"));
    if (m && typeof m === "object" && m.tools && typeof m.tools === "object") return m;
  } catch { /* none yet, or unreadable — start clean */ }
  return { version: 1, tools: {} };
}

export function saveManifest(m, file = MANIFEST_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const recordKey = (r) => {
  if (r.kind === "json-set") return `set|${r.file}|${JSON.stringify(r.path)}`;
  if (r.kind === "json-array-owned") return `own|${r.file}|${JSON.stringify(r.path)}`;
  if (r.kind === "toml-key") return `toml|${r.file}|${r.key}`;
  if (r.kind === "toml-block") return `tomlblock|${r.file}`;
  if (r.kind === "file-created") return `created|${r.file}`;
  if (r.kind === "file-written") return `written|${r.file}`;
  if (r.kind === "rc-block") return `rc|${r.file}`;
  return `${r.kind}|${JSON.stringify(r)}`;
};

/** Merge new change records into a tool's entry, keeping the earliest "before". */
export function mergeRecords(old = [], fresh = []) {
  const byKey = new Map(old.map((r) => [recordKey(r), r]));
  for (const r of fresh) {
    const k = recordKey(r);
    const prior = byKey.get(k);
    if (!prior) { byKey.set(k, r); continue; }
    if (r.kind === "json-set" || r.kind === "toml-key") {
      byKey.set(k, { ...r, had: prior.had, prev: prior.prev });
    }
  }
  return [...byKey.values()];
}

/** Record what one tool's setup changed. */
export function recordTool(m, toolId, { mode = null, records = [], shortcut = null, extra = {} } = {}) {
  const prior = m.tools[toolId] || {};
  m.tools[toolId] = {
    ...prior,
    ...extra,
    at: new Date().toISOString(),
    modes: [...new Set([...(prior.modes || []), ...(mode ? [mode] : [])])],
    records: mergeRecords(prior.records, records),
    shortcut: shortcut || prior.shortcut || null,
  };
  return m;
}
