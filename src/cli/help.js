/**
 * Help: a short map of the commands, and a page per command.
 *
 * `aile --help` used to be one 170-line screen, and it was also what a typo
 * printed — so the one line that mattered ("Unknown command") scrolled away
 * under everything else. Now the overview fits on a screen, each command has
 * its own page (`aile <command> --help`, or `aile help <command>`), and a typo
 * gets a suggestion instead of the manual.
 *
 * Every page here is data, so the overview, the per-command page and the
 * did-you-mean all read from one table and cannot disagree about what exists.
 */

import { C } from "./colors.js";
import { heading, dim, cmd, padTo, width, bad, termWidth, wrap, sym } from "./ui.js";

/**
 * `examples` are `[command line, what it does]`; `notes` are the paragraphs a
 * reader needs to use the command well, shown dim under the examples.
 */
export const COMMANDS = [
  // --- Coding tools --------------------------------------------------------
  {
    name: "setup", group: "tools", summary: "set up Claude Code, Codex, opencode, … to use aile",
    examples: [
      ["aile setup", "pick from the tools installed here, approve a key, done"],
      ["aile setup claude codex", "just these (shortcuts claudeaile, codexaile)"],
      ["aile setup --mode default", "make aile the default in Claude Code and Codex"],
      ["aile setup --all --yes", "every tool found, no questions (scripts)"],
      ["aile setup status", "what is set up, and where"],
      ["aile setup refresh", "give every set-up tool the current key"],
      ["aile setup refresh --new-key", "…or a new one (revoked key, other account)"],
      ["aile setup --remove", "put every file back as it was, forget the key"],
      ["aile setup --remove --revoke", "…and revoke the key on your account"],
      ["aile setup --key -", "use an existing key, read from stdin"],
      ["aile setup --new-key", "mint a fresh key instead of reusing the saved one"],
      ["aile setup claude --shortcut-name cc-aile", "choose the shortcut's name"],
      ["aile setup --dry-run", "show what would change, write nothing"],
    ],
    notes: [
      "Not signed in? setup opens your browser to approve an API key — the machine is not signed in and your other machines stay signed in.",
      "Cursor, Cline, Continue, Zed and the VS Code extension keep their settings in the app, so setup prints the three values to paste instead.",
    ],
  },
  {
    name: "detect", aliases: ["tools"], group: "tools", summary: "which coding tools are installed here, and where",
    examples: [
      ["aile detect", "installed tools, versions, and what setup does for each"],
      ["aile detect --json", "the same, for a script"],
      ["aile detect --fast", "skip reading versions"],
    ],
  },
  {
    name: "run", group: "tools", summary: "start a tool through aile without changing it",
    examples: [
      ["aile run claude", "Claude Code on aile; your own `claude` is untouched"],
      ["aile run codex exec \"fix the test\"", "everything after the tool name goes to the tool"],
      ["aile run --model cc/claude-opus-5 aider", "aile's own flags go before the tool name"],
    ],
    notes: ["Works for claude, codex, qwen, aider and goose. The key travels in the tool's environment, never on its command line."],
  },
  {
    name: "env", group: "tools", summary: "print the environment, for any other launcher",
    examples: [
      ["eval \"$(aile env claude)\"", "set Claude Code's variables in this shell"],
      ["aile env --shell powershell codex", "sh, fish, powershell or cmd"],
    ],
  },
  {
    name: "doctor", group: "tools", summary: "check the key, the server and each tool",
    examples: [["aile doctor", "what works, what does not, and the command that fixes it"]],
  },

  // --- Buying ----------------------------------------------------------------
  {
    name: "lenders", aliases: ["market"], group: "buy", summary: "who is lending, and what they charge",
    examples: [
      ["aile lenders", "everyone online, cheapest first"],
      ["aile lenders --model gpt-5.2", "with what each would charge for it"],
      ["aile lenders --max-price 8", "under $8 per million tokens, both ways"],
      ["aile lenders --verified", "attested subscriptions only"],
      ["aile lenders --provider codex", "offering that subscription"],
      ["aile lenders --seller L4f1a…", "one seller, whichever machine is free"],
      ["aile lenders --node a3f19c2…", "one specific machine"],
      ["aile lenders --min-served 100", "with a track record behind them"],
      ["aile lenders --free", "with capacity free this second"],
      ["aile lenders --sort served|free|uptime|price", "the reading order"],
      ["aile lenders --json", "the same, for a script"],
    ],
    notes: [
      "Filters combine, and every one narrows: --verified --max-price 8 is both.",
      "The first five have a header twin so a choice you make here is one you can act on — `x-aile-max-price`, `x-aile-verified`, `x-aile-provider`, `x-aile-lender`, `x-aile-node`.",
      "--seller is the person and --node is the box: a lender may run several.",
      "--min-served, --free and --sort change only what you read; requests are always routed cheapest-first, which is also the default order here.",
      "A /v1 request's model must be <provider>/<model> (cc/claude-sonnet-5, local/llama3), or a bare id with x-aile-provider. A bare id alone is a 400.",
    ],
  },
  {
    name: "price", aliases: ["quote"], group: "buy", summary: "what one request would cost, at each rate",
    examples: [
      ["aile price gpt-5.2", "at each lender's rate"],
      ["aile price gpt-5.2 --max-tokens 1024", "what the NEXT one would cost at that output ceiling"],
      ["aile price gpt-5.2 --in 3000", "assume this many input tokens"],
    ],
    notes: [
      "Output is priced at the max_tokens your request authorises, not at the reply that comes back — so that field is the one lever you hold over your own bill, and aile price is where you can see it move. It sends nothing.",
      "aile stats and aile spend are counted from the ledger — one row per served request. Nothing here is typed by anyone, which is why there are no ratings to read.",
    ],
  },
  {
    name: "spend", group: "buy", summary: "what each lender has cost you",
    examples: [["aile spend", "your buying: what each lender charged you"], ["aile spend --json", "the same, for a script"]],
  },

  // --- Lending ---------------------------------------------------------------
  {
    name: "login", group: "lend", summary: "sign in and register this machine (paid)",
    examples: [
      ["aile login", "opens your browser; or paste a token"],
      ["aile login --paste", "approve elsewhere, paste the token here"],
      ["aile login --token <token>", "non-interactive (scripts, images)"],
    ],
    notes: ["Signing in as a different account offers to move your coding tools' key to it (--yes accepts)."],
  },
  {
    name: "connect", group: "lend", summary: "connect an AI account to lend (no name = pick one)",
    examples: [
      ["aile connect", "pick from a list; also shows which providers take a key"],
      ["aile connect codex", "a subscription, through the provider's own sign-in"],
      ["aile connect openrouter", "an API key, prompted and masked"],
      ["echo $KEY | aile connect groq --key -", "read the key from a pipe, for scripts"],
      ["aile connect groq --key <key>", "the key as an argument"],
      ["aile connect groq --nodeless", "let it serve while this machine is off"],
      ["aile connect codex --label work", "connect a second one and name it"],
      ["aile connect codex --account work", "same account across re-links, when the provider identifies nothing itself"],
      ["aile connect codex --replace 2", "rotate the credential on one you already have"],
    ],
    notes: [
      "An API key is billed to you per token, with no monthly ceiling to stop at.",
      "--nodeless removes your kill switch: turning this node off no longer stops it, only `aile nodeless <n> off` does. Keys only — a subscription is relayed through your node on purpose.",
      "Personal and work subscriptions have separate quotas, so both earn.",
    ],
  },
  {
    name: "accounts", group: "lend", summary: "show connected accounts, numbered",
    examples: [["aile accounts", "numbered per provider — the numbers other commands take"], ["aile accounts --json", "the same, for a script"]],
  },
  {
    name: "capacity", group: "lend", summary: "everything this machine lends, by kind",
    examples: [["aile capacity", "subscriptions, keys and your own model"], ["aile capacity --json", "the same, for a script"]],
    notes: ["They differ in what stops them: a plan's ceiling, your invoice, or nothing. Only the first two are blind."],
  },
  {
    name: "label", aliases: ["rename"], group: "lend", summary: "name an account",
    examples: [["aile label 2 \"work account\"", "by its number from aile accounts"]],
  },
  {
    name: "retest", aliases: ["recheck"], group: "lend", summary: "re-check a credential from the server",
    examples: [["aile retest", "every account"], ["aile retest 2", "one account"]],
  },
  {
    name: "usage", aliases: ["quota"], group: "lend", summary: "quota each provider reports, per account",
    examples: [["aile usage", "per account"], ["aile usage --json", "the same, for a script"]],
  },
  {
    name: "nodeless", group: "lend", summary: "serve an API key with no machine in the path",
    examples: [["aile nodeless 2 on", "serve it even while this machine is off"], ["aile nodeless 2 off", "only through this machine"]],
  },
  {
    name: "rates", group: "lend", summary: "what you charge, and what you will not serve",
    examples: [
      ["aile rates", "margin, per-model prices, what is off"],
      ["aile rates --margin 0.9", "0 (free) to 1 (list price), on every model"],
      ["aile rates set <model> --in 3 --out 15", "dollars per million tokens, up to list"],
      ["aile rates clear <model>", "back to the margin"],
      ["aile rates off <model>", "stop serving one model"],
      ["aile rates on <model>", "serve it again"],
    ],
    notes: ["Prices are per model, not per account: two keys of one provider share a price sheet. `aile price <model>` is the other direction — what a request would COST you at everyone else's rates."],
  },
  {
    name: "disconnect", group: "lend", summary: "remove a connected account",
    examples: [["aile disconnect 2", "by number, not by id"], ["aile disconnect 2 --yes", "without the confirmation"]],
  },
  {
    name: "local", group: "lend", summary: "lend a model running on this machine",
    examples: [
      ["aile local http://127.0.0.1:11434", "Ollama, vLLM, LM Studio, llama.cpp"],
      ["aile local --off", "stop lending it"],
    ],
    notes: ["This traffic is not blind — it runs on your machine, so your machine reads those prompts."],
  },
  {
    name: "mcp", group: "lend", summary: "lend an MCP server running on this machine",
    examples: [
      ["aile mcp", "what is declared, and whether it can run"],
      ["aile mcp check", "validate the file, print the exact argv"],
      ["aile mcp test <id>", "start it here and list its tools"],
      ["aile mcp path", "where mcp-servers.json lives"],
    ],
    notes: ["Declared in mcp-servers.json next to your config. Each rented session runs in its own throwaway container: read-only root, no host filesystem, no network unless you name hosts. No sandbox, no lending — there is no unsandboxed fallback."],
  },
  {
    name: "start", group: "lend", summary: "run this machine as a relay node",
    examples: [["aile start", "serve until you stop it (Ctrl+C)"]],
    notes: ["Check on it from another terminal with aile status."],
  },
  {
    name: "status", group: "lend", summary: "this machine, your tools, and what to do next",
    examples: [["aile status", "the overview"], ["aile status --json", "the same, for a script"]],
  },
  {
    name: "stats", group: "lend", summary: "what each of your machines has served",
    examples: [["aile stats", "requests served and earned, per machine"], ["aile stats --json", "the same, for a script"]],
  },
  {
    name: "wallet", aliases: ["payout"], group: "lend", summary: "your balance, and where earnings land",
    examples: [["aile wallet", "balance and address"], ["aile wallet --json", "the same, for a script"]],
    notes: ["One account, one wallet, made for you when you sign in. Earnings arrive there in USDC on Solana. To send it on, open /wallet/withdraw in a browser and paste the address to send to — nothing is kept on file, so a withdrawal says where it is going at the moment you make it, and nobody who reaches your account can point your earnings anywhere in advance."],
  },
  {
    name: "donate", aliases: ["contribute"], group: "lend", summary: "contribute this machine (unpaid, no account)",
    examples: [["aile donate", "no sign-up; this machine starts helping"], ["aile donate --yes", "skip the confirmation, for images"]],
    notes: ["Buyers still pay the normal rate — you are donating the earnings, not the price. Nothing accrues, and nothing can be claimed later. Run `aile login` instead to be paid for the same work."],
  },

  // --- Account & client --------------------------------------------------------
  {
    name: "config", aliases: ["settings"], group: "account", summary: "read or change settings",
    examples: [
      ["aile config", "list every setting and what it does"],
      ["aile config maxConcurrent 8", "change one"],
      ["aile config --reset", "restore defaults (keeps your sign-in and your key)"],
      ["aile config --path", "where the file lives"],
    ],
  },
  {
    name: "logout", group: "account", summary: "sign out",
    examples: [["aile logout", "sign this machine out"], ["aile logout --tools", "also take aile out of your coding tools, and revoke their key"]],
  },
  {
    name: "register", group: "account", summary: "register this machine with a token you already have",
    examples: [["aile register --token <token>", "enrol without the browser step"]],
  },
  {
    name: "update", aliases: ["upgrade"], group: "account", summary: "check for, and install, a newer aile.sh",
    examples: [["aile update", "asks before installing"], ["aile update --yes", "no question (scripts)"]],
    notes: ["A one-line notice appears above other commands when a newer version is out. Silence it with AILE_NO_UPDATE_CHECK=1."],
  },
  { name: "help", group: "account", summary: "this overview, or one command's page", examples: [["aile help setup", "one command's page"]] },
];

