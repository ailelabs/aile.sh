/**
 * `aile setup` — use aile from the coding tools already on this machine.
 *
 *   aile setup                      pick tools, approve a key in the browser, done
 *   aile setup claude codex         just these
 *   aile setup --all --yes          every tool found, no questions (scripts)
 *   aile setup --auto               Claude Code on aile/auto
 *   aile setup status               what is set up, and where
 *   aile setup --remove [tool…]     put every file back as it was
 *
 *   aile run <tool> [args…]         start a tool through aile, touching nothing
 *   aile env <tool>                 the environment for any other way of starting it
 *   aile doctor                     check the key, the server and each tool
 *
 * THE DEFAULT IS THE GENTLE ONE. For Claude Code and Codex, which have a
 * default provider of their own, setup installs a shortcut (`claudeaile`,
 * `codexaile`) and leaves `claude` and `codex` exactly as they were — someone
 * with a Claude subscription keeps it. Making aile their default is one flag
 * (`--mode default`) or one answer away. Every other tool gains aile as an
 * extra provider and loses nothing.
 *
 * NOTHING IS WRITTEN WITHOUT BEING SHOWN FIRST, and everything written is
 * recorded (src/setup/manifest.js) so `--remove` restores the exact values it
 * replaced.
 */

import fs from "node:fs";
import { loadConfig, saveConfig } from "../relay/config.js";
import { api, ApiError, isSecureUrl } from "../api/client.js";
import { makeCtx, webOrigin } from "../setup/ctx.js";
import { TOOLS, getTool, revertTool, printsOnly } from "../setup/tools.js";
import { detectInvoker } from "../setup/invoker.js";
import { RUNNERS, NEEDS_MODEL, recipe, childEnv } from "../setup/runners.js";
import { which, spawnTool } from "../setup/exec.js";
import { detectTool, probeVersion } from "../setup/detect.js";
import {
  shortcutName, validShortcutName, chooseBinDir, shortcutFiles, foreignShortcut,
  installShortcut, removeShortcut, pathHint,
} from "../setup/shortcuts.js";
import { fetchChatModels, curatedModels, defaultModel, isSelfHosted } from "../setup/models.js";
import { obtainKey, KeyError, describeKey, KEY_RE, cleanKey, checkKey } from "../setup/key.js";
import { commitEdit } from "../setup/files.js";
import { loadManifest, saveManifest, recordTool, MANIFEST_FILE } from "../setup/manifest.js";
import { isInteractive, promptChoice, promptConfirm, promptMulti, promptSecret } from "./prompt.js";
import { signIn, LoginError } from "../auth/login.js";
import { C } from "./colors.js";
import {
  die, heading, sym, ok as okLine, warn as warnLine, bad as badLine, hintText,
  withSpinner, table, padTo, width, wrap,
} from "./ui.js";

const INSTALL = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
  opencode: "npm install -g opencode-ai",
  qwen: "npm install -g @qwen-code/qwen-code",
  aider: "python -m pip install aider-install && aider-install",
  goose: "see https://block.github.io/goose/docs/getting-started/installation",
  droid: "see https://docs.factory.ai/cli/getting-started/quickstart",
  openclaw: "npm install -g openclaw",
};

// Every refusal in this file goes through the shared `die`, so it looks like
// every other command's: the mark, one sentence, what to do.
const fail = (msg, hint = null) => die(msg, hint);

function transport(args, server) {
  if (isSecureUrl(server)) return false;
  if (args.insecure || loadConfig().allowInsecure === true) return true;
  fail(`Refusing a non-HTTPS server URL: ${server}`, "Credentials would cross the network in clear. Pass --insecure for a staging server.");
}

/** `~` for the home directory, so a plan reads like the paths people type. */
function tidy(ctx, p) {
  const h = ctx.home;
  return p && p.startsWith(h) ? `~${p.slice(h.length)}` : p;
}

/** The two tools that can be sent through a named route, in place of a model. */
const isRoutable = (t) => t.id === "claude" || t.id === "codex";

/**
 * Aile serves these two names on any key, with no route saved. The server refuses them on
 * /v1/responses, the only API Codex speaks, so they reach Codex only as a route saved under the name.
 */
const ZERO_SETUP = new Set(["aile/auto", "aile/auto-claude"]);

/**
 * The key's row in GET /keys, by id, else by the prefix the server shows (`sk-aile-` and 8 hex,
 * then an ellipsis): a pasted key has no id here. Null when it cannot be read: not signed in,
 * offline, an older server, a key made elsewhere.
 */
async function keyRowOf({ key, id = null, server, insecure, token }) {
  if (!token || !key) return null;
  try {
    const keys = (await api.listKeys({ serverUrl: server, insecure, token }))?.keys || [];
    return keys.find((k) => id && k.id === id) || keys.find((k) => k.prefix && key.startsWith(String(k.prefix).replace(/…$/, ""))) || null;
  } catch { return null; }
}

/** The key this run will use, when that is known before any key is made or saved: the one given, else the saved one. */
function knownKey(args, config) {
  if (args.key === "-" || (!args.key && args["new-key"])) return null;
  const k = args.key ? cleanKey(args.key) : config.buyerKey;
  return KEY_RE.test(k || "") ? k : null;
}

/** What to do when the key's saved routes are unknown, or null when they are known. */
const unreadClause = (token, routes) =>
  !token ? "if your key has a route of that name, run aile login and set up again"
    : !routes ? "this key's routes could not be read, so run this again to check" : null;

/**
 * Codex can take a zero-setup name only as a route saved under it, and Claude Code is not in the
 * run. Decided before a key is made or saved, so a refusal writes nothing: the saved key is
 * looked up as it stands, and no token, a new key or a key not found means no such route.
 */
async function refuseCodexOnly({ route, args, config, server, insecure }) {
  const key = knownKey(args, config);
  const row = await keyRowOf({ key, server, insecure, token: config.renterToken });
  if (row?.aliases?.some((a) => a?.name === route)) return;
  const why = key || !config.renterToken ? unreadClause(config.renterToken, row?.aliases) : "if a key of yours has a route of that name, pass it with --key <key>";
  fail(`Claude Code is the only tool that takes ${route} without a saved route.`, `aile setup claude --route ${route}${why ? `   (${why})` : ""}`);
}

/**
 * The tools holding the saved route (`manifest.route.tools`). A record from before the list
 * existed has none: it means Claude Code and Codex, whichever are set up here.
 */
export function routeHolders(manifest) {
  const r = manifest.route;
  if (!r) return [];
  return (Array.isArray(r.tools) ? r.tools : ["claude", "codex"]).filter((id) => manifest.tools[id]);
}

/**
 * After a run, write down who holds the route: the tools it sent through it, plus the ones it
 * did not touch. A run that only wrote a tool's shortcut leaves that tool's claim alone when its
 * config was set up too, because the route is still in the config file.
 */
function noteRoute(manifest, { holders, route, prefix, plans, routeOf, before }) {
  const held = new Set(holders);
  for (const p of plans) {
    if (!p.done || !isRoutable(p.tool)) continue;
    const configured = (before.tools[p.tool.id]?.modes || []).some((m) => m === "config" || m === "both");
    if (routeOf(p.tool)) held.add(p.tool.id);
    else if (p.config || !configured) held.delete(p.tool.id);
  }
  const tools = [...held].filter((id) => manifest.tools[id]);
  if (!tools.length) { delete manifest.route; return; }
  const routed = plans.some((p) => p.done && routeOf(p.tool));
  manifest.route = routed
    ? { name: route, prefix, tools }
    : { name: manifest.route.name, prefix: manifest.route.prefix, tools };
}

const fundUrl = (ctx) => `${ctx.web}/dash?tab=wallet&focus=deposit`;
const keysUrl = (ctx) => `${ctx.web}/dash?tab=keys`;

