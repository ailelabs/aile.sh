/**
 * NOTHING THE SERVER SENDS CAN DOWNLOAD OR INSTALL ANYTHING.
 *
 * `aile local` downloads models and engines and can run an installer — all
 * only from a command the user typed. The relay node (agent, supervisor,
 * framing) acts on frames the server sends, so it must not be able to reach
 * that code at all: not called, not imported, not imported by anything it
 * imports. This walks the static import graph from the node's modules and
 * fails if one of the downloading or installing modules is on it.
 *
 * The README promises this under "What the client refuses to do".
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(import.meta.dirname, "..", "src");
const IMPORT_RE = /^\s*(?:import|export)\b[^\n]*?\bfrom\s+["'](\.[^"']+)["']|\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)|^\s*import\s+["'](\.[^"']+)["']/gm;

function reachable(entry) {
  const seen = new Set();
  const stack = [path.join(SRC, entry)];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1] || m[2] || m[3];
      stack.push(path.resolve(path.dirname(file), spec));
    }
  }
  return [...seen].map((f) => path.relative(SRC, f).replace(/\\/g, "/"));
}

const FORBIDDEN = ["local/download.js", "local/hf.js", "local/install.js", "local/ollama.js", "local/engine.js", "cli/local-command.js"];

describe("the relay node cannot reach the downloader or the installer", () => {
  for (const entry of ["relay/agent.js", "relay/supervisor.js", "relay/framing.js", "relay/local.js"]) {
    test(entry, () => {
      const graph = reachable(entry);
      expect(graph.length).toBeGreaterThan(0);
      expect(graph.filter((f) => FORBIDDEN.includes(f))).toEqual([]);
    });
  }

  test("the walker does see these modules from the command that owns them", () => {
    const graph = reachable("cli/local-command.js");
    for (const f of ["local/download.js", "local/hf.js", "local/install.js"]) expect(graph).toContain(f);
  });
});
