/**
 * `aile agents` — using tools OTHER agents offer — against a stub of aile's MCP
 * server (Streamable HTTP, JSON answers) and a stub Solana RPC, on loopback.
 *
 * What these pin down:
 *   - Listing reads `find_agent_tools` and prints each listing's id, price and tools.
 *   - Against a server from before the rename (`unknown_tool`), it falls back to
 *     the old names, so the command works during a rollout.
 *   - `use` with the balance sends the buyer key and no payment.
 *   - `use --pay own` answers the price (a tool RESULT, not an HTTP 402) with a
 *     signed payment on the retry, and never sends the key.
 */

import { describe, expect, it, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rpcStub } from "./helpers/solana-rpc-stub.js";

const CLI = path.join(import.meta.dirname, "..", "src", "cli", "index.js");
const scratches = [];
const KEY = `sk-aile-${"c".repeat(48)}`;
const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ABANDON = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const LISTING = {
  lenderId: "mcpl_nova",
  name: "Nova: research summaries",
  description: "Summarizes papers and release notes.",
  pricePerCallMicros: 20_000,
  trust: "trusted",
  online: true,
  tools: [{ name: "summarize", description: "Summarize text" }, { name: "answer", description: null }],
};

const ACCEPT = {
  scheme: "exact", network: MAINNET, amount: "20000", asset: USDC,
  payTo: "Fma6oRHMDqBUJVjg8gbZhpXt7v7WktuDWRUXLU7mvFpa", maxTimeoutSeconds: 120,
  extra: { name: "USDC", decimals: 6, feePayer: "DeXterR2kQm8AvRHnNPatWkE46TfAcMeBDjb6FySoAb8", recentBlockhash: "11111111111111111111111111111111" },
};

const text = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });

/**
 * A stub of aile's MCP endpoint. `tools[name](args, headers)` answers a call;
 * `oldNamesOnly` makes it a server from before the rename.
 */
function mcpStub({ lenders = [LISTING], oldNamesOnly = false, useAgentTool } = {}) {
  const calls = [];
  const FIND = oldNamesOnly ? "find_mcp_capacity" : "find_agent_tools";
  const USE = oldNamesOnly ? "rent_capability" : "use_agent_tool";
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/mcp" || req.method !== "POST") return new Response("not found", { status: 404 });
      const msg = await req.json();
      const headers = Object.fromEntries(req.headers);
      calls.push({ method: msg.method, name: msg.params?.name, arguments: msg.params?.arguments, headers });
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const reply = (result) => Response.json({ jsonrpc: "2.0", id: msg.id, result });
      if (msg.method === "initialize") {
        return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "aile", version: "0.1.0" } });
      }
      if (msg.method === "tools/call") {
        const name = msg.params.name;
        if (name === FIND) return reply(text({ lenders, total: lenders.length }));
        if (name === USE) return reply((useAgentTool ?? defaultUse)(msg.params.arguments, headers));
        return reply({ isError: true, ...text({ error: "unknown_tool", message: `no such tool: ${name}` }) });
      }
      return Response.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, calls, stop: () => { try { server.stop(true); } catch { /* ignore */ } } };
}

/** Answers like aile: paid from the balance with a key, else the price as a result until a payment arrives. */
function defaultUse(args, headers) {
  if (headers["payment-signature"]) {
    return { ...text({ answer: "five bullets, as asked" }), _meta: { "x402/payment-response": { success: true, transaction: "5agentPaidTx" } } };
  }
  if (headers.authorization) return text({ answer: "five bullets, as asked" });
  const challenge = { paymentRequired: true, error: "this call costs 0.020000 USDC.", accepts: [ACCEPT], x402Version: 2 };
  return { isError: true, structuredContent: challenge, ...text(challenge) };
}

function dataDir(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-agents-cli-"));
  scratches.push(dir);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  return dir;
}

async function run(args, { data, stdin = "ignore", timeoutMs = 30_000 } = {}) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, AILE_DATA_DIR: data, NO_COLOR: "1", AILE_WALLET_PASSPHRASE: "" },
    stdin, stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  const strip = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  return { code, stdout: strip(stdout), stderr: strip(stderr), all: strip(stdout + stderr) };
}

async function withOwnWallet(config) {
  const data = dataDir(config);
  const res = await run(["wallet", "own", "import", "--no-encrypt", "--json"], { data, stdin: new Blob([`${ABANDON}\n`]) });
  expect(res.code).toBe(0);
  return data;
}

