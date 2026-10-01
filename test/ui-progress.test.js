/**
 * The progress bar is a spinner with a size: drawn only for a person watching
 * stderr, plain lines for a log, and never a byte on stdout.
 */

import { describe, expect, test } from "bun:test";
import { progress, formatBytes, formatDuration } from "../src/cli/ui.js";

function sink(isTTY) {
  const out = [];
  return { isTTY, columns: 100, write: (s) => { out.push(String(s)); return true; }, text: () => out.join(""), out };
}

describe("formatBytes / formatDuration", () => {
  test("decimal units, one decimal under 100", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(4.92e9)).toBe("4.9 GB");
    expect(formatBytes(123e9)).toBe("123 GB");
    expect(formatBytes(null)).toBe("0 B");
    expect(formatBytes(-1)).toBe("?");
  });

  test("seconds, minutes, hours", () => {
    expect(formatDuration(5)).toBe("5s");
    expect(formatDuration(95)).toBe("1m 35s");
    expect(formatDuration(3725)).toBe("1h 02m");
  });
});

describe("progress off a terminal", () => {
  test("one line per tenth, no escape codes, then the result line", () => {
    const s = sink(false);
    let t = 0;
    const p = progress("Downloading x", { stream: s, total: 1000, now: () => (t += 600) });
    for (let d = 0; d <= 1000; d += 50) p.update(d);
    p.succeed("Downloaded x");
    const lines = s.text().trim().split("\n");
    expect(lines.filter((l) => l.includes("Downloading x:")).length).toBe(10);
    expect(s.text()).not.toMatch(/\x1b\[\?25l|\r/);
    expect(lines.at(-1)).toContain("Downloaded x");
  });

  test("unknown size: a line every 30 s at most", () => {
    const s = sink(false);
    let t = 0;
    const p = progress("Pulling", { stream: s, now: () => t });
    for (let i = 0; i < 10; i++) { t += 10_000; p.update(i * 1e6); }
    expect(s.out.length).toBe(3);
  });
});

describe("progress on a terminal", () => {
  test("redraws in place, hides then restores the cursor, and leaves one line", () => {
    const prev = process.env.AILE_NO_SPINNER;
    delete process.env.AILE_NO_SPINNER;
    try {
      const s = sink(true);
      let t = 0;
      const p = progress("Downloading x", { stream: s, total: 1000, now: () => (t += 200) });
      p.update(500);
      p.fail("stopped");
      const text = s.text();
      expect(text.startsWith("\x1b[?25l")).toBe(true);
      expect(text).toContain("\r\x1b[2K");
      expect(text).toContain("\x1b[?25h");
      expect(text.trimEnd().endsWith("stopped")).toBe(true);
      // Closing twice writes nothing more.
      const before = text.length;
      p.succeed("again");
      expect(s.text().length).toBe(before);
    } finally {
      if (prev !== undefined) process.env.AILE_NO_SPINNER = prev;
    }
  });
});
