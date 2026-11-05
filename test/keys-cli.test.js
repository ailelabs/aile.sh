/**
 * `aile keys`, `aile keys suggest` and `aile route` against a stub of the three
 * account routes, on loopback.
 *
 * What these pin down:
 *   - All three need the account token and say so before any request.
 *   - A key is named by id, name or prefix, defaults sensibly, and a pasted
 *     secret is never sent or echoed: the routes take a key's id.
 *   - The dry run's body is built per format, its text says sharer and never
 *     lender, and it exits 0 whenever the server answered.
 *   - An older server and a server error end as a message, never a stack.
 */

import { describe, expect, it, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dirname, "..", "src", "cli", "index.js");
const scratches = [];
const KEY = `sk-aile-${"c".repeat(48)}`;
const TOKEN = "ail_testtoken";

const K1 = { id: "k1", name: "main", prefix: `sk-aile-${"c".repeat(8)}…`, disabled: false, expired: false, creditLimitUsd: 20, limitWindow: "day", spentUsd: 1.5, filters: {}, stake: false,
  aliases: [{ name: "fast", description: "cheap and quick", entries: [] }, { name: "smart", auto: true, entries: [] }] };
const K2 = { id: "k2", name: "work", prefix: `sk-aile-${"d".repeat(8)}…`, disabled: false, expired: false, creditLimitUsd: null, limitWindow: null, spentUsd: 0, filters: {}, stake: false, aliases: [] };
const KSTAKE = { id: "k3", name: "stake", prefix: `sk-aile-${"e".repeat(8)}…`, disabled: false, expired: false, creditLimitUsd: null, limitWindow: null, spentUsd: 0, filters: {}, stake: true, aliases: [] };

const TARGET = (tier, extra = {}) => ({
  tier, provider: "openrouter", model: "vendor/model-" + tier, effort: tier === "heavy" ? "high" : undefined,
  facts: { listUsd: { in: 1, out: 4 }, quoteUsd: { in: 0.8, out: 3.2, cacheRead: 0.08 }, dearestUsd: { in: 0.9, out: 3.6 }, pctOfList: 80, sharers: 3, contextWindow: 200000, tools: true, vision: false, reasoning: true, calls30d: 1200 },
  why: { relaxed: "none", fewCalls: false }, ...extra,
});
const SUGGESTION = {
  options: [{ shape: "mixed", targets: [TARGET("light"), TARGET("standard"), TARGET("heavy", { why: { relaxed: "vision", fewCalls: true } })], gaps: [{ tier: "light", reason: "same" }] }],
  rules: [], minCalls: 50,
  leftOut: { selfHosted: 5, unpriced: 3, locked: 2, ownCapacity: 1, free: 1, keyRules: 2, trainsOnPrompts: 1, notChat: 4 },
};
const DRY = {
  route: { name: "fast", order: "in-order", prefer: null, ttftMs: null, budget: null, refusal: { status: 402, cause: "route-budget", message: "route budget spent" } },
  prefer: null,
  auto: { tier: "standard", reason: "default", pinned: true, promptTokens: 120 },
  autoName: { name: "aile/auto", score: 2, vendorLock: "claude" },
  targets: [
    { entry: 0, position: 0, model: "model-a", provider: "openrouter", tier: "light", capacity: "nodeless", effort: "low",
      removed: [{ stage: "lender", count: 1, lenders: ["L1"] }, { stage: "serve-control", count: 2 }], unavailable: 1,
      candidates: [{ lender: "S1", quoteUsd: 0.0123456 }, { lender: "S2", quoteUsd: 0.02, skipped: "above the buyer's price ceiling" }], more: 1, first: "S1", tiedWith: ["S3"],
      refusal: { status: 503, message: "nobody online" } },
    { entry: 1, position: 1, model: "openrouter/model-b", provider: "openrouter", removed: [], unavailable: 0, candidates: [], first: null, tiedWith: [] },
  ],
  firstTried: { entry: 0, lender: "S1" },
  notes: ["Sent no body, so the planner assumed a short prompt."],
};