// ---------------------------------------------------------------------------
// aile setup
// ---------------------------------------------------------------------------

export async function setupCommand(args) {
  const rest = args._.slice(1);
  if (rest[0] === "status") return setupStatus(args);
  if (rest[0] === "refresh") return setupRefresh(args);
  if (args.remove) return setupRemove(args, rest);

  const config = loadConfig();
  const server = args.server || config.serverUrl;
  const insecure = transport(args, server);
  const ctx = makeCtx({ serverUrl: server });
  const interactive = isInteractive() && !args.yes;
  const dryRun = Boolean(args["dry-run"]);

  if (!args.json && !args.quiet) {
    console.log(`\n${heading("aile setup", "use aile from your coding tools")}\n`);
  }

  let mode = args.mode ? String(args.mode) : null;
  if (mode && !["shortcut", "default", "both"].includes(mode)) {
    fail(`--mode must be shortcut, default or both (got "${mode}").`);
  }
  // A route name on the key (an auto route, say) to send Claude Code and Codex through, in
  // place of a model. Asked for here, or offered below once the key is known.
  if (args.route === true) fail("--route needs a route name.", "aile setup claude --route aile/auto");
  if (args.auto && args.route) fail("--auto and --route contradict each other.");
  // --auto is --route aile/auto; with no tools named it means Claude Code alone.
  let route = args.auto ? "aile/auto" : args.route ? String(args.route).trim() || null : null;
  if (route && args["no-route"]) fail(`${args.auto ? "--auto" : "--route"} and --no-route contradict each other.`);

  // --- which tools -----------------------------------------------------------
  const found = new Map(TOOLS.map((t) => [t.id, t.detect(ctx)]));
  // Run from inside a coding agent? Then that tool is the likely target, and a
  // change to its settings reaches its NEXT session, not this one.
  const invoker = detectInvoker(process.env);
  let chosen;
  if (rest.length) {
    chosen = [];
    for (const name of rest) {
      const t = getTool(name);
      if (!t) fail(`Unknown tool "${name}".`, `Known: ${TOOLS.map((x) => x.id).join(", ")}`);
      if (!chosen.includes(t)) chosen.push(t);
    }
  } else if (args.all) {
    chosen = TOOLS.filter((t) => !printsOnly(t) && isInstalled(found.get(t.id)));
    if (!chosen.length) fail("None of the tools aile sets up is installed here.", `Install one (for example: ${INSTALL.claude}), or name a tool: aile setup claude`);
  } else if (args.auto) {
    chosen = [getTool("claude")];
  } else if (interactive) {
    /**
     * ONE SCREEN, ONE ANSWER. The tools installed here, ticked, each with what
     * setup will do to it; and for Claude Code and Codex, whether aile also
     * becomes their default — one more row here rather than a second question
     * after this one. Tools that are not installed are not rows: a list of
     * fifteen "not found" lines hid the three that mattered. They stay one
     * command away (`aile setup <name>`), and `aile detect` lists them all.
     */
    const here = (t) => isInstalled(found.get(t.id)) || invoker?.id === t.id;
    const auto = TOOLS.filter((t) => !printsOnly(t));
    // Unsupported tools are left out: there is nothing to pick them FOR.
    const manual = TOOLS.filter((t) => t.kinds.includes("manual"));
    let setupRows = auto.filter(here);
    let stepRows = manual.filter(here);
    // Nothing installed at all: offer every tool rather than an empty list.
    const offerAll = !setupRows.length && !stepRows.length;
    if (offerAll) setupRows = auto;
    const list = [...setupRows, ...stepRows];
    const rows = list.map((t) => ({
      label: t.label,
      note: doesNote(t, found.get(t.id), { showMissing: offerAll }),
      checked: here(t),
    }));
    const headings = {};
    if (setupRows.length) headings[0] = "Set up";
    if (stepRows.length) headings[setupRows.length] = "Show the steps for";
    const defaultable = setupRows.filter((t) => t.changesDefault);
    let optionAt = -1;
    if (defaultable.length && !mode) {
      optionAt = rows.length;
      headings[optionAt] = "Option";
      rows.push({
        label: `Also make aile the default in ${defaultable.map((t) => t.label).join(" and ")}`,
        note: "otherwise only the shortcuts use it",
        checked: false,
        option: true,
      });
    }
    const idx = await promptMulti(`${C.bold}Which tools?${C.reset}`, rows, {
      headings,
      footer: offerAll ? null : `not listed: aile setup <tool> ${sym.dot} aile detect lists every tool`,
    });
    if (idx === null) { console.log("\n  Cancelled — nothing changed.\n"); return; }
    chosen = idx.filter((i) => i !== optionAt).map((i) => list[i]);
    if (optionAt >= 0) mode = idx.includes(optionAt) ? "both" : "shortcut";
  } else {
    fail(
      "Name the tools to set up, or pass --all.",
      invoker?.id && getTool(invoker.id) && !printsOnly(getTool(invoker.id))
        ? `You are running inside ${invoker.name}: aile setup ${invoker.id} --yes     (or --all --yes)`
        : "aile setup claude codex --yes     aile setup --all --yes     aile setup status",
    );
  }
  if (!chosen.length) { console.log("  Nothing chosen — nothing changed.\n"); return; }

  // --- how: shortcut, default, or both (Claude Code and Codex only) -----------
  // Decided above: by --mode, or by the checklist's option row. Shortcuts alone
  // are the default, because they leave the tools' own commands untouched.
  mode = mode || "shortcut";

  // A name only Codex is left to take is decided before a key is made or saved, so a refusal writes nothing.
  // (`aile setup refresh` decided once, for all its groups.)
  if (route && ZERO_SETUP.has(route) && !args.resolvedKey && !chosen.some((t) => t.id === "claude")) {
    await refuseCodexOnly({ route, args, config, server, insecure });
  }

  const customName = args["shortcut-name"] ? String(args["shortcut-name"]) : null;
  if (customName && !validShortcutName(customName)) fail(`"${customName}" is not a usable command name.`);

  // --- models, for the tools that need a list or a default -------------------
  const models = await withSpinner("Reading the model list…", fetchChatModels({ serverUrl: server, insecure }));
  const listed = curatedModels(models, { all: args.models === "all" });
  const fallbackModel = args.model ? String(args.model) : defaultModel(models);
  // A self-hosted model is priced by its sharer, so a call to one must name the most it pays, and most of these
  // tools cannot send a header. None is ever listed or made a default: say so once, and say what an explicit one needs.
  if (args.models === "all" && models.selfHostedLeftOut > 0) {
    console.log(`${C.dim}Left out ${models.selfHostedLeftOut} self-hosted model${models.selfHostedLeftOut === 1 ? "" : "s"} (local/…): a call to one must name the most it pays. Set a ceiling on your key with aile keys set --local-max-price 2, then name one with --model.${C.reset}`);
  }
  if (args.model && args.model !== true && isSelfHosted(args.model)) {
    console.log(`${C.dim}${String(args.model)} is priced by its sharer: your key needs a self-hosted price ceiling (aile keys set --local-max-price 2) or, for a model with a published list price, a cost cap (Max cost per request in its Routing settings), or every call is refused.${C.reset}`);
  }

  // --- the key ---------------------------------------------------------------
  const needsKey = chosen.some((t) => !printsOnly(t));
  let key = null;
  let keyNote = null;
  let keyInfo = null;
  if (needsKey) {
    if (dryRun) {
      // The key given, else the saved one: never validated or saved here, and shown masked.
      key = knownKey(args, config) || (args["new-key"] ? null : config.buyerKey) || "sk-aile-<your-key>";
    } else if (args.resolvedKey) {
      // `aile setup refresh` resolved the key once for every tool it re-applies.
      ({ key, note: keyNote, info: keyInfo } = args.resolvedKey);
    } else {
      const got = await getKey({ args, config, server, insecure, ctx, interactive });
      key = got.key;
      keyNote = got.note;
      keyInfo = got.info;
    }
  }

  // --- a route to point Claude Code and Codex at ---------------------------------
  // The route is remembered with the key it was chosen on and the tools it was given to
  // (`manifest.route = {name, prefix, tools}`). A re-run keeps it, on those tools, while that
  // key is the one in use; a different key, --no-route, or a --model of its own takes it back
  // out of the tools this run names — and only those — since its name is a 400 on a key that
  // has no such route. aile/auto and aile/auto-claude work on any key, so a different key keeps them.
  const before = loadManifest();
  const saved = before.route || null;
  const holders = routeHolders(before);
  const routable = chosen.some(isRoutable);
  const prefix = key ? describeKey(key) : null;
  const clearing = Boolean(args["no-route"]) || Boolean(args.model);
  const keep = Boolean(saved) && !route && !clearing && (saved.prefix === prefix || ZERO_SETUP.has(saved.name));
  let keyRow = null;  // this key's row in GET /keys, when signed in and it can be found
  let routes = null;  // the routes saved on it
  // Null routes means unknown, and unknown counts as not saved: off Codex costs a re-run, on it every request is a 400.
  const offCodex = (t, name) => t.id === "codex" && ZERO_SETUP.has(name) && !routes?.some((a) => a?.name === name);
  // The route a tool is sent through, if any.
  const routeOf = (t) => {
    const name = !isRoutable(t) ? null : route || (keep && holders.includes(t.id) ? saved.name : null);
    return name && offCodex(t, name) ? null : name;
  };
  const dropped = saved && !route && !clearing && !keep && chosen.some((t) => holders.includes(t.id)) ? saved.name : null;
  if (dropped && !args.quiet) console.log(`  ${C.dim}Route ${dropped} left out: this is not the key it was chosen for.${C.reset}`);
  // A zero-setup name kept onto another key means aile's own table there, unless that key saves a route of that name.
  const rekept = keep && saved.prefix !== prefix && ZERO_SETUP.has(saved.name) && chosen.some((t) => holders.includes(t.id)) ? saved.name : null;
  if (rekept && !args.quiet) console.log(`  ${C.dim}Route ${rekept} kept: on this key it means aile's own table, unless the key saves a route of that name.${C.reset}`);

  // Signed in, the key's own routes are on hand: refuse a --route it does not have, or
  // offer its auto routes. A convenience, so any failure (offline, an older server, a key
  // made elsewhere) just skips it. A dry run reads the key it was given, never a new one.
  const token = loadConfig().renterToken;
  const asked = Boolean(route);
  // A kept name on Codex needs the same look: it stays there only if this key saves a route of that name.
  const codexHolds = keep && ZERO_SETUP.has(saved.name) && holders.includes("codex") && chosen.some((t) => t.id === "codex");
  // So does --model of the name, the third road into Codex's config.
  const codexModel = ZERO_SETUP.has(String(args.model)) && chosen.some((t) => t.id === "codex");
  const offer = !dryRun && !asked && !codexHolds && !chosen.some(routeOf) && !clearing && interactive;
  const lookupKey = dryRun ? knownKey(args, config) : key;
  if (routable && token && lookupKey && (asked || codexHolds || codexModel || offer)) {
    keyRow = await keyRowOf({ key: lookupKey, id: dryRun ? null : keyInfo?.id, server, insecure, token });
    routes = keyRow?.aliases ?? null;
    if (asked && routes && !ZERO_SETUP.has(route) && !routes.some((a) => a?.name === route)) {
      const names = routes.map((a) => a?.name).filter(Boolean);
      fail(`Your key has no route named "${route}".`, names.length ? `Its routes: ${names.join(", ")}` : `It has none yet — add one at ${keysUrl(ctx)}`);
    }
    const autos = offer ? routes?.filter((a) => a?.auto === true) || [] : [];
    if (autos.length) {
      const pick = await promptChoice(`${C.bold}Point Claude Code and Codex at an auto route?${C.reset}`, [
        ...autos.map((a) => ({ label: a.name, note: a.description || "picks a cheap or strong model per request" })),
        { label: "No", note: "keep their own models" },
      ]);
      if (pick !== null && pick < autos.length) route = autos[pick].name;
    }
  }
  // Only for a name this run asked for, never a kept one, so a key rotation is never blocked by these.
  if (route && ZERO_SETUP.has(route) && !routes?.some((a) => a?.name === route)) {
    if (!chosen.some((t) => t.id === "claude")) {
      // (`aile setup refresh` decided this once, before its first group wrote anything.)
      if (!args.resolvedKey) {
        const why = unreadClause(token, routes);
        fail(`Claude Code is the only tool that takes ${route} without a saved route.`, `aile setup claude --route ${route}${why ? `   (${why})` : ""}`);
      }
    } else {
      const pin = keyRow?.filters?.provider;
      if (pin) fail(`This key is limited to provider ${pin}, and ${route} picks across providers.`, `Use a key without the pin, or --model ${pin}/<model>.`);
      let table = null;
      let older = false;
      try { table = await api.autoCatalog({ serverUrl: server, insecure }); }
      catch (e) { older = e instanceof ApiError && e.status === 404; }  // offline, a 5xx: accept as given
      const turnedDown = older ? `${server} does not offer ${route} yet.` : table?.enabled === false ? `${route} is switched off on ${server}.` : null;
      // With the key's routes unread, a route of that name saved on it may still serve: say so, don't refuse.
      if (turnedDown && routes) fail(turnedDown, "Name a route or a model: --route <name>, --model <provider>/<model>.");
      if (turnedDown && !args.quiet) console.log(warnLine(`${turnedDown} A route of that name saved on your key still works.`));
      // Signed out there is no GET /keys to read a pin from, but the key's own model list leaves off a name it cannot use.
      if (!routes && !turnedDown && key && !dryRun) {
        try { await api.modelRow({ model: route, key, serverUrl: server, insecure }); }
        catch (e) {
          if (e instanceof ApiError && e.status === 404 && !args.quiet) console.log(warnLine(`This key may not take ${route}: a key limited to one provider, for one, cannot use it.`));
        }
      }
    }
  }
  // One name per machine: a different route given to some of the tools holding the saved one
  // would leave the rest on a name the record no longer knows. (`refresh` goes group by group.)
  if (route && saved && !args.resolvedKey && (saved.name !== route || saved.prefix !== prefix)) {
    const others = holders.filter((id) => !chosen.some((t) => t.id === id));
    if (others.length) {
      // The same name on another key is a different route, so say which part differs; the key
      // itself is never echoed.
      const onKey = saved.name === route ? " on the key it was chosen with" : "";
      fail(
        `${others.map((id) => getTool(id)?.label || id).join(" and ")} still ${others.length === 1 ? "uses" : "use"} the route ${saved.name}${onKey}.`,
        `Name ${others.length === 1 ? "it" : "them"} too: aile setup ${[...new Set([...chosen.map((t) => t.id), ...others])].join(" ")} --route ${route}${args.key ? " --key <that key>" : ""}`,
      );
    }
  }

  // --- plan ------------------------------------------------------------------
  const plans = [];
  const binDir = chooseBinDir(ctx);
  for (const t of chosen) {
    if (printsOnly(t)) { plans.push({ tool: t, manual: true }); continue; }
    // The route replaces the model for the two tools that talk to a named route; Claude Code's
    // background calls run on its haiku slot, so that points at the route too.
    const toRoute = routeOf(t);
    const chosenModel = toRoute || (args.model && !offCodex(t, String(args.model)) ? String(args.model) : null);
    // What was asked of this tool, to say why Codex did not take it.
    const wanted = route || (keep && holders.includes(t.id) ? saved.name : null) || (args.model ? String(args.model) : null);
    const smallModel = toRoute && t.id === "claude" ? toRoute : null;
    // A tool that held the route and is no longer sent through it gives it back (`stale`).
    const stale = !toRoute && isRoutable(t) && holders.includes(t.id) ? saved.name : null;
    const wantConfig = t.kinds.includes("config") && (!t.changesDefault || mode !== "shortcut");
    const wantShortcut = t.kinds.includes("shortcut") && (!t.changesDefault || mode !== "default");
    // --mode shortcut leaves the tool's own settings unwritten, so a route there stays (and the
    // tool stays a holder): say so rather than let --no-route look done.
    const staysSet = stale && !wantConfig && t.kinds.includes("config");
    if (staysSet && !args.quiet) {
      console.log(`  ${C.dim}${t.label}'s own settings still use the route ${stale}; run without --mode shortcut to take it out.${C.reset}`);
    }
    // `takes`: the model Codex gets in place of the name. A note that says it "keeps" its model while
    // its settings still use the name (above) would contradict that line, so it is left out then.
    const plan = { tool: t, config: null, shortcut: null, error: null, conflict: null, takes: chosenModel, offCodex: !staysSet && offCodex(t, wanted) ? wanted : null };
    if (wantConfig) {
      const p = t.plan(ctx, { key, model: chosenModel, smallModel, staleRoute: stale, prior: before.tools[t.id]?.records, models: listed });
      if (!p.ok) plan.error = p.reason;
      else { plan.config = p; plan.conflict = p.conflict; }
    }
    if (wantShortcut) {
      const name = customName && chosen.filter((x) => x.kinds.includes("shortcut")).length === 1 ? customName : shortcutName(t.id);
      const rec = recipe(t.runner, {
        key, ...ctx, model: chosenModel, smallModel,
        defaultModel: NEEDS_MODEL.has(t.runner) ? fallbackModel : null,
      });
      // Installed but not on PATH (Claude Code's ~/.local/bin on a stock macOS,
      // opencode's ~/.opencode/bin): the shortcut runs it by its full path, so it
      // works without the user editing PATH first.
      const d = found.get(t.id);
      if (d?.bin && !d.onPath) rec.bin = d.bin;
      const files = shortcutFiles(ctx, binDir.dir, name, rec, { tool: t.id });
      const foreign = foreignShortcut(files);
      if (foreign) plan.error = plan.error || `${tidy(ctx, foreign)} already exists and is not an aile shortcut — pick another name with --shortcut-name`;
      else plan.shortcut = { name, files };
    }
    plans.push(plan);
  }

  // --- show it ----------------------------------------------------------------
  const work = plans.filter((p) => !p.manual);
  if (work.length) {
    console.log(`\n${C.bold}${dryRun ? "Would change" : "Changes"}${C.reset}${key && !dryRun ? `  ${C.dim}key ${describeKey(key)}${keyNote ? ` · ${keyNote}` : ""}${C.reset}` : ""}`);
    const routedWork = work.filter((p) => routeOf(p.tool));
    if (routedWork.length) {
      const where = routedWork.map((p) => (p.tool.id === "claude" ? "Claude Code main and haiku" : "Codex model")).join(", ");
      console.log(`  ${C.dim}route     ${route || saved.name} (${where})${C.reset}`);
      const about = routes?.find((a) => a?.name === (route || saved.name))?.description;
      if (about) console.log(`  ${C.dim}          ${about}${C.reset}`);
    }
    if (args.auto && !rest.length && !args.all) {
      console.log(routes?.some((a) => a?.name === route)
        ? `  ${C.dim}Claude Code only. Your key saves a route named ${route}, which Codex can use: aile setup claude codex --auto${C.reset}`
        : `  ${C.dim}Claude Code only: aile/auto does not work on Codex.${C.reset}`);
    }
    for (const p of work) {
      console.log(`  ${C.bold}${p.tool.label}${C.reset}`);
      if (p.error) console.log(`    ${C.yellow}skipped${C.reset}  ${p.error}`);
      if (p.shortcut) console.log(`    shortcut  ${C.cyan}${p.shortcut.name}${C.reset} ${C.dim}→ ${tidy(ctx, p.shortcut.files[0].file)}${C.reset}`);
      for (const e of p.config?.edits || []) {
        if (!e.changed) { console.log(`    config    ${tidy(ctx, e.file)} ${C.dim}(already set)${C.reset}`); continue; }
        console.log(`    config    ${tidy(ctx, e.file)}${e.created ? ` ${C.dim}(new)${C.reset}` : ""}`);
      }
      if (p.conflict) console.log(`    ${C.yellow}note${C.reset}      it ${p.conflict} — replaced, and restored by --remove`);
      if (p.offCodex) {
        const why = unreadClause(token, routes);
        console.log(`    ${C.yellow}note${C.reset}      ${p.takes ? `takes ${p.takes}` : "keeps its own model"}: ${p.offCodex} does not work on Codex${why ? `; ${why}` : ""}`);
      }
    }
    if (dryRun && !binDir.onPath && work.some((p) => p.shortcut)) {
      console.log(`\n  ${C.yellow}${tidy(ctx, binDir.dir)} is not on your PATH yet.${C.reset} After setup, run:`);
      console.log(`    ${pathHint(ctx, binDir.dir)}`);
    }
  }

  if (dryRun) {
    // What CHANGES, never the whole file: these are the user's files, and some
    // (opencode's auth.json) hold their other providers' keys.
    for (const p of work) {
      for (const e of p.config?.edits || []) {
        if (!e.changed) continue;
        console.log(`\n${C.dim}--- ${e.file}${C.reset}`);
        for (const line of describeRecords(e.records, key)) console.log(`  ${line}`);
      }
      if (p.shortcut) console.log(`\n${C.dim}--- ${p.shortcut.files[0].file}${C.reset}\n${maskKey(p.shortcut.files[0].text, key)}`);
    }
    printManual(plans, ctx, { key: null, model: fallbackModel, models: listed });
    console.log(`\n${C.dim}Dry run — nothing was written.${C.reset}\n`);
    return;
  }

  const actionable = work.filter((p) => p.config || p.shortcut);
  if (actionable.length) {
    const conflicts = actionable.filter((p) => p.conflict);
    if (interactive) {
      const ok = await promptConfirm(`\n${C.bold}Apply?${C.reset}`, { defaultYes: true });
      if (!ok) { console.log("\n  Nothing changed.\n"); return; }
    } else if (conflicts.length && !args.yes) {
      fail("Some tools already point somewhere else.", "Re-run with --yes to replace those settings (--remove restores them).");
    }

    // --- write ------------------------------------------------------------------
    const manifest = loadManifest();
    manifest.serverUrl = ctx.serverUrl;
    manifest.defaultModel = fallbackModel;
    recordKey(manifest, key, keyInfo);
    for (const p of actionable) {
      const records = [];
      try {
        for (const e of p.config?.edits || []) records.push(...commitEdit(e));
        const shortcut = p.shortcut ? { name: p.shortcut.name, files: installShortcut(p.shortcut.files) } : null;
        recordTool(manifest, p.tool.id, {
          mode: p.config && p.shortcut ? "both" : p.config ? "config" : "shortcut",
          records, shortcut,
        });
        p.done = true;
      } catch (e) {
        // Whatever did land is still recorded, so --remove can undo it.
        if (records.length) recordTool(manifest, p.tool.id, { records });
        p.error = `could not write: ${e.message}`;
      }
    }
    if (routable) noteRoute(manifest, { holders, route: route || saved?.name, prefix, plans: actionable, routeOf, before });
    saveManifest(manifest);

    console.log();
    for (const p of actionable) {
      if (p.done) console.log(okLine(p.tool.label));
      else console.log(badLine(p.tool.label, p.error));
    }
  }

  printManual(plans, ctx, { key, model: fallbackModel, models: listed });
  const self = invoker?.id && plans.find((p) => p.done && p.tool.id === invoker.id && p.config);
  if (self) {
    console.log(`\n  ${C.yellow}${invoker.name} is running this command.${C.reset} Its new settings apply to its next session — restart it.`);
  }
  // `aile setup refresh` runs this once per mode group and prints the footer
  // itself, once, for all of them.
  if (!args.noNext) printNext(plans, ctx, { binDir, found });
  return { plans, binDir, found, ctx, dropped, rekept };
}

