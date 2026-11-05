/**
 * `aile keys`, `aile keys suggest`, `aile keys set` and `aile route` — finding a key,
 * drafting a route for it, setting its self-hosted rules, and asking what a request
 * would try.
 *
 * All of them read the account (`requireRenter` on the server), so they send the
 * account token and a key's ID, never a key's secret. Nothing here sends a request
 * through a sharer. `set` is the one that writes, and it writes the key's routing
 * rules only (never a route).
 */

import { api, ApiError } from "../api/client.js";
import { loadConfig } from "../relay/config.js";
import { webOrigin } from "../setup/ctx.js";
import { loadManifest } from "../setup/manifest.js";
import { cleanKey, describeKey } from "../setup/key.js";
import { C } from "./colors.js";
import { die, withSpinner, heading, sym, bold, dim, padTo } from "./ui.js";
import { maxPriceHeader } from "./renter-command.js";

const stem = (k) => String(k.prefix || "").replace(/…$/, "");
const label = (k) => `${k.name || "unnamed"} (${k.prefix})${k.disabled ? ", off" : k.expired ? ", expired" : ""}`;
const usd = (n) => `$${+Number(n).toFixed(4)}`;
const dot = ` ${sym.dot} `;

const FORMATS = ["chat", "messages", "responses"];
const TIERS = ["light", "standard", "heavy"];
const DATA = ["allow", "deny"];

const TOOL = {
  chat: { type: "function", function: { name: "example", parameters: { type: "object", properties: {} } } },
  messages: { name: "example", input_schema: { type: "object", properties: {} } },
  responses: { type: "function", name: "example", parameters: { type: "object", properties: {} } },
};

/** Run one API call; an older server and every other failure end the command here, never as a stack. */
async function ask(work, ctx, server, hint = null) {
  try {
    return await work();
  } catch (e) {
    if (e instanceof ApiError && e.status === 404 && !/no such key/i.test(e.message)) {
      die(`${server} does not offer this yet.`, hint);
    }
    die(...ctx.explainError(e, server));
  }
}

/** Config, transport and the account token, in that order. Nothing here touches the network. */
function connect(args, ctx) {
  const config = loadConfig();
  const server = args.server || config.serverUrl;
  const insecure = ctx.checkTransport(server, args);
  const token = config.renterToken;
  if (!token) die("This reads your account, and this machine is not signed in.", "Run `aile login`. It signs out your other machines.");
  return { config, server, insecure, token };
}

// The two calls that need a key's id say where the keys can still be listed; listing them has no such hint.
const LISTED = "`aile keys` still lists your keys.";

const readKeys = (c, ctx) =>
  ask(() => withSpinner("Reading your keys", () => api.listKeys({ serverUrl: c.server, insecure: c.insecure, token: c.token })), ctx, c.server)
    .then((r) => r?.keys ?? []);

/** The key this machine uses: the saved secret's row, else the one `aile setup` recorded. */
function machineKey(keys, config) {
  const secret = config.buyerKey;
  const byKey = secret && keys.find((k) => stem(k) && secret.startsWith(stem(k)));
  if (byKey) return byKey;
  const id = loadManifest().key?.id;
  return (id && keys.find((k) => k.id === id)) || null;
}

function pickKey(keys, args, config) {
  if (args.key !== undefined) {
    if (args.key === true) die("--key needs a key's id, name or prefix.");
    // A pasted secret is matched here and never echoed: cleaned the way setup cleans a key, so a quote
    // or "Bearer " does not hide it, and anything past a prefix's length is named by its ends.
    const raw = String(args.key).trim();
    const w = cleanKey(raw).startsWith("sk-aile-") ? cleanKey(raw) : raw;
    const p = w.replace(/…$/, "");
    const hits = [
      keys.filter((k) => k.id === w),
      keys.filter((k) => k.name === w),
      keys.filter((k) => stem(k) && (p.startsWith(stem(k)) || stem(k).startsWith(p))),
    ].find((h) => h.length) ?? [];
    const shown = p.startsWith("sk-aile-") && p.length > 16 ? describeKey(p) : w;
    if (!hits.length) die(`No key on this account matches "${shown}".`, "`aile keys` lists yours.");
    if (hits.length > 1) die(`${hits.length} keys match "${shown}".`, "Name one by its id: `aile keys` lists them.");
    return hits[0];
  }
  const mine = machineKey(keys, config);
  if (mine) return mine;
  const usable = keys.filter((k) => !k.disabled && !k.expired && !k.stake);
  if (usable.length === 1) return usable[0];
  if (!keys.length) die("This account has no API key yet.", "`aile setup` makes one.");
  die("Which key?", "Pass --key <id, name or prefix>: `aile keys` lists them.");
}

