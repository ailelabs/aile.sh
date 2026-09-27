/**
 * The buying side, from a terminal:
 *
 *   aile chat "<prompt>" --model <provider/model>   one model call
 *   aile balance                                     what you can spend
 *   aile deposit                                     where to add funds
 *   aile pay <url>                                   any x402 endpoint (your own wallet)
 *   aile agents [query]                              tools other agents offer
 *   aile agents use <listing> <tool> --task "…"      call one, at its flat price
 *
 * TWO WAYS TO PAY, AND THE ACCOUNT'S IS THE DEFAULT. A request carrying the
 * buyer key is debited from the account's balance — the custodial wallet the
 * server holds, which this client never touches. The opt-in self-custody wallet
 * (`aile wallet own create`) pays per call over x402 instead, signing on this
 * machine. `--pay` picks: `balance`, `own`, or `auto` (the balance, and
 * your own wallet only when the balance comes up short).
 *
 * YOUR OWN WALLET'S CODE IS IMPORTED ONLY WHERE IT IS USED. See localwallet/index.js
 * for why; `loadLocal()` below is the one door.
 */

import { api } from "../api/client.js";
import { connectMcp } from "../api/mcp-client.js";
import { loadConfig, saveConfig } from "../relay/config.js";
import { webOrigin } from "../setup/ctx.js";
import { C } from "./colors.js";
import { die, withSpinner, kv, sym } from "./ui.js";
import { isInteractive, promptSecret, promptConfirm } from "./prompt.js";
import { printQr } from "./qr.js";

const loadLocal = () => import("../localwallet/index.js");
/** Is your own wallet set up? Reads for the file only — the signing code stays unloaded. */
const hasLocal = async () => (await import("../localwallet/store.js")).walletExists();

/** The route aile serves each wire format on. */
const ROUTES = {
  openai: "/v1/chat/completions",
  anthropic: "/v1/messages",
};

// ---------------------------------------------------------------------------
// aile chat
// ---------------------------------------------------------------------------

