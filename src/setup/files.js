/**
 * Editing other programs' config files, carefully.
 *
 * These files are not ours. A user has hand-edited them, another tool may be
 * holding them open, and a bad write costs them a working setup they did not
 * ask us to touch. So every write here follows the same rules:
 *
 *  - PARSE OR REFUSE. A file that is not plain JSON — comments, trailing commas,
 *    JSON5 — is left alone and the caller prints the snippet for the user to
 *    paste. Round-tripping a file we cannot read faithfully would silently drop
 *    whatever made it unreadable, and that is always something the user wrote.
 *  - MINIMAL CHANGE. Only the keys a tool needs are set; every other key, and
 *    the order of everything, survives. Indentation and the trailing newline are
 *    kept as found.
 *  - RECORDED. Each key set records what was there before, so `aile setup
 *    --remove` restores exactly that rather than a stale copy of the whole file.
 *  - ATOMIC, AND BACKED UP ONCE. Write to a temporary file and rename it over
 *    the original, so a crash leaves the old file or the new one and never half
 *    of each; the first time an existing file is changed, a copy is kept beside
 *    it as `<file>.aile-backup`.
 */

import fs from "node:fs";
import path from "node:path";

/** The value at a key path, or `undefined`. Paths are arrays of keys and indices. */
export function getPath(obj, keys) {
  let cur = obj;
  for (const k of keys) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}

/** Set a value, creating plain objects along the way. */
export function setPath(obj, keys, value) {
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (cur[k] === null || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

/** Delete a key, then any parent object the deletion left empty. */
export function deletePath(obj, keys) {
  const chain = [obj];
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    cur = cur?.[keys[i]];
    if (cur === null || typeof cur !== "object") return;
    chain.push(cur);
  }
  const last = chain[chain.length - 1];
  if (Array.isArray(last)) last.splice(Number(keys[keys.length - 1]), 1);
  else delete last[keys[keys.length - 1]];
  for (let i = chain.length - 1; i > 0; i--) {
    const node = chain[i];
    if (!Array.isArray(node) && Object.keys(node).length === 0) delete chain[i - 1][keys[i - 1]];
    else break;
  }
}

export function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Which array elements are ours, as data (so it can be kept in the manifest):
 * `{field, prefix}` — an element whose `field` (or, with `field: null`, the
 * element itself, or its first item when it is a `[name, options]` pair) is a
 * string starting with `prefix`.
 */
export function ownsBy(own) {
  return (e) => {
    const v = own.field === null || own.field === undefined
      ? (Array.isArray(e) ? e[0] : e)
      : e?.[own.field];
    return typeof v === "string" && v.startsWith(own.prefix);
  };
}

/**
 * Read a JSON config file. Never throws.
 *
 *   { exists: false, value: {} }                 no file yet
 *   { exists: true,  value, raw, indent, mode }  a plain JSON object
 *   { exists: true,  error }                     anything else — refuse it
 */
export function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { exists: false, value: {}, raw: null, indent: 2, eol: "\n", mode: null };
    return { exists: true, error: `cannot read it (${e.code || e.message})` };
  }
  const text = raw.replace(/^﻿/, "");
  const eol = /\r\n/.test(text) ? "\r\n" : "\n";
  const indentMatch = text.match(/\n([ \t]+)"/);
  const indent = indentMatch ? indentMatch[1] : 2;
  let mode = null;
  try { mode = fs.statSync(file).mode & 0o777; } catch { /* unknown */ }
  if (!text.trim()) return { exists: true, value: {}, raw, indent, eol, mode };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { exists: true, error: "it is not plain JSON (comments or trailing commas?)" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { exists: true, error: "it does not hold a JSON object" };
  }
  return { exists: true, value, raw, indent, eol, mode };
}

export function stringifyJson(value, { indent = 2, eol = "\n" } = {}) {
  const text = JSON.stringify(value, null, indent);
  return (eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text) + eol;
}

/**
 * Plan a JSON edit without writing anything.
 *
 * `mutate(ops)` describes the change through `ops`, which applies it to a copy
 * and records, for each key, what was there before. The result carries the new
 * text so a dry run can show it and `commit` can write it.
 */
