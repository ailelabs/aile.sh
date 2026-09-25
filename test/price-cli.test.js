/**
 * `aile price` — what ONE request would cost, before it is sent.
 *
 * ============================================================================
 * WHAT BEING WRONG HERE COSTS, IN ORDER.
 *
 *  1. A REQUEST BODY BEING CONSTRUCTED AT ALL. This is the worst failure on this
 *     surface and it is not a rendering bug — it is the whole boundary the
 *     command was designed around. The server prices output from `max_tokens` in
 *     the REQUEST BODY, never a header, precisely so the number it quotes is the
 *     ceiling the provider will enforce. A client that injected, defaulted, or
 *     rewrote that field would be changing what a buyer asked for in the one
 *     direction that changes their bill, and the relay is a byte pipe that does
 *     not read bodies at all. So `--max-tokens` must move an ESTIMATE and reach
 *     nothing else, and that is asserted on the recorded traffic rather than on
 *     the printout: only `/market` is ever called, and only ever with GET.
 *  2. THE ESTIMATE DISAGREEING WITH THE BILL. The rates come from `/market`,
 *     which is the same `lenderQuote` that charges the request — a lender's own
 *     dollar price, their per-model multiplier and the deployment default are all
 *     resolved upstream and arrive already applied. If this file's arithmetic
 *     drifts, the network quotes one number and takes another, and a buyer who
 *     cannot trust a quote has no reason to read one.
 *  3. `max_tokens` NOT BEING EXPLAINED. The command exists because output is
 *     priced at the ceiling and nothing on either side said so. A table of
 *     numbers with no sentence naming the lever is the state before this shipped.
 *  4. AN ESTIMATE PRESENTED AS A QUOTE. The output side is exact; the input side
 *     cannot be, because a prompt's real token count is not knowable until the
 *     prompt exists. That has to be visible in the heading, not in a footnote.
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
 * Two lenders at round rates, so the arithmetic in an assertion is legible.
 *
 * Cheap: $2.00 in / $6.00 out per million tokens.
 * Dear:  $4.00 in / $12.00 out, and `known: false` — no published rate for this
 * model, estimated from its family, which the buyer must be told.
 */
const MARKET = {
  lenders: [
    {
      handle: "Labcdef0123456789",
      nodeId: "node-cheap-1",
      providers: [{ provider: "claude", verified: true, live: true, accounts: 1 }],
      price: { in: 2, out: 6, inUsd: "$2.00", outUsd: "$6.00", source: "lender", known: true, model: "claude-opus-5" },
      served: 1204,
      capacity: { active: 1, max: 4, free: 3 },
    },
    {
      handle: "L9876543210fedcba",
      nodeId: "node-dear-2",
      providers: [{ provider: "codex", verified: false, live: true, accounts: 1 }],
      price: { in: 4, out: 12, inUsd: "$4.00", outUsd: "$12.00", source: "fallback", known: false, model: "claude-opus-5" },
      served: 12,
      capacity: { active: 0, max: 2, free: 2 },
    },
  ],
  online: 2,
  priced: true,
  filters: { model: "claude-opus-5", maxUsdPerMtok: null, verified: false, provider: null },
};

/** Machines online, none of them serving the model that was asked about. */
const NONE = {
  lenders: [],
  online: 3,
  priced: true,
  filters: { model: "claude-opus-5", maxUsdPerMtok: null, verified: false, provider: null },
};

/** Nothing lending at all — a different situation with a different response. */
const EMPTY = { lenders: [], online: 0, priced: true, filters: { model: "claude-opus-5" } };

/** A stub server that records every request, method and body included. */
function stubServer({ market = MARKET, status = 200 } = {}) {
  const calls = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      // The BODY is recorded too, and that is the point of this stub: the
      // strongest claim this command makes is that it never builds one.
      let body = null;
      try { body = await req.text(); } catch { /* ignore */ }
      calls.push({ method: req.method, path: url.pathname, search: url.search, body: body || null });
      if (url.pathname === "/market" && req.method === "GET") {
        const enveloped = status >= 200 && status < 300
          ? { success: true, data: market, message: "" }
          : { success: false, message: market.reason ?? market.error ?? "", error: market.error };
        return Response.json(enveloped, { status });
      }
      return Response.json({ success: false, message: "not found", error: "not found" }, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    query: () => {
      const hit = calls.find((c) => c.path === "/market");
      return Object.fromEntries(new URL(`http://x${hit.search}`).searchParams);
    },
    stop: () => { try { server.stop(true); } catch { /* ignore */ } },
  };
}