export async function cmdChat(args, ctx) {
  const config = loadConfig();
  const server = args.server || config.serverUrl;
  const insecure = ctx.checkTransport(server, args);

  const prompt = await readPrompt(args);
  const model = args.model || args.m;
  if (!model || model === true) {
    die("Which model?", "Pass --model <provider>/<model>, e.g. --model claude/claude-sonnet-5 — `aile lenders` lists what is served.");
  }
  const pay = String(args.pay || "auto");
  if (!["auto", "balance", "own"].includes(pay)) die(`--pay must be auto, balance or own (got "${pay}")`);

  // ALWAYS AN EXPLICIT CEILING. The price is quoted on it, and the x402 path
  // refuses a request without one. The default is `quoteMaxTokens` — the same
  // number `aile price` quotes and the server assumes when none is named — so a
  // chat costs what `aile price` said it would.
  const maxTokens = intFlag(args["max-tokens"], "--max-tokens") ?? (Number(config.quoteMaxTokens) || 4096);
  const format = args.anthropic ? "anthropic" : "openai";
  const body = requestBody({ format, model: String(model), prompt, system: args.system, maxTokens, temperature: args.temperature });

  // `--pay own` needs no account at all: the payer's address is the principal.
  const key = pay === "own" ? null : await buyerKey(config, { server, insecure });
  const send = (extra = null) => api.inference({
    path: ROUTES[format], body, serverUrl: server, insecure, ...authFor(format, key, extra),
  });

  let res;
  try {
    res = await withSpinner(`Asking ${model}…`, send());
  } catch (e) {
    die(...ctx.explainError(e, server));
  }

  let paidWith = key ? "balance" : null;
  let settlement = null;

  if (res.status === 402) {
    const shortfall = res.body && typeof res.body === "object" ? res.body.balance : null;
    const canLocal = pay === "own" || (pay === "auto" && (await hasLocal()));
    if (!canLocal) {
      explainShortfall(res.body, server, { pay });
      process.exit(1);
    }
    const lw = await loadLocal();
    if (!lw.walletExists()) die("Your own wallet isn't set up on this machine.", "Create one with `aile wallet own create`, or pay from your balance with --pay balance.");
    const challenge = lw.readChallenge(res.headers, res.body);
    if (!challenge) {
      const why = lw.noChallengeReason("The server", res.headers);
      die(why.message, why.hint || "Try --pay balance.");
    }
    if (shortfall && pay === "auto") {
      console.error(`${C.dim}  Balance short — paying this call from your own wallet.${C.reset}`);
    }
    const wallet = await unlockOrDie(lw, args);
    try {
      const paid = await lw.payChallenge({
        challenge,
        wallet,
        maxMicros: lw.capMicros(args, config),
        confirm: (req) => confirmSpend(args, `Pay $${lw.formatMicros(req.amount)} USDC for this call from ${short(wallet.address)}?`),
        retry: (headers) => withSpinner(`Asking ${model}…`, send(headers)),
      });
      res = paid.response;
      settlement = paid.settlement;
      paidWith = "own";
    } catch (e) {
      if (e?.name === "PaymentRefused") die(e.message, e.hint);
      die(...ctx.explainError(e, server));
    }
  }

  if (res.status < 200 || res.status >= 300) {
    const msg = errorText(res.body) || `the server answered ${res.status}`;
    die(`The request failed: ${msg}`, res.status === 401 ? "Your key was refused — `aile setup refresh --new-key` makes a new one." : null);
  }

  if (args.json) {
    console.log(JSON.stringify({ response: res.body, paidWith, settlement }, null, 2));
    return;
  }

  console.log(replyText(res.body));
  const usage = res.body?.usage;
  const tokens = usage ? ` ${sym.dot} ${usage.completion_tokens ?? usage.output_tokens ?? "?"} tokens out` : "";
  if (paidWith === "own") {
    const tx = settlement?.transaction;
    console.error(`${C.dim}\n  paid from your own wallet${tokens}${tx ? ` ${sym.dot} tx ${tx}` : ""}${C.reset}`);
  } else {
    console.error(`${C.dim}\n  paid from your balance${tokens} ${sym.dot} aile spend shows the charge${C.reset}`);
  }
}

// ---------------------------------------------------------------------------
// aile balance
// ---------------------------------------------------------------------------

export async function cmdBalance(args, ctx) {
  const config = loadConfig();
  const server = args.server || config.serverUrl;
  const out = { account: null, own: null };

  if (config.renterToken) {
    const insecure = ctx.checkTransport(server, args);
    try {
      const res = await withSpinner("Reading your balance…", api.wallet({ serverUrl: server, token: config.renterToken, insecure, balance: true }));
      out.account = res.wallet ? {
        address: res.wallet.address,
        usdc: res.wallet.usdc ?? null,
        spendable: res.wallet.spendable ?? res.wallet.usdc ?? null,
        owedMicros: Number(res.wallet.owedMicros || 0),
      } : { address: null, reason: res.reason || null };
    } catch (e) {
      die(...ctx.explainError(e, server));
    }
  }

  // Read-only and without unlocking: the address is stored in the clear.
  if (await hasLocal()) {
    const lw = await loadLocal();
    const info = lw.readWalletInfo();
    const net = lw.network(config);
    const b = await withSpinner("Reading your own wallet…", lw.balances(info.address, net));
    out.own = { address: info.address, network: net.name, usdc: b.usdc, sol: b.sol };
  }

  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (!out.account && !out.own) {
    die("Nothing to show yet.", "Sign in with `aile login` for an account balance, or create your own wallet with `aile wallet own create`.");
  }

  console.log();
  if (out.account) {
    if (!out.account.address) {
      console.log(`  ${C.bold}Account${C.reset}  ${C.dim}${out.account.reason || "no wallet on this account"}${C.reset}`);
    } else {
      const spend = out.account.spendable === null ? `${C.dim}could not be read just now${C.reset}` : `${C.green}$${out.account.spendable}${C.reset} spendable`;
      console.log(`  ${C.bold}Account${C.reset}  ${spend}${out.account.owedMicros > 0 ? `  ${C.dim}($${out.account.usdc} held, some owed for served requests)${C.reset}` : ""}`);
      console.log(`           ${C.dim}pays requests made with your API key${C.reset}`);
    }
  }
  if (out.own) {
    const usdc = out.own.usdc === null ? `${C.dim}USDC unreadable${C.reset}` : `${C.green}$${out.own.usdc}${C.reset} USDC`;
    const sol = out.own.sol === null ? "" : `  ${C.dim}${out.own.sol} SOL${C.reset}`;
    console.log(`  ${C.bold}Own${C.reset}      ${usdc}${sol}  ${C.dim}(${out.own.network})${C.reset}`);
    console.log(`           ${C.dim}${out.own.address} — pays per call with --pay own${C.reset}`);
  }
  if (args.qr) {
    if (out.account?.address) printQr(out.account.address, { caption: `${C.dim}Account ${sym.dot} send USDC on Solana${C.reset}` });
    if (out.own) printQr(out.own.address, { caption: `${C.dim}Own wallet ${sym.dot} send USDC on Solana ${out.own.network}${C.reset}` });
  }
  console.log(`\n  ${C.dim}Add funds: ${C.reset}${C.cyan}aile deposit${C.reset}${args.qr ? "" : `${C.dim} ${sym.dot} a QR code to scan: ${C.reset}${C.cyan}aile balance --qr${C.reset}`}\n`);
}

