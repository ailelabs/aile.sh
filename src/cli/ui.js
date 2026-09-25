/**
 * How this CLI looks, in one place.
 *
 * Every command used to format its own output: its own success mark, its own
 * idea of a heading, its own column padding. The result read like several tools
 * stapled together — `✓` in one place and `YES` in another, a bold heading here
 * and a cyan one there, and tables that wrapped into mush on an 80-column
 * terminal because nothing ever asked how wide the terminal was. This module is
 * the shared vocabulary, so the next command looks like the last one.
 *
 * THREE RULES, the same as colors.js and prompt.js:
 *
 *  - NOTHING HERE DECIDES CONTENT. It shapes lines a command already chose to
 *    print; it never adds wording of its own a test would have to chase.
 *  - DEGRADE, NEVER BREAK. No colour when stdout is not a terminal (colors.js
 *    decides that once), plain ASCII marks where the console cannot draw the
 *    Unicode ones, and a spinner only where a human is watching stderr — in a
 *    pipe, a log or a test it draws nothing at all.
 *  - LEAVE THE TERMINAL AS IT WAS FOUND. A spinner hides the cursor, so the
 *    cursor is restored on every exit path, Ctrl+C included.
 */

import { C, COLOR } from "./colors.js";

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

/**
 * Can this terminal draw ✓ ✗ ❯ ● and a braille spinner?
 *
 * Everywhere but Windows, yes — except the Linux virtual console, whose font
 * has none of them. On Windows it depends on the host, not on Windows: Windows
 * Terminal, VS Code's terminal, ConEmu and JetBrains' terminal draw them, and
 * the classic console window may show boxes. So Windows gets Unicode only
 * where a host that can draw it has said so in the environment. `AILE_ASCII=1`
 * forces the plain set anywhere — for a screen reader, a font that lacks the
 * glyphs, or a log that will be read in something old.
 */
export function unicodeOk(env = process.env, platform = process.platform) {
  if (env.AILE_ASCII === "1") return false;
  if (platform !== "win32") return env.TERM !== "linux";
  return Boolean(env.WT_SESSION)
    || env.TERM_PROGRAM === "vscode"
    || Boolean(env.ConEmuTask)
    || env.TERMINAL_EMULATOR === "JetBrains-JediTerm"
    || env.TERM === "xterm-256color"
    || env.TERM === "alacritty"
    || Boolean(env.CI);
}

const UNICODE = {
  ok: "✓", fail: "✗", warn: "!", info: "i", arrow: "❯", bullet: "•", dot: "·", live: "●",
  up: "↑", down: "↓", frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};
const ASCII = {
  ok: "+", fail: "x", warn: "!", info: "i", arrow: ">", bullet: "*", dot: "-", live: "*",
  up: "^", down: "v", frames: ["|", "/", "-", "\\"],
};

export const UNICODE_OK = unicodeOk();
export const sym = Object.freeze(UNICODE_OK ? UNICODE : ASCII);

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Visible width: escape codes take no columns. */
export const width = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").length;
export const padTo = (s, n) => String(s) + " ".repeat(Math.max(n - width(s), 0));

/** Shorten to `n` visible columns, with an ellipsis. Colour codes are dropped. */
export function truncate(s, n) {
  const plain = String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  if (plain.length <= n) return String(s);
  if (n <= 1) return plain.slice(0, n);
  return `${plain.slice(0, n - 1)}${UNICODE_OK ? "…" : "~"}`;
}

export const dim = (s) => `${C.dim}${s}${C.reset}`;
export const bold = (s) => `${C.bold}${s}${C.reset}`;
export const cmd = (s) => `${C.cyan}${s}${C.reset}`;

/** A section title, with an optional dim note after it. */
export const heading = (title, note = "") => `${C.bold}${title}${C.reset}${note ? `  ${dim(note)}` : ""}`;

/** One result line. The mark says how it went; the detail stays quiet. */
export const ok = (msg, detail = "") => `  ${C.green}${sym.ok}${C.reset} ${msg}${detail ? `  ${dim(detail)}` : ""}`;
export const warn = (msg, detail = "") => `  ${C.yellow}${sym.warn}${C.reset} ${msg}${detail ? `  ${dim(detail)}` : ""}`;
export const bad = (msg, detail = "") => `  ${C.red}${sym.fail}${C.reset} ${msg}${detail ? `  ${dim(detail)}` : ""}`;
export const info = (msg, detail = "") => `  ${dim(sym.dot)} ${msg}${detail ? `  ${dim(detail)}` : ""}`;

/**
 * Aligned `key  value` rows. `rows` is `[[key, value], …]`; a row whose value
 * is null is skipped, so a caller can list optional facts without branching.
 */
export function kv(rows, { indent = 2 } = {}) {
  const live = rows.filter((r) => r && r[1] !== null && r[1] !== undefined);
  const w = Math.max(0, ...live.map(([k]) => width(k)));
  return live.map(([k, v]) => `${" ".repeat(indent)}${padTo(dim(k), w)}  ${v}`).join("\n");
}

/**
 * "What to do next" — the block every screen that leaves the user with work to
 * do ends with. `items` is `[[command, what it does], …]`.
 */
export function next(items, { title = "Next" } = {}) {
  const live = items.filter(Boolean);
  if (!live.length) return "";
  const w = Math.max(...live.map(([c]) => width(c)));
  return [heading(title), ...live.map(([c, what]) => `  ${padTo(cmd(c), w)}  ${dim(what)}`)].join("\n");
}

/** How wide the terminal is, or a generous default when it is not one. */
export function termWidth(stream = process.stdout) {
  const n = Number(stream?.columns);
  return Number.isFinite(n) && n > 20 ? n : 120;
}