function stub(init = {}) {
  const s = { keys: [K1, K2], suggestion: SUGGESTION, dryRun: DRY, older: false, status: {}, requests: [], ...init };
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const text = req.method === "POST" || req.method === "PUT" ? await req.text() : "";
      s.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: Object.fromEntries(req.headers), body: text ? JSON.parse(text) : null, raw: text, url: req.url });
      // PUT /keys/:id/filters stores what it is sent; `ignoreLocalCeiling` plays a server that predates the field.
      const put = /^\/keys\/([^/]+)\/filters$/.exec(url.pathname);
      if (put && req.method === "PUT") {
        if (s.status.filters) return Response.json({ success: false, message: s.status.filters.message }, { status: s.status.filters.status });
        const row = s.keys.find((k) => k.id === put[1]);
        if (!row) return Response.json({ success: false, message: "no such key" }, { status: 404 });
        let filters = s.requests.at(-1).body.filters;
        if (filters && s.ignoreLocalCeiling) { const { localMaxUsdPerMtok: _drop, ...rest } = filters; filters = Object.keys(rest).length ? rest : null; }
        return Response.json({ success: true, data: { key: { ...row, filters: filters ?? {} } } });
      }
      const kind = url.pathname === "/keys" ? "keys" : url.pathname === "/keys/route-suggestion" ? "suggestion" : url.pathname === "/keys/route-dry-run" ? "dryRun" : null;
      if (!kind) return new Response("nope", { status: 404 });
      if (s.status[kind]) return Response.json({ success: false, message: s.status[kind].message }, { status: s.status[kind].status });
      if (s.older && kind !== "keys") return Response.json({ success: false, message: "Not found" }, { status: 404 });
      const data = kind === "keys" ? { keys: s.keys } : s[kind];
      return Response.json({ success: true, data });
    },
  });
  s.url = `http://127.0.0.1:${server.port}`;
  s.stop = () => { try { server.stop(true); } catch { /* ignore */ } };
  return s;
}

function dataDir(config, manifest = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-keys-cli-"));
  scratches.push(dir);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  if (manifest) fs.writeFileSync(path.join(dir, "integrations.json"), JSON.stringify(manifest));
  return dir;
}

async function run(args, { data }) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, AILE_DATA_DIR: data, NO_COLOR: "1", AILE_NO_UPDATE_CHECK: "1" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 30_000);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  const strip = (x) => x.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  return { code, stdout: strip(stdout), stderr: strip(stderr), all: strip(stdout + stderr) };
}

/** Run against a fresh stub with this machine signed in and holding KEY. */
async function with_(args, { stubOpts, config = {}, manifest = null } = {}) {
  const s = stub(stubOpts);
  try {
    const res = await run(args, { data: dataDir({ serverUrl: s.url, renterToken: TOKEN, buyerKey: KEY, ...config }, manifest) });
    return { ...res, s };
  } finally { s.stop(); }
}

const noStack = (r) => expect(r.all).not.toMatch(/\bat .*[\\/]/);
const sent = (q) => q.url + JSON.stringify(q.headers) + q.raw;

