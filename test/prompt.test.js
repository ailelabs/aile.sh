/**
 * Terminal input.
 *
 * Three failure modes justify testing something this small.
 *
 * A HANG. If a prompt is issued where no terminal exists, the process waits
 * forever with no output — under systemd that looks like a service that started
 * and did nothing. `isInteractive` is what callers check to avoid it.
 *
 * A BROKEN SHELL. Raw mode must be restored on every exit path. Leaving a
 * terminal raw after the process dies makes the user's shell appear broken with
 * no visible connection to us.
 *
 * A LOST RACE THAT DOES NOT LET GO. Sign-in runs the browser flow and the paste
 * prompt at once, so the losing prompt has to abandon cleanly — restore raw
 * mode, drop its listener, and resolve `null` rather than `""`, because the
 * caller must not read "the race ended" as "the user submitted an empty line".
 */

import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import { isInteractive, promptSecret, promptLine, promptChoice, copyToClipboard } from "../src/cli/prompt.js";

/** A stdin that claims to be a TTY and records raw-mode transitions. */
function fakeTty() {
  const s = new PassThrough();
  s.isTTY = true;
  s.isRaw = false;
  s.rawHistory = [];
  s.setRawMode = (v) => { s.isRaw = v; s.rawHistory.push(v); return s; };
  return s;
}

