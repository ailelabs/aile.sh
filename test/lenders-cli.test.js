/**
 * `aile lenders` and `aile spend` — choosing who serves you, and seeing what
 * they cost.
 *
 * ============================================================================
 * WHAT BEING WRONG HERE COSTS, IN ORDER.
 *
 *  1. A FILTER THAT DOES NOT REACH THE WIRE. This is the worst failure on this
 *     surface and the only one that is invisible from the output. A `--verified`
 *     that never became a query parameter prints a full, unfiltered table under a
 *     command that says it is filtered, and the buyer routes to a lender they
 *     believe they excluded. The parser makes this a live risk rather than a
 *     theoretical one: a flag missing from `BOOLEAN_FLAGS` swallows the NEXT
 *     argument as its value, so `--verified --model x` silently loses the model.
 *     Every filter is asserted on the recorded request, not on the printout.
 *  2. AN EMPTY TABLE THAT NAMES NOTHING. "No lenders" sends somebody to debug
 *     their network when the fix is one number in a flag. The server says how
 *     many machines are online and echoes the filters it applied, which is
 *     exactly enough to tell "nobody is lending" from "your ceiling is below all
 *     of them" — two situations with opposite responses.
 *  3. THE ORDER BEING RE-SORTED HERE. The server's order IS the routing order:
 *     cheapest first, ties to the least busy machine. A client that re-sorted
 *     would print a table that disagrees with what actually happens, and the
 *     buyer would pick off the top and be served by someone else.
 *  4. AN OPINION COMING BACK. A star rating was built and removed; a lender is
 *     judged on requests served, counted from the ledger. A rating column, a
 *     `review` command, or an `api.review` method reappearing would restore a
 *     number that can be manufactured, so their absence is asserted directly —
 *     an absence cannot be checked by exercising it.
 *  5. A PRICE WITHOUT A MODEL. There is no such thing. The number shown must be
 *     the number charged, and one invented to fill a column breaks exactly that.
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
const API = path.join(import.meta.dirname, "..", "src", "api", "client.js");
const scratches = [];

/** Two lenders, cheapest first — the order the server sends and this must keep. */
const LENDERS = {
  lenders: [
    {
      handle: "Labcdef0123456789",
      nodeId: "node-cheap-1",
      platform: "linux",
      providers: [
        { provider: "claude", verified: true, live: true, accounts: 1 },
        { provider: "codex", verified: false, live: false, accounts: 2 },
      ],
      price: {
        in: 2.5, out: 7.5, inUsd: "$2.50", outUsd: "$7.50",
        source: "lender", known: true, model: "claude-opus-5",
      },
      served: 1204,
      capacity: { active: 1, max: 4, free: 3 },
      connectedAt: "2026-07-01T00:00:00.000Z",
    },
    {
      handle: "L9876543210fedcba",
      nodeId: "node-dear-2",
      platform: "darwin",
      providers: [{ provider: "gemini-cli", verified: false, live: true, accounts: 1 }],
      price: {
        in: 3, out: 9, inUsd: "$3.00", outUsd: "$9.00",
        source: "default", known: false, model: "claude-opus-5",
      },
      served: 12,
      capacity: { active: 0, max: 2, free: 2 },
      connectedAt: "2026-07-02T00:00:00.000Z",
    },
  ],
  online: 2,
  priced: true,
  filters: { model: "claude-opus-5", maxUsdPerMtok: null, verified: false, provider: null },
};

/** The same listing with no model named, so the server priced nothing. */
const UNPRICED = {
  lenders: LENDERS.lenders.map((l) => ({ ...l, price: null })),
  online: 2,
  priced: false,
  filters: { model: null, maxUsdPerMtok: null, verified: false, provider: null },
};