function signedInData(serverUrl, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-price-cli-"));
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

/**
 * THE BOUNDARY TEST, AND THE REASON THIS COMMAND IS SEPARATE FROM ONE THAT SENDS.
 *
 * An absence cannot be checked by exercising it, so these check the traffic: a
 * body, a non-GET, or any path but `/market` reaching the wire would mean this
 * command had started to construct a request — which is the one thing it must
 * never do, whatever flags it is given.
 */
describe("IT SENDS NO REQUEST AND BUILDS NO REQUEST BODY", () => {
  it("only ever GETs /market, whatever --max-tokens it is handed", async () => {
    const srv = stubServer();
    try {
      for (const extra of [[], ["--max-tokens", "1024"], ["--max-tokens", "128000"], ["--in", "40000"]]) {
        const res = await run(["price", "claude-opus-5", ...extra], { data: signedInData(srv.url) });
        expect({ extra, code: res.code }).toEqual({ extra, code: 0 });
      }
      expect([...new Set(srv.calls.map((c) => `${c.method} ${c.path}`))]).toEqual(["GET /market"]);
      expect(srv.calls.every((c) => !c.body)).toBe(true);
    } finally { srv.stop(); }
  });

  it("NEVER PUTS max_tokens ON THE WIRE, in a query parameter or anywhere else", async () => {
    // The server reads it from the body on purpose. A `max_tokens` that reached
    // the server from here would be a second source for the number that decides
    // the price, and the two could disagree.
    const srv = stubServer();
    try {
      await run(["price", "claude-opus-5", "--max-tokens", "1024", "--in", "9000"], {
        data: signedInData(srv.url),
      });
      const q = srv.query();
      expect(Object.keys(q)).toEqual(["model"]);
      expect(JSON.stringify(srv.calls)).not.toMatch(/max_?tokens/i);
    } finally { srv.stop(); }
  });
});

describe("the estimate, which is the whole command", () => {
  /**
   * THE ARITHMETIC, ASSERTED AGAINST NUMBERS DONE BY HAND.
   *
   * 1,500 input at $2.00/Mtok = 3,000 micro-USDC. 4,096 output at $6.00/Mtok =
   * 24,576. Total 27,576 micros = $0.027576. The dear lender is exactly double:
   * $0.055152. Both rates arrive from the server already multiplied, so this is
   * the only arithmetic in the client and it is two products and a sum.
   */
  it("prices one request at each lender's rate", async () => {
    const srv = stubServer();
    try {
      const res = await run(["price", "claude-opus-5"], { data: signedInData(srv.url) });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("$0.027576");
      expect(res.stdout).toContain("$0.055152");
      expect(res.stdout).toContain("Labcdef01234");
    } finally { srv.stop(); }
  });

  it("SHOWS THE CHEAPEST FIRST, because that is the one a request routes to", async () => {
    const srv = stubServer();
    try {
      const res = await run(["price", "claude-opus-5"], { data: signedInData(srv.url) });
      expect(res.stdout.indexOf("$0.027576")).toBeLessThan(res.stdout.indexOf("$0.055152"));
    } finally { srv.stop(); }
  });

  /**
   * THE POINT OF THE COMMAND, AS AN ASSERTION.
   *
   * The same request at a quarter of the ceiling costs a quarter of the output
   * side: 1,500 in stays 3,000 micros, 1,024 out at $6.00 is 6,144 — $0.009144.
   * If `--max-tokens` ever stopped reaching the estimate, this is the number
   * that would not move.
   */
  it("--max-tokens CHANGES THE ESTIMATE, which is the lever the command exists to show", async () => {
    const srv = stubServer();
    try {
      const res = await run(["price", "claude-opus-5", "--max-tokens", "1024"], {
        data: signedInData(srv.url),
      });
      // Scoped to the TABLE, not the whole printout: the paragraph below it
      // quotes the 4096 figure on purpose, as the contrast that teaches the
      // lever. What must not survive is the 4096 price appearing as this
      // request's price.
      const table = res.stdout.split("Output is priced at")[0];
      expect(table).toContain("$0.009144");
      expect(table).not.toContain("$0.027576");
    } finally { srv.stop(); }
  });

  it("--in changes the input side and leaves the output side alone", async () => {
    // 15,000 in at $2.00 = 30,000 micros; 4,096 out at $6.00 = 24,576. $0.054576.
    const srv = stubServer();
    try {
      const res = await run(["price", "claude-opus-5", "--in", "15000"], {
        data: signedInData(srv.url),
      });
      expect(res.stdout).toContain("$0.054576");
    } finally { srv.stop(); }
  });

  it("reads quoteMaxTokens when no flag is given, and the flag beats it", async () => {
    // The setting is the assumption; the flag is a one-off. A user who configured
    // 1024 and then asks about 4096 must get the 4096 answer.
    const srv = stubServer();
    try {
      const configured = signedInData(srv.url, { quoteMaxTokens: 1024 });
      const a = await run(["price", "claude-opus-5"], { data: configured });
      expect(a.stdout).toContain("$0.009144");
      expect(a.stdout).toMatch(/quoteMaxTokens/);

      const b = await run(["price", "claude-opus-5", "--max-tokens", "4096"], { data: configured });
      expect(b.stdout).toContain("$0.027576");
      expect(b.stdout).toMatch(/--max-tokens/);
    } finally { srv.stop(); }
  });

  it("refuses a --max-tokens that is not a positive number, rather than quoting from a NaN", async () => {
    const srv = stubServer();
    try {
      for (const bad of ["0", "-5", "lots"]) {
        const res = await run(["price", "claude-opus-5", "--max-tokens", bad], {
          data: signedInData(srv.url),
        });
        expect({ bad, code: res.code }).toEqual({ bad, code: 1 });
        expect(res.all).toMatch(/positive number of tokens/i);
      }
    } finally { srv.stop(); }
  });
});

describe("saying what it is", () => {
  it("CALLS IT AN ESTIMATE IN THE HEADING, not in a footnote", async () => {
    // The input token count of a request that does not exist yet is not knowable.
    // A number presented as a quote would be believed as one.
    const srv = stubServer();
    try {
      const res = await run(["price", "claude-opus-5"], { data: signedInData(srv.url) });
      const heading = res.stdout.split("\n").find((l) => l.includes("claude-opus-5") && l.includes("lender"));
      expect(heading).toMatch(/estimate/i);
      expect(heading).toMatch(/1,500 in/);
      expect(heading).toMatch(/4,096 out/);
    } finally { srv.stop(); }
  });

  it("EXPLAINS THAT OUTPUT IS PRICED AT THE CEILING, and shows the same request at another one", async () => {
    // The sentence is the feature. A table of numbers with no explanation is the
    // state this command was added to fix.
    const srv = stubServer();
    try {
      const res = await run(["price", "claude-opus-5"], { data: signedInData(srv.url) });
      expect(res.stdout).toMatch(/priced at/i);
      expect(res.stdout).toContain("max_tokens");
      expect(res.stdout).toMatch(/not at what the model actually returns/i);
      // The contrast figure: the same request at 1024 instead of 4096.
      expect(res.stdout).toContain("$0.009144");
    } finally { srv.stop(); }
  });

  it("names the server's own default for a request that sets no ceiling", async () => {
    // "No max_tokens" does not mean "no charge for output", and a buyer who
    // assumed it did would be surprised by every bill.
    const srv = stubServer();
    try {
      const res = await run(["price", "claude-opus-5"], { data: signedInData(srv.url) });
      expect(res.stdout).toMatch(/names no ceiling/i);
      expect(res.stdout).toContain("4,096");
    } finally { srv.stop(); }
  });

  it("marks a rate that has no published price rather than showing it as confident", async () => {
    const srv = stubServer();
    try {
      const res = await run(["price", "claude-opus-5"], { data: signedInData(srv.url) });
      expect(res.stdout).toMatch(/no published rate/i);
    } finally { srv.stop(); }
  });
});

describe("nothing to price", () => {
  it("names the model rather than reporting an empty network", async () => {
    // "No lenders" sends somebody to debug their connection when the answer is
    // that this particular model is not being served.
    const srv = stubServer({ market: NONE });
    try {
      const res = await run(["price", "claude-opus-5"], { data: signedInData(srv.url) });
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/nobody online is serving claude-opus-5/i);
      expect(res.stdout).toMatch(/lending other models/i);
    } finally { srv.stop(); }
  });

  it("tells the other empty case apart, because the responses are opposite", async () => {
    const srv = stubServer({ market: EMPTY });
    try {
      const res = await run(["price", "claude-opus-5"], { data: signedInData(srv.url) });
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/nothing is lending right now/i);
      expect(res.stdout).not.toMatch(/lending other models/i);
    } finally { srv.stop(); }
  });

  it("asks for a model instead of guessing one", async () => {
    const srv = stubServer();
    try {
      const res = await run(["price"], { data: signedInData(srv.url) });
      expect(res.code).toBe(1);
      expect(res.all).toMatch(/which model/i);
      expect(srv.calls).toHaveLength(0);   // never reached the wire
    } finally { srv.stop(); }
  });
});

