#!/usr/bin/env bun
/**
 * Bundle the CLI into a single minified dist/cli.js.
 *
 * Only dist/ is published (see package.json "files"), so the readable source
 * stays in this private repo. Note what this does and does not buy you:
 * it keeps your source out of the tarball and raises the effort of casual
 * copying — it is NOT a security boundary. Anything shipped to a user's machine
 * can be read by that user. Every security property that matters must be
 * enforced by the aile.sh server against an untrusted client.
 */

import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const outdir = path.join(root, "dist");

fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: [path.join(root, "src/cli/index.js")],
  outdir,
  target: "node",
  format: "esm",
  minify: true,
  naming: "cli.js",
  // No banner: src/cli/index.js already carries the shebang and Bun preserves it.
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const outFile = path.join(outdir, "cli.js");
const bytes = fs.statSync(outFile).size;

// npm does not preserve the executable bit on Windows-built tarballs reliably,
// but the shebang plus the "bin" field is what actually matters for npx/global installs.
try { fs.chmodSync(outFile, 0o755); } catch { /* windows */ }

console.log(`Built dist/cli.js — ${(bytes / 1024).toFixed(1)} KB, minified`);