// ---------------------------------------------------------------------------

export async function cmdKeys(args, ctx) {
  const sub = args._[1];
  if (sub !== undefined && sub !== "suggest" && sub !== "set") {
    die(`"aile keys ${sub}" is not a command.`, "`aile keys` lists your keys; `aile keys suggest` drafts a route; `aile keys set` changes a key's self-hosted rules.");
  }
  // A bad flag ends the command before the network is touched.
  const change = sub === "set" ? readSetFlags(args) : null;
  const c = connect(args, ctx);
  const keys = await readKeys(c, ctx);
  if (sub === "suggest") return suggest(args, ctx, c, keys);
  if (sub === "set") return setRules(args, ctx, c, keys, change);

  if (args.json) return console.log(JSON.stringify({ keys }, null, 2));
  if (!keys.length) {
    console.log("No API keys yet.");
    return console.log(dim("aile setup makes one."));
  }
  const mine = machineKey(keys, c.config);
  console.log();
  console.log(heading("Your API keys"));
  for (const k of keys) {
    const tags = [
      k === mine && `${C.green}this machine${C.reset}`,
      k.disabled && "off",
      k.expired && "expired",
      k.stake && "stake",
    ].filter(Boolean);
    console.log(`  ${bold(k.name || "unnamed")}  ${k.prefix}${tags.length ? `  ${tags.join("  ")}` : ""}`);
    const limit = k.creditLimitUsd ? ` of $${k.creditLimitUsd}${k.limitWindow ? ` per ${k.limitWindow}` : ""}` : "";
    console.log(`    id ${k.id}${dot}$${k.spentUsd} spent${limit}`);
    const selfHosted = selfHostedLine(k.filters);
    if (selfHosted) console.log(`    ${selfHosted}`);
    if (k.aliases?.length) {
      const names = k.aliases.map((a) => `${a.name}${a.auto ? " (auto)" : ""}${a.description ? ` — ${a.description}` : ""}`);
      console.log(`    routes: ${names.join(", ")}`);
    }
  }
  console.log();
  console.log(dim("A route for one of them: aile keys suggest --key <id, name or prefix>"));
  console.log(dim("Self-hosted rules:       aile keys set --local-max-price 2   (or --allow-local no)"));
}

/** What a key says about self-hosted models, as one list line: its ceiling, or that it refuses them. Nothing when it says nothing. */
function selfHostedLine(filters) {
  if (filters?.allowLocal === false) return "self-hosted off";
  const c = filters?.localMaxUsdPerMtok;
  return typeof c === "number" && Number.isFinite(c) ? `self-hosted ≤ $${+c.toFixed(6)}/Mtok` : null;
}

// ---------------------------------------------------------------------------

const CEILING_MAX = 1000;
const NONE_WORDS = ["none", "off", "clear", "remove"];
const YES_WORDS = ["yes", "true", "on", "1"];
const NO_WORDS = ["no", "false", "off", "0"];

/**
 * `--local-max-price <usd>|none` and `--allow-local yes|no`, checked before any request. The ceiling
 * takes what the server takes (dollars per million tokens, above 0, at most 1000, at most 6 decimals,
 * an optional `$`): a value it would refuse is refused here, never sent and never dropped.
 * Returns `{ ceiling: number | "none" | undefined, allowLocal: boolean | undefined }`.
 */