describe("--json", () => {
  it("carries integer micros and names both assumptions as assumptions", async () => {
    // A script comparing lenders must read the integer rather than parse a
    // formatted string, and must be able to see that neither token count was
    // measured — `assumed`, not `tokens`.
    const srv = stubServer();
    try {
      const res = await run(["price", "claude-opus-5", "--json"], { data: signedInData(srv.url) });
      const out = JSON.parse(res.stdout);
      expect(out.model).toBe("claude-opus-5");
      expect(out.assumed).toEqual({ inputTokens: 1500, outputTokens: 4096, outputFrom: "quoteMaxTokens" });
      expect(out.lenders[0].estimateMicros).toBe(27_576);
      expect(out.lenders[0].rate).toEqual({ inUsdPerMtok: 2, outUsdPerMtok: 6, known: true });
      expect(out.lenders[1].rate.known).toBe(false);
    } finally { srv.stop(); }
  });

  it("records that the flag supplied the ceiling, so a log says where the number came from", async () => {
    const srv = stubServer();
    try {
      const res = await run(["price", "claude-opus-5", "--max-tokens", "1024", "--json"], {
        data: signedInData(srv.url),
      });
      const out = JSON.parse(res.stdout);
      expect(out.assumed).toEqual({ inputTokens: 1500, outputTokens: 1024, outputFrom: "flag" });
      expect(out.lenders[0].estimateMicros).toBe(9_144);
    } finally { srv.stop(); }
  });
});

describe("pinning one seller", () => {
  it("passes --lender through as the handle filter", async () => {
    const srv = stubServer();
    try {
      await run(["price", "claude-opus-5", "--lender", "Labcdef0123456789"], {
        data: signedInData(srv.url),
      });
      expect(srv.query()).toEqual({ model: "claude-opus-5", handle: "Labcdef0123456789" });
    } finally { srv.stop(); }
  });
});

describe("before there is an account", () => {
  it("says how to set the machine up, naming both ways", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-price-cli-"));
    scratches.push(dir);
    const res = await run(["price", "claude-opus-5"], { data: dir });
    expect(res.code).toBe(1);
    expect(res.all).toMatch(/not set up yet/i);
    expect(res.all).toMatch(/aile login/);
  });
});

describe("help", () => {
  it("lists the command and states the lever in one place", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-price-cli-"));
    scratches.push(dir);
    const res = await run(["price", "--help"], { data: dir });
    expect(res.stdout).toContain("aile price");
    expect(res.stdout).toMatch(/max_tokens/);
    expect(res.stdout).toMatch(/it sends nothing/i);
    // And the sentence that has to survive every edit to this section.
    expect(res.stdout).toMatch(/no ratings to read/i);
  });
});
