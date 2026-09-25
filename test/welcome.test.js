/**
 * The first run.
 *
 * Typing `aile` with no arguments on a machine that has never signed in is the
 * one moment where the CLI has a user's full attention and no context to lean
 * on. Two things have to hold.
 *
 * IT SAYS WHAT THIS IS. A status table with empty fields answers a question the
 * user has not asked yet. The welcome names the product and what it does before
 * asking for anything.
 *
 * IT IS NEVER IN THE WAY OF A SCRIPT. The gate is the bare invocation only. A
 * real command, `--help`, or a pipe with no terminal must all pass straight
 * through — a first-run experience a cron job can trip over is worse than none.
 */

import { describe, expect, it } from "bun:test";
import { welcome, welcomeNonInteractive, CHOICES } from "../src/cli/welcome.js";

const SERVER = "https://aile.test";

/** Collects output the way the real caller's `console.log` would. */
function recorder() {
  const lines = [];
  const log = (m) => lines.push(String(m ?? ""));
  log.text = () => lines.join("\n");
  log.plain = () => lines.join("\n").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  return log;
}

describe("welcome", () => {
  it("names the product and what it does before asking anything", async () => {
    const log = recorder();
    await welcome({ serverUrl: SERVER, log, interactive: true, choose: async () => 0 });
    const text = log.plain();
    expect(text).toContain("aile.sh");
    // The value proposition, in the words a first-time user needs: what they
    // give, what they get, and that it is not readable by this machine.
    expect(text).toMatch(/spare capacity/i);
    expect(text).toMatch(/paid/i);
  });

  it("promises the relay is blind, because that is the reason to trust it", async () => {
    // This line is the user-facing form of the whole architecture. If it ever
    // stops being true the wording has to change with it.
    const log = recorder();
    await welcome({ serverUrl: SERVER, log, interactive: true, choose: async () => 0 });
    expect(log.plain()).toMatch(/cannot read/i);
  });

  it("offers every way in, and returns the chosen one", async () => {
    for (const [index, expected] of [[0, "setup"], [1, "browser"], [2, "paste"], [3, "donate"]]) {
      const log = recorder();
      const got = await welcome({ serverUrl: SERVER, log, interactive: true, choose: async () => index });
      expect({ index, got }).toEqual({ index, got: expected });
    }
  });

  it("hands the chooser every option with a note explaining each", async () => {
    let offered = null;
    await welcome({
      serverUrl: SERVER, log: recorder(), interactive: true,
      choose: async (_title, choices) => { offered = choices; return 0; },
    });
    expect(offered.map((c) => c.id)).toEqual(["setup", "browser", "paste", "donate"]);
    expect(offered.every((c) => c.label && c.note)).toBe(true);
    // The headless case has to be visible as a first-class answer, not a
    // recovery someone discovers after the browser path fails silently.
    expect(offered[2].note).toMatch(/headless|SSH|container/i);
  });

  /**
   * The unpaid option is offered last, and that ordering is the honest one.
   * It is the only choice that pays nothing, so putting it first — or making it
   * the default a stray Enter lands on — steers people away from money they
   * could have had for the same work. Pinning the position pins that.
   */
  it("puts the unpaid option last and says so in the words that matter", async () => {
    let offered = null;
    await welcome({
      serverUrl: SERVER, log: recorder(), interactive: true,
      choose: async (_title, choices) => { offered = choices; return 0; },
    });
    expect(offered.at(-1).id).toBe("donate");
    // "not paid", not "free" or "community": the latter describe the buyer's
    // price, and the price does not change. What changes is who collects.
    expect(offered.at(-1).note).toMatch(/not paid/i);
    expect(offered.at(-1).note).not.toMatch(/\bfree\b/i);
    // And the two paid choices have to be legible as paid, or the unpaid one
    // is not a choice so much as an ambush.
    for (const c of offered.slice(1, 3)) expect(c.note).toMatch(/get paid/i);
  });

  it("returns null when cancelled, so the caller does not sign in by default", async () => {
    // Ctrl+C at the menu means "not now". Interpreting it as a choice would
    // start a browser flow the user just declined.
    for (const answer of [null, undefined]) {
      const got = await welcome({
        serverUrl: SERVER, log: recorder(), interactive: true, choose: async () => answer,
      });
      expect(got).toBeNull();
    }
  });

  it("still says what this is with no terminal — then stops, rather than prompting", async () => {
    let asked = 0;
    const log = recorder();
    const got = await welcome({
      serverUrl: SERVER, log, interactive: false, choose: async () => { asked++; return 0; },
    });
    // A pipe or a container gets the description but no question: blocking on a
    // prompt nobody can answer is a hang with no explanation.
    expect({ got, asked, described: /aile\.sh/.test(log.plain()) })
      .toEqual({ got: null, asked: 0, described: true });
  });
});

describe("welcomeNonInteractive", () => {
  it("names every way in, including the one that needs no browser", () => {
    const log = recorder();
    welcomeNonInteractive({ log });
    const text = log.plain();
    expect(text).toContain("aile login");
    expect(text).toContain("--paste");
    expect(text).toContain("--token");
    expect(text).toContain("aile setup");
  });

  /**
   * A container or a CI job is exactly where someone lends a machine they will
   * never log into. The unpaid path has to be printed there, with `--yes`,
   * because a prompt is not available to explain it later.
   */
  it("names the unpaid path too, with the flag that makes it work unattended", () => {
    const log = recorder();
    welcomeNonInteractive({ log });
    const text = log.plain();
    expect(text).toContain("aile donate");
    expect(text).toContain("--yes");
    expect(text).toMatch(/not paid/i);
  });

  it("says what comes after signing in, so the trail does not go cold", () => {
    const log = recorder();
    welcomeNonInteractive({ log });
    const text = log.plain();
    expect(text).toContain("aile connect");
    expect(text).toContain("aile start");
  });
});

describe("CHOICES", () => {
  it("uses ids the caller maps to login modes", () => {
    // `firstRun` turns these into signIn's `mode` — except `donate`, which it
    // routes to the command instead, because that flow has a consent step no
    // login mode has. Either way a rename here silently changes which runs.
    expect(CHOICES.map((c) => c.id)).toEqual(["setup", "browser", "paste", "donate"]);
  });

  /**
   * Using aile from a coding tool is what most first runs are for, and it needs
   * no sign-in on this machine — so it is offered first, and says so.
   */
  it("offers the coding-tools setup first, as a key rather than a sign-in", () => {
    expect(CHOICES[0].id).toBe("setup");
    expect(CHOICES[0].note).toMatch(/Claude Code/);
    expect(CHOICES[0].note).toMatch(/key/i);
  });
});
// Naming is not checked here: branding.test.js already scans all of src/ for
// the upstream name, and spelling it in a second file would trip that scan.
