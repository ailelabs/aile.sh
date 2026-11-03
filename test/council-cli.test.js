/**
 * `aile council` against a stub of aile's MCP server (`ask_council`), on loopback.
 *
 * What these pin down: every flag reaches the tool as its argument; answers go to
 * stdout and the receipt (price basis included) to stderr; a partial or empty
 * council exits the way the summary says; and every refusal is a sentence and
 * exit 1 with nothing sent, never a stack trace.
 */

import { describe, expect, it, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connectMcp } from "../src/api/mcp-client.js";

const CLI = path.join(import.meta.dirname, "..", "src", "cli", "index.js");
const scratches = [];
const KEY = `sk-aile-${"d".repeat(48)}`;
const MEMBERS = "a/x,b/y";

const text = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });

const seat = (model, over = {}) => ({
  model, provider: model.split("/")[0], request_id: `req_${model}`, status: "answered",
  answer: `answer from ${model}`, finish_reason: "stop", cost_usd: 0.001234, error: null, ...over,
});

const SUMMARY = {
  council_id: "council_1",
  answer: "the merged verdict",
  merged: true,
  note: null,
  members: [seat("a/x"), seat("b/y", { cost_usd: 0.002 })],
  synthesizer: { model: "a/x", provider: "a", request_id: "req_m", status: "answered", finish_reason: "stop", cost_usd: 0.003, error: null },
  total_cost_usd: 0.006234,
  cost_complete: true,
};

/** `council(args, headers)` answers `ask_council`; `status` answers every POST with that HTTP status. */
function mcpStub({ council = () => ({ structuredContent: SUMMARY, ...text(SUMMARY) }), status = null } = {}) {
  const calls = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/mcp" || req.method !== "POST") return new Response("not found", { status: 404 });
      const msg = await req.json();
      const headers = Object.fromEntries(req.headers);
      calls.push({ method: msg.method, name: msg.params?.name, arguments: msg.params?.arguments, headers });
      if (status) return new Response("nope", { status });
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const reply = (result) => Response.json({ jsonrpc: "2.0", id: msg.id, result });
      if (msg.method === "initialize") {
        return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "aile", version: "0.1.0" } });
      }
      if (msg.method === "tools/call") {
        if (msg.params.name === "ask_council") {
          const out = council(msg.params.arguments, headers);
          return out instanceof Response ? out : reply(out);
        }
        return reply({ isError: true, ...text({ error: "unknown_tool", message: `no such tool: ${msg.params.name}` }) });
      }
      return Response.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    stop: () => { try { server.stop(true); } catch { /* ignore */ } },
  };
}

function dataDir(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-council-cli-"));
  scratches.push(dir);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  return dir;
}

async function run(args, { data, stdin = "ignore", timeoutMs = 30_000 } = {}) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, AILE_DATA_DIR: data, NO_COLOR: "1", AILE_NO_UPDATE_CHECK: "1" },
    stdin, stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  const strip = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  return { code, stdout: strip(stdout), stderr: strip(stderr), all: strip(stdout + stderr) };
}

/** Run against a stub with the key saved; always stops the stub. */
async function against(stubOpts, args, { config = {}, stdin } = {}) {
  const srv = mcpStub(stubOpts);
  try {
    const res = await run(args, { data: dataDir({ serverUrl: srv.url, buyerKey: KEY, ...config }), stdin });
    const calls = srv.calls.slice();
    return { res, calls, asked: calls.filter((c) => c.name === "ask_council") };
  } finally { srv.stop(); }
}

const noStack = (res) => expect(res.all).not.toMatch(/^\s+at /m);
const reply = (summary, isError = false) => ({ council: () => ({ ...(isError ? { isError: true } : {}), structuredContent: summary, ...text(summary) }) });

