/**
 * `aile stats` — which of this account's machines is actually carrying traffic.
 *
 * ============================================================================
 * WHAT BEING WRONG HERE COSTS, IN ORDER.
 *
 *  1. A LEDGER TIMESTAMP PRINTED AS TEN DIGITS. `usage_events.at` is a
 *     millisecond epoch; every other timestamp on the server is ISO. This
 *     command does `String(x).slice(0, 10)` under LAST SERVED, so an epoch
 *     leaking through renders "1753027200" as a date. That bug was real, it
 *     shipped, and it was found by running the CLI against a live instance
 *     rather than by any assertion — the server side now pins it
 *     (`dashboard-routes.test.js`), and this is the client half of the same
 *     pin. It cannot be caught by a fixture that was written in ISO because
 *     the author already knew the answer, so the shape is asserted, not the value.
 *  2. A DONOR BEING SHOWN EARNINGS. Nothing accrues to a machine that chose not
 *     to be paid. A "$0.00" in the EARNED column is a number, and a number reads
 *     as a fact about money rather than as "this does not apply to you". The
 *     server sends `earnedMicros: null` for a donor and the column must render
 *     that as absence, on both the table and the `--json`.
 *  3. AN IDLE MACHINE LOOKING LIKE A WORKING ONE. This is the entire question
 *     somebody types the command to settle: a lender with three boxes wants to
 *     know WHICH to look at. A zero in a column is easy to skim past, so it is
 *     also said in prose.
 *  4. A FORMATTED AMOUNT WHERE A SCRIPT EXPECTS AN INTEGER. `--json` carries
 *     `earnedMicros`, not "$1.23" — parsing a display string back into a float
 *     is how rounding bugs start, and this is the output a script reads.
 *  5. AN ACCOUNT SEEING SOMEBODY ELSE'S MACHINES. Scoping is the server's job
 *     and is tested there; what is testable here is that this command asks for
 *     nothing but `/me` and invents no rows the server did not send.
 *
 * Run through the real CLI, like the other command tests: `src/cli/index.js`
 * dispatches at import time, so nothing here can be reached by importing it.
 * ============================================================================
 */

import { describe, expect, it, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dirname, "..", "src", "cli", "index.js");
const scratches = [];

/**
 * Three machines: one busy, one quiet, one that has never served anything.
 *
 * `lastServedAt` is ISO, as the server sends it, and `created_at`/`last_seen_at`
 * sit beside it in the same format — the agreement between them is what test 1
 * is really about.
 */
const ME = {
  renter: { id: "rnt_1", email: "lender@example.com", createdAt: "2026-06-01T00:00:00.000Z", donor: false },
  nodes: [
    {
      node_id: "aaaa1111bbbb2222",
      label: "box-one",
      created_at: "2026-06-01T00:00:00.000Z",
      last_seen_at: "2026-07-20T09:00:00.000Z",
      requests: 1204,
      earnedMicros: 3_250_000,
      lastServedAt: "2026-07-20T11:22:33.000Z",
    },
    {
      node_id: "cccc3333dddd4444",
      label: "box-two",
      created_at: "2026-06-02T00:00:00.000Z",
      last_seen_at: "2026-07-19T09:00:00.000Z",
      requests: 12,
      earnedMicros: 40_000,
      lastServedAt: "2026-06-30T01:02:03.000Z",
    },
    {
      node_id: "eeee5555ffff6666",
      label: "box-idle",
      created_at: "2026-07-10T00:00:00.000Z",
      last_seen_at: "2026-07-20T09:00:00.000Z",
      requests: 0,
      earnedMicros: 0,
      lastServedAt: null,
    },
  ],
  accounts: [],
  custodyReady: true,
  wallet: { address: "94AtcatFepB2fueGy4BsGb6MoWL6ek5y5R1X97mSrh2V" },
};