function readSetFlags(args) {
  const price = args["local-max-price"];
  const allow = args["allow-local"];
  if (price === undefined && allow === undefined) {
    die("Set what?", "Try `aile keys set --local-max-price 2` (dollars per million tokens), or `aile keys set --allow-local no`.");
  }
  let ceiling;
  if (price !== undefined) {
    const text = typeof price === "string" ? price.trim().replace(/^\$/, "") : "";
    if (NONE_WORDS.includes(text.toLowerCase())) ceiling = "none";
    else {
      const m = /^\d+(?:\.(\d+))?$/.exec(text);
      const v = Number(text);
      if (!m || (m[1] && m[1].length > 6) || !Number.isFinite(v) || v <= 0 || v > CEILING_MAX) {
        die("--local-max-price is dollars per million tokens, above 0 and at most 1000, with at most 6 decimals — or `none`.", "For example --local-max-price 2");
      }
      ceiling = v;
    }
  }
  let allowLocal;
  if (allow !== undefined) {
    const word = typeof allow === "string" ? allow.trim().toLowerCase() : "";
    if (YES_WORDS.includes(word)) allowLocal = true;
    else if (NO_WORDS.includes(word)) allowLocal = false;
    else die("--allow-local is `yes` or `no`.", "`no` keeps this key off self-hosted models.");
  }
  if (allowLocal === false && typeof ceiling === "number") {
    die("A key that refuses self-hosted models cannot also set a price ceiling for them.", "Use --allow-local yes with the ceiling, or --allow-local no on its own.");
  }
  return { ceiling, allowLocal };
}

/**
 * Change one key's self-hosted rules and keep every other rule exactly as the server returned it:
 * the server replaces the WHOLE filter set, so the next set is the stored one with only these
 * fields moved. `--allow-local no` drops the ceiling (the server refuses both together) and says so.
 */
async function setRules(args, ctx, c, keys, { ceiling, allowLocal }) {
  const row = pickKey(keys, args, c.config);
  const next = { ...(row.filters && typeof row.filters === "object" ? row.filters : {}) };
  const notes = [];
  if (allowLocal === false) {
    next.allowLocal = false;
    notes.push("It now refuses self-hosted models.");
    if (next.localMaxUsdPerMtok !== undefined) {
      delete next.localMaxUsdPerMtok;
      notes.push("Its self-hosted price ceiling was dropped too, because a key cannot hold both.");
    }
  } else if (allowLocal === true) {
    delete next.allowLocal;
    notes.push("Self-hosted models are allowed on it.");
  }
  if (ceiling === "none") {
    if (next.localMaxUsdPerMtok !== undefined) notes.push("Its self-hosted price ceiling was dropped.");
    else if (allowLocal === undefined) notes.push("It had no self-hosted price ceiling.");
    delete next.localMaxUsdPerMtok;
  } else if (typeof ceiling === "number") {
    if (next.allowLocal === false) {
      die(`${label(row)} refuses self-hosted models, so a price ceiling for them has nothing to bound.`, `\`aile keys set --allow-local yes --local-max-price ${ceiling}\` allows them and sets it.`);
    }
    if (next.dataCollection === "deny") {
      die(`${label(row)} denies data collection, which refuses self-hosted models, so a price ceiling for them has nothing to bound.`, "Change that rule in the dashboard's Routing settings for the key.");
    }
    next.localMaxUsdPerMtok = ceiling;
    notes.push(`Self-hosted calls on it may now pay up to $${ceiling} per million tokens, input or output.`);
  }

  const res = await ask(
    () => withSpinner("Saving", () => api.setKeyFilters({
      id: row.id, filters: Object.keys(next).length ? next : null,
      serverUrl: c.server, insecure: c.insecure, token: c.token,
    })),
    ctx, c.server, LISTED,
  );
  if (args.json) return console.log(JSON.stringify(res, null, 2));
  console.log();
  console.log(`${C.green}Saved.${C.reset} ${bold(label(row))}`);
  for (const n of notes) console.log(`  ${n}`);
  // An older server stores only the fields it knows: say so rather than let the ceiling look saved.
  const kept = res?.key?.filters?.localMaxUsdPerMtok;
  if (typeof ceiling === "number" && res?.key && kept !== ceiling) {
    console.log(`  ${C.yellow}This server does not keep a self-hosted price ceiling yet — send x-aile-max-price on each call (aile chat --max-price).${C.reset}`);
  }
  console.log();
}