// ---------------------------------------------------------------------------
// aile deposit
// ---------------------------------------------------------------------------

export async function cmdDeposit(args, ctx) {
  const config = loadConfig();
  ctx.requireToken(config);
  const server = args.server || config.serverUrl;
  const insecure = ctx.checkTransport(server, args);

  let res;
  try {
    res = await withSpinner("Reading your deposit address…", api.wallet({ serverUrl: server, token: config.renterToken, insecure, balance: true }));
  } catch (e) {
    die(...ctx.explainError(e, server));
  }
  if (!res.wallet?.address) die(res.reason || "This account has no wallet to deposit into.");
  const to = res.wallet.address;
  const page = `${webOrigin(server)}/dash?tab=wallet&focus=deposit`;

  const amount = args["from-own"];
  if (amount !== undefined) {
    if (amount === true) die("How much? e.g. `aile deposit --from-own 5` sends 5 USDC.");
    const lw = await loadLocal();
    if (!lw.walletExists()) die("Your own wallet isn't set up on this machine.", "Create one with `aile wallet own create`.");
    const wallet = await unlockOrDie(lw, args);
    const ok = await confirmSpend(args, `Send ${amount} USDC from your own wallet to your account (${short(to)})?`, { requireYesOffTty: true });
    if (!ok) die("Cancelled — nothing was sent.");
    try {
      const sent = await withSpinner("Sending…", lw.sendFromLocal({ wallet, token: "USDC", amount, to }));
      if (args.json) return void console.log(JSON.stringify({ to, amount: String(amount), ...sent }, null, 2));
      console.log(`\n  ${C.green}${sym.ok}${C.reset} Sent ${amount} USDC to your account.`);
      console.log(`    ${C.dim}${sent.explorer}${C.reset}`);
      console.log(`    ${C.dim}It is spendable as soon as the chain confirms it — check with${C.reset} ${C.cyan}aile balance${C.reset}\n`);
    } catch (e) {
      die(`The transfer failed: ${e.message}`);
    }
    return;
  }

  if (args.json) {
    console.log(JSON.stringify({ address: to, asset: "USDC", chain: "solana", page }, null, 2));
    return;
  }
  console.log();
  console.log(kv([
    ["Send", "USDC on Solana"],
    ["To", `${C.cyan}${to}${C.reset}`],
  ]));
  if (showQr(args)) printQr(to, { caption: `${C.dim}Scan with any Solana wallet app${C.reset}` });
  console.log(`\n  ${C.dim}It counts toward your balance as soon as it lands — no claim step. SOL,${C.reset}`);
  console.log(`  ${C.dim}USDT and $AILE sent here are converted to USDC for you.${C.reset}`);
  console.log(`\n  ${C.dim}Card or QR code:${C.reset} ${C.cyan}${page}${C.reset}`);
  console.log(`  ${C.dim}From your own wallet:${C.reset} ${C.cyan}aile deposit --from-own <amount>${C.reset}\n`);
}

