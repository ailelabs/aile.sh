/**
 * Terminal input.
 *
 * Small on purpose: the CLI has no dependencies, so this is the whole of the
 * interactive surface. Three rules shape it.
 *
 * MASK, BUT SHOW THAT SOMETHING LANDED. A bearer token typed in the clear ends
 * up in scrollback, in a screen share, and in whatever the terminal logs. So it
 * is masked — but each character echoes a bullet, because a prompt that shows
 * nothing at all reads as "my paste did not work" and gets pasted twice.
 *
 * NEVER HANG WAITING ON A TTY THAT ISN'T THERE. Under a supervisor, a cron job,
 * or a container with no console, `stdin` is not a terminal. Callers check
 * `isInteractive()` and print instructions instead of blocking forever. The one
 * exception is an explicit pipe (`echo $TOKEN | aile login --paste`), which the
 * caller opts into.
 *
 * A PROMPT MUST BE ABANDONABLE. Sign-in waits on the browser and on a paste at
 * the same time, so whichever loses has to stop cleanly — restoring raw mode and
 * releasing stdin, not leaking a listener onto a shared stream. Every prompt here
 * takes an `AbortSignal` and resolves `null` when it fires, which is deliberately
 * distinct from the `""` an empty line produces.
 */

import readline from "node:readline";
import { spawn } from "node:child_process";
import { C } from "./colors.js";

const CTRL_C = "";
const CTRL_D = "";
const CTRL_U = "";
const BACKSPACE = "";

export function isInteractive(input = process.stdin, output = process.stdout) {
  return Boolean(input.isTTY && output.isTTY);
}

/**
 * Put text on the system clipboard, using whatever the platform already has.
 *
 * Best-effort by design. The URL is always printed in full right above the
 * offer, so a failed copy costs the user a manual selection, not the sign-in —
 * which is why this resolves `false` instead of throwing, and why no clipboard
 * dependency is worth adding for it.
 *
 * Over SSH the clipboard here is the *server's*, which is useless; that is
 * unfixable from this side and the printed URL remains the real answer.
 */
export function copyToClipboard(text, { platform = process.platform } = {}) {
  const cmd = platform === "win32" ? "clip"
    : platform === "darwin" ? "pbcopy"
    : "xclip";
  const args = platform === "linux" ? ["-selection", "clipboard"] : [];

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    } catch {
      return resolve(false);
    }
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    try {
      child.stdin.on("error", () => {});   // EPIPE if the tool is missing
      child.stdin.end(text);
    } catch {
      resolve(false);
    }
  });
}

/** Visible line read — for anything that is not a credential. */
export function promptLine(question, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output });
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer).trim());
    });
  });
}

/** First non-empty line of a piped stdin. Resolves on the newline, not on EOF. */
function readPiped(input, signal = null) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const finish = () => {
      cleanup();
      resolve((buf.split(/\r?\n/).find((l) => l.trim()) || "").trim());
    };
    const onData = (chunk) => {
      buf += chunk;
      // Resolve as soon as a full line exists: a pipe that is held open (a
      // process substitution, a paused writer) must not stall the sign-in.
      if (/\r?\n/.test(buf)) finish();
    };
    const onError = (e) => { cleanup(); reject(e); };
    // null, not "": the caller has to tell "cancelled" apart from "the user
    // pressed enter on an empty line", because those mean opposite things.
    const onAbort = () => { cleanup(); resolve(null); };
    function cleanup() {
      input.removeListener("data", onData);
      input.removeListener("end", finish);
      input.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      input.pause();
    }
    if (signal?.aborted) return resolve(null);
    signal?.addEventListener("abort", onAbort);
    input.setEncoding("utf8");
    input.on("data", onData);
    input.on("end", finish);
    input.on("error", onError);
    input.resume();
  });
}

/**
 * Read a secret. Masked when stdin is a terminal, read as a plain line when it
 * is a pipe.
 *
 * Raw mode is restored on every exit path — including Ctrl+C — because leaving
 * a terminal in raw mode after the process dies makes the user's shell appear
 * broken, and they have no way to connect that to us.
 */
