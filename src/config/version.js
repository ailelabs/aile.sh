/**
 * This CLI's own version string.
 *
 * A couple of provider endpoints want a client version on the request — Kimi's
 * `X-Msh-Version` is the one in the catalog today. Reading it from package.json
 * rather than hardcoding it means a release cannot silently start reporting an
 * old number.
 *
 * Two candidate paths because the module sits at a different depth in the two
 * places it runs from: `src/config/` in a checkout, and the bundled `dist/` in
 * an install. Nearest first — from `dist/` the parent IS the package root, and
 * probing upward before that would read `node_modules/package.json` in a real
 * install and report some unrelated package's version.
 *
 * A missing file falls through to a constant rather than throwing: this feeds a
 * header one provider logs, and that is not worth failing a link over.
 */

import fs from "node:fs";
import path from "node:path";

const FALLBACK = "0.0.0";

function read() {
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const raw = fs.readFileSync(path.join(import.meta.dirname, rel), "utf8");
      const v = JSON.parse(raw).version;
      if (v) return String(v);
    } catch { /* try the next candidate */ }
  }
  return FALLBACK;
}

export const APP_VERSION = read();