// ---------------------------------------------------------------------------
// aile pay <url>
// ---------------------------------------------------------------------------

export async function cmdPay(args, ctx) {
  const url = args._[1];
  if (!url) die("Which URL?", "e.g. `aile pay https://example.com/paid --method POST --body '{\"q\":1}'`");
  let target;
  try { target = new URL(url); } catch { die(`That is not a URL: ${url}`); }
  if (target.protocol !== "https:" && !args.insecure) die("Refusing to pay over plain http.", "Pass --insecure for a local test server.");

  const method = String(args.method || (args.body ? "POST" : "GET")).toUpperCase();
  let body;
  if (args.body !== undefined) {
    try { body = JSON.parse(String(args.body)); } catch { die("--body must be JSON."); }
  }

  const lw = await loadLocal();
  if (!lw.walletExists()) die("`aile pay` pays from your own wallet, and there is none on this machine.", "Create one with `aile wallet own create`.");
  const config = loadConfig();

  const send = async (extra = {}) => {
    const res = await fetch(target, {
      method,
      headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extra },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });
    const text = await res.text();
    let parsed = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* text */ }
    return { status: res.status, headers: res.headers, body: parsed };
  };

  let res;
  try {
    res = await withSpinner(`Calling ${target.host}…`, send());
  } catch (e) {
    die(`Could not reach ${target.host}: ${e.message}`);
  }

  let settlement = null;
  if (res.status === 402) {
    const challenge = lw.readChallenge(res.headers, res.body);
    if (!challenge) {
      const why = lw.noChallengeReason(target.host, res.headers);
      die(why.message, why.hint);
    }
    const wallet = await unlockOrDie(lw, args);
    try {
      const paid = await lw.payChallenge({
        challenge,
        wallet,
        maxMicros: lw.capMicros(args, config),
        confirm: (req) => confirmSpend(args, `Pay $${lw.formatMicros(req.amount)} USDC to ${short(req.payTo)} for ${target.host}?`),
        retry: (headers) => withSpinner(`Calling ${target.host}…`, send(headers)),
      });
      res = paid.response;
      settlement = paid.settlement;
    } catch (e) {
      if (e?.name === "PaymentRefused") die(e.message, e.hint);
      die(`Payment failed: ${e.message}`);
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ status: res.status, body: res.body, settlement }, null, 2));
    return;
  }
  const shown = typeof res.body === "string" ? res.body : JSON.stringify(res.body, null, 2);
  console.log(shown);
  if (res.status >= 400) {
    console.error(`${C.red}\n  ${target.host} answered ${res.status}${C.reset}`);
    process.exitCode = 1;
  } else if (settlement?.transaction) {
    console.error(`${C.dim}\n  paid from your own wallet ${sym.dot} tx ${settlement.transaction}${C.reset}`);
  }
}

// ---------------------------------------------------------------------------
// aile agents — tools OTHER AGENTS offer (not models: that is `aile chat`)
// ---------------------------------------------------------------------------

/**
 * `aile agents [query]` lists what other agents offer; `aile agents use <listing>
 * <tool> --task "…"` calls one tool at its flat price per call.
 *
 * THROUGH aile's MCP SERVER, because that is where this product lives: the listing
 * search, the argument allow-list the lender is protected by, and the payment
 * rules. Paid from the account balance with the buyer key, or — `--pay own`, or
 * `auto` when the balance comes up short — per call from your own wallet, the
 * price coming back as a tool result that is signed and sent again.
 */
