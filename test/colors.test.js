/**
 * Colour is a decision, and this is the test that it is made correctly.
 *
 * The bug this exists to prevent shipped once already: every module declared
 * its own unconditional escape table, so `aile > setup.log` wrote
 * `\x1b[36m\x1b[1maile.sh` into the file. It survived a full suite because
 * every assertion in that suite strips ANSI before comparing — which is right
 * for testing *what* is said, and blind to *how* it is written.
 *
 * So there are two halves here. `colorEnabled` is checked directly against
 * stub environments, because the exported table is frozen at first import and
 * cannot be re-decided in-process. And the real CLI is run with its output
 * piped, asserting that not one escape byte comes back — the end-to-end check
 * that no module kept a private table.
 */

import { describe, expect, it, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { colorEnabled } from "../src/cli/colors.js";

const tty = { isTTY: true };
const pipe = { isTTY: false };

describe("colorEnabled", () => {
  it("is on for a terminal and off for a pipe", () => {
    expect({
      terminal: colorEnabled({}, tty),
      pipe: colorEnabled({}, pipe),
    }).toEqual({ terminal: true, pipe: false });
  });

  it("NO_COLOR wins over a terminal", () => {
    expect(colorEnabled({ NO_COLOR: "1" }, tty)).toBe(false);
  });

  it("honours NO_COLOR by presence, not by value", () => {
    // no-color.org is explicit: any value counts. `NO_COLOR=0` still means the
    // user reached for the variable, and reading it as "no, do use colour" is
    // the exact misreading the standard was written to stop.
    expect(colorEnabled({ NO_COLOR: "0" }, tty)).toBe(false);
    expect(colorEnabled({ NO_COLOR: "false" }, tty)).toBe(false);
  });

  it("ignores NO_COLOR set to empty — that is how shells unset it", () => {
    // `NO_COLOR= aile` and an exported-then-cleared variable both arrive as "".
    // Treating that as "colour off" makes the variable impossible to turn back
    // off within a session.
    expect(colorEnabled({ NO_COLOR: "" }, tty)).toBe(true);
  });

  it("FORCE_COLOR turns it on through a pipe", () => {
    // The CI case: output is captured, and the log viewer renders colour.
    expect(colorEnabled({ FORCE_COLOR: "1" }, pipe)).toBe(true);
  });

  it("FORCE_COLOR=0 does not force anything", () => {
    expect(colorEnabled({ FORCE_COLOR: "0" }, pipe)).toBe(false);
  });

  it("NO_COLOR beats FORCE_COLOR when both are set", () => {
    // Contradictory input, so the tie-break must be stated somewhere rather
    // than left to whichever branch happens to run first. Off is the safer
    // reading: the cost of unwanted plain text is nil, the cost of escapes in
    // a file someone greps is a broken match.
    expect(colorEnabled({ NO_COLOR: "1", FORCE_COLOR: "1" }, tty)).toBe(false);
  });

  it("survives a stream that is not there at all", () => {
    // stdout can be null in a detached or double-forked process. Throwing here
    // would take down a CLI that had not yet printed anything.
    expect(colorEnabled({}, null)).toBe(false);
    expect(colorEnabled({}, undefined)).toBe(false);
  });
});

const CLI = path.join(import.meta.dirname, "..", "src", "cli", "index.js");
const scratches = [];
const ESC = /\x1b\[/;

function freshData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-colors-"));
  scratches.push(dir);
  return dir;
}

/** Run the CLI with stdout piped — which is what redirecting to a file gives it. */
async function run(args, env = {}) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, AILE_DATA_DIR: freshData(), NO_COLOR: undefined, FORCE_COLOR: undefined, ...env },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return stdout + stderr;
}

afterAll(() => {
  for (const dir of scratches) fs.rmSync(dir, { recursive: true, force: true });
});

describe("the real CLI, with its output redirected", () => {
  it("writes no escape bytes on the first-run screen", async () => {
    // The screen most likely to end up in a pasted log, and the one that had
    // three separate hardcoded colour tables behind it.
    const out = await run([]);
    expect(out).toContain("aile.sh");
    expect(ESC.test(out)).toBe(false);
  });

  it("writes no escape bytes in help", async () => {
    const out = await run(["--help"]);
    expect(ESC.test(out)).toBe(false);
  });

  it("writes no escape bytes in the settings table", async () => {
    // config-command.js had its own copy of the table.
    const out = await run(["config"]);
    expect(ESC.test(out)).toBe(false);
  });

  it("writes no escape bytes when a command fails", async () => {
    // The error paths are `console.error` with red and dim around them, and an
    // error is the single most likely thing to be redirected and shared.
    const out = await run(["definitely-not-a-command"]);
    expect(out).toMatch(/unknown command/i);
    expect(ESC.test(out)).toBe(false);
  });

  it("still colours when FORCE_COLOR asks it to", async () => {
    // The other direction matters too: a table wired to always-empty would
    // pass every test above while making the tool permanently monochrome.
    const out = await run([], { FORCE_COLOR: "1" });
    expect(ESC.test(out)).toBe(true);
  });
});