afterAll(() => {
  for (const d of scratches) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

describe("signed out", () => {
  for (const args of [["keys"], ["keys", "suggest"], ["route", "aile/auto"]]) {
    it(`aile ${args.join(" ")} says so and sends nothing`, async () => {
      const s = stub();
      try {
        const res = await run(args, { data: dataDir({ serverUrl: s.url, buyerKey: KEY }) });
        expect(res.code).toBe(1);
        expect(res.all).toContain("not signed in");
        expect(s.requests.length).toBe(0);
      } finally { s.stop(); }
    });
  }
});

describe("aile keys", () => {
  it("lists each key with routes and marks this machine's", async () => {
    const r = await with_(["keys"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("main");
    expect(r.stdout).toContain(K1.prefix);
    expect(r.stdout).toMatch(/main .*this machine/);
    expect(r.stdout).not.toMatch(/work .*this machine/);
    expect(r.stdout).toContain("fast");
    expect(r.stdout).toContain("cheap and quick");
    expect(r.stdout).toContain("smart (auto)");
    expect(r.stdout).toContain("$1.5 spent of $20 per day");
    expect(r.all).not.toContain(KEY);
    expect(r.s.requests[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("--json prints the server's rows", async () => {
    const r = await with_(["keys", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ keys: [K1, K2] });
  });

  it("says so when there are none", async () => {
    const r = await with_(["keys"], { stubOpts: { keys: [] } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("No API keys yet");
  });

  it("refuses a stray subcommand", async () => {
    const r = await with_(["keys", "bogus"]);
    expect(r.code).toBe(1);
    expect(r.all).toContain('"aile keys bogus" is not a command');
  });

  it("401 is a message, not a stack", async () => {
    const r = await with_(["keys"], { stubOpts: { status: { keys: { status: 401, message: "no" } } } });
    expect(r.code).toBe(1);
    expect(r.all).toContain("no longer valid");
    noStack(r);
  });

  it("500 exits 1", async () => {
    const r = await with_(["keys"], { stubOpts: { status: { keys: { status: 500, message: "boom" } } } });
    expect(r.code).toBe(1);
    expect(r.all).toContain("had a problem");
    noStack(r);
  });

  it("a dead server exits 1 with a plain message", async () => {
    const res = await run(["keys"], { data: dataDir({ serverUrl: "http://127.0.0.1:1", renterToken: TOKEN }) });
    expect(res.code).toBe(1);
    expect(res.all).toContain("Could not reach");
    noStack(res);
  });
});

describe("aile keys suggest — which key", () => {
  const asked = (r) => r.s.requests.find((x) => x.path === "/keys/route-suggestion");

  it("defaults to the key matching this machine's saved key, and sends its id", async () => {
    const r = await with_(["keys", "suggest"]);
    expect(r.code).toBe(0);
    expect(asked(r).query).toEqual({ key: "k1" });
    expect(asked(r).headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("falls back to the key setup recorded", async () => {
    const r = await with_(["keys", "suggest"], {
      config: { buyerKey: undefined },
      manifest: { version: 1, tools: {}, key: { id: "k2", prefix: "x" } },
    });
    expect(r.code).toBe(0);
    expect(asked(r).query.key).toBe("k2");
  });

  it("falls back to the only usable key", async () => {
    const r = await with_(["keys", "suggest"], { config: { buyerKey: undefined }, stubOpts: { keys: [K2, KSTAKE] } });
    expect(r.code).toBe(0);
    expect(asked(r).query.key).toBe("k2");
  });

  it("asks which when there are two and no signal", async () => {
    const r = await with_(["keys", "suggest"], { config: { buyerKey: undefined } });
    expect(r.code).toBe(1);
    expect(r.all).toContain("Which key?");
    expect(asked(r)).toBeUndefined();
  });

  it("says when the account has no key", async () => {
    const r = await with_(["keys", "suggest"], { stubOpts: { keys: [] } });
    expect(r.code).toBe(1);
    expect(r.all).toContain("no API key yet");
  });

  for (const [how, flag] of [["id", "k2"], ["name", "work"], ["prefix", `sk-aile-${"d".repeat(8)}…`], ["prefix without the ellipsis", `sk-aile-${"d".repeat(8)}`]]) {
    it(`--key by ${how}`, async () => {
      const r = await with_(["keys", "suggest", "--key", flag]);
      expect(r.code).toBe(0);
      expect(asked(r).query.key).toBe("k2");
    });
  }

  it("--key matching nothing exits 1", async () => {
    const r = await with_(["keys", "suggest", "--key", "nope"]);
    expect(r.code).toBe(1);
    expect(r.all).toContain('No key on this account matches "nope"');
  });

  it("--key with no value exits 1", async () => {
    const r = await with_(["keys", "suggest", "--key"]);
    expect(r.code).toBe(1);
    expect(r.all).toContain("--key needs");
  });

  it("a full secret that matches nothing is never echoed or sent", async () => {
    const secret = `sk-aile-${"a".repeat(48)}`;
    const r = await with_(["keys", "suggest", "--key", secret]);
    expect(r.code).toBe(1);
    expect(r.all).not.toContain(secret);
    expect(r.all).toContain("No key on this account matches");
    for (const q of r.s.requests) expect(sent(q)).not.toContain(secret);
  });

  it("a full secret that matches a row resolves to its id, locally", async () => {
    const r = await with_(["keys", "suggest", "--key", KEY]);
    expect(r.code).toBe(0);
    expect(asked(r).query.key).toBe("k1");
    for (const q of r.s.requests) expect(sent(q)).not.toContain(KEY);
  });

  it("a secret pasted a little wrong is still never echoed or sent", async () => {
    const tail = "a".repeat(47);
    for (const flag of [`sk-aile-${tail}`, `Bearer sk-aile-${tail}a`, `"sk-aile-${tail}a"`]) {
      const r = await with_(["keys", "suggest", "--key", flag]);
      expect(r.code).toBe(1);
      expect(r.all).toContain("No key on this account matches");
      expect(r.all).not.toContain("a".repeat(20));
      for (const q of r.s.requests) expect(sent(q)).not.toContain("a".repeat(20));
    }
    // The same paste, right, but with the decoration: it matches locally.
    const ok = await with_(["keys", "suggest", "--key", `Bearer ${KEY}`]);
    expect(ok.code).toBe(0);
    expect(asked(ok).query.key).toBe("k1");
    for (const q of ok.s.requests) expect(sent(q)).not.toContain(KEY);
  });

  it("a key name with a space is still a name", async () => {
    const r = await with_(["keys", "suggest", "--key", "my key"], { stubOpts: { keys: [K1, { ...K2, name: "my key" }] } });
    expect(r.code).toBe(0);
    expect(asked(r).query.key).toBe("k2");
  });

  it("marks this machine's key when it is off or expired, so a route is not saved on it unawares", async () => {
    const off = await with_(["keys", "suggest"], { stubOpts: { keys: [{ ...K1, disabled: true }, K2] } });
    expect(off.code).toBe(0);
    expect(off.stdout).toContain("Suggested route for main (sk-aile-cccccccc…), off");
    const expired = await with_(["route", "fast"], { stubOpts: { keys: [{ ...K1, expired: true }, K2] } });
    expect(expired.stdout).toContain("key main (sk-aile-cccccccc…), expired");
  });

  it("two rows sharing a name exit 1", async () => {
    const r = await with_(["keys", "suggest", "--key", "dup"], { stubOpts: { keys: [{ ...K1, name: "dup" }, { ...K2, name: "dup" }] } });
    expect(r.code).toBe(1);
    expect(r.all).toContain("2 keys match");
  });
});

describe("aile keys suggest — output", () => {
  it("prints tiers, prices, facts, gaps, left-out and where to save", async () => {
    const r = await with_(["keys", "suggest"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Suggested route for main");
    expect(r.stdout).toContain("A model per tier");
    expect(r.stdout).toContain("light");
    expect(r.stdout).toContain("openrouter/vendor/model-standard");
    expect(r.stdout).toContain("effort high");
    expect(r.stdout).toContain("$0.8 in, $3.2 out, $0.08 cached per Mtok");
    expect(r.stdout).toContain("80% of list ($1, $4)");
    expect(r.stdout).toContain("up to $3.6 out");
    expect(r.stdout).toContain("3 sharers");
    expect(r.stdout).toContain("1200 calls in 30 days");
    expect(r.stdout).toContain("tools");
    expect(r.stdout).toContain("reasoning");
    expect(r.stdout).toContain("cannot read images");
    expect(r.stdout).toContain("few calls, so cheapest on price");
    expect(r.stdout).toContain("the standard model serves it");
    expect(r.stdout).toContain("Left out: 3 unpriced, 2 locked, 1 your own capacity, 1 free, 2 by this key's rules, 1 trains on prompts, 4 not chat, 5 self-hosted");
    expect(r.stdout).toContain("Nothing was saved");
    expect(r.stdout).toContain("/dash?tab=keys");
    expect(r.stdout).not.toMatch(/lender|renter|buyer/i);
  });

  it("--json prints the server's data", async () => {
    const r = await with_(["keys", "suggest", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(SUGGESTION);
  });

  it("empty options exits 0", async () => {
    const r = await with_(["keys", "suggest"], { stubOpts: { suggestion: { options: [], rules: [], minCalls: 50, leftOut: {} } } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Nothing listed fits");
  });

  it("an older server exits 1 with a message", async () => {
    const r = await with_(["keys", "suggest"], { stubOpts: { older: true } });
    expect(r.code).toBe(1);
    expect(r.all).toContain("does not offer");
    expect(r.all).toContain("aile keys still lists your keys");
    noStack(r);
  });

  it("a server with no key list does not send the person to the list that failed", async () => {
    const r = await with_(["keys"], { stubOpts: { status: { keys: { status: 404, message: "Not found" } } } });
    expect(r.code).toBe(1);
    expect(r.all).toContain("does not offer");
    expect(r.all).not.toContain("still lists");
    noStack(r);
  });

  it("a 404 'no such key' is not 'does not offer'", async () => {
    const r = await with_(["keys", "suggest"], { stubOpts: { status: { suggestion: { status: 404, message: "no such key" } } } });
    expect(r.code).toBe(1);
    expect(r.all).toContain("no such key");
    expect(r.all).not.toContain("does not offer");
  });
});

describe("aile route — the request", () => {
  const dry = (r) => r.s.requests.find((x) => x.path === "/keys/route-dry-run");

  it("sends only the key and the name when given nothing else", async () => {
    const r = await with_(["route", "aile/auto"]);
    expect(r.code).toBe(0);
    expect(dry(r).body).toEqual({ key: "k1", model: "aile/auto" });
    expect(dry(r).headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("builds a messages body with tools and both headers", async () => {
    const r = await with_(["route", "fast", "hello", "there", "--format", "messages", "--tools", "--tier", "heavy", "--data", "deny"]);
    expect(r.code).toBe(0);
    const b = dry(r).body;
    expect(b.format).toBe("messages");
    expect(b.body.messages[0].content).toBe("hello there");
    expect(b.body.tools[0].input_schema).toBeDefined();
    expect(b.headers).toEqual({ "x-aile-auto-tier": "heavy", "x-aile-data-collection": "deny" });
  });

  it("builds a responses body", async () => {
    const r = await with_(["route", "fast", "--format", "responses", "--tools"]);
    expect(r.code).toBe(0);
    const b = dry(r).body.body;
    expect(b.input).toBe("Hello");
    expect(b.tools[0].name).toBe("example");
  });

  for (const [flag, value] of [["--format", "xml"], ["--tier", "huge"], ["--data", "maybe"], ["--format", undefined]]) {
    it(`${flag} ${value ?? "(bare)"} exits 1 before any request`, async () => {
      const r = await with_(["route", "fast", ...(value ? [flag, value] : [flag])]);
      expect(r.code).toBe(1);
      expect(r.all).toContain(`${flag} must be`);
      expect(r.s.requests.length).toBe(0);
    });
  }

  it("needs a name", async () => {
    const r = await with_(["route"]);
    expect(r.code).toBe(1);
    expect(r.all).toContain("Which route?");
    expect(r.s.requests.length).toBe(0);
  });

  it("never carries a full key in any request", async () => {
    const r = await with_(["route", "aile/auto", "hi"]);
    for (const q of r.s.requests) expect(sent(q)).not.toMatch(/sk-aile-[0-9a-f]{48}/);
  });
});

describe("aile route — the answer", () => {
  it("prints the plan in sharer words and exits 0 despite a refusal", async () => {
    const r = await with_(["route", "fast", "hi"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("aile route fast");
    expect(r.stdout).toContain("cheap and quick");
    expect(r.stdout).toContain("standard (default), held by this conversation");
    expect(r.stdout).toContain("~120 prompt tokens");
    expect(r.stdout).toContain("2 of 3");
    expect(r.stdout).toContain("stays on claude");
    expect(r.stdout).toContain("402: route budget spent");
    expect(r.stdout).toMatch(/first\s+openrouter\/model-a .* sharer S1/);
    expect(r.stdout.indexOf("openrouter/model-a")).toBeLessThan(r.stdout.indexOf("openrouter/model-b"));
    expect(r.stdout).toContain("at $0.012346");
    expect(r.stdout).toContain("3 sharers");
    expect(r.stdout).toContain("1 unavailable");
    expect(r.stdout).toContain("1 passed over");
    expect(r.stdout).toContain("1 tied");
    expect(r.stdout).toContain("removed sharer: 1 (L1)");
    expect(r.stdout).toContain("removed serve-control: 2");
    expect(r.stdout).toContain("refused 503: nobody online");
    expect(r.stdout).toContain("no sharer would be tried");
    expect(r.stdout).toContain("Sent no body");
    expect(r.stdout).toContain("Nothing was sent");
    expect(r.all).not.toMatch(/lender|renter|buyer/i);
  });

  it("quotes the sharer it names, even when the server listed a passed-over one before it", async () => {
    const target = {
      ...DRY.targets[0], first: "CHEAP", tiedWith: [], more: 0, unavailable: 0,
      candidates: [{ lender: "FAST", quoteUsd: 9.5, skipped: "above the buyer's cost cap" }, { lender: "CHEAP", quoteUsd: 0.01 }],
    };
    const r = await with_(["route", "fast"], { stubOpts: { dryRun: { ...DRY, targets: [target], firstTried: { entry: 0, lender: "CHEAP" } } } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("first CHEAP at $0.010000");
    expect(r.stdout).not.toContain("9.5");
    expect(r.stdout).toContain("2 sharers");
    expect(r.stdout).toContain("1 passed over");
  });

  it("firstTried null says nobody, and still exits 0", async () => {
    const r = await with_(["route", "fast"], { stubOpts: { dryRun: { ...DRY, firstTried: null } } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("nobody");
  });

  it("--json prints the server's data verbatim", async () => {
    const withLender = { ...DRY, firstTried: { entry: 0, lender: "S1" } };
    const r = await with_(["route", "fast", "--json"], { stubOpts: { dryRun: withLender } });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(withLender);
    expect(r.stdout).toContain('"lender"');
  });

  it("a 400 from the dry run carries the server's sentence", async () => {
    const r = await with_(["route", "fast"], { stubOpts: { status: { dryRun: { status: 400, message: "aile/auto is not served on /v1/responses" } } } });
    expect(r.code).toBe(1);
    expect(r.all).toContain("aile/auto is not served on /v1/responses");
    noStack(r);
  });

  it("an older server exits 1 with a message", async () => {
    const r = await with_(["route", "fast"], { stubOpts: { older: true } });
    expect(r.code).toBe(1);
    expect(r.all).toContain("does not offer");
    noStack(r);
  });
});


describe("aile keys set — a key's self-hosted rules", () => {
  const withFilters = (filters) => ({ keys: [{ ...K1, filters }, K2] });
  const puts = (r) => r.s.requests.filter((q) => q.method === "PUT");

  it("sets the ceiling on this machine's key and keeps every other rule as stored", async () => {
    const stored = { provider: "openrouter", maxPctOfList: 80, dedupeTools: true, sticky: false };
    const r = await with_(["keys", "set", "--local-max-price", "2"], { stubOpts: withFilters(stored) });
    expect(r.code).toBe(0);
    expect(puts(r)).toHaveLength(1);
    expect(puts(r)[0].path).toBe("/keys/k1/filters");
    expect(puts(r)[0].body).toEqual({ filters: { ...stored, localMaxUsdPerMtok: 2 } });
    expect(r.stdout).toMatch(/may now pay up to \$2 per million tokens/);
    expect(r.stdout).not.toContain("does not keep");
  });

  it("an empty key gets just the ceiling; the request goes to the named key", async () => {
    const r = await with_(["keys", "set", "--key", "work", "--local-max-price", "$0.5"]);
    expect(r.code).toBe(0);
    expect(puts(r)[0].path).toBe("/keys/k2/filters");
    expect(puts(r)[0].body).toEqual({ filters: { localMaxUsdPerMtok: 0.5 } });
  });

  it("none removes the ceiling and keeps the rest; removing the last field sends null", async () => {
    const r = await with_(["keys", "set", "--local-max-price", "none"], { stubOpts: withFilters({ localMaxUsdPerMtok: 2, sticky: false }) });
    expect(puts(r)[0].body).toEqual({ filters: { sticky: false } });
    expect(r.stdout).toMatch(/ceiling was dropped/);
    const r2 = await with_(["keys", "set", "--local-max-price", "none"], { stubOpts: withFilters({ localMaxUsdPerMtok: 2 }) });
    expect(puts(r2)[0].body).toEqual({ filters: null });
    const r3 = await with_(["keys", "set", "--local-max-price", "off"], { stubOpts: withFilters({}) });
    expect(r3.code).toBe(0);
    expect(r3.stdout).toMatch(/had no self-hosted price ceiling/);
  });

  it("--allow-local no writes allowLocal:false AND drops the ceiling, and says so", async () => {
    const r = await with_(["keys", "set", "--allow-local", "no"], { stubOpts: withFilters({ localMaxUsdPerMtok: 2, maxUsdPerMtok: 9 }) });
    expect(r.code).toBe(0);
    expect(puts(r)[0].body).toEqual({ filters: { maxUsdPerMtok: 9, allowLocal: false } });
    expect(r.stdout).toMatch(/refuses self-hosted models/);
    expect(r.stdout).toMatch(/self-hosted price ceiling was dropped too/);
  });

  it("--allow-local yes removes allowLocal; both flags together set the ceiling on a key that refused", async () => {
    const r = await with_(["keys", "set", "--allow-local", "yes"], { stubOpts: withFilters({ allowLocal: false, sticky: false }) });
    expect(puts(r)[0].body).toEqual({ filters: { sticky: false } });
    const r2 = await with_(["keys", "set", "--allow-local", "yes", "--local-max-price", "3"], { stubOpts: withFilters({ allowLocal: false }) });
    expect(puts(r2)[0].body).toEqual({ filters: { localMaxUsdPerMtok: 3 } });
  });

  it("a ceiling on a key that refuses self-hosted dies before sending, with the way out", async () => {
    const r = await with_(["keys", "set", "--local-max-price", "2"], { stubOpts: withFilters({ allowLocal: false }) });
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/refuses self-hosted models/);
    expect(r.all).toContain("aile keys set --allow-local yes --local-max-price 2");
    expect(puts(r)).toHaveLength(0);
    const deny = await with_(["keys", "set", "--local-max-price", "2"], { stubOpts: withFilters({ dataCollection: "deny" }) });
    expect(deny.code).toBe(1);
    expect(deny.all).toMatch(/denies data collection/);
    expect(puts(deny)).toHaveLength(0);
  });

  it("warns when the server dropped the field, instead of pretending it was saved", async () => {
    const r = await with_(["keys", "set", "--local-max-price", "2"], { stubOpts: { ...withFilters({ sticky: false }), ignoreLocalCeiling: true } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("This server does not keep a self-hosted price ceiling yet");
    expect(r.stdout).toContain("aile chat --max-price");
  });

  it("MUST-NOT: a bad value, a contradiction or no flag at all dies before ANY request, even the listing", async () => {
    for (const args of [
      ["keys", "set"],
      ["keys", "set", "--local-max-price"],
      ["keys", "set", "--local-max-price", "0"],
      ["keys", "set", "--local-max-price", "-1"],
      ["keys", "set", "--local-max-price", "1001"],
      ["keys", "set", "--local-max-price", "1000.5"],
      ["keys", "set", "--local-max-price", "0.0000001"],
      ["keys", "set", "--local-max-price", "abc"],
      ["keys", "set", "--local-max-price", "2%"],
      ["keys", "set", "--allow-local", "maybe"],
      ["keys", "set", "--allow-local"],
      ["keys", "set", "--allow-local", "no", "--local-max-price", "2"],
    ]) {
      const r = await with_(args);
      expect(r.code).toBe(1);
      expect(r.s.requests).toHaveLength(0);
      noStack(r);
    }
  });

  it("accepts the edges: 1000 and six decimals", async () => {
    const r = await with_(["keys", "set", "--local-max-price", "1000"]);
    expect(puts(r)[0].body).toEqual({ filters: { localMaxUsdPerMtok: 1000 } });
    const r2 = await with_(["keys", "set", "--local-max-price", "0.000001"]);
    expect(puts(r2)[0].body).toEqual({ filters: { localMaxUsdPerMtok: 0.000001 } });
  });

  it("the server's refusal ends the command with its sentence", async () => {
    const r = await with_(["keys", "set", "--allow-local", "no"], { stubOpts: { status: { filters: { status: 400, message: "this key is pinned to local, so it cannot refuse it" } } } });
    expect(r.code).toBe(1);
    expect(r.all).toContain("this key is pinned to local");
    noStack(r);
  });

  it("an unknown key is named, nothing is sent", async () => {
    const r = await with_(["keys", "set", "--key", "nope", "--local-max-price", "2"]);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/No key on this account matches/);
    expect(puts(r)).toHaveLength(0);
  });

  it("signed out: says so and sends nothing", async () => {
    const s = stub();
    try {
      const res = await run(["keys", "set", "--local-max-price", "2"], { data: dataDir({ serverUrl: s.url, buyerKey: KEY }) });
      expect(res.code).toBe(1);
      expect(res.all).toContain("not signed in");
      expect(s.requests.length).toBe(0);
    } finally { s.stop(); }
  });
});

describe("aile keys — the list shows a key's self-hosted rule", () => {
  it("prints the ceiling, or that the key refuses self-hosted, and nothing for a key that says nothing", async () => {
    const r = await with_(["keys"], { stubOpts: { keys: [{ ...K1, filters: { localMaxUsdPerMtok: 2.5 } }, { ...K2, filters: { allowLocal: false } }, { ...KSTAKE, filters: {} }] } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("self-hosted ≤ $2.5/Mtok");
    expect(r.stdout).toContain("self-hosted off");
    expect(r.stdout.match(/self-hosted/g)).toHaveLength(2); // the two lines; the hint under the list says "Self-hosted rules"
  });

  it("an older server's keys (no filters at all) list as before", async () => {
    const r = await with_(["keys"], { stubOpts: { keys: [{ ...K1, filters: undefined }] } });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/self-hosted ≤|self-hosted off/);
  });

  it("an unknown subcommand names `set`", async () => {
    const r = await with_(["keys", "frobnicate"]);
    expect(r.code).toBe(1);
    expect(r.all).toContain("aile keys set");
  });
});

describe("aile route --max-price", () => {
  it("sends x-aile-max-price in the dry run's headers", async () => {
    const r = await with_(["route", "local/llama3.1:8b", "--max-price", "2"]);
    expect(r.code).toBe(0);
    const q = r.s.requests.find((x) => x.path === "/keys/route-dry-run");
    expect(q.body.headers).toEqual({ "x-aile-max-price": "2" });
  });
  it("a percent on a local/ model dies before any request", async () => {
    const r = await with_(["route", "local/x", "--max-price", "80%"]);
    expect(r.code).toBe(1);
    expect(r.s.requests).toHaveLength(0);
  });
  it("without the flag the dry run's headers are as before", async () => {
    const r = await with_(["route", "fast"]);
    expect(r.s.requests.find((x) => x.path === "/keys/route-dry-run").body.headers ?? null).toBeNull();
  });
});