/** The same account, contributing. Every earnings figure comes back null. */
const DONOR_ME = {
  renter: { id: "rnt_d", email: null, createdAt: "2026-06-01T00:00:00.000Z", donor: true },
  nodes: ME.nodes.map((n) => ({ ...n, earnedMicros: null })),
  accounts: [],
  custodyReady: true,
  wallet: null,
  contributing: true,
};

const NO_MACHINES = { ...ME, nodes: [] };

function stubServer({ me = ME, status = 200 } = {}) {
  const calls = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      calls.push(`${req.method} ${url.pathname}${url.search}`);
      if (url.pathname === "/me" && req.method === "GET") {
        const enveloped = status >= 200 && status < 300
          ? { success: true, data: me, message: "" }
          : { success: false, message: me.reason ?? me.error ?? "", error: me.error };
        return Response.json(enveloped, { status });
      }
      return Response.json({ success: false, message: "not found", error: "not found" }, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    stop: () => { try { server.stop(true); } catch { /* ignore */ } },
  };
}

function signedInData(serverUrl, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-stats-cli-"));
  scratches.push(dir);
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ serverUrl, renterToken: `ail_${"a".repeat(48)}`, ...extra }),
  );
  return dir;
}

async function run(args, { data, timeoutMs = 15_000 } = {}) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, AILE_DATA_DIR: data, NO_COLOR: "1" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });

  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  const strip = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  return { code, stdout: strip(stdout), stderr: strip(stderr), all: strip(stdout + stderr) };
}

