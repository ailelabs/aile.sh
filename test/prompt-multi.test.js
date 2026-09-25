/**
 * The checkbox list `aile setup` opens with, the yes/no every destructive
 * command asks, and the way out of a menu — driven through fake terminals, the
 * same way prompt.test.js drives promptChoice.
 */

import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import { promptMulti, promptConfirm, promptChoice } from "../src/cli/prompt.js";

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
const TOOLS = [{ label: "Claude Code", checked: true }, { label: "Codex" }, { label: "opencode", checked: true }];

describe("promptMulti", () => {
  it("returns what was pre-ticked when enter is pressed straight away", async () => {
    const input = fakeTty(), output = capture();
    const p = promptMulti("Which tools?", TOOLS, { input, output });
    await tick();
    input.write("\r");
    expect(await p).toEqual([0, 2]);
  });

  it("toggles the row under the cursor with space", async () => {
    const input = fakeTty(), output = capture();
    const p = promptMulti("Which tools?", TOOLS, { input, output });
    await tick();
    input.write("\x1b[B");      // down to Codex
    await tick();
    input.write(" ");           // tick it
    await tick();
    input.write("\r");
    expect(await p).toEqual([0, 1, 2]);
  });

  it("`a` ticks everything, and again unticks everything", async () => {
    const input = fakeTty(), output = capture();
    const p = promptMulti("Which tools?", TOOLS, { input, output });
    await tick();
    input.write("a");
    await tick();
    input.write("\r");
    expect(await p).toEqual([0, 1, 2]);

    const input2 = fakeTty(), output2 = capture();
    const p2 = promptMulti("Which tools?", TOOLS.map((t) => ({ ...t, checked: true })), { input: input2, output: output2 });
    await tick();
    input2.write("a");
    await tick();
    input2.write("\r");
    expect(await p2).toEqual([]);
  });

  it("`a` ticks every item but leaves an option row as it was", async () => {
    const input = fakeTty(), output = capture();
    const rows = [...TOOLS, { label: "Also make aile the default", option: true }];
    const p = promptMulti("Which tools?", rows, { input, output });
    await tick();
    input.write("a");
    await tick();
    input.write("\r");
    expect(await p).toEqual([0, 1, 2]);
  });

  it("an option row's long label does not push the items' notes to the edge", async () => {
    const input = fakeTty(), output = capture();
    output.columns = 200;
    const rows = [
      { label: "Codex", note: "adds codexaile" },
      { label: "Also make aile the default in Claude Code and Codex", note: "edits their settings", option: true },
    ];
    const p = promptMulti("Which tools?", rows, { input, output });
    await tick();
    input.write("\r");
    await p;
    const first = output.written.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n").find((l) => l.includes("Codex"));
    expect(first.indexOf("adds codexaile")).toBeLessThan(20);
  });

  it("draws the footer under the list, fitted to the window", async () => {
    const input = fakeTty(), output = capture();
    output.columns = 30;
    const p = promptMulti("Which tools?", TOOLS, { input, output, footer: "not listed: aile setup <tool> and a long tail" });
    await tick();
    input.write("\r");
    await p;
    const plain = output.written.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    expect(plain).toContain("not listed:");
    for (const l of plain.split("\n")) expect(l.length).toBeLessThanOrEqual(29);
  });

  it("Esc abandons the list: null, which every caller reads as cancelled", async () => {
    const input = fakeTty(), output = capture();
    const p = promptMulti("Which tools?", TOOLS, { input, output });
    await tick();
    input.write("\x1b");
    expect(await p).toBeNull();
  });

  it("gives the terminal back as it found it", async () => {
    const input = fakeTty(), output = capture();
    const p = promptMulti("Which tools?", TOOLS, { input, output });
    await tick();
    input.write("\r");
    await p;
    expect(input.isRaw).toBe(false);
  });

  it("asks nothing without a terminal", async () => {
    const input = new PassThrough(), output = capture();
    expect(await promptMulti("Which tools?", TOOLS, { input, output })).toBeNull();
    expect(output.written).toBe("");
  });
});

describe("promptConfirm", () => {
  it("takes the default on a bare enter", async () => {
    for (const defaultYes of [true, false]) {
      const input = fakeTty(), output = capture();
      const p = promptConfirm("Apply?", { defaultYes, input, output });
      await tick();
      input.write("\n");
      expect(await p).toBe(defaultYes);
    }
  });

  it("reads y and yes as yes, anything else as no", async () => {
    for (const [typed, want] of [["y", true], ["YES", true], ["n", false], ["nope", false]]) {
      const input = fakeTty(), output = capture();
      const p = promptConfirm("Apply?", { defaultYes: true, input, output });
      await tick();
      input.write(`${typed}\n`);
      expect({ typed, got: await p }).toEqual({ typed, got: want });
    }
  });

  it("shows which answer is the default", async () => {
    const input = fakeTty(), output = capture();
    const p = promptConfirm("Remove it?", { defaultYes: false, input, output });
    await tick();
    expect(output.written).toContain("y/N");
    input.write("\n");
    await p;
  });

  it("answers the default without a terminal, rather than hanging", async () => {
    expect(await promptConfirm("Apply?", { defaultYes: false, input: new PassThrough(), output: capture() })).toBe(false);
  });
});

