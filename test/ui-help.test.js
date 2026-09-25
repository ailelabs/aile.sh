/**
 * The shared presentation module (src/cli/ui.js) and the help (src/cli/help.js),
 * plus the three dispatcher rules they exist for:
 *
 *  - HELP RUNS NOTHING. `aile lenders --help` must not reach the network, and
 *    `aile start -h` must not start a node — help is read before an account
 *    exists and before anything is trusted.
 *  - A TYPO GETS A SUGGESTION, and exit 1, not a wall of text.
 *  - BARE `aile` ON A MACHINE THAT USES AILE ONLY TO BUY shows the overview, not
 *    the first-run welcome it has already been through.
 */

import { describe, expect, it, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  unicodeOk, width, padTo, truncate, table, hintText, next, sym,
} from "../src/cli/ui.js";
import { COMMANDS, findCommand, commandNames, suggest, overview, commandHelp, unknownCommand } from "../src/cli/help.js";

const CLI = path.join(import.meta.dirname, "..", "src", "cli", "index.js");
const scratches = [];
const plain = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

function scratch(config = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-uihelp-"));
  scratches.push(dir);
  if (config) fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  return dir;
}

async function run(args, { data, timeoutMs = 15_000, env = {} } = {}) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, AILE_DATA_DIR: data, NO_COLOR: "1", AILE_NO_UPDATE_CHECK: "1", ...env },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  clearTimeout(timer);
  return { code, stdout: plain(stdout), stderr: plain(stderr), all: plain(stdout + stderr) };
}

/** A server that answers everything 200 and counts what reached it. */
function countingServer() {
  const hits = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      hits.push(new URL(req.url).pathname);
      return Response.json({ lenders: [], models: [], data: [] });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, hits, stop: () => server.stop(true) };
}