export const GLOBAL_OPTIONS = [
  ["--server <url>", "point at a different server"],
  ["--insecure", "allow plain http:// (staging only)"],
  ["--json", "machine-readable output, on the commands that read"],
  ["--yes", "skip confirmations"],
  ["--help, -h", "help for any command"],
  ["--version, -v", "print this client's version"],
];

const byName = new Map();
for (const c of COMMANDS) {
  byName.set(c.name, c);
  for (const a of c.aliases || []) byName.set(a, c);
}

/** The command a name or alias refers to, or null. */
export function findCommand(name) {
  return byName.get(String(name || "").toLowerCase()) || null;
}

/** Every name a user can type. */
export function commandNames() {
  return [...byName.keys()];
}

function distance(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      // A swap of neighbours ("stauts") costs one, not two.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

/**
 * The closest known names to `input`, best first: within two edits, or the
 * input is the start of a name ("stat" → status, stats). Works for any list —
 * commands, providers, tools, settings.
 */
export function suggest(input, names, { max = 2 } = {}) {
  const s = String(input || "").toLowerCase();
  if (!s) return [];
  const scored = [];
  for (const n of new Set(names)) {
    const l = n.toLowerCase();
    const dist = distance(s, l);
    if (dist <= (s.length <= 3 ? 1 : 2) || (s.length >= 3 && l.startsWith(s))) scored.push([n, dist]);
  }
  return scored.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).slice(0, max).map(([n]) => n);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const GROUPS = [
  ["tools", "Use aile from your coding tools"],
  ["buy", "Buy"],
  ["lend", "Lend"],
  ["account", "Account"],
];

/**
 * Wrap dim prose to the terminal, indented. Not wrapped at all when stdout is
 * not a terminal: a file or a pipe wraps for itself, and a phrase split across
 * two lines is one a script (or a test) can no longer find.
 */
function para(text, { indent = 2, columns = process.stdout.isTTY ? Math.min(termWidth(), 96) : Infinity } = {}) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    if (line && width(line) + 1 + width(w) > columns - indent) { lines.push(line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.map((l) => `${" ".repeat(indent)}${C.dim}${l}${C.reset}`).join("\n");
}

/**
 * `  left   right`, with `right` wrapped under its own column when the terminal
 * is too narrow for it — rather than wrapped by the terminal back to column 0,
 * where it reads as the start of the next command. Unwrapped off a terminal.
 */
function twoCol(left, right, w) {
  const indent = 2 + w + 2;
  const head = `  ${padTo(left, w)}  `;
  const avail = (process.stdout.isTTY ? termWidth() : Infinity) - indent;
  if (!Number.isFinite(avail) || width(right) < avail || avail < 16) return `${head}${dim(right)}`;
  const parts = wrap(right, { indent: 0, columns: avail }).split("\n");
  return parts.map((p, i) => `${i ? " ".repeat(indent) : head}${dim(p)}`).join("\n");
}

/** Commands in `text` written as `aile …` are shown as commands, not quoted. */
const codeSpans = (text) => String(text).replace(/`([^`]+)`/g, `${C.reset}${C.cyan}$1${C.reset}${C.dim}`);

/**
 * The overview: every command in one line, grouped, fitting one screen. The
 * commands a new user needs are spelled out; the rest of each group is one
 * dotted line, because a list of twenty-five commands is where the eye stops.
 */
export function overview() {
  const lines = [heading("aile.sh", "use and lend AI models, paid per request"), ""];
  const PRIMARY = {
    tools: ["setup", "detect", "run", "doctor"],
    buy: ["lenders", "price", "spend"],
    lend: ["login", "connect", "start", "status"],
    account: ["config", "update"],
  };
  const usage = (c) => ({
    connect: "aile connect [provider]", price: "aile price <model>", run: "aile run <tool>",
  }[c.name] || `aile ${c.name}`);
  const w = Math.max(width("https://aile.sh/docs/cli"), ...COMMANDS.map((c) => width(usage(c))));
  for (const [g, title] of GROUPS) {
    lines.push(heading(title));
    const main = PRIMARY[g].map(findCommand);
    for (const c of main) lines.push(twoCol(cmd(usage(c)), c.summary, w));
    const rest = COMMANDS.filter((c) => c.group === g && !PRIMARY[g].includes(c.name) && c.name !== "help");
    if (rest.length) lines.push(`${C.dim}${wrap(`also: ${rest.map((c) => c.name).join(` ${sym.dot} `)}`)}${C.reset}`);
    lines.push("");
  }
  lines.push(twoCol(cmd("aile help <command>"), "examples and details for one command", w));
  lines.push(twoCol(cmd("https://aile.sh/docs/cli"), "every command and flag, in full", w));
  return lines.join("\n");
}

/** One command's page. */
export function commandHelp(c) {
  const lines = [heading(`aile ${c.name}`, c.summary)];
  if (c.aliases?.length) lines.push(dim(`also: ${c.aliases.map((a) => `aile ${a}`).join(", ")}`));
  lines.push("");
  const w = Math.max(...c.examples.map(([e]) => width(e)));
  for (const [e, what] of c.examples) {
    lines.push(width(e) > 44
      ? `  ${cmd(e)}\n${twoCol("", what, Math.min(w, 44))}`
      : twoCol(cmd(e), what, Math.min(w, 44)));
  }
  for (const n of c.notes || []) lines.push("", para(codeSpans(n)));
  lines.push("", heading("Options on every command"));
  const ow = Math.max(...GLOBAL_OPTIONS.map(([o]) => o.length));
  for (const [o, what] of GLOBAL_OPTIONS) lines.push(twoCol(o, what, ow));
  return lines.join("\n");
}

/** What an unknown command gets: one line, a suggestion, and where to look. */
export function unknownCommand(name) {
  const hits = suggest(name, commandNames());
  const lines = [bad(`Unknown command "${name}".`)];
  if (hits.length) lines.push(`    ${dim("Did you mean")} ${hits.map((h) => cmd(`aile ${h}`)).join(dim(" or "))}${dim("?")}`);
  lines.push(`    ${cmd("aile help")} ${dim("lists every command.")}`);
  return lines.join("\n");
}
