/**
 * Surgical edits to Codex's `config.toml`.
 *
 * No TOML library (this client has no dependencies), and none is wanted: a
 * parse-and-reserialise round trip would drop every comment the user wrote. So
 * the edit is textual and deliberately narrow — it only ever
 *
 *  - sets top-level `key = value` lines, which must sit BEFORE the first
 *    `[table]` header or TOML files them under that table instead; and
 *  - owns one block between marker comments, holding `[model_providers.aile]`.
 *
 * Anything it does not recognise is left byte-for-byte. A `[model_providers.aile]`
 * table somebody wrote by hand is refused rather than overwritten.
 */

export const BLOCK_START = "# >>> aile setup >>>";
export const BLOCK_END = "# <<< aile setup <<<";

export const tomlString = (v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const isHeader = (line) => /^\s*\[/.test(line);
const keyRe = (key) => new RegExp(`^\\s*${key.replace(/[.]/g, "\\.")}\\s*=`);

function splitLines(text) {
  const eol = /\r\n/.test(text) ? "\r\n" : "\n";
  const lines = text.length ? text.replace(/\r\n/g, "\n").split("\n") : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return { lines, eol };
}

const join = (lines, eol) => (lines.length ? lines.join(eol) + eol : "");

/** Index of the first table header outside our own block, or lines.length. */
function firstHeader(lines) {
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === BLOCK_START) inBlock = true;
    else if (lines[i].trim() === BLOCK_END) inBlock = false;
    else if (!inBlock && isHeader(lines[i])) return i;
  }
  return lines.length;
}

/** The raw line for a top-level key, or null. */
export function topLevelLine(text, key) {
  const { lines } = splitLines(text);
  const end = firstHeader(lines);
  const re = keyRe(key);
  for (let i = 0; i < end; i++) if (re.test(lines[i])) return lines[i];
  return null;
}

/** Does the file define `[model_providers.<id>]` outside our block? */
export function hasForeignTable(text, table) {
  const { lines } = splitLines(text);
  let inBlock = false;
  const re = new RegExp(`^\\s*\\[\\s*${table.replace(/[.]/g, "\\s*\\.\\s*")}\\s*\\]`);
  for (const l of lines) {
    if (l.trim() === BLOCK_START) inBlock = true;
    else if (l.trim() === BLOCK_END) inBlock = false;
    else if (!inBlock && re.test(l)) return true;
  }
  return false;
}

/**
 * Set (or with `line === null`, remove) one top-level key. Returns new text.
 * A new key goes at the end of the top-level section, before the first table.
 */
export function setTopLevel(text, key, line) {
  const { lines, eol } = splitLines(text);
  const end = firstHeader(lines);
  const re = keyRe(key);
  const at = lines.slice(0, end).findIndex((l) => re.test(l));
  if (at >= 0) {
    if (line === null) lines.splice(at, 1);
    else lines[at] = line;
    return join(lines, eol);
  }
  if (line === null) return join(lines, eol);
  // Insert after the last non-blank top-level line, keeping a blank line
  // between it and the first table as the file had it.
  let pos = end;
  while (pos > 0 && lines[pos - 1].trim() === "") pos--;
  lines.splice(pos, 0, line);
  return join(lines, eol);
}

/** Replace (or add, or with `body === null` remove) our marked block. */
export function setBlock(text, body) {
  const { lines, eol } = splitLines(text);
  const s = lines.findIndex((l) => l.trim() === BLOCK_START);
  const e = s >= 0 ? lines.findIndex((l, i) => i > s && l.trim() === BLOCK_END) : -1;
  if (s >= 0 && e > s) {
    let from = s;
    // Take the blank line we put before the block with it.
    if (body === null && from > 0 && lines[from - 1].trim() === "") from--;
    lines.splice(from, e - from + 1, ...(body === null ? [] : [BLOCK_START, ...body, BLOCK_END]));
    return join(lines, eol);
  }
  if (body === null) return join(lines, eol);
  if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
  lines.push(BLOCK_START, ...body, BLOCK_END);
  return join(lines, eol);
}

export function blockBody(text) {
  const { lines } = splitLines(text);
  const s = lines.findIndex((l) => l.trim() === BLOCK_START);
  const e = s >= 0 ? lines.findIndex((l, i) => i > s && l.trim() === BLOCK_END) : -1;
  return s >= 0 && e > s ? lines.slice(s + 1, e) : null;
}

/** The `value` of a `key = value` line, unquoted if it is a basic string. */
export function lineValue(line) {
  if (!line) return null;
  const m = String(line).match(/=\s*(.*?)\s*(#.*)?$/);
  if (!m) return null;
  const v = m[1];
  const q = v.match(/^"((?:[^"\\]|\\.)*)"$/) || v.match(/^'([^']*)'$/);
  return q ? q[1] : v;
}