function capture() {
  const out = new PassThrough();
  out.written = "";
  const write = out.write.bind(out);
  out.write = (chunk, ...rest) => { out.written += String(chunk); return write(chunk, ...rest); };
  return out;
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("isInteractive", () => {
  it("is true only when BOTH streams are a terminal", () => {
    const tty = { isTTY: true }, pipe = { isTTY: false };
    expect([
      isInteractive(tty, tty),
      isInteractive(tty, pipe),
      isInteractive(pipe, tty),
      isInteractive(pipe, pipe),
    ]).toEqual([true, false, false, false]);
  });

  it("treats an undefined isTTY as not a terminal", () => {
    expect(isInteractive({}, {})).toBe(false);
  });
});

describe("promptSecret on a terminal", () => {
  it("returns what was typed and never echoes it", async () => {
    const input = fakeTty(), output = capture();
    const p = promptSecret("Token: ", { input, output });
    await tick();
    input.write("ail_secret");
    input.write("\r");
    expect(await p).toBe("ail_secret");
    // The value must not appear anywhere in what the terminal saw — that is the
    // entire reason this function exists rather than readline.
    expect(output.written).not.toContain("ail_secret");
    expect(output.written).toContain("Token: ");
  });

  it("echoes one mask character per keypress", async () => {
    // Showing nothing at all reads as "my paste did not register", and the user
    // pastes a second time on top of the first.
    const input = fakeTty(), output = capture();
    const p = promptSecret("> ", { input, output, mask: "*" });
    await tick();
    input.write("abcd");
    input.write("\n");
    await p;
    expect((output.written.match(/\*/g) || []).length).toBe(4);
  });

  it("restores raw mode when the line is submitted", async () => {
    const input = fakeTty(), output = capture();
    const p = promptSecret("> ", { input, output });
    await tick();
    input.write("x".repeat(30));
    input.write("\r");
    await p;
    expect({ raw: input.isRaw, history: input.rawHistory }).toEqual({ raw: false, history: [true, false] });
  });

  it("handles backspace", async () => {
    const input = fakeTty(), output = capture();
    const p = promptSecret("> ", { input, output });
    await tick();
    input.write("abcZ\r");
    expect(await p).toBe("aZ");
  });

  it("clears the line on Ctrl+U", async () => {
    const input = fakeTty(), output = capture();
    const p = promptSecret("> ", { input, output });
    await tick();
    input.write("wrongtokenright\r");
    expect(await p).toBe("right");
  });

  it("accepts a whole paste arriving as one chunk", async () => {
    // The normal case, not an edge case: a terminal delivers a paste in one go.
    const input = fakeTty(), output = capture();
    const token = "ail_" + "f".repeat(48);
    const p = promptSecret("> ", { input, output });
    await tick();
    input.write(token + "\n");
    expect(await p).toBe(token);
  });

  it("returns what was typed so far on Ctrl+D", async () => {
    const input = fakeTty(), output = capture();
    const p = promptSecret("> ", { input, output });
    await tick();
    input.write("partial");
    expect(await p).toBe("partial");
  });
});

describe("promptSecret on a pipe", () => {
  it("reads the first line, so `echo $TOKEN | aile login --paste` works", async () => {
    const input = new PassThrough();       // no isTTY
    const output = capture();
    const p = promptSecret("> ", { input, output });
    input.write("ail_piped\n");
    expect(await p).toBe("ail_piped");
  });

  it("resolves on the newline without waiting for the writer to close", async () => {
    // A pipe held open by a still-running process must not stall sign-in.
    const input = new PassThrough();
    const p = promptSecret("> ", { input, output: capture() });
    input.write("ail_piped\n");           // deliberately no .end()
    expect(await p).toBe("ail_piped");
  });

  it("skips leading blank lines", async () => {
    const input = new PassThrough();
    const p = promptSecret("> ", { input, output: capture() });
    input.write("\n\n  ail_after_blanks\n");
    expect(await p).toBe("ail_after_blanks");
  });

  it("returns empty on a closed stdin rather than hanging", async () => {
    const input = new PassThrough();
    const p = promptSecret("> ", { input, output: capture() });
    input.end();
    expect(await p).toBe("");
  });
});

describe("promptLine", () => {
  it("reads and trims a visible line", async () => {
    const input = new PassThrough(), output = capture();
    const p = promptLine("Email: ", { input, output });
    await tick();
    input.write("  you@example.com  \n");
    expect(await p).toBe("you@example.com");
  });
});

describe("promptSecret when something else wins the race", () => {
  it("resolves null — not empty string — when aborted", async () => {
    // The distinction is the whole contract. `""` means the user pressed enter
    // on an empty line, which sign-in treats as cancelling; `null` means the
    // browser approval landed and this prompt was never answered at all.
    const input = fakeTty(), output = capture();
    const stop = new AbortController();
    const p = promptSecret("> ", { input, output, signal: stop.signal });
    await tick();
    stop.abort();
    expect(await p).toBeNull();
  });

  it("restores the terminal when abandoned, not just when answered", async () => {
    // A lost race that leaves raw mode on hands the user a shell that appears
    // broken, with nothing pointing back at us.
    const input = fakeTty(), output = capture();
    const stop = new AbortController();
    const p = promptSecret("> ", { input, output, signal: stop.signal });
    await tick();
    stop.abort();
    await p;
    expect({ raw: input.isRaw, history: input.rawHistory, listeners: input.listenerCount("data") })
      .toEqual({ raw: false, history: [true, false], listeners: 0 });
  });

  it("does not even start when handed an already-aborted signal", async () => {
    const input = fakeTty(), output = capture();
    const stop = new AbortController();
    stop.abort();
    expect(await promptSecret("> ", { input, output, signal: stop.signal })).toBeNull();
    expect(input.rawHistory).toEqual([]);
  });

  it("abandons a piped read too", async () => {
    // `echo $TOKEN | aile login` still races the browser; a pipe that never
    // delivers a line must not pin the process open after the browser wins.
    const input = new PassThrough();
    const stop = new AbortController();
    const p = promptSecret("> ", { input, output: capture(), signal: stop.signal });
    await tick();
    stop.abort();
    expect(await p).toBeNull();
  });
});

describe("promptSecret hotkeys", () => {
  it("fires on an empty line", async () => {
    const input = fakeTty(), output = capture();
    let fired = 0;
    const p = promptSecret("> ", { input, output, hotkeys: { c: () => { fired++; } } });
    await tick();
    input.write("c");
    await tick();
    input.write("tok\r");
    expect({ value: await p, fired }).toEqual({ value: "tok", fired: 1 });
  });

  it("does NOT swallow a hotkey character that is part of a paste", async () => {
    // A token containing "c" three characters in must survive intact. Treating
    // it as a command corrupts the paste and the user cannot see why — the
    // input is masked.
    const input = fakeTty(), output = capture();
    let fired = 0;
    const token = "abcdef";
    const p = promptSecret("> ", { input, output, hotkeys: { c: () => { fired++; } } });
    await tick();
    input.write(token + "\r");
    expect({ value: await p, fired }).toEqual({ value: token, fired: 0 });
  });
});

describe("promptChoice", () => {
  it("selects and confirms on a digit, in one keystroke", async () => {
    // The fast path, and the only one that survives a connection where arrow
    // keys arrive as escape-sequence gibberish.
    const input = fakeTty(), output = capture();
    const p = promptChoice("Pick:", ["first", "second"], { input, output });
    await tick();
    input.write("2");
    expect(await p).toBe(1);
  });

  it("moves with arrows and confirms on enter", async () => {
    const input = fakeTty(), output = capture();
    const p = promptChoice("Pick:", ["a", "b", "c"], { input, output });
    await tick();
    input.write("\x1b[B");
    await tick();
    input.write("\r");
    expect(await p).toBe(1);
  });

  it("wraps around rather than sticking at the ends", async () => {
    const input = fakeTty(), output = capture();
    const p = promptChoice("Pick:", ["a", "b"], { input, output });
    await tick();
    input.write("\x1b[A");            // up from the first lands on the last
    await tick();
    input.write("\r");
    expect(await p).toBe(1);
  });

  it("ignores a digit outside the list instead of picking something", async () => {
    const input = fakeTty(), output = capture();
    const p = promptChoice("Pick:", ["a", "b"], { input, output });
    await tick();
    input.write("9");
    await tick();
    input.write("1");
    expect(await p).toBe(0);
  });

  it("returns null with no terminal, rather than blocking forever", async () => {
    const input = new PassThrough();
    expect(await promptChoice("Pick:", ["a", "b"], { input, output: capture() })).toBeNull();
  });

  it("restores the terminal after a choice", async () => {
    const input = fakeTty(), output = capture();
    const p = promptChoice("Pick:", ["a", "b"], { input, output });
    await tick();
    input.write("1");
    await p;
    expect({ raw: input.isRaw, listeners: input.listenerCount("data") }).toEqual({ raw: false, listeners: 0 });
  });

  it("shows the numbers, because they are what the user is told to press", async () => {
    const input = fakeTty(), output = capture();
    const p = promptChoice("How would you like to sign in?", [
      { label: "Sign in with your browser", note: "opens a page" },
      { label: "Paste a token", note: "headless" },
    ], { input, output });
    await tick();
    input.write("1");
    await p;
    // Compare what the user reads, not the byte stream: colour and bold codes
    // sit between the number and the label, so a raw substring match tests the
    // escape sequences rather than the text.
    const seen = output.written.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    expect(seen).toContain("1. Sign in with your browser");
    expect(seen).toContain("2. Paste a token");
    expect(seen).toContain("opens a page");
  });
});

/**
 * The provider menu offers 19 options, and every one past 9 was unreachable by
 * number: a chooser that commits on the first digit takes the `1` of `18` and
 * selects the first entry before the `8` is even typed. It did so silently —
 * nothing on screen showed a partial number — so it read as a menu picking at
 * random rather than as input being cut off.
 *
 * The fix is a rule, not a delay: a digit commits as soon as it CANNOT be
 * extended into another valid choice. Both halves of that need pinning, because
 * the obvious implementations break the other one — waiting for a second digit
 * always makes short menus need an enter, and committing eagerly makes long
 * menus unreachable.
 */
describe("promptChoice with more than nine options", () => {
  const many = (n) => Array.from({ length: n }, (_, i) => `item ${i + 1}`);
  const plain = (out) => out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

  it("reaches an option past 9, which is the bug", async () => {
    const input = fakeTty(), output = capture();
    const p = promptChoice("Pick:", many(19), { input, output });
    await tick();
    input.write("1");            // ambiguous: could still become 10-19
    await tick();
    input.write("8");
    expect(await p).toBe(17);    // item 18
  });

  it("moves the marker to the pending number, so the user knows it landed", async () => {
    // The silence is half the bug: a first digit that selects nothing and shows
    // nothing is indistinguishable from a dead keyboard. The marker moving is
    // the whole signal — there is deliberately no second "you typed 1" line,
    // because it says the same thing in a place that can disagree with this one.
    const input = fakeTty(), output = capture();
    const p = promptChoice("Pick:", many(19), { input, output });
    await tick();
    input.write("1");
    await tick();
    // Split on the cursor-up FIRST: `plain` strips those too, so stripping
    // before splitting would silently yield the whole transcript and assert
    // against a frame the user never saw.
    const frame = plain(output.written.split(/\x1b\[\d+A/).pop());
    expect(frame).toMatch(/❯ 1\. item 1/);
    expect(frame).not.toMatch(/❯ .*item 2\b/);
    input.write("2");
    expect(await p).toBe(11);
  });

  it("commits at once on a digit that cannot be extended", async () => {
    // 2 of 19 can only ever be 2 — waiting for a second digit here would make
    // every unambiguous choice need an enter it never needed before.
    const input = fakeTty(), output = capture();
    const p = promptChoice("Pick:", many(19), { input, output });
    await tick();
    input.write("2");
    expect(await p).toBe(1);
  });

  it("takes enter as the end of an ambiguous number", async () => {
    // Item 1 of 19 is otherwise unreachable: its digit is a prefix of ten others.
    const input = fakeTty(), output = capture();
    const p = promptChoice("Pick:", many(19), { input, output });
    await tick();
    input.write("1");
    await tick();
    input.write("\r");
    expect(await p).toBe(0);
  });

  it("takes a pasted number as one number, not as two keystrokes", async () => {
    // Typed fast enough, or pasted, both digits arrive in a single chunk. The
    // per-character loop is what makes that identical to typing them.
    const input = fakeTty(), output = capture();
    const p = promptChoice("Pick:", many(19), { input, output });
    await tick();
    input.write("15");
    expect(await p).toBe(14);
  });

  it("backspaces out of a mistyped digit without moving the selection", async () => {
    const input = fakeTty(), output = capture();
    const p = promptChoice("Pick:", many(19), { input, output, initial: 4 });
    await tick();
    input.write("1");             // highlight follows to item 1
    await tick();
    input.write("\x7f");          // ...and back to where it was
    await tick();
    input.write("\r");
    expect(await p).toBe(4);
  });

  it("abandons a half-typed number on escape", async () => {
    const input = fakeTty(), output = capture();
    const p = promptChoice("Pick:", many(19), { input, output, initial: 2 });
    await tick();
    input.write("1");
    await tick();
    input.write("\x1b");
    await tick();
    input.write("\r");
    expect(await p).toBe(2);
  });

  it("still lets the arrows through while a digit is pending", async () => {
    // The escape branch above must not swallow an arrow key, which arrives as a
    // longer sequence beginning with the same byte.
    const input = fakeTty(), output = capture();
    const p = promptChoice("Pick:", many(19), { input, output, initial: 0 });
    await tick();
    input.write("1");
    await tick();
    input.write("\x1b[B");        // clears the pending 1, moves down from item 1
    await tick();
    input.write("\r");
    expect(await p).toBe(1);
  });

  it("drops a digit that cannot begin any valid number", async () => {
    // With 19 options a `0` starts nothing. Buffering it would eat the digit
    // typed after it, which is worse than ignoring it.
    const input = fakeTty(), output = capture();
    const p = promptChoice("Pick:", many(19), { input, output });
    await tick();
    input.write("0");
    await tick();
    input.write("3");
    expect(await p).toBe(2);
  });

  it("prints group headings above the rows they belong to", async () => {
    // A flat list of nineteen names cannot say that seven of them bill per
    // token, which is the difference the lender is actually choosing between.
    const input = fakeTty(), output = capture();
    const p = promptChoice("Pick:", many(12), {
      input, output, headings: { 0: "Subscriptions", 9: "API keys" },
    });
    await tick();
    input.write("\r");
    await p;
    const lines = plain(output.written).split("\n");
    const at = (needle) => lines.findIndex((l) => l.includes(needle));
    expect(at("Subscriptions")).toBeGreaterThan(-1);
    expect(at("Subscriptions")).toBeLessThan(at("1. item 1"));
    expect(at("API keys")).toBeGreaterThan(at("9. item 9"));
    expect(at("API keys")).toBeLessThan(at("10. item 10"));
  });
});

/**
 * A menu taller than the window is not a menu. The redraw walks the cursor up by
 * the number of lines it last wrote; if those lines did not fit, the terminal
 * scrolled and the top of them is gone, so the walk lands mid-list and every
 * keypress smears another copy down the screen. 19 providers do not fit a 24-row
 * terminal, which is the shape this actually shipped in.
 */
describe("promptChoice in a window too short for the list", () => {
  const many = (n) => Array.from({ length: n }, (_, i) => `item ${i + 1}`);
  const plain = (out) => out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  /** A terminal whose height the chooser can read. */
  const shortTty = () => fakeTty();

  it("never writes more lines than it can walk back up", async () => {
    const input = shortTty(), output = capture();
    output.rows = 12;
    const p = promptChoice("Pick:", many(19), { input, output });
    await tick();
    // The cursor-up counts are the claim about how much was written. Each must
    // match the lines that followed the previous one, or the redraw is offset.
    const frames = output.written.split(/\x1b\[(\d+)A/);
    for (let k = 1; k < frames.length; k += 2) {
      const claimed = Number(frames[k]);
      const wrote = (frames[k + 1].match(/\n/g) || []).length;
      expect({ claimed, wrote }).toEqual({ claimed: wrote, wrote });
      expect(claimed).toBeLessThanOrEqual(12);
    }
    input.write("\r");
    await p;
  });

  it("scrolls to keep the highlighted row on screen", async () => {
    const input = shortTty(), output = capture();
    output.rows = 12;
    const p = promptChoice("Pick:", many(19), { input, output });
    await tick();
    input.write("19");
    await p;
    // The last frame is the one the user is looking at when it commits — split
    // before stripping, because `plain` removes the cursor-up codes as well.
    const last = plain(output.written.split(/\x1b\[\d+A/).pop());
    expect(last).toContain("19. item 19");
  });

  it("says how many rows are out of view in each direction", async () => {
    // Otherwise a windowed list looks like the whole list, and the options
    // below the fold are as invisible as they were before any of this.
    const input = shortTty(), output = capture();
    output.rows = 12;
    const p = promptChoice("Pick:", many(19), { input, output });
    await tick();
    expect(plain(output.written)).toMatch(/↓ \d+ more/);
    input.write("\r");
    await p;
  });

  it("prints everything when the height is unknown", async () => {
    // A pipe or a test double has no rows. Windowing on a guess would hide
    // options for no reason.
    const input = fakeTty(), output = capture();
    const p = promptChoice("Pick:", many(19), { input, output });
    await tick();
    input.write("\r");
    await p;
    const seen = plain(output.written);
    for (const n of [1, 10, 19]) expect(seen).toContain(`${n}. item ${n}`);
  });
});

describe("copyToClipboard", () => {
  it("resolves false instead of throwing when the platform tool is missing", async () => {
    // Best-effort by design: the URL is printed in full right above the offer,
    // so a failed copy costs a manual selection, not the sign-in.
    expect(await copyToClipboard("x", { platform: "definitely-not-a-platform" })).toBe(false);
  });
});