const LEFT_OUT = [
  ["unpriced", "unpriced"], ["locked", "locked"], ["ownCapacity", "your own capacity"], ["free", "free"],
  ["keyRules", "by this key's rules"], ["trainsOnPrompts", "trains on prompts"], ["notChat", "not chat"], ["selfHosted", "self-hosted"],
];

async function suggest(args, ctx, c, keys) {
  const row = pickKey(keys, args, c.config);
  const data = await ask(
    () => withSpinner("Drafting a route", () => api.routeSuggestion({ key: row.id, serverUrl: c.server, insecure: c.insecure, token: c.token })),
    ctx, c.server, LISTED,
  );
  if (args.json) return console.log(JSON.stringify(data, null, 2));

  console.log();
  console.log(heading(`Suggested route for ${label(row)}`));
  const options = data?.options ?? [];
  if (!options.length) console.log("\n  Nothing listed fits this key.");
  for (const o of options) {
    console.log(`\n${bold(o.shape === "effort" ? "One model at three efforts" : "A model per tier")}`);
    for (const t of o.targets ?? []) printTarget(t);
    for (const g of o.gaps ?? []) {
      console.log(`  ${padTo(g.tier, 9)}${g.reason === "same" ? "the standard model serves it" : "nothing fits; standard serves it"}`);
    }
  }
  const left = LEFT_OUT.filter(([k]) => data?.leftOut?.[k]).map(([k, name]) => `${data.leftOut[k]} ${name}`);
  if (left.length) console.log(`\n${dim(`Left out: ${left.join(", ")}`)}`);
  if (!options.length) return;
  console.log(dim(`\nNothing was saved. Save a route on this key at ${webOrigin(c.server)}/dash?tab=keys, then: aile setup --route <name>`));
}

function printTarget(t) {
  const f = t.facts ?? {};
  const q = f.quoteUsd ?? {};
  console.log(`  ${padTo(t.tier, 9)}${t.provider}/${t.model}${t.effort ? ` effort ${t.effort}` : ""}`);
  let price = `    ${usd(q.in)} in, ${usd(q.out)} out${q.cacheRead != null ? `, ${usd(q.cacheRead)} cached` : ""} per Mtok`;
  price += `${dot}${f.pctOfList}% of list (${usd(f.listUsd?.in)}, ${usd(f.listUsd?.out)})`;
  if (f.dearestUsd && f.dearestUsd.out !== q.out) price += `${dot}up to ${usd(f.dearestUsd.out)} out`;
  console.log(price);
  const n = f.sharers ?? 0;
  const facts = [
    `${n} sharer${n === 1 ? "" : "s"}`,
    f.calls30d != null && `${f.calls30d} calls in 30 days`,
    f.contextWindow != null && `${f.contextWindow} context`,
    f.tools && "tools",
    f.vision && "images",
    f.reasoning && "reasoning",
  ].filter(Boolean);
  console.log(`    ${facts.join(dot)}`);
  const why = t.why ?? {};
  if (why.relaxed === "class") console.log(dim("    below the usual price class for this tier"));
  if (why.relaxed === "vision") console.log(dim("    cannot read images"));
  if (why.fewCalls) console.log(dim("    few calls, so cheapest on price"));
  if (t.handle || t.nodeId || t.verified || t.maxUsdPerMtok) console.log(dim("    keeps this key's own sharer, node, verified or price limit"));
}

// ---------------------------------------------------------------------------