describe("a menu on a narrow terminal", () => {
  // A row wider than the window wraps onto a second physical line, and the
  // redraw walks the cursor up by ROWS — so every keypress left a torn copy of
  // the menu behind. No row may be wider than the window.
  const visible = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  const LONG = [
    { label: "Use aile in my coding tools", note: "Claude Code, Codex, opencode, and a long tail of others besides" },
    { label: "Paste a token from another device", note: "for a headless machine, SSH, or a container" },
  ];

  it("promptChoice keeps every row inside the window", async () => {
    const input = fakeTty(), output = capture();
    output.columns = 40;
    const p = promptChoice("Pick:", LONG, { input, output });
    await tick();
    input.write("\x1b[B");
    await tick();
    input.write("\r");
    await p;
    const rows = visible(output.written).split("\n").slice(1).filter(Boolean);
    for (const r of rows) expect({ r, fits: r.length <= 39 }).toEqual({ r, fits: true });
  });

  it("promptMulti keeps every row inside the window", async () => {
    const input = fakeTty(), output = capture();
    output.columns = 40;
    const p = promptMulti("Pick:", LONG, { input, output });
    await tick();
    input.write("\r");
    await p;
    const rows = visible(output.written).split("\n").slice(1).filter(Boolean);
    for (const r of rows) expect({ r, fits: r.length <= 39 }).toEqual({ r, fits: true });
  });

  it("lines the notes up in a column when there is room", async () => {
    const input = fakeTty(), output = capture();
    output.columns = 200;
    const p = promptChoice("Pick:", LONG, { input, output });
    await tick();
    input.write("\r");
    await p;
    const rows = visible(output.written).split("\n").slice(1, 3);
    expect(rows[0].indexOf("Claude Code")).toBe(rows[1].indexOf("for a headless"));
  });
});

describe("leaving a menu", () => {
  it("Esc with nothing half-typed leaves the menu", async () => {
    const input = fakeTty(), output = capture();
    const p = promptChoice("Pick:", ["a", "b"], { input, output });
    await tick();
    input.write("\x1b");
    expect(await p).toBeNull();
  });

  it("q leaves it too", async () => {
    const input = fakeTty(), output = capture();
    const p = promptChoice("Pick:", ["a", "b"], { input, output });
    await tick();
    input.write("q");
    expect(await p).toBeNull();
  });

  it("Esc with a number half-typed only clears the number", async () => {
    const many = Array.from({ length: 12 }, (_, i) => `item ${i + 1}`);
    const input = fakeTty(), output = capture();
    const p = promptChoice("Pick:", many, { input, output });
    await tick();
    input.write("1");           // could still become 10-12
    await tick();
    input.write("\x1b");        // clears the 1, stays in the menu
    await tick();
    input.write("\r");          // the highlighted first item
    expect(await p).toBe(0);
  });
});

describe("the cursor under a menu", () => {
  // A menu takes keys, not text, so the caret is hidden while it waits — Zed
  // draws the cursor blue, and a blinking block under the list read as "type
  // here". Whatever ends the menu must give the cursor back.
  const HIDE = "\x1b[?25l";
  const SHOW = "\x1b[?25h";
  const tty = () => { const o = capture(); o.isTTY = true; return o; };
  const hiddenThenShown = (w) => w.indexOf(HIDE) >= 0 && w.lastIndexOf(SHOW) > w.lastIndexOf(HIDE);

  for (const [name, key, want] of [["enter", "\r", 0], ["esc", "\x1b", null], ["q", "q", null]]) {
    it(`promptChoice hides it, and ${name} shows it again`, async () => {
      const input = fakeTty(), output = tty();
      const p = promptChoice("Pick:", ["a", "b"], { input, output });
      await tick();
      expect(output.written).toContain(HIDE);
      expect(output.written).not.toContain(SHOW);
      input.write(key);
      expect(await p).toBe(want);
      expect(hiddenThenShown(output.written)).toBe(true);
    });
  }

  for (const [name, key] of [["enter", "\r"], ["esc", "\x1b"]]) {
    it(`promptMulti hides it, and ${name} shows it again`, async () => {
      const input = fakeTty(), output = tty();
      const p = promptMulti("Which tools?", TOOLS, { input, output });
      await tick();
      expect(output.written).toContain(HIDE);
      input.write(key);
      await p;
      expect(hiddenThenShown(output.written)).toBe(true);
    });
  }

  it("writes no cursor codes to a stream that is not a terminal", async () => {
    const input = fakeTty(), output = capture();
    const p = promptChoice("Pick:", ["a", "b"], { input, output });
    await tick();
    input.write("\r");
    await p;
    expect(output.written).not.toContain(HIDE);
    expect(output.written).not.toContain(SHOW);
  });

  it("leaves no exit hook behind once the menu is done", async () => {
    const before = process.listenerCount("exit");
    const input = fakeTty(), output = tty();
    const p = promptChoice("Pick:", ["a", "b"], { input, output });
    await tick();
    expect(process.listenerCount("exit")).toBe(before + 1);
    input.write("\r");
    await p;
    expect(process.listenerCount("exit")).toBe(before);
  });
});