export async function cmdAgents(args, ctx) {
  if (args._[1] === "use") return agentsUse(args, ctx);
  const config = loadConfig();
  const server = args.server || config.serverUrl;
  const insecure = ctx.checkTransport(server, args);
  const query = args._.slice(1).join(" ") || null;
  const limit = intFlag(args.limit, "--limit") ?? 24;

  let found;
  try {
    // Browsing is public: a key is sent only when one is already saved.
    const mcp = await withSpinner("Looking for agents' tools…", connectMcp({ serverUrl: server, insecure, key: config.buyerKey || null }));
    found = await mcp.callTool("find_agent_tools", { ...(query ? { q: query } : {}), limit });
  } catch (e) {
    die(...ctx.explainError(e, server));
  }
  if (found.isError) die(`The server refused: ${found.data?.message || found.text}`);
  const rows = found.data?.lenders ?? [];

  if (args.json) {
    console.log(JSON.stringify({ lenders: rows, total: rows.length }, null, 2));
    return;
  }
  if (!rows.length) {
    console.log(`
  ${C.dim}No agents are offering tools${query ? ` matching "${query}"` : ""} right now.${C.reset}`);
    console.log(`  ${C.dim}For an AI model instead:${C.reset} ${C.cyan}aile chat "…" --model <m>${C.reset} ${C.dim}(see${C.reset} ${C.cyan}aile lenders${C.reset}${C.dim})${C.reset}
`);
    return;
  }
  console.log();
  for (const r of rows) {
    const price = `$${(Number(r.pricePerCallMicros || 0) / 1e6).toFixed(r.pricePerCallMicros >= 10_000 ? 2 : 4)}`;
    const state = r.online ? `${C.green}online${C.reset}` : `${C.dim}offline${C.reset}`;
    console.log(`  ${C.bold}${r.name}${C.reset}  ${C.green}${price}${C.reset}${C.dim}/call${C.reset}  ${state}  ${C.dim}trust ${r.trust ?? "?"}${C.reset}`);
    console.log(`    ${C.dim}listing${C.reset} ${C.cyan}${r.lenderId}${C.reset}`);
    if (r.description) console.log(`    ${C.dim}${String(r.description).slice(0, 160)}${C.reset}`);
    const tools = (r.tools ?? []).map((t) => t.name).filter(Boolean);
    if (tools.length) console.log(`    ${C.dim}tools:${C.reset} ${tools.slice(0, 8).join(", ")}${tools.length > 8 ? ` ${C.dim}+${tools.length - 8}${C.reset}` : ""}`);
    console.log();
  }
  console.log(`  ${C.dim}Call one:${C.reset} ${C.cyan}aile agents use <listing> <tool> --task "…"${C.reset}\n`);
}