/**
 * Word-wrap `text` to the terminal, each line indented. Breaks between words
 * only — a list of names split mid-word ("GitHub / Copilot") reads as two
 * names. Off a terminal it does not wrap at all; a file or a pipe wraps for
 * itself.
 */
export function wrap(text, { indent = 2, columns = process.stdout.isTTY ? termWidth() : Infinity } = {}) {
  const pad = " ".repeat(indent);
  const lines = [];
  let line = "";
  for (const w of String(text).split(/ +/)) {
    if (line && width(line) + 1 + width(w) > columns - indent - 1) { lines.push(line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.map((l) => pad + l).join("\n");
}

/**
 * A table that fits. `cols` is `[{key, label, align?: "right", shrink?: true}]`;
 * `rows` are objects. Columns are sized to their content; if the whole row is
 * wider than the terminal, the `shrink` columns (or else the widest) give up
 * width first and are cut with an ellipsis — a row never wraps, because a
 * wrapped table is no longer a table.
 */
export function table(cols, rows, { indent = 2, columns = termWidth(), header = true } = {}) {
  const cell = (r, c) => (r[c.key] === null || r[c.key] === undefined ? "" : String(r[c.key]));
  const widths = cols.map((c) => Math.max(header ? width(c.label || "") : 0, ...rows.map((r) => width(cell(r, c)))));
  const gap = 2;
  const total = () => indent + widths.reduce((a, b) => a + b, 0) + gap * (cols.length - 1);
  const shrinkable = cols.map((c, i) => (c.shrink ? i : -1)).filter((i) => i >= 0);
  let guard = 200;
  while (total() > columns && guard-- > 0) {
    const pool = shrinkable.length ? shrinkable : cols.map((_, i) => i);
    const widest = pool.reduce((a, i) => (widths[i] > widths[a] ? i : a), pool[0]);
    if (widths[widest] <= 6) break;
    widths[widest]--;
  }
  const fit = (s, i, c) => {
    const t = width(s) > widths[i] ? truncate(s, widths[i]) : s;
    return c.align === "right" ? " ".repeat(Math.max(widths[i] - width(t), 0)) + t : padTo(t, widths[i]);
  };
  const lines = [];
  const pad = " ".repeat(indent);
  if (header) lines.push(pad + cols.map((c, i) => fit(dim(c.label || ""), i, c)).join(" ".repeat(gap)).trimEnd());
  for (const r of rows) lines.push(pad + cols.map((c, i) => fit(cell(r, c), i, c)).join(" ".repeat(gap)).trimEnd());
  return lines.join("\n");
}

/**
 * A hint line: dim prose where anything in backticks is a command, shown as one
 * (cyan) instead of as literal backticks. Hints are written with backticks so
 * they read correctly in source and in plain logs alike.
 */
export function hintText(hint) {
  return `${C.dim}${String(hint).replace(/`([^`]+)`/g, `${C.reset}${C.cyan}$1${C.reset}${C.dim}`)}${C.reset}`;
}

/**
 * The one way a command gives up: the mark, what went wrong, what to do about
 * it, exit 1. On stderr, so a script reading stdout sees nothing half-written.
 */
export function die(msg, hint = null, { code = 1 } = {}) {
  console.error(`\n${bad(msg)}`);
  if (hint) console.error(`    ${hintText(hint)}`);
  console.error();
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
let cursorHidden = false;
function restoreCursor(stream) {
  if (!cursorHidden) return;
  cursorHidden = false;
  try { stream.write(SHOW); } catch { /* stream gone */ }
}

/**
 * A one-line "working on it" indicator, on stderr.
 *
 * Only when stderr is a terminal: in a pipe, a CI log or a test it is a no-op
 * object with the same methods, so a caller never branches and stdout — the
 * part a script parses — is never touched either way. `succeed`/`fail` leave
 * one finished line behind; `stop` leaves nothing.
 */
export function spinner(text, { stream = process.stderr, interval = 80 } = {}) {
  const live = Boolean(stream?.isTTY) && process.env.AILE_NO_SPINNER !== "1";
  let label = text;
  let i = 0;
  let timer = null;
  const draw = () => {
    stream.write(`\r\x1b[2K${C.cyan}${sym.frames[i = (i + 1) % sym.frames.length]}${C.reset} ${label}`);
  };
  const onExit = () => restoreCursor(stream);
  const clear = () => {
    if (!live) return;
    if (timer) clearInterval(timer);
    timer = null;
    stream.write("\r\x1b[2K");
    restoreCursor(stream);
    process.off("exit", onExit);
    process.off("SIGINT", onSigint);
  };
  // Ctrl+C mid-spinner must not leave the cursor hidden in the user's shell.
  const onSigint = () => { clear(); process.exit(130); };
  if (live) {
    stream.write(HIDE);
    cursorHidden = true;
    process.on("exit", onExit);
    process.on("SIGINT", onSigint);
    draw();
    timer = setInterval(draw, interval);
    timer.unref?.();
  }
  const s = {
    update(t) { label = t; if (live) draw(); return s; },
    stop() { clear(); return s; },
    succeed(t = label) { clear(); if (live) stream.write(`${ok(t).trimStart()}\n`); return s; },
    fail(t = label) { clear(); if (live) stream.write(`${bad(t).trimStart()}\n`); return s; },
  };
  return s;
}

/**
 * Await `work` with a spinner showing `text`, cleared whatever happens. The
 * result (or the throw) passes through unchanged.
 */
export async function withSpinner(text, work, opts) {
  const s = spinner(text, opts);
  try {
    return await (typeof work === "function" ? work() : work);
  } finally {
    s.stop();
  }
}

export { C, COLOR };
