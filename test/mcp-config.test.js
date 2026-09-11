/**
 * mcp-servers.json: what a lender may declare, and what is refused.
 *
 * Most of these assert a REFUSAL, and that is the point of the file. A config
 * key that is silently ignored is how a lender comes to believe their sandbox
 * has a mount, or that `$ANTHROPIC_API_KEY` was substituted, when neither is
 * true. Each `toThrow` below corresponds to a rule written in src/mcp/config.js.
 */

import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LIMITS,
  normalizeServer,
  parseMcpConfig,
  loadMcpServers,
  enabledMcpServers,
  findMcpServer,
} from "../src/mcp/config.js";

const MINIMAL = { id: "srv", image: "alpine:3" };

function tmpFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-mcp-"));
  const file = path.join(dir, "mcp-servers.json");
  fs.writeFileSync(file, contents);
  return file;
}

describe("normalizeServer", () => {
  it("fills every default from one id and one image", () => {
    const s = normalizeServer(MINIMAL);
    expect(s.id).toBe("srv");
    expect(s.name).toBe("srv");
    expect(s.enabled).toBe(true);
    expect(s.command).toEqual([]);
    expect(s.env).toEqual({});
    expect(s.egress).toEqual([]);
    expect(s.tools).toEqual([]);
    expect(s.cpus).toBe(LIMITS.cpus.default);
    expect(s.memoryMb).toBe(LIMITS.memoryMb.default);
    expect(s.pids).toBe(LIMITS.pids.default);
    expect(s.timeoutMs).toBe(LIMITS.timeoutMs.default);
  });

  it("refuses an id that would not survive a container name", () => {
    for (const id of ["../etc", "Server", "a b", "srv;rm -rf /", "", "-lead"]) {
      expect(() => normalizeServer({ ...MINIMAL, id })).toThrow(/id must match/);
    }
  });

  // Rule 1. Refused, not ignored — a stale key must never become a disclosure
  // the day a later version starts honouring it.
  it("refuses every key that would name a host path", () => {
    for (const key of ["mounts", "volumes", "binds", "mount", "volume", "bind", "workdir", "user"]) {
      expect(() => normalizeServer({ ...MINIMAL, [key]: ["/home/hugo:/work"] }))
        .toThrow(/is not supported and is refused rather than ignored/);
    }
  });

  // Rule 2. There is no syntax that reads the host environment, and a value
  // that expects one is refused so the lender learns it rather than shipping
  // a literal "$VAR" into a rented container.
  it("refuses an env value that expects host substitution", () => {
    expect(() => normalizeServer({ ...MINIMAL, env: { K: "${ANTHROPIC_API_KEY}" } }))
      .toThrow(/values here are literal/);
    expect(() => normalizeServer({ ...MINIMAL, env: { K: "$HOME/x" } }))
      .toThrow(/values here are literal/);
  });

  // The check cannot distinguish a reference from a literal, so it refuses the
  // ambiguous shape rather than guessing. A false positive is a loud message the
  // lender can act on; a false negative is a broken credential in a rented
  // container, discovered by a paying renter.
  it("refuses an ambiguous literal too, rather than guessing", () => {
    expect(() => normalizeServer({ ...MINIMAL, env: { K: "pa$$word" } }))
      .toThrow(/genuinely contains a "\$" followed by a letter is refused/);
  });

  it("keeps a value whose dollar sign cannot be a reference", () => {
    expect(normalizeServer({ ...MINIMAL, env: { K: "cost: 5$" } }).env.K).toBe("cost: 5$");
    expect(normalizeServer({ ...MINIMAL, env: { K: "sk-ant-api03-xY9" } }).env.K).toBe("sk-ant-api03-xY9");
  });

  it("refuses an env name that is not a variable name", () => {
    expect(() => normalizeServer({ ...MINIMAL, env: { "A-B": "x" } })).toThrow(/valid variable name/);
    expect(() => normalizeServer({ ...MINIMAL, env: { K: 5 } })).toThrow(/must be a string/);
  });

  // Rule 3. Closed by default, and the opt-in is a bare hostname: a URL here
  // would read as though the path were enforced, and nothing enforces a path.
  it("defaults to no network and accepts only bare hostnames", () => {
    expect(normalizeServer(MINIMAL).egress).toEqual([]);
    expect(normalizeServer({ ...MINIMAL, network: "none" }).egress).toEqual([]);
    expect(normalizeServer({ ...MINIMAL, network: ["api.anthropic.com"] }).egress)
      .toEqual(["api.anthropic.com"]);
    for (const host of ["https://api.anthropic.com", "api.anthropic.com:443", "localhost", "a.com/p", ""]) {
      expect(() => normalizeServer({ ...MINIMAL, network: [host] })).toThrow(/bare hostname/);
    }
    expect(() => normalizeServer({ ...MINIMAL, network: [] })).toThrow(/non-empty array/);
  });

  it("bounds cpu, memory, pids and the wall clock", () => {
    expect(() => normalizeServer({ ...MINIMAL, cpus: 64 })).toThrow(/between 0.1 and 8/);
    expect(() => normalizeServer({ ...MINIMAL, memoryMb: 8 })).toThrow(/between 128 and 8192/);
    expect(() => normalizeServer({ ...MINIMAL, pids: 100000 })).toThrow(/between 16 and 2048/);
    expect(() => normalizeServer({ ...MINIMAL, timeoutMs: 1 })).toThrow(/between 5000 and 600000/);
    expect(() => normalizeServer({ ...MINIMAL, cpus: "lots" })).toThrow(/must be a number/);
  });

  it("requires an image and a string command array", () => {
    expect(() => normalizeServer({ id: "srv" })).toThrow(/image is required/);
    expect(() => normalizeServer({ ...MINIMAL, command: "claude mcp serve" })).toThrow(/array of strings/);
  });

  it("names the offending server in every message", () => {
    expect(() => normalizeServer({ ...MINIMAL, id: "claude-code", cpus: 99 }))
      .toThrow(/mcp server "claude-code"/);
  });
});