export function promptSecret(question, {
  input = process.stdin, output = process.stdout, mask = "•",
  signal = null, hotkeys = null,
} = {}) {
  if (!input.isTTY || typeof input.setRawMode !== "function") return readPiped(input, signal);

  return new Promise((resolve) => {
    // Check BEFORE touching the terminal. By the time this is called the race
    // may already be over — the browser approval landed while we were being
    // set up. Enabling raw mode first and undoing it after is one restore path
    // away from leaving the user's shell raw, and it prints a prompt nobody
    // will ever be asked to answer.
    if (signal?.aborted) return resolve(null);

    let value = "";
    const wasRaw = Boolean(input.isRaw);
    output.write(question);
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();

    function restore() {
      input.removeListener("data", onData);
      signal?.removeEventListener("abort", onAbort);
      try { input.setRawMode(wasRaw); } catch { /* stream already gone */ }
      input.pause();
    }

    function done(result) {
      restore();
      output.write("\n");
      resolve(result);
    }

    /**
     * Something else finished first — the browser approval landed while the
     * user was still deciding whether to paste. Resolve `null` rather than "":
     * the caller must not treat a race it won elsewhere as an empty answer.
     */
    function onAbort() {
      restore();
      output.write("\n");
      resolve(null);
    }
    signal?.addEventListener("abort", onAbort);

    function onData(chunk) {
      // A paste arrives as one chunk, so this loop is the normal path, not an
      // edge case.
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done(value);
        if (ch === CTRL_D) return done(value);
        if (ch === CTRL_C) {
          restore();
          output.write("\n");
          process.exit(130);
          return;
        }
        if (ch === BACKSPACE || ch === "\b") {
          if (value) { value = value.slice(0, -1); output.write("\b \b"); }
          continue;
        }
        if (ch === CTRL_U) {
          output.write("\b \b".repeat(value.length));
          value = "";
          continue;
        }
        // A hotkey only fires on an empty line. Once the user has started
        // pasting, every character belongs to the token — a "c" three chars into
        // a paste must not be swallowed as a command.
        if (!value && hotkeys && Object.hasOwn(hotkeys, ch.toLowerCase())) {
          hotkeys[ch.toLowerCase()]({ output });
          continue;
        }
        if (ch >= " ") { value += ch; output.write(mask); }
      }
    }

    input.on("data", onData);
  });
}

/**
 * A numbered chooser, arrow keys or digits.
 *
 * Digits are the point. Arrow keys need a real terminal and a user who knows to
 * try them; a number is visible in the prompt and works over any connection,
 * including the ones where arrow keys arrive as escape-sequence gibberish.
 *
 * TWO DIGITS ARE ONE NUMBER, AND THE USER MUST SEE THEM ACCUMULATE. Keystrokes
 * arrive one chunk at a time, so a chooser that commits on the first digit it
 * recognises makes every option past 9 unreachable: the provider menu offers 19,
 * and pressing `1` for the eighteenth selected the first instead — instantly,
 * with no chance to type the `8`. Worse, it was silent. Nothing on screen showed
 * a partial number, so the failure did not read as "it took my 1 and ran" but as
 * "this menu picks at random".
 *
 * So digits buffer and the highlight follows them. Commit happens when the
 * number CANNOT be extended into another valid one (`2` of 19 can only be 2) or
 * on enter. That rule is what keeps a short menu behaving exactly as it always
 * did — with nine or fewer options no digit is ever ambiguous, so every press
 * still selects and confirms in one keystroke.
 *
 * THE MARKER IS THE INDICATOR. A separate "you typed 1" line under the list says
 * what `❯ 1.` already says, in a second place that can disagree with the first —
 * and once the list scrolls it sits fifteen rows away from the row it describes,
 * so the two read as two different claims about what is selected. The highlight
 * moving, and the menu not closing, is the whole signal.
 *
 * A LIST TALLER THAN THE WINDOW IS NOT A LIST. The redraw walks the cursor up
 * by the number of lines it last wrote; if those lines did not fit, the terminal
 * has scrolled and the top of them no longer exists, so the walk lands mid-menu
 * and every keypress smears another copy down the screen. Nineteen providers
 * plus headings does not fit a 24-row window, so the list scrolls within a
 * budget derived from `output.rows` instead. Height unknown (a pipe, a test
 * double) means no budget and everything is printed, which is the old behaviour.
 *
 * `headings` maps an index to a group label printed above that row — the option
 * exists because a flat list of nineteen names cannot say that some of them bill
 * per token, which is the difference a lender is choosing between.
 *
 * Returns the chosen index, or `null` if the caller aborted (nothing was picked)
 * — distinct from choosing item 0.
 */