afterAll(() => {
  for (const d of scratches) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

// ---------------------------------------------------------------------------

describe("the breakdown, which is the whole reason this exists beside aile status", () => {
  it("reads /me and asks for nothing else", async () => {
    // A second endpoint for per-machine figures would have to be kept in step
    // with the one that lists the machines. It is a projection on `/me` instead,
    // and this is what says so.
    const srv = stubServer();
    try {
      const res = await run(["stats"], { data: signedInData(srv.url) });
      expect(res.code).toBe(0);
      expect([...new Set(srv.calls.map((c) => c.split("?")[0]))]).toEqual(["GET /me"]);
    } finally { srv.stop(); }
  });

  it("prints one row per machine, with its requests and its earnings", async () => {
    const srv = stubServer();
    try {
      const res = await run(["stats"], { data: signedInData(srv.url) });
      expect(res.stdout).toContain("aaaa1111bbbb2222");
      expect(res.stdout).toContain("cccc3333dddd4444");
      expect(res.stdout).toContain("eeee5555ffff6666");
      // Thousands separated: 1204 requests is the number a lender reads at a
      // glance, and "1204" beside "12" is easy to misread by an order of magnitude.
      expect(res.stdout).toContain("1,204");
      expect(res.stdout).toContain("$3.25");
      expect(res.stdout).toMatch(/MACHINE\s+REQUESTS\s+EARNED\s+LAST SERVED/);
    } finally { srv.stop(); }
  });

  /**
   * THE ONE THAT ALREADY WENT WRONG IN PRODUCTION.
   *
   * The column is `String(lastServedAt).slice(0, 10)`. Given ISO that is a day;
   * given the ledger's millisecond epoch it is ten digits printed where a date
   * belongs. The server pins the format on its side; this pins that the client
   * still renders it as a date and — the part a correct fixture cannot prove by
   * itself — that nothing here would quietly accept a number.
   */
  it("RENDERS LAST SERVED AS A DAY, and would not pass an epoch off as one", async () => {
    const srv = stubServer();
    try {
      const res = await run(["stats"], { data: signedInData(srv.url) });
      expect(res.stdout).toContain("2026-07-20");
      expect(res.stdout).toContain("2026-06-30");
      // Ten consecutive digits under a date column is the exact shape of the bug.
      expect(res.stdout).not.toMatch(/\b\d{10}\b/);
    } finally { srv.stop(); }
  });

  it("says 'never' for a machine that has served nothing, rather than a blank", async () => {
    // A blank cell reads as missing data — "we do not know" — when the truth is
    // known and is the most useful fact in the table.
    const srv = stubServer();
    try {
      const res = await run(["stats"], { data: signedInData(srv.url) });
      expect(res.stdout).toMatch(/never/);
      expect(res.stdout).not.toContain("undefined");
      expect(res.stdout).not.toContain("null");
    } finally { srv.stop(); }
  });

  it("TOTALS IT, and names the idle machine out loud instead of leaving a zero to be spotted", async () => {
    const srv = stubServer();
    try {
      const res = await run(["stats"], { data: signedInData(srv.url) });
      expect(res.stdout).toMatch(/1,216 requests served across 3 machines/);
      expect(res.stdout).toMatch(/\$3\.29/);       // 3_250_000 + 40_000 + 0
      expect(res.stdout).toMatch(/1 machine has served nothing/);
      // And it points at the command that diagnoses that machine, because
      // "which box" and "why" are two questions and this answers only the first.
      expect(res.stdout).toMatch(/aile status/);
    } finally { srv.stop(); }
  });

  it("says nothing about idle machines when every one of them is working", async () => {
    const srv = stubServer({
      me: { ...ME, nodes: ME.nodes.filter((n) => n.requests > 0) },
    });
    try {
      const res = await run(["stats"], { data: signedInData(srv.url) });
      expect(res.stdout).toMatch(/1,216 requests served across 2 machines/);
      expect(res.stdout).not.toMatch(/served nothing/);
    } finally { srv.stop(); }
  });
});

describe("a machine this account has, but that is not this one", () => {
  it("marks the machine the command was typed on", async () => {
    // The node id is derived from state in the data directory, so the only way
    // to know it is to ask the same module the CLI asks. Importing it with
    // AILE_DATA_DIR pointed at the scratch dir creates the identity the
    // subprocess will then derive for itself.
    const dir = signedInData("http://127.0.0.1:1");
    process.env.AILE_DATA_DIR = dir;
    const mod = await import(`../src/relay/identity.js?stats=${encodeURIComponent(dir)}`);
    const here = mod.getNodeId();
    delete process.env.AILE_DATA_DIR;

    const srv = stubServer({
      me: { ...ME, nodes: [{ ...ME.nodes[0], node_id: here }, ME.nodes[1]] },
    });
    try {
      // The config has to point at the live stub, so it is rewritten in place —
      // same directory, so the node identity derived above still holds.
      fs.writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({ serverUrl: srv.url, renterToken: `ail_${"a".repeat(48)}` }),
      );
      const res = await run(["stats"], { data: dir });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("(this one)");
      // Exactly one row is marked. Marking every row, or none, is the same bug
      // wearing two faces.
      expect(res.stdout.match(/\(this one\)/g)).toHaveLength(1);
    } finally { srv.stop(); }
  });

  it("marks nothing when none of the machines is this one", async () => {
    const srv = stubServer();
    try {
      const res = await run(["stats"], { data: signedInData(srv.url) });
      expect(res.stdout).not.toContain("(this one)");
    } finally { srv.stop(); }
  });
});

describe("a donor, to whom nothing accrues", () => {
  it("SHOWS NO EARNINGS FIGURE AT ALL, not a zero", async () => {
    // "$0.00" is a claim about money. The truth is that the question does not
    // apply — they chose not to be paid — and a dash says that where a number
    // cannot.
    const srv = stubServer({ me: DONOR_ME });
    try {
      const res = await run(["stats"], { data: signedInData(srv.url) });
      expect(res.code).toBe(0);
      expect(res.stdout).not.toContain("$0.00");
      expect(res.stdout).toMatch(/contributing/i);
      expect(res.stdout).toMatch(/nothing accrues/i);
    } finally { srv.stop(); }
  });

  it("still counts their requests, which is the part that is theirs", async () => {
    // A donated machine serves real traffic and its operator is entitled to see
    // how much. Suppressing the count along with the earnings would make the
    // command useless to exactly the people running it for free.
    const srv = stubServer({ me: DONOR_ME });
    try {
      const res = await run(["stats"], { data: signedInData(srv.url) });
      expect(res.stdout).toContain("1,204");
      expect(res.stdout).toMatch(/1,216 requests served across 3 machines/);
    } finally { srv.stop(); }
  });

  it("carries the null through --json rather than turning it into 0", async () => {
    const srv = stubServer({ me: DONOR_ME });
    try {
      const res = await run(["stats", "--json"], { data: signedInData(srv.url) });
      const out = JSON.parse(res.stdout);
      expect(out.machines.every((m) => m.earnedMicros === null)).toBeTrue();
      expect(out.totals.earnedMicros).toBeNull();
      // The counts are real and stay numbers.
      expect(out.totals.requests).toBe(1216);
    } finally { srv.stop(); }
  });
});

describe("--json", () => {
  it("carries amounts as integer micros, not as formatted strings", async () => {
    // The rule the whole client follows: a script comparing earnings must never
    // have to parse "$3.25" back into a float.
    const srv = stubServer();
    try {
      const res = await run(["stats", "--json"], { data: signedInData(srv.url) });
      const out = JSON.parse(res.stdout);
      expect(out.machines).toHaveLength(3);
      expect(out.machines[0]).toMatchObject({
        nodeId: "aaaa1111bbbb2222",
        requests: 1204,
        earnedMicros: 3_250_000,
        lastServedAt: "2026-07-20T11:22:33.000Z",
      });
      expect(out.totals).toEqual({ requests: 1216, earnedMicros: 3_290_000 });
      expect(res.stdout).not.toContain("$");
    } finally { srv.stop(); }
  });

  it("reports a machine that never served as a zero and a null, which are different facts", async () => {
    // 0 requests is a measurement; a null date is the absence of an event. Both
    // are true of the same row and collapsing either loses information a script
    // would want.
    const srv = stubServer();
    try {
      const res = await run(["stats", "--json"], { data: signedInData(srv.url) });
      const idle = JSON.parse(res.stdout).machines.find((m) => m.nodeId === "eeee5555ffff6666");
      expect(idle.requests).toBe(0);
      expect(idle.lastServedAt).toBeNull();
    } finally { srv.stop(); }
  });
});

describe("nothing to report", () => {
  it("says no machines are registered, and how to register one", async () => {
    // An empty table under a heading is a dead end. The next step is one command
    // and it costs nothing to name it.
    const srv = stubServer({ me: NO_MACHINES });
    try {
      const res = await run(["stats"], { data: signedInData(srv.url) });
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/no machines registered/i);
      expect(res.stdout).toMatch(/aile start/);
    } finally { srv.stop(); }
  });

  it("emits empty arrays and zeroes under --json, not an error", async () => {
    const srv = stubServer({ me: NO_MACHINES });
    try {
      const res = await run(["stats", "--json"], { data: signedInData(srv.url) });
      expect(JSON.parse(res.stdout)).toEqual({
        machines: [],
        totals: { requests: 0, earnedMicros: 0 },
      });
    } finally { srv.stop(); }
  });
});