/** How a tool was found, in a few words for a menu or a table. */
export function foundNote(d) {
  if (!d?.found) return "not found";
  if (d.via === "path") return "installed";
  if (d.via === "location") return "installed, not on PATH";
  if (d.via === "app") return "app installed";
  if (d.via === "extension") return `in ${[...new Set(d.extensions.map((e) => e.host))].join(", ")}`;
  if (d.via === "config") return "settings found, command not";
  return "found";
}

/** What setup will do to a tool, in a few words — the note on its row. */
function doesNote(t, d, { showMissing = false } = {}) {
  const does = t.kinds.includes("shortcut") ? `adds ${shortcutName(t.id)}`
    : t.id === "opencode" ? "adds aile's plugin"
    : t.kinds.includes("config") ? "adds aile as a provider"
    : d?.via === "extension" ? foundNote(d)
    : "";
  const missing = showMissing && !isInstalled(d) ? "not found" : "";
  return [does, missing].filter(Boolean).join(` ${sym.dot} `);
}

function maskKey(text, key) {
  if (!key || !KEY_RE.test(key)) return text;
  return text.split(key).join(describeKey(key));
}

/** One line per recorded change, secrets masked — for `--dry-run`. */
function describeRecords(records, key) {
  const show = (v) => {
    const s = JSON.stringify(v);
    if (s === undefined) return "";
    const masked = maskKey(s, key);
    return masked.length > 120 ? `${masked.slice(0, 117)}…` : masked;
  };
  const out = [];
  for (const r of records || []) {
    if (r.kind === "json-set") {
      const at = r.path.join(".");
      out.push(r.value === undefined ? `remove ${at}${r.had ? `  (was ${show(maskOther(r.prev))})` : ""}` : `set    ${at} = ${show(r.value)}`);
    } else if (r.kind === "json-array-owned") {
      const n = r.added ?? 0;
      out.push(`add    ${n} entr${n === 1 ? "y" : "ies"} to ${r.path.join(".")}${r.hadArray ? ` (replacing any earlier aile entries)` : ""}`);
    } else if (r.kind === "toml-key") {
      out.push(r.value === null ? `remove ${r.key}${r.had ? `  (was: ${r.prev.trim()})` : ""}` : `set    ${r.value}${r.had ? `  (was: ${r.prev.trim()})` : ""}`);
    } else if (r.kind === "toml-block") {
      out.push("add    [model_providers.aile] (name, base_url, wire_api, experimental_bearer_token)");
    }
  }
  return out;
}