export function promptChoice(title, choices, {
  input = process.stdin, output = process.stdout, signal = null, initial = 0,
  headings = null,
} = {}) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    // No terminal: there is nothing to select with, and blocking here is the
    // hang this module exists to avoid.
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let index = Math.min(Math.max(initial, 0), choices.length - 1);
    const wasRaw = Boolean(input.isRaw);
    let painted = 0;

    // Digits typed so far, and where the highlight was before they were. The
    // anchor is what backspacing all the way out returns to — otherwise
    // clearing a mistyped number silently moves the selection.
    let pending = "";
    let anchor = index;
    const labelOf = (c) => (typeof c === "string" ? c : c.label);

    // Headings are rows, so the window and the line count are computed over the
    // same sequence that is printed rather than over the choices alone.
    const ROWS = [];
    for (const [i, c] of choices.entries()) {
      if (headings?.[i]) ROWS.push({ heading: headings[i] });
      ROWS.push({ i, c });
    }

    /** How many rows fit, leaving the title and the shell's next prompt room. */
    function budget() {
      const h = Number(output.rows) || 0;
      if (!h) return Infinity;                  // not a real window: print it all
      return Math.max(5, h - 4);
    }

    function paint() {
      // Redraw in place. Scrolling a new copy of the menu on every keypress
      // makes a five-line list unreadable after three arrow presses.
      //
      // Cursor movement and line-erase are written unconditionally, unlike the
      // colours: they are not decoration, they are what makes this a menu
      // rather than a growing transcript. This whole branch is TTY-only (see
      // the guard above), so there is no pipe for them to leak into — whereas
      // `NO_COLOR` on a real terminal is a preference about appearance, and
      // honouring it must not flatten the menu into unusable scroll.
      if (painted) output.write(`\x1b[${painted}A`);
      let lines = 0;
      const line = (s) => { output.write(`\x1b[2K${s}\n`); lines++; };

      const fits = ROWS.length <= budget();
      let slice = ROWS, above = 0, below = 0;
      if (!fits) {
        // Two of the budget go to the more-above / more-below markers.
        const span = budget() - 2;
        const at = ROWS.findIndex((r) => r.i === index);
        const start = Math.min(Math.max(at - (span >> 1), 0), ROWS.length - span);
        slice = ROWS.slice(start, start + span);
        above = start;
        below = ROWS.length - start - span;
      }

      // Both markers are written whenever the list scrolls, blank when the count
      // is zero. Omitting one would change the number of lines between redraws,
      // and the cursor walk up is a fixed count — a line that comes and goes is
      // a line left behind on screen.
      if (!fits) line(above ? `  ${C.dim}↑ ${above} more${C.reset}` : "");
      for (const r of slice) {
        if (r.heading) { line(`  ${C.bold}${r.heading}${C.reset}`); continue; }
        const on = r.i === index;
        const c = r.c;
        const note = typeof c === "string" ? "" : (c.note ? `  ${C.dim}${c.note}${C.reset}` : "");
        const marker = on ? `${C.cyan}❯${C.reset}` : " ";
        line(`${marker} ${r.i + 1}. ${on ? C.bold : ""}${labelOf(c)}${on ? C.reset : ""}${note}`);
      }
      if (!fits) line(below ? `  ${C.dim}↓ ${below} more${C.reset}` : "");
      painted = lines;
    }

    function restore() {
      input.removeListener("data", onData);
      signal?.removeEventListener("abort", onAbort);
      try { input.setRawMode(wasRaw); } catch { /* stream already gone */ }
      input.pause();
    }

    function done(result) { restore(); resolve(result); }
    function onAbort() { restore(); resolve(null); }

    if (signal?.aborted) return resolve(null);
    signal?.addEventListener("abort", onAbort);

    if (title) output.write(`${title}\n`);
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    paint();

    /** Forget a half-typed number and put the highlight back where it was. */
    function clearPending() {
      pending = "";
      index = anchor;
    }

    /**
     * One digit of a possibly-longer number.
     *
     * Returns true when the entry is complete — either because the user pressed
     * enter or because no valid choice number begins with what they have typed.
     * A digit that cannot start or continue a valid number is dropped: with two
     * choices, `9` is not a selection and must not become a pending `9` that
     * eats the `1` typed after it.
     */
    function onDigit(d) {
      const candidate = pending + d;
      const n = Number.parseInt(candidate, 10);
      if (!(n >= 1 && n <= choices.length)) return false;

      index = n - 1;
      // Could another digit make a different valid choice? `1` of 19 could
      // still become 10–19, so it waits; `2` of 19 could only ever be 2, so it
      // commits — which is what keeps every menu of nine or fewer instant.
      if (n * 10 > choices.length) { pending = ""; return true; }
      pending = candidate;
      paint();
      return false;
    }

    function onData(chunk) {
      const s = String(chunk);
      if (s === CTRL_C) {
        restore();
        output.write("\n");
        process.exit(130);
        return;
      }
      if (s === "\r" || s === "\n") return done(index);
      if (s === BACKSPACE || s === "\b") {
        if (!pending) return;
        pending = pending.slice(0, -1);
        index = pending ? Number.parseInt(pending, 10) - 1 : anchor;
        return paint();
      }
      // Escape and Ctrl+U both abandon a mistyped number. Bare escape only —
      // the arrow keys below arrive as a longer sequence and are not caught here.
      if (s === "\x1b" || s === CTRL_U) {
        if (!pending) return;
        clearPending();
        return paint();
      }
      if (s === "\x1b[A" || s === "k") {
        clearPending();
        index = (index - 1 + choices.length) % choices.length;
        anchor = index;
        return paint();
      }
      if (s === "\x1b[B" || s === "j") {
        clearPending();
        index = (index + 1) % choices.length;
        anchor = index;
        return paint();
      }
      // Digits select by number — the fast path, and the only one that works
      // when arrow keys do not survive the connection. Iterated rather than
      // parsed whole, because a pasted or fast-typed "12" arrives as one chunk
      // and has to behave exactly like two keystrokes.
      if (/^[0-9]+$/.test(s)) {
        for (const d of s) {
          if (onDigit(d)) { paint(); return done(index); }
        }
      }
    }

    input.on("data", onData);
  });
}