afterAll(() => {
  for (const d of scratches) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

describe("aile council: what reaches the tool", () => {
  it("sends the defaults, with the key", async () => {
    const { res, asked } = await against({}, ["council", "q", "--members", MEMBERS]);
    expect(res.code).toBe(0);
    expect(asked.length).toBe(1);
    expect(asked[0].arguments).toEqual({ question: "q", members: ["a/x", "b/y"], synthesizer: "a/x", max_tokens: 4096, deadline_seconds: 110 });
    expect(asked[0].headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("takes max_tokens from quoteMaxTokens", async () => {
    const { asked } = await against({}, ["council", "q", "--members", MEMBERS], { config: { quoteMaxTokens: 800 } });
    expect(asked[0].arguments.max_tokens).toBe(800);
  });

  it("maps every flag, zero temperature included", async () => {
    const { res, asked } = await against({}, [
      "council", "which", "index?", "--members", "a/x, b/y ,c/z", "--synthesizer", "c/z", "--max-tokens", "500",
      "--synthesizer-max-tokens", "900", "--system", "be brief", "--temperature", "0", "--deadline", "30",
    ]);
    expect(res.code).toBe(0);
    expect(asked[0].arguments).toEqual({
      question: "which index?", members: ["a/x", "b/y", "c/z"], synthesizer: "c/z", max_tokens: 500,
      deadline_seconds: 30, system: "be brief", synthesizer_max_tokens: 900, temperature: 0,
    });
  });

  it("reads the question from a pipe", async () => {
    const { res, asked } = await against({}, ["council", "-", "--members", MEMBERS], { stdin: new Blob(["from a pipe\n"]) });
    expect(res.code).toBe(0);
    expect(asked[0].arguments.question).toBe("from a pipe");
  });

  it("refuses an empty pipe", async () => {
    const { res, asked } = await against({}, ["council", "-", "--members", MEMBERS], { stdin: new Blob([""]) });
    expect(res.code).toBe(1);
    expect(asked.length).toBe(0);
  });
});

describe("aile council: what it prints", () => {
  it("answers on stdout, the receipt on stderr, and never the key", async () => {
    const { res } = await against(reply({ ...SUMMARY, note: "the merge used both answers" }), ["council", "q", "--members", MEMBERS]);
    expect(res.code).toBe(0);
    for (const s of ["a/x", "answer from a/x", "$0.001234", "b/y", "answer from b/y", "$0.002000", "Merged by a/x", "$0.003000", "the merged verdict"]) {
      expect(res.stdout).toContain(s);
    }
    for (const s of ["the merge used both answers", "$0.006234 in all", "quoted on --max-tokens 4096", "the merge on 8192", "not on tokens used", "aile spend"]) {
      expect(res.stderr).toContain(s);
    }
    expect(res.stdout).not.toContain("in all");
    expect(res.all).not.toContain(KEY);
    noStack(res);
  });

  it("--json prints the summary and nothing else", async () => {
    const { res } = await against({}, ["council", "q", "--members", MEMBERS, "--json"]);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual(SUMMARY);
  });

  it("one member failed and nothing merged: shows its error, no merge, exit 0", async () => {
    const partial = {
      ...SUMMARY, merged: false, answer: "answer from a/x", note: "only one member answered, so nothing was merged",
      members: [seat("a/x"), seat("b/y", { status: "failed", answer: null, cost_usd: 0, error: "upstream timed out" })],
      synthesizer: { ...SUMMARY.synthesizer, status: "skipped", cost_usd: null },
      total_cost_usd: 0.001234,
    };
    const { res } = await against(reply(partial), ["council", "q", "--members", MEMBERS]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("upstream timed out");
    expect(res.stdout).not.toContain("Merged by");
    expect(res.stderr).toContain("only one member answered");
    expect(res.stderr).not.toContain("the merge on");
  });

  it("says when a cost is unknown", async () => {
    const unknown = { ...SUMMARY, cost_complete: false, members: [seat("a/x", { cost_usd: null }), seat("b/y")] };
    const { res } = await against(reply(unknown), ["council", "q", "--members", MEMBERS]);
    expect(res.stdout).toContain("cost unknown");
    expect(res.stderr).toContain("at least");
  });

  it("prints a data notice, and flags a cut or length-stopped answer", async () => {
    const policy = {
      ...SUMMARY,
      members: [
        seat("a/x", { data_policy: { trains_on_prompts: true, notice: "this model trains on prompts" }, finish_reason: "length" }),
        seat("b/y", { cut_for_merge: true }),
      ],
    };
    const { res } = await against(reply(policy), ["council", "q", "--members", MEMBERS]);
    expect(res.stdout).toContain("this model trains on prompts");
    expect(res.stdout).toContain("(stopped at max_tokens)");
    expect(res.stdout).toContain("(cut for the merge)");
  });

  it("no member answered: errors shown, exit 1, and with --json the summary still parses", async () => {
    const none = {
      ...SUMMARY, merged: false, answer: null, total_cost_usd: 0,
      members: [seat("a/x", { status: "failed", answer: null, error: "no capacity" }), seat("b/y", { status: "failed", answer: null, error: "bad gateway" })],
      synthesizer: { ...SUMMARY.synthesizer, status: "skipped", cost_usd: null },
    };
    const plain = await against(reply(none, true), ["council", "q", "--members", MEMBERS]);
    expect(plain.res.code).toBe(1);
    expect(plain.res.stdout).toContain("no capacity");
    expect(plain.res.stdout).toContain("bad gateway");
    noStack(plain.res);
    const json = await against(reply(none, true), ["council", "q", "--members", MEMBERS, "--json"]);
    expect(json.res.code).toBe(1);
    expect(JSON.parse(json.res.stdout).council_id).toBe("council_1");
  });
});

describe("aile council: the key and the receipt", () => {
  it("names the key that paid, never in full", async () => {
    const { res } = await against({}, ["council", "q", "--members", MEMBERS]);
    expect(res.stderr).toContain("paid from your balance with key sk-aile-dddd…dddd");
    expect(res.all).not.toContain(KEY);
  });

  it("takes no --key, since it spends on this machine's key, and sends nothing", async () => {
    const { res, calls } = await against({}, ["council", "q", "--members", MEMBERS, "--key", `sk-aile-${"e".repeat(48)}`]);
    expect(res.code).toBe(1);
    expect(res.all).toContain("takes no --key");
    expect(res.all).not.toContain("e".repeat(20));
    expect(calls.length).toBe(0);
  });

  it("when every member was refused and nothing was charged, it says so and points at funds, not at a charge", async () => {
    const refused = (m) => seat(m, { status: "failed", answer: null, cost_usd: 0, error: "the endpoint answered HTTP 402" });
    const none = { ...SUMMARY, merged: false, answer: null, total_cost_usd: 0, cost_complete: true, members: [refused("a/x"), refused("b/y")], synthesizer: { ...SUMMARY.synthesizer, status: "skipped", cost_usd: null } };
    const { res } = await against(reply(none, true), ["council", "q", "--members", MEMBERS]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("nothing charged");
    expect(res.stderr).toContain("aile deposit");
    expect(res.stderr).not.toContain("paid from your balance");
    expect(res.stderr).not.toContain("aile spend");
  });
});

describe("aile council: a connection lost after the question was sent", () => {
  it("says the council may still have run and where to look, not that the server was unreachable", async () => {
    // The server answers its headers, then the connection is closed under the client.
    const srv = mcpStub({
      council: () => {
        setTimeout(() => srv.stop(), 50);
        return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } });
      },
    });
    const res = await run(["council", "q", "--members", MEMBERS], { data: dataDir({ serverUrl: srv.url, buyerKey: KEY }) });
    expect(srv.calls.filter((c) => c.name === "ask_council").length).toBe(1);
    expect(res.code).toBe(1);
    expect(res.all).toContain("may still have run");
    expect(res.all).toContain("aile spend");
    expect(res.all).not.toContain("Could not reach");
    noStack(res);
  });

  it("the client's wait covers the body, not only the headers", async () => {
    const server = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch: () => new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } }),
    });
    try {
      const started = Date.now();
      await expect(connectMcp({ serverUrl: `http://127.0.0.1:${server.port}`, insecure: true, timeoutMs: 300 })).rejects.toThrow(/no response from/);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally { server.stop(true); }
  });
});