const SPEND = {
  lenders: [
    { handle: "Labcdef0123456789", requests: 42, micros: 3_250_000, lastAt: "2026-07-20T11:22:33.000Z" },
    { handle: "L9876543210fedcba", requests: 8, micros: 750_000, lastAt: "2026-06-30T01:02:03.000Z" },
  ],
  totals: { requests: 50, micros: 4_000_000 },
};

/** A stub server that records every request, so a test can assert on the query. */
function stubServer({ market = LENDERS, spend = SPEND, status = 200 } = {}) {
  const calls = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      calls.push(`${req.method} ${url.pathname}${url.search}`);
      if (url.pathname === "/market" && req.method === "GET") {
        const enveloped = status >= 200 && status < 300
          ? { success: true, data: market, message: "" }
          : { success: false, message: market.reason ?? market.error ?? "", error: market.error };
        return Response.json(enveloped, { status });
      }
      if (url.pathname === "/market/spend" && req.method === "GET") {
        const enveloped = status >= 200 && status < 300
          ? { success: true, data: spend, message: "" }
          : { success: false, message: spend.reason ?? spend.error ?? "", error: spend.error };
        return Response.json(enveloped, { status });
      }
      return Response.json({ success: false, message: "not found", error: "not found" }, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    /** The query of the first `/market` call, parsed — what actually reached the wire. */
    query: () => {
      const hit = calls.find((c) => c.startsWith("GET /market?") || c === "GET /market");
      return Object.fromEntries(new URL(`http://x${hit.slice(4)}`).searchParams);
    },
    stop: () => { try { server.stop(true); } catch { /* ignore */ } },
  };
}