afterAll(() => {
  for (const dir of scratches) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ui.js
// ---------------------------------------------------------------------------

describe("unicodeOk — draw ✓ and ❯ only where the terminal can", () => {
  it("is on everywhere but Windows, except the Linux console", () => {
    expect(unicodeOk({}, "darwin")).toBe(true);
    expect(unicodeOk({ TERM: "xterm-256color" }, "linux")).toBe(true);
    expect(unicodeOk({ TERM: "linux" }, "linux")).toBe(false);
  });

  it("on Windows, only where a host that can draw it says so", () => {
    expect(unicodeOk({}, "win32")).toBe(false);
    expect(unicodeOk({ WT_SESSION: "x" }, "win32")).toBe(true);
    expect(unicodeOk({ TERM_PROGRAM: "vscode" }, "win32")).toBe(true);
  });

  it("AILE_ASCII=1 wins everywhere", () => {
    expect(unicodeOk({ AILE_ASCII: "1" }, "darwin")).toBe(false);
    expect(unicodeOk({ AILE_ASCII: "1", WT_SESSION: "x" }, "win32")).toBe(false);
  });

  it("has a mark for everything a command prints", () => {
    for (const k of ["ok", "fail", "warn", "arrow", "bullet", "dot", "live", "up", "down"]) {
      expect({ k, set: typeof sym[k] === "string" && sym[k].length > 0 }).toEqual({ k, set: true });
    }
    expect(sym.frames.length).toBeGreaterThan(1);
  });
});

describe("text helpers", () => {
  it("measures what is visible, not the escape codes", () => {
    expect(width("\x1b[32mabc\x1b[0m")).toBe(3);
    expect(width(padTo("\x1b[1mab\x1b[0m", 5))).toBe(5);
  });

  it("truncates to the width asked, with a mark that it did", () => {
    const t = truncate("abcdefgh", 5);
    expect(width(t)).toBe(5);
    expect(t.startsWith("abcd")).toBe(true);
    expect(truncate("abc", 5)).toBe("abc");
  });

  it("shows a command in backticks as a command, without the backticks", () => {
    expect(plain(hintText("Run `aile login` to sign in."))).toBe("Run aile login to sign in.");
  });

  it("prints no Next block when there is nothing to do next", () => {
    expect(next([])).toBe("");
    expect(next([null, false])).toBe("");
    const out = plain(next([["aile setup", "use aile from your tools"], null]));
    expect(out).toContain("Next");
    expect(out).toContain("aile setup");
    expect(out).toContain("use aile from your tools");
  });
});

describe("table — fits the terminal instead of wrapping", () => {
  const cols = [{ key: "name", label: "NAME" }, { key: "where", label: "WHERE", shrink: true }, { key: "n", label: "N", align: "right" }];
  const rows = [
    { name: "claude", where: "/a/very/long/path/that/would/wrap/on/a/narrow/terminal/claude", n: 3 },
    { name: "codex", where: "/short", n: 12 },
  ];

  it("keeps every line inside the width it was given", () => {
    const out = table(cols, rows, { columns: 40 });
    for (const line of out.split("\n")) expect(width(line)).toBeLessThanOrEqual(40);
  });

  it("cuts the column marked shrink, and leaves the others whole", () => {
    const out = plain(table(cols, rows, { columns: 40 }));
    expect(out).toContain("claude");
    expect(out).toContain("codex");
    expect(out).not.toContain("terminal/claude");
  });

  it("right-aligns a numeric column", () => {
    const lines = plain(table(cols, rows, { columns: 200 })).split("\n");
    expect(lines[1].endsWith(" 3")).toBe(true);
    expect(lines[2].endsWith("12")).toBe(true);
  });

  it("changes nothing when it already fits", () => {
    const out = plain(table(cols, rows, { columns: 200 }));
    expect(out).toContain("terminal/claude");
  });
});

// ---------------------------------------------------------------------------
// help.js
// ---------------------------------------------------------------------------

describe("the command table", () => {
  it("gives every command a summary and a known group", () => {
    for (const c of COMMANDS) {
      expect({ c: c.name, ok: Boolean(c.summary) && ["tools", "buy", "lend", "account"].includes(c.group) })
        .toEqual({ c: c.name, ok: true });
    }
  });

  it("finds a command by an alias", () => {
    expect(findCommand("market").name).toBe("lenders");
    expect(findCommand("quote").name).toBe("price");
    expect(findCommand("payout").name).toBe("wallet");
    expect(findCommand("nope")).toBeFalsy();
  });

  it("documents only commands the dispatcher actually runs", () => {
    // A help entry for a command that exits "Unknown command" is worse than
    // none. run, env and help dispatch before the switch.
    const src = fs.readFileSync(CLI, "utf8");
    const early = new Set(["run", "env", "help"]);
    for (const name of commandNames()) {
      if (early.has(name)) continue;
      expect({ name, dispatched: src.includes(`case "${name}":`) }).toEqual({ name, dispatched: true });
    }
  });
});

describe("did you mean", () => {
  const names = commandNames();

  it("suggests the command a typo was reaching for", () => {
    expect(suggest("stup", names)).toContain("setup");
    expect(suggest("lendrs", names)).toContain("lenders");
    expect(suggest("statu", names)).toContain("status");
  });

  it("suggests nothing for something that is not close to anything", () => {
    expect(suggest("xyzzyplugh", names)).toEqual([]);
    expect(suggest("", names)).toEqual([]);
  });

  it("names the suggestion and where the full list is", () => {
    const out = plain(unknownCommand("stup"));
    expect(out).toContain('Unknown command "stup"');
    expect(out).toContain("aile setup");
    expect(out).toContain("aile help");
  });
});

describe("overview and per-command help", () => {
  it("keeps the overview short enough to read", () => {
    const lines = plain(overview()).split("\n");
    expect(lines.length).toBeLessThan(60);
    for (const c of ["aile setup", "aile lenders", "aile login", "aile connect", "aile start"]) {
      expect(lines.join("\n")).toContain(c);
    }
  });

  it("puts a command's detail in its own help", () => {
    const out = plain(commandHelp(findCommand("lenders")));
    expect(out).toContain("aile lenders");
    expect(out).toContain("Filters combine");
  });
});

// ---------------------------------------------------------------------------
// The dispatcher, through the real CLI
// ---------------------------------------------------------------------------

describe("help runs nothing", () => {
  it("`aile lenders --help` never reaches the server", async () => {
    const srv = countingServer();
    try {
      const data = scratch({ serverUrl: srv.url, renterToken: `ail_${"a".repeat(48)}`, allowInsecure: true });
      const res = await run(["lenders", "--help"], { data });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("aile lenders");
      expect(srv.hits).toEqual([]);
    } finally { srv.stop(); }
  });

  it("`aile start -h` prints help and does not start a node", async () => {
    const res = await run(["start", "-h"], { data: scratch({ renterToken: `ail_${"a".repeat(48)}` }) });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("aile start");
    expect(res.all).not.toMatch(/Connecting to/);
  });

  it("`aile help <command>` and `aile <command> --help` say the same thing", async () => {
    const data = scratch();
    const a = await run(["help", "price"], { data });
    const b = await run(["price", "--help"], { data });
    expect(a.code).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });

  it("`aile help <nonsense>` is an error, with a suggestion when there is one", async () => {
    const res = await run(["help", "lendrs"], { data: scratch() });
    expect(res.code).toBe(1);
    expect(res.all).toContain("aile lenders");
  });
});

describe("a typo", () => {
  it("exits 1 with a suggestion instead of the whole help", async () => {
    const res = await run(["stup"], { data: scratch() });
    expect(res.code).toBe(1);
    expect(res.all).toContain("Did you mean");
    expect(res.all).toContain("aile setup");
    expect(res.all.split("\n").length).toBeLessThan(10);
  });
});

describe("bare `aile` on a machine that only buys", () => {
  const KEY = `sk-aile-${"1a".repeat(24)}`;

  it("shows the overview, not the first-run welcome", async () => {
    const res = await run([], { data: scratch({ serverUrl: "https://aile.test", buyerKey: KEY }) });
    expect(res.code).toBe(0);
    expect(res.all).not.toMatch(/How would you like to get started/);
    expect(res.all).not.toMatch(/spare capacity/i);
    expect(res.stdout).toMatch(/Tools\s+not set up/);
    expect(res.stdout).toContain("aile setup");
  });

  it("`aile status --json` is one parseable object with the key masked", async () => {
    const res = await run(["status", "--json"], { data: scratch({ serverUrl: "https://aile.test", buyerKey: KEY }) });
    expect(res.code).toBe(0);
    const j = JSON.parse(res.stdout);
    expect(j.signedIn).toBe(false);
    expect(j.server).toBe("https://aile.test");
    expect(typeof j.machine?.id).toBe("string");
    expect(Array.isArray(j.tools)).toBe(true);
    expect(res.stdout).not.toContain(KEY);
  });

  it("does not count the saved key as a changed setting", async () => {
    const res = await run(["status"], { data: scratch({ serverUrl: "https://aile.test", buyerKey: KEY }) });
    const settings = res.stdout.split("\n").find((l) => l.includes("Settings:")) || "";
    expect(settings).not.toContain("buyerKey");
  });
});

// ---------------------------------------------------------------------------
// The glance on a signed-in machine: the balance, and no `aile start` where a
// node would serve nothing.
// ---------------------------------------------------------------------------

/** A relay answering `/me` and `/wallet?balance=1`, enveloped as the real one is. */
function accountServer({ accounts, wallet = null, walletStatus = 200 }) {
  const me = {
    renter: { id: "rnt_1", email: "lender@example.com", donor: false },
    accounts,
    nodes: [{ node_id: "some-other-box", requests: 1216 }],
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/me") return Response.json({ success: true, data: me, message: "" });
      if (url.pathname === "/wallet" && wallet) {
        return walletStatus === 200
          ? Response.json({ success: true, data: { wallet }, message: "" })
          : Response.json({ success: false, message: "down" }, { status: walletStatus });
      }
      return Response.json({ success: false, message: "not found" }, { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

const NODELESS = (n) => ({ id: `a${n}`, provider: "openrouter", label: `Key #${n}`, serving: { via: "nodeless", nodeId: null, online: false, nodeless: true } });
const IDLE = { id: "a9", provider: "claude", label: "Claude #1", serving: { via: "none", nodeId: null, online: false, nodeless: false } };
const lenderData = (url) => scratch({ serverUrl: url, allowInsecure: true, renterToken: `ail_${"a".repeat(48)}` });

describe("bare `aile` on a signed-in machine", () => {
  it("leads with the balance", async () => {
    const srv = accountServer({ accounts: [NODELESS(1)], wallet: { address: "W", usdc: "12.34", spendable: "12.34", owedMicros: 0 } });
    try {
      const res = await run([], { data: lenderData(srv.url) });
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/Balance\s+\$12\.34/);
      expect(res.stdout).toContain("lender@example.com");
    } finally { srv.stop(); }
  });

  it("names what is spendable only when something is owed", async () => {
    const srv = accountServer({ accounts: [NODELESS(1)], wallet: { address: "W", usdc: "12.34", spendable: "12.10", owedMicros: 240_000 } });
    try {
      const res = await run([], { data: lenderData(srv.url) });
      expect(res.stdout).toMatch(/\$12\.34 . \$12\.10 spendable/);
    } finally { srv.stop(); }
  });

  it("says the balance could not be read, never $0.00, when the read fails", async () => {
    const srv = accountServer({ accounts: [NODELESS(1)], wallet: { address: "W" }, walletStatus: 503 });
    try {
      const res = await run([], { data: lenderData(srv.url) });
      expect(res.stdout).toMatch(/Balance\s+could not be read/);
      expect(res.stdout).not.toContain("$0.00");
    } finally { srv.stop(); }
  });

  it("does not send somebody whose every account is nodeless to `aile start`", async () => {
    const srv = accountServer({ accounts: [NODELESS(1), NODELESS(2)] });
    try {
      const glance = await run([], { data: lenderData(srv.url) });
      expect(glance.stdout).toMatch(/Lending\s+2 accounts \(nodeless\)/);
      expect(glance.stdout).not.toContain("aile start");
      // Served is counted per machine, and a nodeless serve passes through none:
      // "0 served" beside real earnings would be wrong, so it is left out.
      expect(glance.stdout).not.toMatch(/served/);
      const status = await run(["status"], { data: lenderData(srv.url) });
      expect(status.stdout).toMatch(/Relay:\s+not running . not needed, your accounts are nodeless/);
      expect(status.stdout).not.toMatch(/^\s+aile start/m);
    } finally { srv.stop(); }
  });

  it("does suggest `aile start` for an account only a node can serve", async () => {
    const srv = accountServer({ accounts: [NODELESS(1), IDLE] });
    try {
      const res = await run([], { data: lenderData(srv.url) });
      expect(res.stdout).toMatch(/Lending\s+2 accounts \(1 nodeless\) . 1,216 served/);
      expect(res.stdout).toMatch(/aile start\s+serve your idle account from this machine/);
    } finally { srv.stop(); }
  });

  it("keeps the glance short: the detail is `aile status`", async () => {
    const srv = accountServer({ accounts: [NODELESS(1), IDLE], wallet: { address: "W", usdc: "1.00", owedMicros: 0 } });
    try {
      const res = await run([], { data: lenderData(srv.url) });
      const lines = res.stdout.split("\n").filter((l) => l.trim());
      expect(lines.length).toBeLessThanOrEqual(9);
      expect(res.stdout).not.toContain("Machine:");
      expect(res.stdout).not.toContain("config.json");
    } finally { srv.stop(); }
  });
});