describe("aile council: refusals", () => {
  it("with no key, says how to get one and sends nothing", async () => {
    const srv = mcpStub();
    try {
      const res = await run(["council", "q", "--members", MEMBERS], { data: dataDir({ serverUrl: srv.url }) });
      expect(res.code).toBe(1);
      expect(res.all).toContain("aile setup");
      expect(srv.calls.length).toBe(0);
    } finally { srv.stop(); }
  });

  it("checks its flags before any request", async () => {
    const bad = [
      ["--members", "a/x"],
      ["--members", "a/x,b/y,c/z,d/w,e/v"],
      [],
      ["--members", MEMBERS, "--deadline", "9"],
      ["--members", MEMBERS, "--deadline", "111"],
      ["--members", MEMBERS, "--temperature", "x"],
      ["--members", MEMBERS, "--synthesizer"],
    ];
    for (const flags of bad) {
      const { res, calls } = await against({}, ["council", "q", ...flags]);
      expect(res.code).toBe(1);
      expect(calls.length).toBe(0);
      noStack(res);
    }
  });

  it("repeats the server's own sentence when it refuses the arguments", async () => {
    const refusal = { error: "invalid_arguments", message: "each member must be a different model" };
    const { res } = await against({ council: () => ({ isError: true, ...text(refusal) }) }, ["council", "q", "--members", "a/x,a/x"]);
    expect(res.code).toBe(1);
    expect(res.all).toContain("each member must be a different model");
    noStack(res);
  });

  it("says an older server has no council", async () => {
    const { res } = await against({ council: () => ({ isError: true, ...text({ error: "unknown_tool" }) }) }, ["council", "q", "--members", MEMBERS]);
    expect(res.code).toBe(1);
    expect(res.all).toContain("no council yet");
    noStack(res);
  });

  it("says when there is no MCP endpoint", async () => {
    const { res } = await against({ status: 404 }, ["council", "q", "--members", MEMBERS]);
    expect(res.code).toBe(1);
    expect(res.all).toContain("no MCP endpoint");
    noStack(res);
  });

  it("points a refused key at a new one", async () => {
    const { res } = await against({ status: 401 }, ["council", "q", "--members", MEMBERS]);
    expect(res.code).toBe(1);
    expect(res.all).toContain("aile setup refresh");
    noStack(res);
  });

  it("says when the server cannot be reached", async () => {
    const res = await run(["council", "q", "--members", MEMBERS], { data: dataDir({ serverUrl: "http://127.0.0.1:9", buyerKey: KEY }) });
    expect(res.code).toBe(1);
    expect(res.all).toContain("Could not reach");
    noStack(res);
  });
});
