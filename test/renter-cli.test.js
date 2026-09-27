/**
 * `aile chat`, `aile balance`, `aile deposit`, and your own wallet paying
 * through them — the real CLI, spawned, against a stub aile server and a stub
 * Solana RPC on loopback. Nothing leaves the machine and nothing is spent.
 *
 * What these pin down:
 *
 *   - The balance path sends the buyer key and an explicit max_tokens, and no
 *     payment header. A shortfall says so and points at `aile deposit`.
 *   - `--pay own` signs an x402 v2 payment for exactly the entry the 402
 *     named, sends it on the retry, and never sends the buyer key.
 *   - `aile wallet` (the account's custodial view) is untouched by a local
 *     wallet existing — it neither reads nor prints it.
 */

import { describe, expect, it, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rpcStub } from "./helpers/solana-rpc-stub.js";

const CLI = path.join(import.meta.dirname, "..", "src", "cli", "index.js");
const scratches = [];

const KEY = `sk-aile-${"b".repeat(48)}`;
const ACCOUNT_ADDR = "94AtcatFepB2fueGy4BsGb6MoWL6ek5y5R1X97mSrh2V";
const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ABANDON = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ABANDON_ADDRESS = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";

const COMPLETION = {
  id: "chatcmpl-1",
  object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content: "hello from a lender" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 },
};

const ACCEPT = {
  scheme: "exact",
  network: MAINNET,
  amount: "3015",
  asset: USDC,
  payTo: "Fma6oRHMDqBUJVjg8gbZhpXt7v7WktuDWRUXLU7mvFpa",
  maxTimeoutSeconds: 120,
  extra: { name: "USDC", decimals: 6, feePayer: "DeXterR2kQm8AvRHnNPatWkE46TfAcMeBDjb6FySoAb8", recentBlockhash: "11111111111111111111111111111111" },
};

/**
 * The aile server. `chat(req, body, headers)` decides each inference answer;
 * every request is recorded with its headers and parsed body.
 */
function aileStub({ chat, wallet = { wallet: { address: ACCOUNT_ADDR, usdc: "12.50", usdcMicros: 12_500_000, spendable: "12.50" } } } = {}) {
  const calls = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const text = req.method === "POST" ? await req.text() : "";
      const body = text ? JSON.parse(text) : null;
      const headers = Object.fromEntries(req.headers);
      calls.push({ method: req.method, path: url.pathname, search: url.search, headers, body });
      if (url.pathname === "/wallet") return Response.json({ success: true, data: wallet, message: "" });
      if (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/messages") return chat(req, body, headers, calls);
      return Response.json({ success: false, message: "not found" }, { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, calls, stop: () => { try { server.stop(true); } catch { /* ignore */ } } };
}

const challenge402 = (accepts, extra = {}) => {
  const doc = { x402Version: 2, error: "PAYMENT-SIGNATURE header is required", resource: { url: "https://api.aile.sh/v1/chat/completions" }, accepts, ...extra };
  return Response.json(doc, { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(doc)).toString("base64") } });
};

function dataDir(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-renter-cli-"));
  scratches.push(dir);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  return dir;
}

async function run(args, { data, stdin = "ignore", timeoutMs = 30_000, env = {} } = {}) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, AILE_DATA_DIR: data, NO_COLOR: "1", AILE_WALLET_PASSPHRASE: "", ...env },
    stdin, stdout: "pipe", stderr: "pipe",
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

/** A data dir holding your own wallet made from the test phrase, via the real `import`. */
async function withLocalWallet(config) {
  const data = dataDir(config);
  const res = await run(["wallet", "own", "import", "--no-encrypt", "--json"], { data, stdin: new Blob([`${ABANDON}\n`]) });
  expect(res.code).toBe(0);
  expect(JSON.parse(res.stdout).address).toBe(ABANDON_ADDRESS);
  return data;
}