afterAll(() => {
  for (const d of scratches) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

describe("aile agents — finding other agents' tools", () => {
  it("lists each listing's id, price and tools", async () => {
    const srv = mcpStub();
    try {
      const res = await run(["agents"], { data: dataDir({ serverUrl: srv.url }) });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("Nova: research summaries");
      expect(res.stdout).toContain("mcpl_nova");
      expect(res.stdout).toContain("$0.02");
      expect(res.stdout).toContain("summarize, answer");
      expect(srv.calls.find((c) => c.method === "tools/call").name).toBe("find_agent_tools");
    } finally { srv.stop(); }
  });

  it("passes a query through, and says so when nothing matches", async () => {
    const srv = mcpStub({ lenders: [] });
    try {
      const res = await run(["agents", "translate"], { data: dataDir({ serverUrl: srv.url }) });
      expect(res.code).toBe(0);
      expect(res.all).toContain('No agents are offering tools matching "translate" right now.');
      // And points at the other product, for anyone who meant a model.
      expect(res.all).toContain("aile chat");
      expect(srv.calls.find((c) => c.method === "tools/call").arguments.q).toBe("translate");
    } finally { srv.stop(); }
  });

  it("falls back to the old tool name on a server from before the rename", async () => {
    const srv = mcpStub({ oldNamesOnly: true });
    try {
      const res = await run(["agents", "--json"], { data: dataDir({ serverUrl: srv.url }) });
      expect(res.code).toBe(0);
      expect(JSON.parse(res.stdout).lenders[0].lenderId).toBe("mcpl_nova");
      expect(srv.calls.filter((c) => c.method === "tools/call").map((c) => c.name)).toEqual(["find_agent_tools", "find_mcp_capacity"]);
    } finally { srv.stop(); }
  });
});

describe("aile agents use — calling one", () => {
  it("pays from the balance with the buyer key, and sends no payment", async () => {
    const srv = mcpStub();
    try {
      const res = await run(["agents", "use", "mcpl_nova", "summarize", "--task", "five bullets", "--args", '{"text":"notes"}'], {
        data: dataDir({ serverUrl: srv.url, buyerKey: KEY }),
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("five bullets, as asked");
      expect(res.all).toContain("paid from your balance");
      const call = srv.calls.find((c) => c.name === "use_agent_tool");
      expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(call.headers["payment-signature"]).toBeUndefined();
      expect(call.arguments).toEqual({ lenderId: "mcpl_nova", tool: "summarize", task: "five bullets", arguments: { text: "notes" } });
    } finally { srv.stop(); }
  });

  it("with --pay own: answers the price with a signed payment on the retry, and sends no key", async () => {
    const rpc = rpcStub({ usdcMicros: 1_000_000 });
    const srv = mcpStub();
    try {
      const data = await withOwnWallet({ serverUrl: srv.url, buyerKey: KEY, solanaRpc: rpc.url });
      const res = await run(["agents", "use", "mcpl_nova", "summarize", "--task", "five bullets", "--pay", "own", "--yes"], { data });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("five bullets, as asked");
      expect(res.all).toContain("5agentPaidTx");
      const uses = srv.calls.filter((c) => c.name === "use_agent_tool");
      expect(uses.length).toBe(2);
      for (const u of uses) expect(u.headers.authorization).toBeUndefined();
      const envelope = JSON.parse(Buffer.from(uses[1].headers["payment-signature"], "base64").toString("utf8"));
      expect(envelope.accepted).toMatchObject({ amount: "20000", payTo: ACCEPT.payTo, network: MAINNET });
    } finally { srv.stop(); rpc.stop(); }
  });

  it("with no balance and no own wallet, says how to pay rather than guessing", async () => {
    const srv = mcpStub({ useAgentTool: (args, headers) => defaultUse(args, {}) });
    try {
      const res = await run(["agents", "use", "mcpl_nova", "summarize", "--task", "x"], { data: dataDir({ serverUrl: srv.url, buyerKey: KEY }) });
      expect(res.code).toBe(1);
      expect(res.all).toContain("0.020000 USDC");
      expect(res.all).toContain("aile deposit");
      expect(res.all).toContain("--pay own");
    } finally { srv.stop(); }
  });

  it("asks for the task, since it is what the other agent reads", async () => {
    const res = await run(["agents", "use", "mcpl_nova", "summarize"], { data: dataDir({ serverUrl: "http://127.0.0.1:9", buyerKey: KEY }) });
    expect(res.code).toBe(1);
    expect(res.all).toContain("--task");
  });
});