/** A replaced value may be somebody's other credential: show only that it existed. */
function maskOther(v) {
  return typeof v === "string" && v.length > 16 ? `${v.slice(0, 6)}…` : v;
}

/**
 * The key, with the unsupported-server case handled: a relay too old to grant
 * a key from the browser gets the dashboard link and a paste prompt instead.
 */
async function getKey({ args, config, server, insecure, ctx, interactive }) {
  const source = { given: "yours", saved: "saved on this machine", account: "new, on your account", browser: "new, approved in your browser" };
  try {
    const got = await obtainKey({ args, config, serverUrl: server, insecure, interactive: isInteractive() });
    const limited = got.check?.limited ? `at its credit limit — raise it at ${keysUrl(ctx)}` : null;
    return { key: got.key, note: limited || source[got.source], info: { id: got.id, account: got.account, source: got.source } };
  } catch (e) {
    if (!(e instanceof KeyError)) throw e;
    if (e.reason === "unsupported" || e.reason === "no-tty") {
      console.log(`\n  ${e.message}`);
      if (!isInteractive()) {
        fail("No terminal to sign in or paste on.", `aile login, then aile setup …   or   aile setup --key <key> …   or   echo $KEY | aile setup --key - …`);
      }
      /**
       * A SERVER THAT CANNOT APPROVE A KEY FROM THE BROWSER still has the other
       * two ways in, and pasting was the only one offered. Signing in first is
       * usually the easier one: the browser does the work, and once this machine
       * is signed in the key is made on the account with no further step.
       *
       * Its cost is said on the row, because it is real: a sign-in hands out a
       * new account token, which signs out every other machine on the account.
       * That is exactly what the browser key approval exists to avoid.
       */
      const pick = await promptChoice(`${C.bold}How would you like to get a key?${C.reset}`, [
        { label: "Sign in with your browser", note: "the key is made on your account · your other machines sign out" },
        { label: "Paste a key", note: `create one at ${keysUrl(ctx)}` },
      ]);
      if (pick === null) fail("No key — nothing changed.");
      if (pick === 0) return signInForKey({ args, server, insecure, ctx });
      return pasteKey({ server, insecure });
    }
    fail(e.message, e.hint);
  }
}