export async function cmdRoute(args, ctx) {
  const name = args._[1];
  if (!name) die("Which route?", "`aile route aile/auto`, a route on your key, or <provider>/<model>.");
  for (const [flag, ok] of [["format", FORMATS], ["tier", TIERS], ["data", DATA]]) {
    const v = args[flag];
    if (v !== undefined && !ok.includes(String(v))) die(`--${flag} must be ${ok.slice(0, -1).join(", ")} or ${ok.at(-1)} (got "${v}")`);
  }
  const f = args.format || "chat";
  const prompt = args._.slice(2).join(" ");
  let body = null;
  if (prompt || args.tools) {
    const text = prompt || "Hello";
    body = f === "responses" ? { input: text } : { messages: [{ role: "user", content: text }] };
    if (args.tools) body.tools = [TOOL[f]];
  }
  const headers = {};
  if (args.tier) headers["x-aile-auto-tier"] = args.tier;
  if (args.data) headers["x-aile-data-collection"] = args.data;
  // A self-hosted model's sharer sets its price, so the plan of a keyed call to one needs a dollar ceiling too.
  Object.assign(headers, maxPriceHeader(args["max-price"], name));

  const c = connect(args, ctx);
  const row = pickKey(await readKeys(c, ctx), args, c.config);
  const r = await ask(
    () => withSpinner("Planning", () => api.routeDryRun({
      key: row.id, model: name, format: args.format || null, headers: Object.keys(headers).length ? headers : null, body,
      serverUrl: c.server, insecure: c.insecure, token: c.token,
    })),
    ctx, c.server, LISTED,
  );
  if (args.json) return console.log(JSON.stringify(r, null, 2));

  const targets = r?.targets ?? [];
  const idOf = (t) => (t.provider && !t.model?.startsWith(`${t.provider}/`) ? `${t.provider}/${t.model}` : t.model ?? "?");
  const row9 = (k, v) => console.log(`  ${padTo(k, 9)}${v}`);
  console.log();
  console.log(heading(`aile route ${name}`, `key ${label(row)}`));
  const about = row.aliases?.find((a) => a?.name === name)?.description;
  if (about) row9("about", about);
  if (r?.auto) {
    row9("tier", `${r.auto.tier} (${r.auto.reason})${r.auto.pinned ? ", held by this conversation" : ""}${dot}~${r.auto.promptTokens} prompt tokens`);
  }
  if (r?.autoName) {
    row9("score", `${r.autoName.score} of 3`);
    if (r.autoName.vendorLock) row9("vendor", `stays on ${r.autoName.vendorLock}`);
  }
  const refusal = r?.route?.refusal ?? r?.autoName?.empty;
  if (refusal) row9("refused", `${C.yellow}${refusal.status}: ${refusal.message}${C.reset}`);
  const ft = r?.firstTried;
  if (ft) {
    const t = targets.find((x) => x.entry === ft.entry);
    row9("first", `${t ? idOf(t) : `entry ${ft.entry}`}${dot}sharer ${ft.lender ?? "unknown"}`);
  } else {
    row9("first", "nobody: a real request would not reach a sharer");
  }

  console.log();
  console.log(heading("Targets, in try order"));
  for (const t of targets) {
    console.log(`  ${t.position + 1}  ${idOf(t)}${t.tier ? ` ${t.tier}` : ""}${t.capacity ? ` ${t.capacity}` : ""}${t.effort ? ` effort ${t.effort}` : ""}`);
    const cands = t.candidates ?? [];
    if (t.first == null) {
      console.log("     no sharer would be tried");
    } else {
      // The quote of the sharer named, which is not always the first listed: the server lists a row it passed over where it sorted.
      const quote = cands.find((x) => x.lender === t.first)?.quoteUsd;
      const at = quote != null ? ` at $${quote.toFixed(6)}` : "";
      const over = cands.filter((x) => x.skipped).length;
      const listed = cands.length + (t.more || 0);
      console.log(
        `     first ${t.first}${at}${dot}${listed} sharer${listed === 1 ? "" : "s"}` +
        (t.unavailable ? `${dot}${t.unavailable} unavailable` : "") +
        (over ? `${dot}${over} passed over` : "") +
        (t.tiedWith?.length ? `${dot}${t.tiedWith.length} tied` : ""),
      );
    }
    for (const rm of t.removed ?? []) {
      const ls = rm.lenders;
      const who = ls?.length ? ` (${ls.slice(0, 5).join(", ")}${ls.length > 5 ? ` +${ls.length - 5}` : ""})` : "";
      console.log(`     removed ${String(rm.stage).replace(/lender/g, "sharer")}: ${rm.count}${who}`);
    }
    if (t.refusal) console.log(`     ${C.yellow}refused ${t.refusal.status}: ${t.refusal.message}${C.reset}`);
  }
  for (const n of r?.notes ?? []) console.log(dim(`  ${n}`));
  console.log();
  console.log(dim("Nothing was sent or charged."));
}
