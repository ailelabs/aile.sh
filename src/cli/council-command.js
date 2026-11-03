/**
 * `aile council "<question>"` — one question to 2 to 4 models, then one merged
 * answer. Each model is a paid call, so the receipt says what it was priced on.
 *
 * THROUGH aile's MCP SERVER (`ask_council`), which runs the members side by side
 * under one deadline and merges what came back. It needs an ordinary `sk-aile-`
 * key: a wallet cannot pay several calls at once.
 */

import { connectMcp } from "../api/mcp-client.js";
import { loadConfig } from "../relay/config.js";
import { describeKey } from "../setup/key.js";
import { readPrompt, intFlag } from "./renter-command.js";
import { C } from "./colors.js";
import { die, withSpinner, sym } from "./ui.js";

const money = (n) => (n === null || n === undefined ? "cost unknown" : `$${Number(n).toFixed(6)}`);

export async function cmdCouncil(args, ctx) {
  const config = loadConfig();
  const server = args.server || config.serverUrl;
  const insecure = ctx.checkTransport(server, args);

  // `aile route` and `aile keys suggest` take --key; a council spends on this machine's key only.
  if (args.key !== undefined) die("A council spends from this machine's key, so it takes no --key.", "To use another key, save it here first: aile setup <tool> --key <key>");

  const members = typeof args.members === "string" ? args.members.split(",").map((m) => m.trim()).filter(Boolean) : [];
  if (members.length < 2 || members.length > 4) {
    die("A council takes 2 to 4 models.", "--members claude/claude-sonnet-5-5,codex/gpt-6.1-sol — `aile sharers` lists what is served.");
  }
  if (args.synthesizer === true) die("--synthesizer needs a model.");
  const synthesizer = typeof args.synthesizer === "string" ? args.synthesizer : members[0];

  const maxTokens = intFlag(args["max-tokens"], "--max-tokens") ?? (Number(config.quoteMaxTokens) || 4096);
  const synthMax = intFlag(args["synthesizer-max-tokens"], "--synthesizer-max-tokens");
  // The tool's own default is 55 s, for MCP clients that give up at 60 s. This
  // client waits 120 s, so 110 gives members 66 s rather than 33 s.
  const deadline = intFlag(args.deadline, "--deadline") ?? 110;
  if (deadline < 10 || deadline > 110) die("--deadline must be 10 to 110 seconds.");

  let temperature;
  if (args.temperature !== undefined) {
    temperature = args.temperature === true ? NaN : Number(args.temperature);
    if (!Number.isFinite(temperature)) die(`--temperature must be a number (got "${args.temperature}")`);
  }

  // Before the question is read, so a missing key never waits on stdin.
  if (!config.buyerKey) die("A council needs an API key on this machine.", "Run `aile setup` to get one.");
  if (!args._.slice(1).length && process.stdin.isTTY) {
    die("What should the council answer?", "e.g. `aile council \"which index?\" --members <a>,<b>`, or pipe text in.");
  }
  const question = await readPrompt(args);

  const callArgs = {
    question, members, synthesizer, max_tokens: maxTokens, deadline_seconds: deadline,
    ...(typeof args.system === "string" ? { system: args.system } : {}),
    ...(synthMax ? { synthesizer_max_tokens: synthMax } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
  };

  let mcp;
  try {
    mcp = await withSpinner("Connecting…", connectMcp({ serverUrl: server, insecure, key: config.buyerKey }));
  } catch (e) {
    if (e?.name === "McpCallError") die(e.message, e.code === "unauthorized" ? "Your key was refused — `aile setup refresh --new-key` makes a new one." : null);
    die(...ctx.explainError(e, server));
  }
  let res;
  try {
    res = await withSpinner(`Asking ${members.length} models…`, mcp.callTool("ask_council", callArgs));
  } catch (e) {
    if (e?.name === "McpCallError") die(e.message, e.code === "unauthorized" ? "Your key was refused — `aile setup refresh --new-key` makes a new one." : null);
    // The question was sent: a dropped connection stops nothing on the server, and every member that serves is charged.
    die("The connection failed after the question was sent, so the council may still have run.", "Members that served are charged: check `aile spend` before you ask again.");
  }

  if (res.isError && res.data?.error === "unknown_tool") die("This server has no council yet.", "`aile chat` calls one model at a time.");
  const s = res.structured ?? res.data;
  if (!s?.council_id) die(`The server refused: ${res.data?.message || res.text || "no reason given"}`);

  if (args.json) {
    console.log(JSON.stringify(s, null, 2));
    if (res.isError) process.exitCode = 1;
    return;
  }

  // Answers on stdout, the receipt on stderr, as `aile chat` does.
  const blocks = (s.members ?? []).map((m) => {
    let head = `${C.bold}${m.model}${C.reset}  ${m.status}  ${C.dim}${money(m.cost_usd)}${C.reset}`;
    if (m.finish_reason === "length") head += `${C.dim} (stopped at max_tokens)${C.reset}`;
    if (m.cut_for_merge) head += `${C.dim} (cut for the merge)${C.reset}`;
    const lines = [head, m.answer ?? `${C.dim}${m.error ?? ""}${C.reset}`];
    if (m.data_policy?.notice) lines.push(`${C.dim}${m.data_policy.notice}${C.reset}`);
    return lines.join("\n");
  });
  console.log(blocks.join("\n\n"));
  if (s.merged) {
    console.log(`\n${C.bold}Merged by ${s.synthesizer.model}${C.reset}  ${C.dim}${money(s.synthesizer.cost_usd)}${C.reset}\n${s.answer}`);
  }

  if (s.note) console.error(`${C.dim}${s.note}${C.reset}`);
  const merge = s.synthesizer?.status !== "skipped" ? `, the merge on ${synthMax ?? Math.min(maxTokens * 2, 32000)}` : "";
  // Nothing charged (every call refused, say an empty balance): no "paid" and no charge to look up.
  const charged = !(Number(s.total_cost_usd) === 0 && s.cost_complete !== false);
  console.error(`${C.dim}${[
    charged ? `paid from your balance with key ${describeKey(config.buyerKey)}` : `key ${describeKey(config.buyerKey)}, nothing charged`,
    `${s.cost_complete === false ? "at least " : ""}${money(s.total_cost_usd)} in all`,
    `each member quoted on --max-tokens ${maxTokens}${merge}, not on tokens used`,
    ...(charged ? ["aile spend shows the charge"] : []),
  ].join(` ${sym.dot} `)}${C.reset}`);
  if (!(s.members ?? []).some((m) => m.status === "answered")) console.error(`${C.dim}Nobody answered. If your balance is empty, add funds: aile deposit${C.reset}`);

  if (res.isError) process.exitCode = 1;
}