afterAll(() => {
  for (const d of scratches) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

// ---------------------------------------------------------------------------

describe("aile chat, paid from the account balance", () => {
  it("sends the buyer key and an explicit max_tokens, and no payment", async () => {
    const srv = aileStub({ chat: () => Response.json(COMPLETION) });
    try {
      const res = await run(["chat", "say", "hello", "--model", "claude/claude-sonnet-5", "--pay", "balance"], {
        data: dataDir({ serverUrl: srv.url, buyerKey: KEY }),
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("hello from a lender");
      const call = srv.calls.find((c) => c.path === "/v1/chat/completions");
      expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(call.headers["payment-signature"]).toBeUndefined();
      // quoteMaxTokens' default — the number `aile price` quotes.
      expect(call.body).toEqual({ model: "claude/claude-sonnet-5", max_tokens: 4096, messages: [{ role: "user", content: "say hello" }] });
    } finally { srv.stop(); }
  });

  it("uses --max-tokens and --system when given", async () => {
    const srv = aileStub({ chat: () => Response.json(COMPLETION) });
    try {
      const res = await run(["chat", "hi", "--model", "m/x", "--max-tokens", "300", "--system", "be brief"], {
        data: dataDir({ serverUrl: srv.url, buyerKey: KEY }),
      });
      expect(res.code).toBe(0);
      const { body } = srv.calls.find((c) => c.path === "/v1/chat/completions");
      expect(body.max_tokens).toBe(300);
      expect(body.messages[0]).toEqual({ role: "system", content: "be brief" });
    } finally { srv.stop(); }
  });

  it("speaks Anthropic's format with --anthropic", async () => {
    const srv = aileStub({ chat: () => Response.json({ content: [{ type: "text", text: "anthropic says hi" }] }) });
    try {
      const res = await run(["chat", "hi", "--anthropic", "--model", "claude/claude-sonnet-5"], {
        data: dataDir({ serverUrl: srv.url, buyerKey: KEY }),
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("anthropic says hi");
      const call = srv.calls.find((c) => c.path === "/v1/messages");
      expect(call.headers["x-api-key"]).toBe(KEY);
      expect(call.headers["anthropic-version"]).toBeTruthy();
    } finally { srv.stop(); }
  });

  it("says a short balance is a short balance, and where to add funds", async () => {
    const srv = aileStub({
      chat: () => challenge402([ACCEPT], { balance: { spendableMicros: 100, neededMicros: 3015, balanceMicros: 100, owedMicros: 0 } }),
    });
    try {
      const res = await run(["chat", "hi", "--model", "m/x"], { data: dataDir({ serverUrl: srv.url, buyerKey: KEY }) });
      expect(res.code).toBe(1);
      expect(res.all).toContain("Not enough balance");
      expect(res.all).toContain("$0.003015");
      expect(res.all).toContain("aile deposit");
    } finally { srv.stop(); }
  });

  it("asks for a key rather than guessing one", async () => {
    const res = await run(["chat", "hi", "--model", "m/x"], { data: dataDir({ serverUrl: "http://127.0.0.1:9" }) });
    expect(res.code).toBe(1);
    expect(res.all).toContain("No API key");
    expect(res.all).toContain("aile setup");
  });
});

describe("aile chat, paid per call from your own wallet", () => {
  it("signs exactly what the 402 asked for, retries with it, and sends no key", async () => {
    const rpc = rpcStub({ usdcMicros: 1_000_000 });
    let paidEnvelope = null;
    const srv = aileStub({
      chat: (req, body, headers) => {
        const sig = headers["payment-signature"];
        if (!sig) return challenge402([ACCEPT]);
        paidEnvelope = JSON.parse(Buffer.from(sig, "base64").toString("utf8"));
        const settle = Buffer.from(JSON.stringify({ success: true, transaction: "5settledSig", network: MAINNET })).toString("base64");
        return Response.json(COMPLETION, { headers: { "payment-response": settle } });
      },
    });
    try {
      const data = await withLocalWallet({ serverUrl: srv.url, buyerKey: KEY, solanaRpc: rpc.url });
      const res = await run(["chat", "hi", "--model", "m/x", "--pay", "own", "--max-tokens", "1000"], { data });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("hello from a lender");
      expect(res.all).toContain("5settledSig");

      const calls = srv.calls.filter((c) => c.path === "/v1/chat/completions");
      expect(calls.length).toBe(2);
      for (const c of calls) expect(c.headers.authorization).toBeUndefined();
      expect(calls[1].headers["x-payment"]).toBe(calls[1].headers["payment-signature"]);
      expect(calls[1].body).toEqual(calls[0].body);

      expect(paidEnvelope.x402Version).toBe(2);
      expect(paidEnvelope.accepted).toMatchObject({ amount: "3015", payTo: ACCEPT.payTo, asset: USDC, network: MAINNET });
      expect(typeof paidEnvelope.payload.transaction).toBe("string");
    } finally { srv.stop(); rpc.stop(); }
  });

  it("falls back to your own wallet under --pay auto when the balance is short", async () => {
    const rpc = rpcStub({ usdcMicros: 1_000_000 });
    const srv = aileStub({
      chat: (req, body, headers) => headers["payment-signature"]
        ? Response.json(COMPLETION)
        : challenge402([ACCEPT], { balance: { spendableMicros: 0, neededMicros: 3015 } }),
    });
    try {
      const data = await withLocalWallet({ serverUrl: srv.url, buyerKey: KEY, solanaRpc: rpc.url });
      const res = await run(["chat", "hi", "--model", "m/x"], { data });
      expect(res.code).toBe(0);
      expect(res.all).toContain("Balance short");
      const paid = srv.calls.filter((c) => c.path === "/v1/chat/completions")[1];
      // Keyed x402: the account is still named, the payment is the wallet's.
      expect(paid.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(paid.headers["payment-signature"]).toBeTruthy();
    } finally { srv.stop(); rpc.stop(); }
  });

  it("refuses over the cap without signing, and says how to raise it", async () => {
    const rpc = rpcStub();
    const srv = aileStub({ chat: () => challenge402([{ ...ACCEPT, amount: "900000" }]) });
    try {
      const data = await withLocalWallet({ serverUrl: srv.url, solanaRpc: rpc.url });
      const res = await run(["chat", "hi", "--model", "m/x", "--pay", "own"], { data });
      expect(res.code).toBe(1);
      expect(res.all).toContain("over your cap");
      expect(res.all).toContain("--max-usd");
      expect(srv.calls.filter((c) => c.path === "/v1/chat/completions").length).toBe(1);
    } finally { srv.stop(); rpc.stop(); }
  });

  it("explains a price under the facilitator minimum", async () => {
    const rpc = rpcStub();
    const srv = aileStub({ chat: () => challenge402([], { quote: { usd: "$0.000165" } }) });
    try {
      const data = await withLocalWallet({ serverUrl: srv.url, solanaRpc: rpc.url });
      const res = await run(["chat", "hi", "--model", "m/x", "--pay", "own"], { data });
      expect(res.code).toBe(1);
      expect(res.all).toContain("$0.000165");
      expect(res.all).toContain("--max-tokens");
    } finally { srv.stop(); rpc.stop(); }
  });

  it("says an unfunded wallet needs USDC, with its address, before signing", async () => {
    const rpc = rpcStub({ usdcMicros: 0 });
    const srv = aileStub({ chat: () => challenge402([ACCEPT]) });
    try {
      const data = await withLocalWallet({ serverUrl: srv.url, solanaRpc: rpc.url });
      const res = await run(["chat", "hi", "--model", "m/x", "--pay", "own"], { data });
      expect(res.code).toBe(1);
      expect(res.all).toContain(ABANDON_ADDRESS);
      expect(srv.calls.filter((c) => c.path === "/v1/chat/completions").length).toBe(1);
    } finally { srv.stop(); rpc.stop(); }
  });
});

describe("balance and deposit", () => {
  it("shows the account's spendable balance and your own wallet's", async () => {
    const rpc = rpcStub({ usdcMicros: 2_500_000, lamports: 10_000_000 });
    const srv = aileStub({ chat: () => Response.json(COMPLETION) });
    try {
      const data = await withLocalWallet({ serverUrl: srv.url, renterToken: `ail_${"a".repeat(48)}`, solanaRpc: rpc.url });
      const res = await run(["balance", "--json"], { data });
      expect(res.code).toBe(0);
      const out = JSON.parse(res.stdout);
      expect(out.account).toMatchObject({ address: ACCOUNT_ADDR, spendable: "12.50" });
      expect(out.own).toMatchObject({ address: ABANDON_ADDRESS, usdc: 2.5, sol: 0.01, network: "mainnet" });
    } finally { srv.stop(); rpc.stop(); }
  });

  it("names the account's deposit address", async () => {
    const srv = aileStub({ chat: () => Response.json(COMPLETION) });
    try {
      const res = await run(["deposit"], { data: dataDir({ serverUrl: srv.url, renterToken: `ail_${"a".repeat(48)}` }) });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain(ACCOUNT_ADDR);
      expect(res.stdout).toContain("USDC on Solana");
      expect(srv.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /wallet"]);
    } finally { srv.stop(); }
  });

  it("will not send from your own wallet off a terminal without --yes", async () => {
    const rpc = rpcStub();
    const srv = aileStub({ chat: () => Response.json(COMPLETION) });
    try {
      const data = await withLocalWallet({ serverUrl: srv.url, renterToken: `ail_${"a".repeat(48)}`, solanaRpc: rpc.url });
      const res = await run(["deposit", "--from-own", "1"], { data });
      expect(res.code).toBe(1);
      expect(res.all).toContain("--yes");
    } finally { srv.stop(); rpc.stop(); }
  });
});

describe("QR codes on the funding screens", () => {
  const QR_BLOCK = /[█▀▄]{10,}/;

  it("aile deposit --qr draws one under the address; in a pipe it draws none by default", async () => {
    const srv = aileStub({ chat: () => Response.json(COMPLETION) });
    try {
      const data = dataDir({ serverUrl: srv.url, renterToken: `ail_${"a".repeat(48)}` });
      const plain = await run(["deposit"], { data });
      expect(plain.code).toBe(0);
      expect(plain.stdout).not.toMatch(QR_BLOCK);
      const withQr = await run(["deposit", "--qr"], { data });
      expect(withQr.code).toBe(0);
      expect(withQr.stdout).toMatch(QR_BLOCK);
      expect(withQr.stdout).toContain("Scan with any Solana wallet app");
      const noQr = await run(["deposit", "--qr", "--no-qr"], { data });
      expect(noQr.stdout).not.toMatch(QR_BLOCK);
    } finally { srv.stop(); }
  });

  it("aile balance --qr draws one per wallet; --json never does", async () => {
    const rpc = rpcStub();
    const srv = aileStub({ chat: () => Response.json(COMPLETION) });
    try {
      const data = await withLocalWallet({ serverUrl: srv.url, renterToken: `ail_${"a".repeat(48)}`, solanaRpc: rpc.url });
      const res = await run(["balance", "--qr"], { data });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("Account · send USDC on Solana");
      expect(res.stdout).toContain("Own wallet · send USDC on Solana mainnet");
      const json = await run(["balance", "--qr", "--json"], { data });
      expect(json.stdout).not.toMatch(QR_BLOCK);
      expect(() => JSON.parse(json.stdout)).not.toThrow();
    } finally { srv.stop(); rpc.stop(); }
  });

  it("aile wallet --qr draws the account's, and still only GETs /wallet", async () => {
    const srv = aileStub({ chat: () => Response.json(COMPLETION) });
    try {
      const res = await run(["wallet", "--qr"], { data: dataDir({ serverUrl: srv.url, renterToken: `ail_${"a".repeat(48)}` }) });
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(QR_BLOCK);
      expect(res.stdout).toContain(ACCOUNT_ADDR);
      expect([...new Set(srv.calls.map((c) => `${c.method} ${c.path}`))]).toEqual(["GET /wallet"]);
    } finally { srv.stop(); }
  });
});

describe("the account's wallet view does not change because a local one exists", () => {
  it("aile wallet prints only the account wallet, and still only GETs /wallet", async () => {
    const rpc = rpcStub();
    const srv = aileStub({ chat: () => Response.json(COMPLETION) });
    try {
      const data = await withLocalWallet({ serverUrl: srv.url, renterToken: `ail_${"a".repeat(48)}`, solanaRpc: rpc.url });
      const res = await run(["wallet"], { data });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain(ACCOUNT_ADDR);
      expect(res.all).not.toContain(ABANDON_ADDRESS);
      expect(res.all).not.toMatch(/abandon/);
      expect([...new Set(srv.calls.map((c) => `${c.method} ${c.path}`))]).toEqual(["GET /wallet"]);
      expect(rpc.methods).toEqual([]);
    } finally { srv.stop(); rpc.stop(); }
  });
});

describe("the key stays behind one door", () => {
  it("nothing outside the wallet's own commands imports src/localwallet", () => {
    // Statically or dynamically: the only modules allowed to reach the signing
    // code are the two commands that exist to use it. `aile wallet`, `status`,
    // the relay and setup must never load it.
    const SRC = path.join(import.meta.dirname, "..", "src");
    const ALLOWED = new Set(["cli/renter-command.js", "cli/localwallet-command.js"]);
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      if (!rel.endsWith(".js") || rel.startsWith("localwallet/")) continue;
      const text = fs.readFileSync(file, "utf8");
      const reaches = /["']\.\.?\/(?:\.\.\/)*localwallet\//.test(text);
      expect({ rel, reaches: reaches && !ALLOWED.has(rel) }).toEqual({ rel, reaches: false });
    }
  });

  it("and the account API client still exports no way to make or export a wallet", async () => {
    const { api } = await import(path.join(import.meta.dirname, "..", "src", "api", "client.js"));
    for (const name of ["createWallet", "generateWallet", "exportWallet", "privateKey", "signTransaction"]) {
      expect({ name, present: name in api }).toEqual({ name, present: false });
    }
  });
});