export function planJson(file, mutate, { secret = false } = {}) {
  const read = readJson(file);
  if (read.error) return { ok: false, file, reason: `${file}: ${read.error}` };
  const obj = structuredClone(read.value);
  const records = [];
  const ops = {
    created: !read.exists,
    get: (keys) => getPath(obj, keys),
    set(keys, value) {
      const prev = getPath(obj, keys);
      if (sameJson(prev, value)) return;
      records.push({ kind: "json-set", file, path: keys, had: prev !== undefined, prev, value });
      setPath(obj, keys, value);
    },
    unset(keys) {
      const prev = getPath(obj, keys);
      if (prev === undefined) return;
      records.push({ kind: "json-set", file, path: keys, had: true, prev, value: undefined });
      deletePath(obj, keys);
    },
    /**
     * Own every element of an array that `owns(element)` recognises: drop the
     * ones already there and append `items`. Recorded as ownership rather than
     * as a before/after pair, so undoing it removes exactly our elements and
     * keeps anything the user added in between.
     */
    ownArray(keys, own, items) {
      const cur = getPath(obj, keys);
      const owns = ownsBy(own);
      const kept = Array.isArray(cur) ? cur.filter((e) => !owns(e)) : [];
      const next = [...kept, ...items];
      if (Array.isArray(cur) && sameJson(cur, next)) return;
      records.push({ kind: "json-array-owned", file, path: keys, own, hadArray: Array.isArray(cur), added: items.length });
      setPath(obj, keys, next);
    },
  };
  mutate(ops, obj);
  const text = stringifyJson(obj, read);
  return {
    ok: true, file, text, records,
    created: !read.exists,
    changed: !read.exists || text !== read.raw,
    // A file we create holds a key more often than not, so it is private by
    // default. An existing file keeps whatever mode its owner gave it.
    mode: read.exists ? read.mode : (secret ? 0o600 : null),
  };
}

/** Write text atomically: temp file, then rename over the target. */
export function writeText(file, text, { mode = null } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.aile-tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, mode ? { mode } : undefined);
  if (mode) { try { fs.chmodSync(tmp, mode); } catch { /* not supported here */ } }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // Windows refuses to rename over a file another process holds open — an
    // editor, or the tool itself watching its settings. Writing in place is the
    // fallback; it is not atomic, but it is what that user's editor would do.
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    if (e.code !== "EPERM" && e.code !== "EBUSY" && e.code !== "EACCES") throw e;
    fs.writeFileSync(file, text);
  }
}

/** Keep the original once, before our first change to it. Returns the backup path. */
export function backupOnce(file) {
  const bak = `${file}.aile-backup`;
  try {
    if (!fs.existsSync(file) || fs.existsSync(bak)) return null;
    fs.copyFileSync(file, bak);
    return bak;
  } catch {
    return null;
  }
}

/** Apply a planned edit. Returns the records to keep in the manifest. */
export function commitEdit(edit) {
  if (!edit.changed) return [];
  if (!edit.created) backupOnce(edit.file);
  writeText(edit.file, edit.text, { mode: edit.mode });
  const out = [...(edit.records || [])];
  if (edit.created) out.unshift({ kind: "file-created", file: edit.file });
  return out;
}

/**
 * Undo recorded JSON changes on one file. Returns a note when the file could
 * not be read — it was changed into something we will not rewrite.
 */
export function revertJson(file, records, { created = false } = {}) {
  const read = readJson(file);
  if (!read.exists) return null;
  if (read.error) return `${file}: left alone — ${read.error}`;
  const obj = read.value;
  for (const r of [...records].reverse()) {
    if (r.kind === "json-set") {
      if (r.had) setPath(obj, r.path, r.prev);
      else if (getPath(obj, r.path) !== undefined) deletePath(obj, r.path);
    } else if (r.kind === "json-array-owned") {
      const owns = ownsBy(r.own || {});
      const cur = getPath(obj, r.path);
      if (!r.own || !Array.isArray(cur)) continue;
      const kept = cur.filter((e) => !owns(e));
      if (!kept.length && !r.hadArray) deletePath(obj, r.path);
      else setPath(obj, r.path, kept);
    }
  }
  // A file this tool created and nothing else has written to since goes away
  // entirely; `$schema` alone is not the user's content.
  const left = Object.keys(obj).filter((k) => k !== "$schema");
  if (created && left.length === 0) {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
    return null;
  }
  const text = stringifyJson(obj, read);
  if (text !== read.raw) writeText(file, text, { mode: read.mode });
  return null;
}

export function fileExists(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

export function dirExists(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}