describe("before there is an account, and when the server is not there", () => {
  it("says how to set the machine up", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-stats-cli-"));
    scratches.push(dir);
    const res = await run(["stats"], { data: dir });
    expect(res.code).toBe(1);
    expect(res.all).toMatch(/not set up yet/i);
    expect(res.all).toMatch(/aile login/);
  });

  it("fails with the reason rather than printing an empty table", async () => {
    // An unreachable server and an account with no machines are opposite
    // situations, and "no machines registered" sent to somebody whose relay is
    // down would send them to enrol a box that is already enrolled.
    const srv = stubServer();
    const url = srv.url;
    srv.stop();
    const res = await run(["stats"], { data: signedInData(url) });
    expect(res.code).toBe(1);
    expect(res.all).toMatch(/could not reach the server/i);
    expect(res.all).not.toMatch(/no machines registered/i);
  });
});

describe("aile status carries the headline, so the number is visible without a second command", () => {
  it("prints what the account has served across every machine", async () => {
    // `aile status` answers "is this machine working?" and its only evidence used
    // to be that a socket was open. A connected relay that has served nothing
    // looks identical to a busy one from the outside.
    const srv = stubServer();
    try {
      const res = await run(["status"], { data: signedInData(srv.url) });
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/Served:\s+1,216 requests across 3 machines/);
      // With more than one machine the account total and THIS machine's total are
      // different numbers, and reading one as the other sends a lender to debug a
      // box that is fine — so status points at the command that splits them.
      expect(res.stdout).toMatch(/aile stats/);
    } finally { srv.stop(); }
  });

  it("SHOWS THE ZERO when nothing has been served, rather than leaving the line out", async () => {
    // The single most common confusion on this surface: connected, enrolled, and
    // earning nothing. The count is shown as a count; the sentence that used to
    // explain it was cut when the overview was trimmed (2026-09-25).
    const srv = stubServer({
      me: { ...ME, nodes: ME.nodes.map((n) => ({ ...n, requests: 0, earnedMicros: 0, lastServedAt: null })) },
    });
    try {
      const res = await run(["status"], { data: signedInData(srv.url) });
      expect(res.stdout).toMatch(/Served:\s+0 requests across 3 machines/);
    } finally { srv.stop(); }
  });

  it("marks each account with WHERE it is served, this box apart from the rest", async () => {
    // The complaint that started this: `status` never said which accounts THIS
    // machine was carrying, so a node serving four accounts read the same as one
    // serving none. The compact marker is the smallest thing that answers it, and
    // it uses the same `serving` verdict `aile accounts` and the dashboard do.
    //
    // The node id is derived from files in the data dir, so rather than recompute
    // it here (paths.js caches its dir at first import, which another test in this
    // file has already fixed) we read it back off the subprocess's own `Machine:`
    // line, then feed it in as the id of the account THIS box is serving.
    let me = { ...ME, accounts: [] };
    const server = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch(req) {
        if (new URL(req.url).pathname === "/me") return Response.json({ success: true, data: me, message: "" });
        return Response.json({ success: false, error: "x" }, { status: 404 });
      },
    });
    try {
      const dir = signedInData(`http://127.0.0.1:${server.port}`);
      const first = await run(["status"], { data: dir });
      const here = first.stdout.match(/Machine:\s+([0-9a-f]{16})/)?.[1];
      expect(here).toBeTruthy();

      me = {
        ...ME,
        accounts: [
          { id: "s0001", provider: "openrouter", label: "Here", attested: 0,
            serving: { via: "node", nodeId: here, online: true, nodeless: false } },
          { id: "s0002", provider: "codex", label: "There", attested: 1,
            serving: { via: "node", nodeId: "0000abcd0000abcd", online: true, nodeless: false } },
          { id: "s0003", provider: "openrouter", label: "Direct", attested: 0,
            serving: { via: "nodeless", nodeId: null, online: false, nodeless: true } },
          { id: "s0004", provider: "codex", label: "Idle", attested: 1,
            serving: { via: "none", nodeId: null, online: false, nodeless: false } },
        ],
      };
      const res = await run(["status"], { data: dir });
      expect(res.code).toBe(0);
      // This box, another box, Aile-direct, and nothing — each named, and "this
      // node" reserved for the one whose serving id is ours. The mark is ● or,
      // on a console that cannot draw it, * (src/cli/ui.js).
      expect(res.stdout).toMatch(/Here[\s\S]*[●*] this node/);
      expect(res.stdout).toMatch(/There[\s\S]*[●*] another node/);
      expect(res.stdout).toMatch(/Direct[\s\S]*nodeless/);
      expect(res.stdout).toMatch(/Idle[\s\S]*no node/);
      // Exactly one line is "this node": marking all or none is the same bug.
      expect(res.stdout.match(/[●*] this node/g)).toHaveLength(1);
    } finally { try { server.stop(true); } catch { /* ignore */ } }
  });
});