/** Sign this machine in, then make the key on that account — `aile login`, then step 3. */
async function signInForKey({ args, server, insecure, ctx }) {
  let result;
  try {
    result = await signIn({ serverUrl: server, insecure, token: null, mode: "auto" });
  } catch (e) {
    fail(`Sign-in failed: ${e.message}`, e instanceof LoginError && e.hint ? e.hint : "Run `aile login --paste` to sign in without a browser, then `aile setup` again.");
  }
  console.log(`\n${okLine(`Signed in as ${result.renter?.email || "your account"}`)}`);
  try {
    const got = await obtainKey({ args: { ...args, key: undefined }, config: loadConfig(), serverUrl: server, insecure, interactive: false });
    return { key: got.key, note: "new, on your account", info: { id: got.id, account: got.account, source: got.source } };
  } catch (e) {
    if (!(e instanceof KeyError)) throw e;
    fail(`Signed in, but no key could be made: ${e.message}`, `Create one at ${keysUrl(ctx)} and run \`aile setup --key <key>\`.`);
  }
}

/** Up to three tries at a pasted key, each checked with the server before use. */
async function pasteKey({ server, insecure }) {
  for (let i = 0; i < 3; i++) {
    const k = cleanKey(await promptSecret("  API key: "));
    if (!k) break;
    if (!KEY_RE.test(k)) { console.log("  That is not an aile key — it starts with sk-aile-."); continue; }
    const v = await checkKey({ key: k, serverUrl: server, insecure });
    if (!v.ok) { console.log(`  ${v.reason}`); continue; }
    saveConfig({ buyerKey: k });
    return { key: k, note: "yours", info: { id: null, account: null, source: "given" } };
  }
  fail("No key — nothing changed.");
}

function printManual(plans, ctx, { key, model, models }) {
  for (const p of plans.filter((x) => x.manual)) {
    console.log(`\n${C.bold}${p.tool.label}${C.reset}`);
    for (const line of p.tool.steps(ctx, { key, model, models })) console.log(`  ${line}`);
  }
}

