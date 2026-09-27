/**
 * A QR code that looks like one and scans to the wrong thing — or to nothing —
 * is the failure that matters here, and no amount of eyeballing catches it. So
 * every code is decoded with a real QR reader (jsQR, test-only) and must come
 * back as exactly the address it was made from: once from the matrix, and once
 * from the characters the terminal would actually show, in both polarities.
 */

import { describe, expect, it } from "bun:test";
import jsQR from "jsqr";
import { qrMatrix, qrLines } from "../src/cli/qr.js";

const ADDRESSES = [
  "ALUejqkjAifsZnJxVXA9SCya7u1fdx18RmCDfcy7i4y1",
  "HmsisfphYN2zv65vYd42gb9ajeD8fB4Mbs2A9WDNApHC",
  "94AtcatFepB2fueGy4BsGb6MoWL6ek5y5R1X97mSrh2V",
  "So11111111111111111111111111111111111111112",
];

/** Rows of booleans (true = dark) → RGBA pixels, `scale` px per module, with a wide white margin. */
function decode(rows, scale = 6, margin = 4) {
  const n = rows.length + margin * 2;
  const px = n * scale;
  const rgba = new Uint8ClampedArray(px * px * 4).fill(255);
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      if (!rows[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + margin) * scale + dy) * px + (x + margin) * scale + dx) * 4;
          rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
        }
      }
    }
  }
  return jsQR(rgba, px, px)?.data ?? null;
}

/** Terminal lines back to modules. `inkIsDark`: whether a drawn half-block is a dark module. */
function linesToRows(lines, { inkIsDark }) {
  const rows = [];
  for (const raw of lines) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "");
    const top = [];
    const bottom = [];
    for (const ch of line) {
      const t = ch === "█" || ch === "▀";
      const b = ch === "█" || ch === "▄";
      top.push(inkIsDark ? t : !t);
      bottom.push(inkIsDark ? b : !b);
    }
    rows.push(top, bottom);
  }
  return rows;
}

describe("the QR code scans back to the address", () => {
  for (const address of ADDRESSES) {
    it(`matrix: ${address.slice(0, 8)}…`, () => {
      expect(decode(qrMatrix(address))).toBe(address);
    });
  }

  it("as drawn with colour: black modules on a white background", () => {
    for (const address of ADDRESSES) {
      const lines = qrLines(address, { color: true, unicode: true });
      expect(lines.every((l) => l.startsWith("\x1b[30;47m") && l.endsWith("\x1b[0m"))).toBe(true);
      expect(decode(linesToRows(lines, { inkIsDark: true }))).toBe(address);
    }
  });

  it("as drawn without colour: the light modules are the ones drawn", () => {
    for (const address of ADDRESSES) {
      const lines = qrLines(address, { color: false, unicode: true });
      // The quiet zone is light, so without colour its rows are solid blocks.
      expect(lines[0]).toMatch(/^█+$/);
      expect(decode(linesToRows(lines, { inkIsDark: false }))).toBe(address);
    }
  });

  it("draws nothing where Unicode blocks cannot be shown", () => {
    expect(qrLines(ADDRESSES[0], { color: true, unicode: false })).toBeNull();
  });

  it("is two modules per line, so it fits a terminal", () => {
    const lines = qrLines(ADDRESSES[0], { color: false, unicode: true });
    expect(lines.length).toBe(Math.ceil(qrMatrix(ADDRESSES[0]).length / 2));
    expect([...lines[0]].length).toBeLessThanOrEqual(41);
  });
});