describe("parseMcpConfig", () => {
  it("accepts both an object and a bare array", () => {
    expect(parseMcpConfig({ servers: [MINIMAL] })).toHaveLength(1);
    expect(parseMcpConfig([MINIMAL])).toHaveLength(1);
    expect(parseMcpConfig({})).toEqual([]);
    expect(parseMcpConfig(null)).toEqual([]);
  });

  it("refuses a duplicate id", () => {
    expect(() => parseMcpConfig({ servers: [MINIMAL, MINIMAL] })).toThrow(/duplicate server id/);
  });
});

describe("loadMcpServers", () => {
  // The asymmetry is deliberate: never declaring MCP servers is the normal
  // state of a node; a file that exists and does not parse is a lender being
  // silently unlisted, which is the worst of the three outcomes.
  it("treats a missing file as empty and a malformed one as an error", () => {
    expect(loadMcpServers({ file: path.join(os.tmpdir(), "definitely-absent-aile.json") })).toEqual([]);
    expect(() => loadMcpServers({ file: tmpFile("{ nope") })).toThrow(/not valid JSON/);
  });

  it("filters disabled servers out of what would be advertised", () => {
    const file = tmpFile(JSON.stringify({
      servers: [MINIMAL, { id: "off", image: "alpine:3", enabled: false }],
    }));
    expect(loadMcpServers({ file })).toHaveLength(2);
    expect(enabledMcpServers({ file }).map((s) => s.id)).toEqual(["srv"]);
    expect(findMcpServer("srv", { file })?.id).toBe("srv");
    expect(findMcpServer("off", { file })).toBeNull();
    expect(findMcpServer("../srv", { file })).toBeNull();
    expect(findMcpServer(null, { file })).toBeNull();
  });
});