function printNext(plans, ctx, { binDir, found }) {
  const done = plans.filter((p) => p.done);
  if (!done.length) { console.log(); return; }
  console.log(`\n${heading("Start")}`);
  const w = Math.max(12, ...done.map((p) => width(p.shortcut ? p.shortcut.name : RUNNERS[p.tool.id]?.bin || p.tool.id)));
  for (const p of done) {
    const t = p.tool;
    const cmd = p.shortcut ? p.shortcut.name : RUNNERS[t.id]?.bin || t.id;
    const how = {
      claude: "Claude Code on aile — `/model` lists every Claude model aile can serve",
      codex: "Codex on aile",
      opencode: "opencode — the aile models appear in `/models`",
      droid: "Factory Droid — pick an `aile ·` model in `/model`",
      openclaw: "OpenClaw — the `aile` provider is available",
    }[t.id] || `${t.label} on aile`;
    const missing = !isInstalled(found.get(t.id)) && INSTALL[t.id] ? `  ${C.dim}(not installed: ${INSTALL[t.id]})${C.reset}` : "";
    console.log(`  ${padTo(`${C.cyan}${cmd}${C.reset}`, w)}  ${how.replace(/`([^`]+)`/g, `${C.cyan}$1${C.reset}`)}${missing}`);
  }
  if (!binDir.onPath && done.some((p) => p.shortcut)) {
    console.log(`\n  ${C.yellow}First put ${tidy(ctx, binDir.dir)} on PATH:${C.reset} ${pathHint(ctx, binDir.dir)}`);
  }
  console.log(`\n  ${C.dim}Add funds   ${C.reset}${fundUrl(ctx)}`);
  console.log(`  ${C.dim}Check       ${C.reset}aile doctor`);
  console.log(`  ${C.dim}Undo        ${C.reset}aile setup --remove\n`);
}

// ---------------------------------------------------------------------------
// aile setup status
// ---------------------------------------------------------------------------

export async function setupStatus(args) {
  const config = loadConfig();
  const ctx = makeCtx({ serverUrl: args.server || config.serverUrl });
  const manifest = loadManifest();
  const rows = TOOLS.filter((t) => !printsOnly(t)).map((t) => {
    const rec = manifest.tools[t.id];
    const st = t.status(ctx);
    const shortcut = rec?.shortcut?.name && rec.shortcut.files?.some((f) => fs.existsSync(f)) ? rec.shortcut.name : null;
    return { id: t.id, label: t.label, found: t.detect(ctx).found, config: st, shortcut };
  });
  if (args.json) {
    console.log(JSON.stringify({ serverUrl: ctx.serverUrl, key: config.buyerKey ? describeKey(config.buyerKey) : null, tools: rows }, null, 2));
    return;
  }
  const labelW = Math.max(...rows.map((r) => width(r.label)));
  console.log(`\n  Key:     ${config.buyerKey ? describeKey(config.buyerKey) : `${C.dim}none — run aile setup${C.reset}`}`);
  console.log(`  Server:  ${ctx.serverUrl}\n`);
  for (const r of rows) {
    const cfg = r.config.state === "aile" ? `${C.green}config → aile${C.reset}${r.config.detail ? ` ${C.dim}(${r.config.detail})${C.reset}` : ""}`
      : r.config.state === "other" ? `${C.yellow}config → ${r.config.detail}${C.reset}` : "";
    const sc = r.shortcut ? `${C.green}${r.shortcut}${C.reset}` : "";
    const bits = [sc, cfg].filter(Boolean).join("  ");
    console.log(`  ${padTo(r.label, labelW)}  ${bits || `${C.dim}${r.found ? "installed, not set up" : "not installed"}${C.reset}`}`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// aile setup --remove
// ---------------------------------------------------------------------------

export async function setupRemove(args, names) {
  const config = loadConfig();
  const ctx = makeCtx({ serverUrl: args.server || config.serverUrl });
  const manifest = loadManifest();
  const ids = names.length
    ? names.map((n) => { const t = getTool(n); if (!t) fail(`Unknown tool "${n}".`); return t.id; })
    : Object.keys(manifest.tools);
  const targets = ids.filter((id) => manifest.tools[id]);
  if (!targets.length) {
    console.log(`\n  Nothing to undo — ${names.length ? "those tools were" : "no tool was"} set up by aile here.\n`);
    return;
  }
  console.log(`\n${heading("Undo")}`);
  for (const id of targets) {
    const rec = manifest.tools[id];
    const files = [...new Set((rec.records || []).map((r) => r.file).filter(Boolean))];
    console.log(`  ${getTool(id)?.label || id}${rec.shortcut ? `  ${C.dim}shortcut ${rec.shortcut.name}${C.reset}` : ""}`);
    for (const f of files) console.log(`    restore ${tidy(ctx, f)}`);
  }
  if (isInteractive() && !args.yes) {
    if (!(await promptConfirm(`\n${C.bold}Undo these?${C.reset}`, { defaultYes: true }))) {
      console.log("\n  Nothing changed.\n");
      return;
    }
  }
  const notes = [];
  for (const id of targets) {
    const rec = manifest.tools[id];
    const tool = getTool(id);
    if (tool) notes.push(...(revertTool(tool, ctx, rec.records || []) || []));
    if (rec.shortcut?.files) removeShortcut(rec.shortcut.files);
    delete manifest.tools[id];
    console.log(okLine(tool?.label || id));
  }
  // The route goes with the last tool that was pointed at it.
  const held = routeHolders(manifest);
  if (held.length) manifest.route = { ...manifest.route, tools: held };
  else delete manifest.route;

  // NOTHING LEFT USING THE KEY: a full uninstall forgets it here too, so this
  // machine holds no credential for a setup it no longer has. It still exists
  // on the account until revoked — `--revoke` does that when this machine can
  // (it is signed in); otherwise the dashboard does.
  const everything = !Object.keys(manifest.tools).length;
  const recorded = manifest.key;
  if (everything && !args["keep-key"]) {
    if (args.revoke && recorded?.id && config.renterToken) {
      try {
        await api.revokeKey({ id: recorded.id, serverUrl: ctx.serverUrl, token: config.renterToken });
        console.log(okLine(`key ${recorded.prefix} revoked`));
      } catch (e) {
        console.log(warnLine(`could not revoke ${recorded.prefix}: ${e.message}`));
      }
    }
    if (config.buyerKey) saveConfig({ buyerKey: "" });
    delete manifest.key;
  }
  saveManifest(manifest);
  for (const n of notes) console.log(warnLine(n));
  if (everything && !args["keep-key"] && !(args.revoke && recorded?.id && config.renterToken)) {
    console.log(`\n  ${C.dim}The key is forgotten here but still exists on your account — revoke it at ${keysUrl(ctx)}${recorded?.id && config.renterToken ? " or re-run with --revoke" : ""}.${C.reset}\n`);
  } else {
    console.log();
  }
}

// ---------------------------------------------------------------------------
// The key's owner, and switching every tool to another key
// ---------------------------------------------------------------------------

/**
 * Remember which key the tools were given, and whose it is: `{prefix, id,
 * account: {id, email}, source, at}`. The prefix identifies the key without
 * storing it twice; the account is what lets `aile login` notice that the tools
 * are still billing somebody else.
 */
export function recordKey(manifest, key, info) {
  if (!key) return;
  const prefix = describeKey(key);
  const same = manifest.key?.prefix === prefix;
  manifest.key = {
    prefix,
    id: info?.id ?? (same ? manifest.key.id : null) ?? null,
    account: info?.account ?? (same ? manifest.key.account : null) ?? null,
    source: info?.source ?? (same ? manifest.key.source : null) ?? null,
    at: new Date().toISOString(),
  };
}

/** Tools `aile setup` has configured here, and how: `[{id, mode}]`. */
export function toolsSetUp(manifest = loadManifest()) {
  return Object.entries(manifest.tools).map(([id, rec]) => {
    const m = new Set(rec.modes || []);
    const both = m.has("both") || (m.has("config") && m.has("shortcut"));
    return { id, mode: both ? "both" : m.has("config") ? "default" : "shortcut" };
  });
}

/**
 * `aile setup refresh` — put the current key (or a new one: `--new-key`,
 * `--key <key>`) into every tool already set up, the way each was set up. For
 * a revoked key, a key that hit its limit, or a switch to another account.
 */
export async function setupRefresh(args) {
  const config = loadConfig();
  const server = args.server || config.serverUrl;
  const insecure = transport(args, server);
  const ctx = makeCtx({ serverUrl: server });
  const tools = toolsSetUp();
  if (!tools.length) {
    console.log(`\n  No tool is set up here yet — run ${C.cyan}aile setup${C.reset}.\n`);
    return;
  }
  // A name only Codex could take is decided here, before a key is made or any group writes.
  const asked = args.auto ? "aile/auto" : typeof args.route === "string" ? args.route.trim() : null;
  if (ZERO_SETUP.has(asked) && !tools.some((t) => t.id === "claude")) {
    await refuseCodexOnly({ route: asked, args, config, server, insecure });
  }
  console.log(`\n${heading("aile setup refresh", tools.map((t) => getTool(t.id)?.label || t.id).join(", "))}`);
  const got = await getKey({ args, config, server, insecure, ctx, interactive: isInteractive() });
  // Grouped by mode because one run of setup takes one mode for Claude Code
  // and Codex; every other tool ignores it.
  const groups = new Map();
  for (const t of tools) {
    if (!groups.has(t.mode)) groups.set(t.mode, []);
    groups.get(t.mode).push(t.id);
  }
  const runs = [];
  // Each run keeps the route record until the last tool holding it has let go of it, so the
  // groups after the first still find it.
  for (const [mode, ids] of groups) {
    runs.push(await setupCommand({ ...args, _: ["setup", ...ids], mode, yes: true, quiet: true, noNext: true, resolvedKey: got }));
  }
  const done = runs.filter(Boolean);
  const dropped = done.find((r) => r.dropped)?.dropped;
  if (dropped) console.log(`  ${C.dim}Route ${dropped} left out: this is not the key it was chosen for.${C.reset}`);
  const rekept = done.find((r) => r.rekept)?.rekept;
  if (rekept) console.log(`  ${C.dim}Route ${rekept} kept: on this key it means aile's own table, unless the key saves a route of that name.${C.reset}`);
  if (done.length) {
    const last = done[done.length - 1];
    printNext(done.flatMap((r) => r.plans), last.ctx, { binDir: last.binDir, found: last.found });
  }
}

// ---------------------------------------------------------------------------
// aile run <tool> [args…]
// ---------------------------------------------------------------------------

/**
 * Split `aile [flags] run [our flags] <tool> [the tool's args…]`. Everything
 * after the tool name belongs to the tool, flags included — `aile run claude
 * --resume` must reach Claude Code as `--resume`, not be read as ours.
 */
export function splitRunArgv(argv, command = "run") {
  const i = argv.indexOf(command);
  const tail = argv.slice(i + 1);
  const ours = {};
  let j = 0;
  const VALUED = new Set(["--model", "--server", "--key", "--shell"]);
  while (j < tail.length && tail[j].startsWith("--")) {
    const a = tail[j];
    const eq = a.indexOf("=");
    if (eq > 2) { ours[a.slice(2, eq)] = a.slice(eq + 1); j++; continue; }
    if (VALUED.has(a) && tail[j + 1] !== undefined) { ours[a.slice(2)] = tail[j + 1]; j += 2; continue; }
    ours[a.slice(2)] = true;
    j++;
  }
  const tool = tail[j] || null;
  let rest = tail.slice(j + 1);
  if (rest[0] === "--") rest = rest.slice(1);
  return { ours, tool, rest };
}

async function launchRecipe(ours, toolName) {
  const t = getTool(toolName);
  if (!t || !t.runner) {
    const runnable = TOOLS.filter((x) => x.runner).map((x) => x.id).join(", ");
    fail(toolName ? `aile cannot start "${toolName}".` : "Name the tool to start.", `aile run <tool>, where tool is one of: ${runnable}`);
  }
  const config = loadConfig();
  const server = ours.server || config.serverUrl;
  const ctx = makeCtx({ serverUrl: server });
  const key = ours.key ? cleanKey(ours.key) : config.buyerKey;
  if (!key) fail("No API key on this machine yet.", "Run `aile setup` once (or pass --key).");
  // Codex is sent a model, and the zero-setup names are a 400 there unless the key saves a route of that name.
  if (t.id === "codex" && ZERO_SETUP.has(String(ours.model))) {
    const row = await keyRowOf({ key, server, insecure: Boolean(ours.insecure), token: config.renterToken });
    if (!row?.aliases?.some((a) => a?.name === ours.model)) {
      fail(`${ours.model} does not work on Codex unless your key saves a route of that name.`, `Name another model, or save the route and run: aile setup codex --route ${ours.model}`);
    }
  }
  let def = null;
  if (NEEDS_MODEL.has(t.runner) && !ours.model) {
    def = loadManifest().defaultModel || defaultModel(await fetchChatModels({ serverUrl: server, insecure: Boolean(ours.insecure) }));
  }
  const rec = recipe(t.runner, { key, ...ctx, model: ours.model || null, defaultModel: def });
  return { t, ctx, rec };
}

export async function runCommand(argv) {
  const { ours, tool, rest } = splitRunArgv(argv);
  const { t, ctx, rec } = await launchRecipe(ours, tool);
  const bin = which(rec.bin, { env: ctx.env, platform: ctx.platform }) || detectTool(ctx, t.id).bin;
  if (!bin) fail(`${t.label} is not installed (no \`${rec.bin}\` on PATH).`, INSTALL[t.id] ? `Install it: ${INSTALL[t.id]}` : null);
  const code = await spawnTool(bin, [...rec.args, ...rest], { env: childEnv(process.env, rec) });
  process.exit(code);
}

// ---------------------------------------------------------------------------
// aile env <tool>
// ---------------------------------------------------------------------------

export async function envCommand(argv) {
  const { ours, tool } = splitRunArgv(argv, "env");
  const { rec } = await launchRecipe(ours, tool);
  const shell = String(ours.shell || (process.platform === "win32" ? "powershell" : /fish$/.test(process.env.SHELL || "") ? "fish" : "sh"));
  const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  const lines = [];
  for (const [k, v] of Object.entries(rec.env)) {
    if (shell === "powershell") lines.push(`$env:${k} = "${String(v).replace(/[`"$]/g, "`$&")}"`);
    else if (shell === "cmd") lines.push(`set "${k}=${v}"`);
    else if (shell === "fish") lines.push(`set -gx ${k} ${q(v)}`);
    else lines.push(`export ${k}=${q(v)}`);
  }
  for (const k of rec.unset) {
    if (shell === "powershell") lines.push(`Remove-Item Env:${k} -ErrorAction SilentlyContinue`);
    else if (shell === "cmd") lines.push(`set "${k}="`);
    else if (shell === "fish") lines.push(`set -e ${k}`);
    else lines.push(`unset ${k}`);
  }
  console.log(lines.join("\n"));
  if (rec.args.length) {
    console.error(`${C.dim}# then start it with: ${rec.bin} ${rec.args.join(" ")}${C.reset}`);
  }
}

// ---------------------------------------------------------------------------
// aile doctor
// ---------------------------------------------------------------------------

export async function doctorCommand(args) {
  const config = loadConfig();
  const server = args.server || config.serverUrl;
  const insecure = !isSecureUrl(server) && (args.insecure || config.allowInsecure === true);
  const ctx = makeCtx({ serverUrl: server });
  const ok = (s) => console.log(okLine(s));
  const bad = (s, hint) => console.log(`${badLine(s)}${hint ? `\n    ${hintText(hint)}` : ""}`);
  const warn = (s, hint) => console.log(`${warnLine(s)}${hint ? `\n    ${hintText(hint)}` : ""}`);
  let problems = 0;

  console.log(`\n${heading("aile doctor")}\n`);
  try {
    await withSpinner(`Reaching ${server}…`, api.health({ serverUrl: server, insecure, timeoutMs: 10000 }));
    ok(`${server} is reachable`);
  } catch (e) {
    problems++;
    bad(`${server} is not reachable: ${e.message}`);
  }

  if (!config.buyerKey) {
    problems++;
    bad("No API key on this machine", "Run `aile setup`.");
  } else {
    const v = await withSpinner("Checking the key…", checkKey({ key: config.buyerKey, serverUrl: server, insecure }));
    if (v.unverified) warn(`Key ${describeKey(config.buyerKey)} could not be checked (${v.reason})`);
    else if (!v.ok) { problems++; bad(`Key ${describeKey(config.buyerKey)} is refused: ${v.reason}`, "Run `aile setup --new-key`."); }
    else if (v.limited) warn(`Key ${describeKey(config.buyerKey)} is at its credit limit`, `Raise it at ${keysUrl(ctx)}.`);
    else ok(`Key ${describeKey(config.buyerKey)} works`);
  }

  const manifest = loadManifest();
  for (const [id, rec] of Object.entries(manifest.tools)) {
    const t = getTool(id);
    if (!t) continue;
    if (rec.shortcut?.name) {
      const on = which(rec.shortcut.name, { env: ctx.env, platform: ctx.platform });
      const exists = rec.shortcut.files?.some((f) => fs.existsSync(f));
      if (on) ok(`${t.label}: \`${rec.shortcut.name}\` is on PATH`);
      else if (exists) { problems++; bad(`${t.label}: \`${rec.shortcut.name}\` exists but is not on PATH`, pathHint(ctx, ctx.path.dirname(rec.shortcut.files[0]))); }
      else { problems++; bad(`${t.label}: the \`${rec.shortcut.name}\` shortcut is gone`, `Run \`aile setup ${id}\` again.`); }
      if (t.runner && !which(RUNNERS[t.runner].bin, { env: ctx.env, platform: ctx.platform })) {
        warn(`${t.label} itself is not installed`, INSTALL[id] ? `Install it: ${INSTALL[id]}` : null);
      }
    }
    if ((rec.modes || []).some((m) => m === "config" || m === "both")) {
      const st = t.status(ctx);
      if (st.state === "aile") ok(`${t.label}: config points at aile`);
      else { problems++; bad(`${t.label}: config no longer points at aile${st.detail ? ` (${st.detail})` : ""}`, `Run \`aile setup ${id}\` again.`); }
    }
  }
  if (!Object.keys(manifest.tools).length) warn("No tool is set up here yet", "Run `aile setup`.");

  // A variable exported by the shell sits under whatever a tool's config says,
  // and is the usual reason "it still uses my old provider".
  for (const v of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "OPENAI_BASE_URL"]) {
    if (process.env[v] && !(process.env[v] || "").startsWith(ctx.serverUrl) && !KEY_RE.test(process.env[v] || "")) {
      warn(`${v} is set in this shell`, "It can override what `aile setup` wrote; unset it if a tool ignores aile.");
    }
  }

  console.log(`\n  ${C.dim}Add funds: ${fundUrl(ctx)}${C.reset}`);
  console.log(problems
    ? `\n${badLine(`${problems} problem${problems === 1 ? "" : "s"} found.`)}\n`
    : `\n${okLine("Everything looks right.")}\n`);
  if (problems) process.exitCode = 1;
}

export { MANIFEST_FILE, webOrigin };

// ---------------------------------------------------------------------------
// aile detect
// ---------------------------------------------------------------------------

/** Every tool's version, in parallel, each bounded by probeVersion's own timeout. */
function probeAll(rows, ctx) {
  return Promise.all(rows.map(({ d }) =>
    (d.bin ? probeVersion(d.bin, { platform: ctx.platform, env: ctx.env }) : Promise.resolve(null))));
}

/** Installed, as opposed to having left only a config directory behind. */
export function isInstalled(d) {
  return Boolean(d?.found) && d.via !== "config";
}

/**
 * Every coding tool aile knows, whether it is installed, where, which
 * version, and what `aile setup` would do with it. The same detection the
 * setup wizard uses to pre-tick its list, shown on its own.
 */
export async function detectCommand(args) {
  const config = loadConfig();
  const ctx = makeCtx({ serverUrl: args.server || config.serverUrl });
  const rows = TOOLS.map((t) => ({ t, d: t.detect(ctx) }));
  // Versions in parallel, each bounded by probeVersion's own timeout, and
  // skipped with --fast: running a dozen programs is the slow part.
  const versions = args.fast ? rows.map(() => null)
    : await withSpinner("Looking for coding tools…", probeAll(rows, ctx));

  const out = rows.map(({ t, d }, i) => ({
    id: t.id,
    label: t.label,
    found: d.found,
    installed: isInstalled(d),
    via: d.via,
    where: d.where,
    onPath: d.onPath,
    version: versions[i] || (d.extensions[0]?.version ?? null),
    extensions: d.extensions,
    setup: t.kinds.includes("unsupported") ? "unsupported" : t.kinds.includes("manual") ? "steps" : t.kinds.join("+"),
  }));

  if (args.json) {
    console.log(JSON.stringify({ platform: ctx.platform, invoker: detectInvoker(process.env), tools: out }, null, 2));
    return;
  }

  const does = (r) => ({
    "shortcut+config": `aile setup ${r.id}`,
    config: `aile setup ${r.id}`,
    shortcut: `aile setup ${r.id}`,
    steps: `aile setup ${r.id} (steps)`,
    unsupported: "not supported yet",
  }[r.setup]);
  const have = out.filter((r) => r.installed || r.via === "config");
  const missing = out.filter((r) => !r.installed && r.via !== "config");

  console.log(`\n${heading("Coding tools on this machine")}\n`);
  if (!have.length) console.log(`  ${C.dim}None found.${C.reset}`);
  // One table so the columns line up and a long path is cut to the terminal
  // rather than wrapped; the setup command sits under each row.
  const lines = table([
    { key: "label" }, { key: "version" }, { key: "note" }, { key: "where", shrink: true },
  ], have.map((r) => ({
    label: `${r.installed ? `${C.green}${sym.ok}${C.reset}` : `${C.yellow}?${C.reset}`} ${r.label}`,
    version: r.version || "",
    note: r.installed ? foundNote(r) : `${C.dim}${foundNote(r)}${C.reset}`,
    where: r.via === "extension" ? "" : `${C.dim}${tidy(ctx, r.where)}${C.reset}`,
  })), { header: false }).split("\n");
  have.forEach((r, i) => {
    if (!lines[i]) return;
    console.log(lines[i]);
    console.log(`    ${C.cyan}${does(r)}${C.reset}`);
  });
  // A name is one unit: its own spaces are non-breaking, so "Gemini CLI" is
  // never split across two lines and read as two tools.
  if (missing.length) console.log(`\n${C.dim}${wrap(`Not found: ${missing.map((r) => r.label.replace(/ /g, " ")).join(", ")}`)}${C.reset}`);
  console.log(`\n${wrap(`${C.dim}Set up everything found:${C.reset} ${C.cyan}aile setup${C.reset} ${C.dim}${sym.dot} details:${C.reset} ${C.cyan}aile detect --json${C.reset}`)}\n`);
}
