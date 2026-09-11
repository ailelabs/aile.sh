/**
 * Branding guard.
 *
 * The app is presented as a single product. Nothing that ships may name the
 * upstream project the provider catalog was originally derived from — not in the
 * bundle a user installs, not in a help string, not in a code comment they could
 * read after unminifying.
 *
 * This test exists because debranding is exactly the kind of thing that decays:
 * one copied comment or one error message reintroduces the name, and nobody
 * notices until a user reads it.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const FORBIDDEN = /9router/i;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe("branding", () => {
  test("no shipped source names the upstream project", () => {
    const offenders = [];
    for (const dir of ["src", "scripts", "test"]) {
      const abs = path.join(ROOT, dir);
      if (!fs.existsSync(abs)) continue;
      for (const file of walk(abs)) {
        if (!/\.(js|json|md)$/.test(file)) continue;
        // This file has to spell the name to search for it. Skipping it is the
        // one exemption, and it is scoped to exactly this path so a second file
        // cannot quietly inherit it.
        if (file === import.meta.path) continue;
        const text = fs.readFileSync(file, "utf8");
        if (FORBIDDEN.test(text)) offenders.push(path.relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  test("user-facing docs are clean", () => {
    for (const doc of ["README.md", "CHANGELOG.md", "SECURITY.md", "docs/PROTOCOL.md"]) {
      const abs = path.join(ROOT, doc);
      if (!fs.existsSync(abs)) continue;
      expect({ doc, clean: !FORBIDDEN.test(fs.readFileSync(abs, "utf8")) })
        .toEqual({ doc, clean: true });
    }
  });

  test("no setting name or description leaks the upstream project", () => {
    // Settings are the most user-visible text in the app after the help output,
    // and the descriptions are prose — the easiest place for a name to reappear.
    const text = fs.readFileSync(path.join(ROOT, "src/config/settings.js"), "utf8");
    expect(FORBIDDEN.test(text)).toBe(false);
  });

  test("the built bundle is clean", () => {
    const dist = path.join(ROOT, "dist/cli.js");
    if (!fs.existsSync(dist)) return; // not built in this run
    expect(FORBIDDEN.test(fs.readFileSync(dist, "utf8"))).toBe(false);
  });

  test("the package metadata is clean, including the installed command name", () => {
    // What `npm install -g` writes into the user's PATH, and what `npm info`
    // prints, are both read far more often than any source file.
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(FORBIDDEN.test(JSON.stringify(pkg))).toBe(false);
    expect(Object.keys(pkg.bin)).toEqual(["aile"]);
  });

  test("no source imports a module from outside this package", () => {
    // A stray import of an upstream module would reintroduce the coupling that
    // the vendored catalog exists to remove.
    //
    // Anchored to an `import`/`export` statement, and the specifier may not
    // span lines. A bare /from ["']…["']/ reads prose as code: the words
    // `from "the user` at the end of one comment line pair up with a quote on
    // the next and report a stray import that does not exist. Every import in
    // src/ keeps its specifier on the line the keyword is on, so nothing real
    // is missed by refusing to match across a newline.
    // All three import forms, because a dependency sneaks in through whichever
    // one is not being watched — and `await import("ws")` is exactly the shape
    // the WebSocket fallback would have taken.
    const FORMS = [
      /^\s*(?:import|export)\b[^\n]*?\bfrom\s+["']([^"'\n]+)["']/gm,  // import x from "y"
      /^\s*import\s+["']([^"'\n]+)["']/gm,                            // import "y"
      /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,                     // await import("y")
    ];

    for (const file of walk(path.join(ROOT, "src"))) {
      if (!file.endsWith(".js")) continue;
      const text = fs.readFileSync(file, "utf8");
      for (const form of FORMS) {
        for (const m of text.matchAll(form)) {
          const spec = m[1];
          const external = !spec.startsWith(".") && !spec.startsWith("node:");
          expect({ file: path.relative(ROOT, file), spec, external })
            .toEqual({ file: path.relative(ROOT, file), spec, external: false });
        }
      }
    }
  });
});