async function agentsUse(args, ctx) {
  const [, , lenderId, tool] = args._;
  if (!lenderId || !tool) die("usage: aile agents use <listing> <tool> --task \"…\"", "`aile agents` lists listings and their tools.");
  const task = typeof args.task === "string" ? args.task : null;
  if (!task) die("What should the other agent do?", "Pass --task \"…\" — it is sent to the other agent as text.");
  let toolArgs;
  if (args.args !== undefined) {
    try { toolArgs = JSON.parse(String(args.args)); } catch { die("--args must be JSON, e.g. --args '{\"q\":1}'."); }
    if (!toolArgs || typeof toolArgs !== "object" || Array.isArray(toolArgs)) die("--args must be a JSON object.");
  }
  const pay = String(args.pay || "auto");
  if (!["auto", "balance", "own"].includes(pay)) die(`--pay must be auto, balance or own (got "${pay}")`);

  const config = loadConfig();
  const server = args.server || config.serverUrl;
  const insecure = ctx.checkTransport(server, args);
  const key = pay === "own" ? null : await buyerKey(config, { server, insecure });
  const callArgs = { lenderId, tool, task, ...(toolArgs ? { arguments: toolArgs } : {}) };

  let mcp;
  let res;
  try {
    mcp = await withSpinner("Connecting…", connectMcp({ serverUrl: server, insecure, key }));
    res = await withSpinner(`Calling ${tool}…`, mcp.callTool("use_agent_tool", callArgs));
  } catch (e) {
    die(...ctx.explainError(e, server));
  }

  // The price comes back as the tool RESULT (`paymentRequired`), not an HTTP 402.
  let paidWith = key ? "balance" : null;
  let settlement = null;
  const challenge = res.isError ? (res.structured ?? res.data) : null;
  if (challenge?.paymentRequired || (res.isError && Array.isArray(challenge?.accepts))) {
    const canOwn = pay === "own" || (pay === "auto" && (await hasLocal()));
    if (!canOwn) {
      console.error(`\n  ${C.red}${sym.fail}${C.reset} ${challenge.error || "Payment required."}`);
      console.error(`    ${C.dim}Add funds with \`aile deposit\`, or pay per call from your own wallet (\`aile wallet own create\`, then --pay own).${C.reset}\n`);
      process.exit(1);
    }
    const lw = await loadLocal();
    if (!lw.walletExists()) die("Your own wallet isn't set up on this machine.", "Create one with `aile wallet own create`, or pay from your balance with --pay balance.");
    const wallet = await unlockOrDie(lw, args);
    try {
      const paid = await lw.payChallenge({
        challenge,
        wallet,
        maxMicros: lw.capMicros(args, config),
        confirm: (req) => confirmSpend(args, `Pay $${lw.formatMicros(req.amount)} USDC to ${short(req.payTo)} for ${tool}?`),
        retry: async (headers) => {
          const again = await withSpinner(`Calling ${tool}…`, mcp.callTool("use_agent_tool", callArgs, { headers }));
          return { status: again.isError ? 402 : 200, headers: new Headers(), body: again };
        },
      });
      res = paid.response.body;
      settlement = res.raw?._meta?.["x402/payment-response"] ?? null;
      paidWith = "own";
    } catch (e) {
      if (e?.name === "PaymentRefused") die(e.message, e.hint);
      die(...ctx.explainError(e, server));
    }
  }

  if (res.isError) {
    const msg = res.data?.message || res.data?.error || res.text || "the call failed";
    die(`${tool} failed: ${msg}`, res.data?.error === "lender_unavailable" ? "That listing is offline or not available — `aile agents` shows what is." : null);
  }
  if (args.json) {
    console.log(JSON.stringify({ result: res.data ?? res.text, paidWith, settlement }, null, 2));
    return;
  }
  const out = res.data ?? res.text;
  console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
  const tx = settlement?.transaction;
  console.error(`${C.dim}\n  ${paidWith === "own" ? "paid from your own wallet" : "paid from your balance"}${tx ? ` ${sym.dot} tx ${tx}` : ""}${C.reset}`);
}

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

/**
 * Whether a funding screen draws its QR code: yes on a terminal, no in a pipe
 * or a log (where 19 lines of blocks are noise), `--qr` / `--no-qr` to decide.
 */
export function showQr(args) {
  if (args["no-qr"]) return false;
  return Boolean(args.qr) || Boolean(process.stdout.isTTY);
}

/** The prompt: positional words, or stdin when it is `-` or omitted from a pipe. */
async function readPrompt(args) {
  const words = args._.slice(1);
  if (words.length === 1 && words[0] === "-") return readStdin();
  if (words.length) return words.join(" ");
  if (!process.stdin.isTTY) return readStdin();
  die("What should it answer?", "e.g. `aile chat \"explain this error\" --model claude/claude-sonnet-5`, or pipe text in.");
}

async function readStdin() {
  let buf = "";
  for await (const chunk of process.stdin) buf += chunk;
  const text = buf.trim();
  if (!text) die("Nothing came in on stdin.");
  return text;
}

function intFlag(v, name) {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  if (v === true || !Number.isInteger(n) || n <= 0) die(`${name} must be a positive whole number (got "${v}")`);
  return n;
}

export function requestBody({ format, model, prompt, system, maxTokens, temperature }) {
  const temp = temperature !== undefined && temperature !== true ? Number(temperature) : undefined;
  if (temp !== undefined && !Number.isFinite(temp)) die(`--temperature must be a number (got "${temperature}")`);
  if (format === "anthropic") {
    return {
      model,
      max_tokens: maxTokens,
      ...(system && system !== true ? { system: String(system) } : {}),
      messages: [{ role: "user", content: prompt }],
      ...(temp !== undefined ? { temperature: temp } : {}),
    };
  }
  return {
    model,
    max_tokens: maxTokens,
    messages: [
      ...(system && system !== true ? [{ role: "system", content: String(system) }] : []),
      { role: "user", content: prompt },
    ],
    ...(temp !== undefined ? { temperature: temp } : {}),
  };
}

