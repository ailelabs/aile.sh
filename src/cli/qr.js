/**
 * A QR code of an address, drawn in the terminal, for funding a wallet from a
 * phone: `aile deposit`, `aile wallet own`, and `--qr` on `aile wallet` and
 * `aile balance`.
 *
 * THE ENCODER IS A LIBRARY AND THE ONLY ONE HERE. QR is Reed–Solomon error
 * correction, masking and version selection — a hand-rolled one fails by
 * producing a code that LOOKS right and scans to nothing, or to a different
 * address. `uqr` has no dependencies of its own, and it is bundled into
 * dist/cli.js like the wallet libraries, so an install still pulls nothing. The
 * branding test lets it be imported from this file and nowhere else.
 *
 * WHAT IS ENCODED IS THE BARE ADDRESS. Every Solana wallet and exchange app
 * scans that; a `solana:` payment URI is read by some and rejected by others.
 *
 * TWO MODULES PER CHARACTER, VERTICALLY (▀ ▄ █), so a 33-module code is 19 lines
 * rather than 37. The polarity matters as much as the pattern:
 *
 *   - With colour, the code is drawn black on an explicit white background, so
 *     it is right on a dark terminal and on a light one alike.
 *   - Without colour (NO_COLOR, a pipe), there is no background to set, so the
 *     LIGHT modules are the ones drawn — correct on the dark terminal most people
 *     run. Phone scanners read the inverse of that too.
 *   - Without Unicode (AILE_ASCII, a legacy console) there is no way to draw one
 *     that scans, so nothing is drawn: a wrong QR is worse than none.
 */

import { encode } from "uqr";
import { COLOR } from "./colors.js";
import { UNICODE_OK } from "./ui.js";

/** Light modules around the code. The spec asks for 4; 2 scans reliably off a screen and saves 4 lines. */
const QUIET = 2;

/** The code as rows of booleans, `true` = dark, quiet zone included. */
export function qrMatrix(text) {
  const { data } = encode(String(text), { ecc: "M", border: 0 });
  const size = data.length + QUIET * 2;
  const blank = () => new Array(size).fill(false);
  const rows = [];
  for (let i = 0; i < QUIET; i++) rows.push(blank());
  for (const row of data) rows.push([...new Array(QUIET).fill(false), ...row, ...new Array(QUIET).fill(false)]);
  for (let i = 0; i < QUIET; i++) rows.push(blank());
  return rows;
}

const BLOCK = { both: "█", top: "▀", bottom: "▄", none: " " };

/**
 * The code as terminal lines, or null when this terminal cannot draw one.
 * `color` and `unicode` are parameters for the tests; callers use the defaults.
 */
export function qrLines(text, { color = COLOR, unicode = UNICODE_OK } = {}) {
  if (!unicode) return null;
  const m = qrMatrix(text);
  // With colour the dark modules are drawn (black on white). Without, the light
  // ones are, and the terminal's own dark background supplies the dark.
  const ink = color ? (dark) => dark : (dark) => !dark;
  const lines = [];
  for (let y = 0; y < m.length; y += 2) {
    const top = m[y];
    const bottom = m[y + 1] ?? new Array(top.length).fill(false);
    let line = "";
    for (let x = 0; x < top.length; x++) {
      const t = ink(top[x]);
      const b = ink(bottom[x]);
      line += t && b ? BLOCK.both : t ? BLOCK.top : b ? BLOCK.bottom : BLOCK.none;
    }
    lines.push(color ? `\x1b[30;47m${line}\x1b[0m` : line);
  }
  return lines;
}

/** Print it, indented, with a caption underneath. Prints nothing where it cannot be drawn. */
export function printQr(text, { caption = null, indent = 2 } = {}) {
  const lines = qrLines(text);
  if (!lines) return false;
  const pad = " ".repeat(indent);
  console.log();
  for (const l of lines) console.log(`${pad}${l}`);
  if (caption) console.log(`${pad}${caption}`);
  return true;
}