function signedInData(serverUrl, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-lenders-cli-"));
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

describe("THE FILTERS REACH THE WIRE, which is the only place they can be seen", () => {
  it("sends every filter it was given, as query parameters", async () => {
    const srv = stubServer();
    try {
      const res = await run(
        ["lenders", "--model", "claude-opus-5", "--max-price", "8", "--verified", "--provider", "claude"],
        { data: signedInData(srv.url) },
      );
      expect(res.code).toBe(0);
      expect(srv.query()).toEqual({
        model: "claude-opus-5", maxPrice: "8", verified: "1", provider: "claude",
      });
    } finally { srv.stop(); }
  });

  it("DOES NOT LET --verified SWALLOW THE FLAG AFTER IT", async () => {
    // The parser treats an unlisted flag's next argument as its value. If
    // `verified` ever falls out of BOOLEAN_FLAGS, `--model` becomes its value and
    // the model filter disappears — and the printed table looks entirely normal.
    const srv = stubServer();
    try {
      await run(["lenders", "--verified", "--model", "claude-opus-5"], { data: signedInData(srv.url) });
      const q = srv.query();
      expect(q.verified).toBe("1");
      expect(q.model).toBe("claude-opus-5");
    } finally { srv.stop(); }
  });

  it("sends NOTHING when nothing was asked for", async () => {
    // An empty `model=` is not the same request as no model: the server prices a
    // listing only when one is named, so a blank one asks for a column it cannot
    // fill and gets an unpriced answer under a priced-looking command.
    const srv = stubServer({ market: UNPRICED });
    try {
      await run(["lenders"], { data: signedInData(srv.url) });
      expect(srv.calls[0]).toBe("GET /market");
    } finally { srv.stop(); }
  });

  it("accepts --maxPrice as well as --max-price, because both get typed", async () => {
    const srv = stubServer();
    try {
      await run(["lenders", "--maxPrice", "12"], { data: signedInData(srv.url) });
      expect(srv.query().maxPrice).toBe("12");
    } finally { srv.stop(); }
  });

  it("SENDS --seller AND --node AS SEPARATE PARAMETERS, because they ask different things", async () => {
    // A lender may run several machines. `--seller` means "this person,
    // whichever of their machines is free"; `--node` means "that box". Folding
    // one into the other fails exactly when the buyer wanted the other one.
    const srv = stubServer();
    try {
      await run(["lenders", "--seller", "Labcdef0123456789", "--node", "node-cheap-1"], {
        data: signedInData(srv.url),
      });
      expect(srv.query()).toEqual({ handle: "Labcdef0123456789", nodeId: "node-cheap-1" });
    } finally { srv.stop(); }
  });

  it("accepts --lender as a name for --seller, because both get typed", async () => {
    const srv = stubServer();
    try {
      await run(["lenders", "--lender", "Labcdef0123456789"], { data: signedInData(srv.url) });
      expect(srv.query().handle).toBe("Labcdef0123456789");
    } finally { srv.stop(); }
  });

  it("sends the reading filters: --min-served, --free and --sort", async () => {
    const srv = stubServer();
    try {
      await run(["lenders", "--min-served", "100", "--free", "--sort", "served"], {
        data: signedInData(srv.url),
      });
      expect(srv.query()).toEqual({ minServed: "100", freeOnly: "1", sort: "served" });
    } finally { srv.stop(); }
  });

  it("DOES NOT LET --free SWALLOW THE FLAG AFTER IT", async () => {
    // Same trap as `--verified`, and the same invisible consequence: missing from
    // BOOLEAN_FLAGS, `--free` takes "--sort" as its value and the order silently
    // disappears while the table still prints and still looks filtered.
    const srv = stubServer();
    try {
      await run(["lenders", "--free", "--sort", "free"], { data: signedInData(srv.url) });
      expect(srv.query()).toEqual({ freeOnly: "1", sort: "free" });
    } finally { srv.stop(); }
  });

  it("REFUSES AN ORDER IT DOES NOT KNOW rather than sending it", async () => {
    // The server falls back to price for an unknown sort, which is right for a
    // hand-edited URL and wrong for a typed flag: `--sort srved` would print a
    // price-ordered table and never say so. The error also names the four.
    const srv = stubServer();
    try {
      const res = await run(["lenders", "--sort", "srved"], { data: signedInData(srv.url) });
      expect(res.code).toBe(1);
      expect(res.all).toContain("price, served, free, uptime");
      expect(srv.calls).toHaveLength(0);   // never reached the wire
    } finally { srv.stop(); }
  });

  it("combines every filter in one request, since filters narrow together", async () => {
    const srv = stubServer();
    try {
      await run([
        "lenders", "--model", "claude-opus-5", "--max-price", "8", "--verified",
        "--provider", "claude", "--min-served", "10", "--free", "--sort", "uptime",
      ], { data: signedInData(srv.url) });
      expect(srv.query()).toEqual({
        model: "claude-opus-5", maxPrice: "8", verified: "1", provider: "claude",
        minServed: "10", freeOnly: "1", sort: "uptime",
      });
    } finally { srv.stop(); }
  });
});

describe("the table", () => {
  it("prints every lender, numbered, with its machine and its handle", async () => {
    const srv = stubServer();
    try {
      const res = await run(["lenders"], { data: signedInData(srv.url) });
      expect(res.stdout).toContain("node-cheap-1");
      expect(res.stdout).toContain("node-dear-2");
      // BOTH names, because they answer different questions: the machine is what
      // `x-aile-node` pins, the handle is what a lender is still called after
      // they replace it.
      expect(res.stdout).toContain("Labcdef01");
    } finally { srv.stop(); }
  });

  it("KEEPS THE SERVER'S ORDER, which is the order requests are routed in", async () => {
    const srv = stubServer();
    try {
      const res = await run(["lenders"], { data: signedInData(srv.url) });
      expect(res.stdout.indexOf("node-cheap-1")).toBeLessThan(res.stdout.indexOf("node-dear-2"));
      expect(res.stdout).toContain("the same order your request is routed in");
    } finally { srv.stop(); }
  });

  it("shows both directions of the price, never one number", async () => {
    // A single figure is gameable: cheap input, output at thirty. The listing
    // shows both because the ceiling filter bounds both.
    const srv = stubServer();
    try {
      const res = await run(["lenders", "--model", "claude-opus-5"], { data: signedInData(srv.url) });
      expect(res.stdout).toContain("$2.50");
      expect(res.stdout).toContain("$7.50");
    } finally { srv.stop(); }
  });

  it("MARKS AN ESTIMATED RATE rather than showing it as a quote", async () => {
    // `known: false` means no published rate was found and the number came from
    // the model's family. A buyer should be told, not shown a confident price.
    const srv = stubServer();
    try {
      const res = await run(["lenders", "--model", "claude-opus-5"], { data: signedInData(srv.url) });
      expect(res.stdout).toContain("~");
      expect(res.stdout).toContain("estimated from its family");
    } finally { srv.stop(); }
  });

  it("SAYS TO NAME A MODEL rather than printing a price without one", async () => {
    const srv = stubServer({ market: UNPRICED });
    try {
      const res = await run(["lenders"], { data: signedInData(srv.url) });
      expect(res.stdout).toContain("--model");
      expect(res.stdout).not.toContain("$2.50");
    } finally { srv.stop(); }
  });

  it("distinguishes verified from unverified by a glyph, not by colour", async () => {
    // With NO_COLOR set there is nothing else to tell them apart by, which is
    // also true for a good fraction of readers who have colour.
    const srv = stubServer();
    try {
      const res = await run(["lenders"], { data: signedInData(srv.url) });
      expect(res.stdout).toContain("✓claude");
      expect(res.stdout).toContain("·codex");
      expect(res.stdout).toContain("×2");        // two accounts behind one provider
    } finally { srv.stop(); }
  });

  it("SAYS WHAT SERVED COUNTS, so it is not read as an opinion", async () => {
    const srv = stubServer();
    try {
      const res = await run(["lenders"], { data: signedInData(srv.url) });
      expect(res.stdout).toContain("1,204");
      expect(res.stdout).toContain("requests actually relayed");
    } finally { srv.stop(); }
  });

  it("prints every header where it will be pasted", async () => {
    // A comparison you cannot act on is a table. These are the levers, and there
    // is one for each filter that changes who serves you — a filter offered here
    // with no way to act on it is a view, not a choice.
    const srv = stubServer();
    try {
      const res = await run(["lenders"], { data: signedInData(srv.url) });
      for (const h of ["x-aile-node", "x-aile-lender", "x-aile-max-price", "x-aile-verified", "x-aile-provider"]) {
        expect({ h, printed: res.stdout.includes(h) }).toEqual({ h, printed: true });
      }
      // With the top row's own id and handle filled in, so they can be copied
      // as-is: "the one at the top, every time" is the common case.
      expect(res.stdout).toContain("x-aile-node: node-cheap-1");
      expect(res.stdout).toContain("x-aile-lender: Labcdef0123456789");
    } finally { srv.stop(); }
  });

  it("SAYS WHICH FLAGS HAVE NO HEADER, rather than leaving one to be invented", async () => {
    // `--sort` changes what you read and nothing about routing. Without saying
    // so, a reader invents `x-aile-sort`, sends it, and it is ignored in silence.
    const srv = stubServer();
    try {
      const res = await run(["lenders"], { data: signedInData(srv.url) });
      expect(res.stdout).toContain("no header, no routing change");
      expect(res.stdout).not.toContain("x-aile-sort");
    } finally { srv.stop(); }
  });

  it("--json prints the server's answer untouched", async () => {
    const srv = stubServer();
    try {
      const res = await run(["lenders", "--json"], { data: signedInData(srv.url) });
      expect(res.code).toBe(0);
      expect(JSON.parse(res.stdout)).toEqual(LENDERS);
    } finally { srv.stop(); }
  });
});

describe("AN EMPTY TABLE NAMES THE THING TO RELAX", () => {
  const empty = (filters, online = 4) => ({ lenders: [], online, priced: Boolean(filters.model), filters });

  it("says the network is empty when nothing is online at all", async () => {
    const srv = stubServer({
      market: empty({ model: null, maxUsdPerMtok: null, verified: false, provider: null }, 0),
    });
    try {
      const res = await run(["lenders"], { data: signedInData(srv.url) });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("Nobody is lending right now");
      // NOT a filter suggestion — no filter would help.
      expect(res.stdout).not.toContain("Raise the ceiling");
    } finally { srv.stop(); }
  });

  it("NAMES THE PRICE CEILING when that is what emptied it, and suggests a number", async () => {
    const srv = stubServer({
      market: empty({ model: "claude-opus-5", maxUsdPerMtok: 1, verified: false, provider: null }),
    });
    try {
      const res = await run(["lenders", "--model", "claude-opus-5", "--max-price", "1"], { data: signedInData(srv.url) });
      expect(res.stdout).toContain("4 machines are lending");
      expect(res.stdout).toContain("--max-price 2");
    } finally { srv.stop(); }
  });

  it("names the verified filter when that is what emptied it", async () => {
    const srv = stubServer({
      market: empty({ model: null, maxUsdPerMtok: null, verified: true, provider: null }),
    });
    try {
      const res = await run(["lenders", "--verified"], { data: signedInData(srv.url) });
      expect(res.stdout).toContain("--verified");
      expect(res.stdout).toContain("signed provider token");
    } finally { srv.stop(); }
  });

  it("names the provider filter when that is what emptied it", async () => {
    const srv = stubServer({
      market: empty({ model: null, maxUsdPerMtok: null, verified: false, provider: "codex" }),
    });
    try {
      const res = await run(["lenders", "--provider", "codex"], { data: signedInData(srv.url) });
      expect(res.stdout).toContain("--provider codex");
    } finally { srv.stop(); }
  });

  it("says nobody can be paid when machines are online and no filter is set", async () => {
    const srv = stubServer({
      market: empty({ model: null, maxUsdPerMtok: null, verified: false, provider: null }),
    });
    try {
      const res = await run(["lenders"], { data: signedInData(srv.url) });
      expect(res.stdout).toContain("none can take a request");
    } finally { srv.stop(); }
  });

  it("gets the singular right, because '1 machines' reads as a bug", async () => {
    const srv = stubServer({
      market: empty({ model: null, maxUsdPerMtok: null, verified: false, provider: null }, 1),
    });
    try {
      const res = await run(["lenders"], { data: signedInData(srv.url) });
      expect(res.stdout).toContain("1 machine is lending");
    } finally { srv.stop(); }
  });

  it("NAMES THE PINNED MACHINE FIRST, because that is far more often the reason", async () => {
    // Pinning one box empties a listing much more readily than a price ceiling
    // does, and a reader takes the first suggestion offered.
    const srv = stubServer({
      market: empty({
        model: null, maxUsdPerMtok: 5, verified: false, provider: null,
        nodeId: "node-gone", handle: null, minServed: null, freeOnly: false,
      }),
    });
    try {
      const res = await run(["lenders", "--node", "node-gone", "--max-price", "5"], { data: signedInData(srv.url) });
      expect(res.stdout).toContain("--node node-gone");
      expect(res.stdout.indexOf("--node node-gone")).toBeLessThan(res.stdout.indexOf("Raise the ceiling"));
    } finally { srv.stop(); }
  });

  it("names the seller when their machines are all offline", async () => {
    const srv = stubServer({
      market: empty({
        model: null, maxUsdPerMtok: null, verified: false, provider: null,
        nodeId: null, handle: "Labcdef0123456789", minServed: null, freeOnly: false,
      }),
    });
    try {
      const res = await run(["lenders", "--seller", "Labcdef0123456789"], { data: signedInData(srv.url) });
      expect(res.stdout).toContain("--seller Labcdef0123456789");
      expect(res.stdout).toContain("none of their machines are online");
    } finally { srv.stop(); }
  });

  it("names the track-record floor, and says why a new machine trips it", async () => {
    const srv = stubServer({
      market: empty({
        model: null, maxUsdPerMtok: null, verified: false, provider: null,
        nodeId: null, handle: null, minServed: 500, freeOnly: false,
      }),
    });
    try {
      const res = await run(["lenders", "--min-served", "500"], { data: signedInData(srv.url) });
      expect(res.stdout).toContain("--min-served 500");
      expect(res.stdout).toContain("served nobody yet");
    } finally { srv.stop(); }
  });

  it("names --free, and says busy is temporary", async () => {
    // A machine at capacity frees up between requests. Somebody who filtered it
    // out and got nothing should be told that, not sent looking for more lenders.
    const srv = stubServer({
      market: empty({
        model: null, maxUsdPerMtok: null, verified: false, provider: null,
        nodeId: null, handle: null, minServed: null, freeOnly: true,
      }),
    });
    try {
      const res = await run(["lenders", "--free"], { data: signedInData(srv.url) });
      expect(res.stdout).toContain("--free");
      expect(res.stdout).toContain("free up between requests");
    } finally { srv.stop(); }
  });

  it("still says nobody can be paid only when NO filter is on", async () => {
    // That sentence is about the deployment, not about the request. Printing it
    // beside a filter suggestion would send somebody to the wrong problem.
    const srv = stubServer({
      market: empty({
        model: null, maxUsdPerMtok: null, verified: false, provider: null,
        nodeId: null, handle: null, minServed: 5, freeOnly: false,
      }),
    });
    try {
      const res = await run(["lenders", "--min-served", "5"], { data: signedInData(srv.url) });
      expect(res.stdout).not.toContain("none can take a request");
    } finally { srv.stop(); }
  });
});

describe("THE HEADING SAYS WHICH ORDER THIS IS, because only one is a promise", () => {
  it("claims the routing order only when the order IS the routing order", async () => {
    const srv = stubServer();
    try {
      const res = await run(["lenders"], { data: signedInData(srv.url) });
      expect(res.stdout).toContain("the same order your request is routed in");
    } finally { srv.stop(); }
  });

  it("SAYS A SORTED LISTING IS FOR READING, not for routing", async () => {
    // Otherwise the buyer picks the top row of a `--sort served` table believing
    // that is where their request goes, and it is not.
    const srv = stubServer({
      market: { ...LENDERS, filters: { ...LENDERS.filters, sort: "served" } },
    });
    try {
      const res = await run(["lenders", "--sort", "served"], { data: signedInData(srv.url) });
      expect(res.stdout).toContain("sorted by served");
      expect(res.stdout).toContain("requests still route cheapest-first");
      expect(res.stdout).not.toContain("the same order your request is routed in");
    } finally { srv.stop(); }
  });

  it("treats an explicit --sort price as the routing order it is", async () => {
    const srv = stubServer({
      market: { ...LENDERS, filters: { ...LENDERS.filters, sort: "price" } },
    });
    try {
      const res = await run(["lenders", "--sort", "price"], { data: signedInData(srv.url) });
      expect(res.stdout).toContain("the same order your request is routed in");
    } finally { srv.stop(); }
  });

  it("KEEPS THE SERVER'S ORDER even when sorted, never re-sorting locally", async () => {
    // The rows come back served-descending; a client that re-applied its own
    // idea of the order would disagree with `/market` and with the web page.
    const srv = stubServer({
      market: {
        ...LENDERS,
        lenders: [LENDERS.lenders[1], LENDERS.lenders[0]],
        filters: { ...LENDERS.filters, sort: "uptime" },
      },
    });
    try {
      const res = await run(["lenders", "--sort", "uptime"], { data: signedInData(srv.url) });
      expect(res.stdout.indexOf("node-dear-2")).toBeLessThan(res.stdout.indexOf("node-cheap-1"));
    } finally { srv.stop(); }
  });
});

describe("aile spend — the half of the ledger that is the reader's own", () => {
  it("asks the right endpoint", async () => {
    const srv = stubServer();
    try {
      await run(["spend"], { data: signedInData(srv.url) });
      expect(srv.calls).toContain("GET /market/spend");
    } finally { srv.stop(); }
  });

  it("prints each lender with what they charged this account", async () => {
    const srv = stubServer();
    try {
      const res = await run(["spend"], { data: signedInData(srv.url) });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("Labcdef0123456789");
      expect(res.stdout).toContain("$3.25");
      expect(res.stdout).toContain("$0.75");
    } finally { srv.stop(); }
  });

  it("TOTALS IT, because 'how much am I spending' is why anyone runs this", async () => {
    const srv = stubServer();
    try {
      const res = await run(["spend"], { data: signedInData(srv.url) });
      expect(res.stdout).toContain("$4.00");
      expect(res.stdout).toContain("50 requests across 2 lenders");
    } finally { srv.stop(); }
  });

  it("shows a date rather than a full timestamp", async () => {
    const srv = stubServer();
    try {
      const res = await run(["spend"], { data: signedInData(srv.url) });
      expect(res.stdout).toContain("2026-07-20");
      expect(res.stdout).not.toContain("11:22:33");
    } finally { srv.stop(); }
  });

  it("says plainly that there is nothing yet, and where to start", async () => {
    const srv = stubServer({ spend: { lenders: [], totals: { requests: 0, micros: 0 } } });
    try {
      const res = await run(["spend"], { data: signedInData(srv.url) });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("You have not bought from anyone yet");
      expect(res.stdout).toContain("aile lenders");
    } finally { srv.stop(); }
  });

  it("--json prints the server's answer untouched", async () => {
    const srv = stubServer();
    try {
      const res = await run(["spend", "--json"], { data: signedInData(srv.url) });
      expect(JSON.parse(res.stdout)).toEqual(SPEND);
    } finally { srv.stop(); }
  });
});

/**
 * THE ABSENCE TESTS.
 *
 * A star rating was built on this surface and taken out: a lender is judged on
 * requests served, which is counted from the ledger and cannot be manufactured
 * by a lender who did not serve them or moved by a buyer at all. A capability
 * that does not exist cannot be checked by calling it, so these check the shape
 * of the client — so a change that reintroduces one fails here, beside the
 * reason it was removed, rather than shipping quietly.
 */
describe("nothing here records an opinion", () => {
  it("exports no review method on the api client", async () => {
    const { api } = await import(API);
    for (const name of ["review", "unreview", "reviewable", "rate", "rating"]) {
      expect({ name, present: name in api }).toEqual({ name, present: false });
    }
  });

  it("has no review command", async () => {
    const srv = stubServer();
    try {
      const res = await run(["review"], { data: signedInData(srv.url) });
      expect(res.code).toBe(1);
      expect(res.all).toContain("Unknown command");
    } finally { srv.stop(); }
  });

  it("prints no rating column, even handed a row carrying one", async () => {
    // The server no longer sends `rating`, but a stale deployment might. A client
    // that rendered it would put a number back in front of buyers that the whole
    // removal was about.
    const srv = stubServer({
      market: { ...LENDERS, lenders: LENDERS.lenders.map((l) => ({ ...l, rating: { avg: 4.8, count: 17 } })) },
    });
    try {
      const res = await run(["lenders"], { data: signedInData(srv.url) });
      expect(res.stdout).not.toContain("4.8");
      expect(res.stdout).not.toMatch(/★|RATING|no reviews/i);
    } finally { srv.stop(); }
  });

  it("lists both buying commands in the help, and no review", async () => {
    const res = await run(["--help"], { data: signedInData("https://example.invalid") });
    expect(res.stdout).toContain("aile lenders");
    expect(res.stdout).toContain("aile spend");
    expect(res.stdout).not.toMatch(/aile review/);
  });
});

/**
 * THE HELP IS WHERE A FILTER IS FOUND.
 *
 * A filter nobody can find is a filter nobody has. Every one of these is
 * asserted in `--help` because that is the only place a reader who has not been
 * told about them will look — and a flag that reaches the wire correctly but is
 * documented nowhere fails the request that started this work ("where is filter
 * option"), while passing every test above.
 */
describe("every filter is documented where somebody will find it", () => {
  it("names all nine filters in the help", async () => {
    const res = await run(["--help"], { data: signedInData("https://example.invalid") });
    for (const flag of [
      "--model", "--max-price", "--verified", "--provider",
      "--seller", "--node", "--min-served", "--free", "--sort",
    ]) {
      expect({ flag, documented: res.stdout.includes(flag) }).toEqual({ flag, documented: true });
    }
  });

  it("says filters combine, since narrowing twice is the point of having nine", async () => {
    const res = await run(["--help"], { data: signedInData("https://example.invalid") });
    expect(res.stdout).toContain("Filters combine");
  });

  it("EXPLAINS --seller AGAINST --node, the one pair that is easy to confuse", async () => {
    const res = await run(["--help"], { data: signedInData("https://example.invalid") });
    expect(res.stdout).toContain("--seller is the person and --node is the box");
  });

  it("names every header twin, and says which flags have none", async () => {
    const res = await run(["--help"], { data: signedInData("https://example.invalid") });
    for (const h of ["x-aile-max-price", "x-aile-verified", "x-aile-provider", "x-aile-lender", "x-aile-node"]) {
      expect({ h, documented: res.stdout.includes(h) }).toEqual({ h, documented: true });
    }
    expect(res.stdout).toContain("change only what you read");
  });

  it("lists the four sort orders, which exist nowhere else a reader can see", async () => {
    const res = await run(["--help"], { data: signedInData("https://example.invalid") });
    expect(res.stdout).toContain("--sort served|free|uptime|price");
  });
});

describe("when it cannot get an answer", () => {
  it("names the reason rather than printing an empty table", async () => {
    // A closed port and a network with no lenders on it are opposite situations
    // and an empty table reads the same for both.
    const data = signedInData("http://127.0.0.1:1");
    const res = await run(["lenders"], { data });
    expect(res.code).toBe(1);
    expect(res.all).toContain("Could not reach the server");
  });

  it("passes the server's own sentence through on a refused filter", async () => {
    // A 400 from `/market` is the server naming the unit the number is in, which
    // is more use than "request failed".
    const srv = stubServer({
      market: { error: "x-aile-max-price is dollars per million tokens" }, status: 400,
    });
    try {
      const res = await run(["lenders", "--max-price", "cheap"], { data: signedInData(srv.url) });
      expect(res.code).toBe(1);
      expect(res.all).toContain("dollars per million tokens");
    } finally { srv.stop(); }
  });

  it("refuses to talk to a plain-http server without being told to", async () => {
    // The same transport rule as every other command: a token on the wire in
    // clear is a token anybody on the path keeps.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-lenders-cli-"));
    scratches.push(dir);
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ serverUrl: "http://example.invalid", renterToken: `ail_${"a".repeat(48)}` }),
    );
    const res = await run(["lenders"], { data: dir });
    expect(res.code).toBe(1);
    expect(res.all).toMatch(/http|insecure/i);
  });

  it("tells an unsigned-in machine to sign in rather than failing at the server", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-lenders-cli-"));
    scratches.push(dir);
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ serverUrl: "https://example.invalid" }));
    for (const cmd of ["lenders", "spend"]) {
      const res = await run([cmd], { data: dir });
      expect({ cmd, code: res.code }).toEqual({ cmd, code: 1 });
      expect(res.all).toContain("aile login");
    }
  });
});