/** Anthropic's route reads `x-api-key`; OpenAI's reads the bearer. */
function authFor(format, key, extra) {
  if (!key) return { extraHeaders: extra };
  if (format === "anthropic") {
    return { extraHeaders: { "x-api-key": key, "anthropic-version": "2023-06-01", ...(extra || {}) } };
  }
  return { key, extraHeaders: extra };
}

/**
 * The buyer key for `aile chat`: the one `aile setup` saved, or — on a signed-in
 * machine — a new one minted on the account and saved the same way, so the next
 * chat and `aile run` reuse it. Never the browser flow: that is `aile setup`'s.
 */
async function buyerKey(config, { server, insecure }) {
  if (config.buyerKey) return config.buyerKey;
  if (config.renterToken) {
    try {
      const made = await api.createKey({ serverUrl: server, insecure, token: config.renterToken, name: "aile chat" });
      if (made?.secret) {
        saveConfig({ buyerKey: made.secret });
        return made.secret;
      }
    } catch { /* fall through to the hint */ }
  }
  die(
    "No API key on this machine.",
    "Run `aile setup` to get one, or pay per call from your own wallet with --pay own.",
  );
}

function explainShortfall(body, server, { pay }) {
  const bal = body && typeof body === "object" ? body.balance : null;
  const deposit = "Add funds with `aile deposit`" + (pay === "balance" ? "." : ", or create your own wallet (`aile wallet own create`) to pay per call.");
  if (bal) {
    const need = (Number(bal.neededMicros || 0) / 1e6).toFixed(6);
    const have = (Number(bal.spendableMicros || 0) / 1e6).toFixed(6);
    console.error(`\n  ${C.red}${sym.fail}${C.reset} Not enough balance — this call needs $${need}, you have $${have} spendable.`);
  } else {
    console.error(`\n  ${C.red}${sym.fail}${C.reset} ${errorText(body) || "Payment required."}`);
  }
  console.error(`    ${C.dim}${deposit}${C.reset}\n`);
}

async function unlockOrDie(lw, args) {
  try {
    const passphrase = await lw.resolvePassphrase(args, {
      prompt: (q) => promptSecret(q),
      interactive: isInteractive(),
    });
    return await withSpinner("Unlocking your own wallet…", lw.unlock(passphrase));
  } catch (e) {
    die(e.message, e.name === "WalletLockedError" ? "Pass --passphrase, or set AILE_WALLET_PASSPHRASE." : null);
  }
}

/**
 * Ask before money moves. On a terminal: a question, unless --yes. Off one: the
 * cap alone decides for per-call payments, but a transfer of an arbitrary
 * amount (`requireYesOffTty`) needs --yes — a script must say so on purpose.
 */
async function confirmSpend(args, question, { requireYesOffTty = false } = {}) {
  if (args.yes) return true;
  if (!isInteractive()) {
    if (requireYesOffTty) die("Refusing to send without a terminal to confirm on.", "Pass --yes to send from a script.");
    return true;
  }
  return promptConfirm(`  ${question}`, { defaultYes: false });
}

export function replyText(body) {
  if (!body || typeof body !== "object") return String(body ?? "");
  const oa = body.choices?.[0]?.message?.content;
  if (typeof oa === "string") return oa;
  if (Array.isArray(body.content)) {
    return body.content.filter((b) => b?.type === "text").map((b) => b.text).join("");
  }
  return JSON.stringify(body, null, 2);
}

function errorText(body) {
  if (!body) return "";
  if (typeof body === "string") return body.slice(0, 300);
  const e = body.error;
  if (typeof e === "string") return e;
  if (e?.message) return e.message;
  return body.message || "";
}

const short = (a) => (a && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
