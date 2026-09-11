/**
 * Test preload — runs before any test file imports anything.
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT LIVE INSIDE A TEST FILE:
 *
 * `src/relay/paths.js` computes AILE_DIR as a module-level const, and state.js /
 * identity.js / config.js derive their file paths from it at import time. Those
 * values are frozen the first time any module in the process imports paths.js.
 *
 * Bun shares one module registry across test files, so setting AILE_DATA_DIR
 * inside a test file only works if that file happens to load first — which
 * depends on alphabetical order and silently breaks when a file is added. When
 * it loses that race, the tests read and write the developer's REAL node data
 * dir: reading their node secret, and (via stopRelayAgent → clearState) deleting
 * the state.json of a linked, running node.
 *
 * Setting it here makes the isolation independent of file order.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aile-test-"));
process.env.AILE_DATA_DIR = TEST_DIR;

// Same spirit as the sandbox above: a test must not reach the network or fork a
// process. The update check (config/update-check.js) otherwise hits the npm
// registry and spawns a detached refresher on any CLI run with an empty data
// dir — a side effect the e2e specs (colors, first-run, branding, status)
// neither want nor assert on, and one that can race their scratch-dir cleanup on
// Windows. update-check.test.js deletes this to exercise the enabled path.
process.env.AILE_NO_UPDATE_CHECK = "1";

// Exported so a test can assert it is actually pointed at the sandbox.
export const TEST_AILE_DIR = TEST_DIR;

process.on("exit", () => {
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});
