/**
 * `aile local` — run a model on this machine and lend it.
 *
 *   aile local                         what is set up, and what it sells as
 *   aile local setup                   one command: engine, model, test, lend
 *   aile local models [query]          models aile can download and sell
 *   aile local pull <model>            download one (curated id, Ollama tag, hf.co/…)
 *   aile local list                    what is downloaded here
 *   aile local rm <model>              delete one
 *   aile local run <model> [prompt]    talk to it
 *   aile local install [engine]        install Ollama or llama.cpp
 *   aile local on | --off              start / stop lending it
 *   aile local <url>                   lend a model server you already run
 *
 * SELLING NEEDS THE RIGHT NAME. The relay sells `local/<id>` only when `<id>`
 * has a published list price, matched exactly. A model pulled under its own
 * name (`llama3.1:8b`) runs but earns nothing, so the curated models are saved
 * under the priced id (src/local/catalog.js), and every screen that names a
 * model says whether it sells — from the server's own answer, never a guess.
 *
 * THIS TRAFFIC IS NOT BLIND. The model runs here, so this machine reads the
 * prompts it answers. Said wherever lending is switched on.
 *
 * Downloads and installs happen only here, in a command the user typed. The
 * relay's code never reaches this module (`test/local-isolation.test.js`).
 */

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { loadConfig, updateSettings } from "../relay/config.js";
import { resolveLocalTarget, discoverLocalModels, localStatus } from "../relay/local.js";
import { C } from "./colors.js";
import {
  heading, next, kv, table, ok, warn, bad, info, dim, cmd, hintText,
  die, withSpinner, progress, formatBytes, formatDuration,
} from "./ui.js";
import { isInteractive, promptChoice, promptConfirm, promptLine } from "./prompt.js";
import { suggest } from "./help.js";
import { CURATED, resolveModelRef, searchCurated, sizeFor } from "../local/catalog.js";
import { detectHardware, describeHardware, fit, FIT_LABEL, FIT_RANK, diskFree } from "../local/hardware.js";
import * as ollama from "../local/ollama.js";
import { listRepoFiles, pickGguf, pullFromHf } from "../local/hf.js";
import { installLlamaCpp, ollamaInstallPlan, runOllamaInstall, InstallError } from "../local/install.js";
import { pickAsset, assetBytes, serverArgs, endpointPort, LLAMACPP_DEFAULT_ENDPOINT } from "../local/llamacpp.js";
import { LLAMACPP_PINS } from "../local/llamacpp-pins.js";
import { detectEngine, LlamaServer } from "../local/engine.js";
import { chatOnce, chatStream, ChatError } from "../local/chat.js";
import { loadManifest, saveManifest, upsertModel, removeModel, findModel } from "../local/manifest.js";
import { modelsDir, logsDir, localDir } from "../local/paths.js";
import { livePrices, sellState, priceText, snapshotAdvertising, addAdvertised, removeAdvertised, parseList } from "../local/sell.js";

const SUBCOMMANDS = ["setup", "models", "search", "pull", "list", "ls", "rm", "remove", "run", "install", "on", "status"];
const ENGINE_NAME = { ollama: "Ollama", llamacpp: "llama.cpp", external: "your server" };

/** `aile local …` */
export async function localCommand(args, { banner = () => {}, startNode = null } = {}) {
  const sub = args._[1] === undefined ? undefined : String(args._[1]);
  if (args.off) { banner(); return legacyOff(); }
  if (sub === undefined) {
    banner();
    return args.endpoint ? legacyEndpoint(args, String(args.endpoint)) : showStatus(args);
  }
  switch (sub.toLowerCase()) {
    case "setup": banner(); return setupWizard(args, { startNode });
    case "models": case "search": banner(); return showModels(args);
    case "pull": banner(); return pullCommand(args);
    case "list": case "ls": banner(); return listCommand(args);
    case "rm": case "remove": banner(); return rmCommand(args);
    case "run": return runCommand(args);
    case "install": banner(); return installCommand(args);
    case "on": banner(); return onCommand();
    case "status": banner(); return showStatus(args);
    default: break;
  }
  // A word that is not a URL and is close to a subcommand is a typo, not an
  // endpoint. Anything else keeps the endpoint path and its own error.
  if (!/[:/.]/.test(sub)) {
    const hits = suggest(sub, SUBCOMMANDS.filter((s) => !["search", "ls", "remove", "status"].includes(s)));
    if (hits.length) die(`Unknown: aile local ${sub}`, `Did you mean \`aile local ${hits[0]}\`? \`aile help local\` lists them all.`);
  }
  banner();
  return legacyEndpoint(args, sub);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const engineArg = (args) => {
  if (!args.engine) return null;
  const e = String(args.engine).toLowerCase().replace(/[^a-z]/g, "");
  if (e === "ollama" || e === "llamacpp") return e;
  return die(`--engine must be ollama or llamacpp (got "${args.engine}")`);
};

const ollamaModelsDir = () => process.env.OLLAMA_MODELS || path.join(os.homedir(), ".ollama", "models");

/** Ctrl+C during a download: stop cleanly, keep the partial file, say how to resume. */
function interruptible() {
  const ctl = new AbortController();
  const onSig = () => ctl.abort();
  process.on("SIGINT", onSig);
  return { signal: ctl.signal, release: () => process.off("SIGINT", onSig) };
}

function stoppedByUser(e, signal) {
  return signal?.aborted || e?.name === "AbortError";
}

function checkDisk(dir, bytes, hint) {
  if (!bytes) return;
  const free = diskFree(dir);
  if (free !== null && free < bytes * 1.05 + 1e9) {
    die(`Not enough disk space: this needs ${formatBytes(bytes)}, and ${formatBytes(free)} is free (${dir}).`, hint);
  }
}

function ctxFor(args, config, entry = null) {
  const want = Number(args.ctx || config.localContext || 8192);
  if (!Number.isInteger(want) || want < 2048) die(`--ctx must be a whole number of tokens, at least 2048 (got "${args.ctx}")`);
  return entry?.ctx ? Math.min(want, entry.ctx) : want;
}

/** Which engine a command acts on: `--engine`, the configured one, else whatever is here. */
async function engineForModels(args, config) {
  const named = engineArg(args);
  if (named) return named;
  if (config.localEngine === "ollama" || config.localEngine === "llamacpp") return config.localEngine;
  if (await ollama.version(ollama.ollamaBase(config))) return "ollama";
  if (loadManifest().engines.llamacpp?.bin) return "llamacpp";
  return null;
}

function priceCell(id, live) {
  const state = sellState(id, live);
  if (state === "priced") return priceText(live.prices.get(id));
  if (state === "unpriced") return `${C.yellow}not sellable${C.reset}`;
  return dim("price unknown");
}

/** Where a pulled model should be served from, given what lending uses now. */
function servingPlan(config, engine) {
  const base = engine === "ollama"
    ? ollama.ollamaBase(config)
    : (config.localEngine === "llamacpp" && config.localEndpoint) || LLAMACPP_DEFAULT_ENDPOINT;
  // Lending already points somewhere else (LM Studio, vLLM, another engine):
  // a pull must not silently move it.
  const elsewhere = config.localEnabled && config.localEndpoint && config.localEndpoint.replace(/\/+$/, "") !== base;
  return { base, elsewhere };
}

/**
 * Record a pulled model in the lending settings, without turning lending on.
 * @returns {{ seeded: string[], advertised: boolean, elsewhere: boolean }}
 */
function adoptForLending({ config, pre, engine, id, sellable }) {
  const { base, elsewhere } = servingPlan(config, engine);
  if (elsewhere) return { seeded: [], advertised: false, elsewhere: true };
  const patch = { localEngine: engine, localEndpoint: base };
  let seeded = [];
  if (engine === "llamacpp") patch.localModels = id;
  else if (sellable) {
    const r = addAdvertised(id, pre, base);
    patch.localModels = r.value;
    seeded = r.seeded;
  }
  const res = updateSettings(patch);
  if (!res.ok) die(res.error);
  return { seeded, advertised: engine === "llamacpp" || sellable, elsewhere: false };
}

function privacyLines() {
  return [
    `${C.yellow}Worth knowing:${C.reset} this traffic is ${C.yellow}not blind${C.reset}.`,
    `${C.dim}The model runs on this machine, so this machine reads the prompts it`,
    `answers. Subscription traffic is unaffected and stays blind.${C.reset}`,
  ];
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

async function showStatus(args) {
  const config = loadConfig();
  const manifest = loadManifest();
  const engine = config.localEngine || "external";

  if (!config.localEndpoint && !manifest.models.length) {
    if (args.json) return console.log(JSON.stringify({ engine: null, endpoint: null, lending: false, models: [] }, null, 2));
    console.log(`\n${C.dim}Not lending a self-hosted model.${C.reset}\n`);
    console.log(next([
      ["aile local setup", "download a model and lend it, in one go"],
      ["aile local http://127.0.0.1:11434", "lend a model server you already run (Ollama, vLLM, LM Studio, llama.cpp)"],
    ], { title: "Start" }));
    console.log();
    return;
  }

  const probeConfig = { ...config, localEnabled: true };
  const now = config.localEndpoint ? await localStatus(probeConfig) : { state: "misconfigured", reason: "no endpoint set" };
  const advertised = config.localEndpoint ? await discoverLocalModels(probeConfig) : [];
  const detected = now.state === "up" ? await detectEngine(config.localEndpoint) : { kind: "down" };
  const managed = manifest.models.filter((m) => engine === "external" || m.engine === engine);
  const ids = [...new Set([...advertised, ...managed.map((m) => m.id)])];
  const live = await livePrices(ids, config);
  const lending = Boolean(config.localEnabled);

  const rows = ids.map((id) => {
    const m = managed.find((x) => x.id === id);
    const row = live.prices.get(id);
    return {
      id, offered: lending && advertised.includes(id) && now.state === "up",
      listed: advertised.includes(id), downloaded: Boolean(m), active: manifest.active === id,
      priced: row ? row.priced : null, inPerMtok: row?.inPerMtok ?? null, outPerMtok: row?.outPerMtok ?? null,
    };
  });

  if (args.json) {
    console.log(JSON.stringify({
      engine, endpoint: config.localEndpoint || null, lending, state: now.state,
      reason: now.reason || null, prices: live.available ? "live" : "unknown", models: rows,
    }, null, 2));
    return;
  }

  const engineLabel = detected.kind === "ollama" ? `Ollama ${detected.version}`
    : detected.kind === "llamacpp" ? "llama.cpp"
      : ENGINE_NAME[engine] || engine;
  const stateText = now.state === "up" ? `${C.green}answering${C.reset}`
    : now.state === "down" ? `${C.yellow}not answering${C.reset} ${dim(`(${now.reason})${lending ? " · listed once it does" : ""}`)}`
      : `${C.red}misconfigured${C.reset} ${dim(now.reason || "")}`;
  const offered = rows.filter((r) => r.offered);

  console.log();
  console.log(kv([
    ["Engine", `${engineLabel}${config.localEndpoint ? dim(` at ${config.localEndpoint}`) : ""}`],
    ["Status", stateText],
    ["Lending", lending ? `${C.green}on${C.reset}` : `${C.yellow}off${C.reset} ${dim("· aile local on")}`],
    ["Context", engine === "external" ? null : `${config.localContext} tokens`],
    ["Buyers", offered.length ? `${C.cyan}${offered.map((r) => `local/${r.id}`).join(", ")}${C.reset}` : null],
    ["Privacy", `${C.yellow}not blind${C.reset} ${dim("— requests run here, so this machine reads them")}`],
  ]));

  if (rows.length) {
    console.log();
    console.log(table([
      { key: "id", label: "MODEL", shrink: true },
      { key: "state", label: "STATE" },
      { key: "price", label: "LIST $/MTOK IN / OUT" },
    ], rows.map((r) => ({
      id: r.id,
      state: r.offered ? `${C.green}offered${C.reset}`
        : r.listed && lending ? `${C.yellow}waiting${C.reset}`
          : r.listed ? "ready" : r.downloaded ? dim(engine === "llamacpp" && !r.active ? "downloaded, not loaded" : "downloaded, not offered") : dim("—"),
      price: priceCell(r.id, live),
    }))));
    if (!live.available) console.log(`\n  ${dim(`Prices unknown: ${live.reason}.`)}`);
    else if (rows.some((r) => r.priced === false)) {
      console.log(`\n  ${hintText("A model with no list price is refused by the network. `aile local models` lists ones that sell.")}`);
    }
  } else {
    console.log(`\n  ${C.yellow}No models found.${C.reset} ${dim("Pull one with")} ${cmd("aile local pull <model>")}`);
  }

  console.log();
  const steps = [];
  if (!rows.length || rows.every((r) => r.priced === false)) steps.push(["aile local models", "models that download and sell"]);
  if (!lending) steps.push(["aile local on", "offer these to buyers"]);
  else if (now.state !== "up") steps.push(["aile start", "starts the engine and serves"]);
  else steps.push(["aile start", "serve them (Ctrl+C stops)"]);
  if (rows.length) steps.push([`aile local run ${rows[0].id}`, "talk to it here"]);
  console.log(next(steps));
  console.log();
}

// ---------------------------------------------------------------------------
// Models (the curated catalogue)
// ---------------------------------------------------------------------------

async function showModels(args) {
  const config = loadConfig();
  const query = args._.slice(2).join(" ");
  const rows = searchCurated(query);
  const hw = detectHardware();
  const engine = engineArg(args) || (config.localEngine === "llamacpp" ? "llamacpp" : "ollama");
  const ctx = ctxFor(args, config);
  const live = await withSpinner("Checking list prices…", livePrices(rows.map((m) => m.id), config));

  const out = rows.map((m) => {
    const size = sizeFor(m, engine);
    const where = fit(size, hw, Math.min(ctx, m.ctx));
    const row = live.prices.get(m.id);
    return {
      id: m.id, name: m.name, params: m.params, sizeBytes: size, fit: where, ollama: m.ollama, hf: m.hf.repo,
      license: m.license, priced: row ? row.priced : null, inPerMtok: row?.inPerMtok ?? null, outPerMtok: row?.outPerMtok ?? null,
    };
  }).sort((a, b) => FIT_RANK[a.fit] - FIT_RANK[b.fit] || b.sizeBytes - a.sizeBytes);

  if (args.json) {
    console.log(JSON.stringify({ engine, hardware: hw, prices: live.available ? "live" : "unknown", models: out }, null, 2));
    return;
  }
  if (!out.length) die(`No curated model matches "${query}".`, "Any Ollama tag or hf.co/<user>/<repo> can be pulled too — it runs, but only these sell.");

  console.log(`\n${heading("Models that download and sell", `for ${ENGINE_NAME[engine]} · ${describeHardware(hw)}`)}\n`);
  const fitText = { gpu: `${C.green}${FIT_LABEL.gpu}${C.reset}`, partial: `${C.yellow}${FIT_LABEL.partial}${C.reset}`, cpu: `${C.yellow}${FIT_LABEL.cpu}${C.reset}`, no: `${C.red}${FIT_LABEL.no}${C.reset}` };
  console.log(table([
    { key: "id", label: "ID", shrink: true },
    { key: "size", label: "SIZE", align: "right" },
    { key: "fit", label: "HERE" },
    { key: "price", label: "LIST $/MTOK IN / OUT" },
  ], out.map((r) => ({ id: r.id, size: formatBytes(r.sizeBytes), fit: fitText[r.fit], price: priceCell(r.id, live) }))));
  if (!live.available) console.log(`\n  ${dim(`Prices unknown: ${live.reason}.`)}`);
  console.log(`\n  ${hintText("List prices are the model's published rate; you earn list × your margin (`aile rates`).")}`);
  console.log(`  ${dim("Downloads are 4-bit builds, sold under the full model's id.")}\n`);
  console.log(next([
    [`aile local pull ${out.find((r) => r.fit === "gpu")?.id || out[0].id}`, "download one"],
    ["aile local pull hf.co/<user>/<repo>", "any other GGUF (runs here, may not sell)"],
  ]));
  console.log();
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

async function pullCommand(args) {
  const ref = args._[2];
  if (!ref) die("Which model?", "Try `aile local pull meta-llama/llama-3.1-8b-instruct`, or `aile local models` for the list.");
  const config = loadConfig();
  const engine = await engineForModels(args, config);
  if (!engine) die("No engine set up yet.", "Run `aile local setup`: it installs one and downloads a model in one go.");
  const pre = await snapshotAdvertising(config, (c) => discoverLocalModels(c));
  const hw = detectHardware();
  const got = await pullModel({ args, config, engine, ref, hw });
  if (!got) return;
  reportPulled({ pre, engine, got, before: config });
}

/**
 * Download `ref` on `engine` and save it under the name it sells as.
 * @returns {Promise<{ id: string, sellId: string|null, sellable: boolean|null, entry: object|null, sizeBytes: number|null }|null>}
 */
async function pullModel({ args, config, engine, ref, hw, quiet = false }) {
  const r = resolveModelRef(ref);
  if (r.kind === "invalid") die(r.reason, "`aile local models` lists models that download and sell.");
  const entry = r.kind === "curated" ? r.entry : null;
  const quant = args.quant ? String(args.quant) : r.quant || null;
  const ctx = ctxFor(args, config, entry);

  const got = engine === "ollama"
    ? await pullOllama({ config, r, entry, quant, ctx, hw })
    : await pullLlama({ config, r, entry, quant, ctx, hw, args });
  if (!got) return null;

  let sellable = entry ? true : null;
  const live = await livePrices([got.id], config);
  const state = sellState(got.id, live);
  if (state === "priced") sellable = true;
  else if (state === "unpriced") sellable = false;
  if (!quiet && entry && state === "unpriced") {
    console.log(warn(`${got.id} has no list price on this server right now`, "it will not sell until one is published"));
  }
  return { ...got, sellable, live, entry };
}

async function pullOllama({ config, r, entry, quant, ctx, hw }) {
  const base = ollama.ollamaBase(config);
  if (!(await ollama.version(base))) {
    die(`Ollama is not running at ${base}.`, "Start Ollama, or run `aile local setup` to install it.");
  }
  const tag = r.kind === "ollama" ? r.tag
    : r.kind === "hf" ? `hf.co/${r.repo}${quant ? `:${quant}` : ""}`
      : quant ? `hf.co/${entry.hf.repo}:${quant}` : entry.ollama;
  const id = entry ? entry.id : tag;
  const size = entry && !quant ? entry.ollamaBytes : null;

  let installed = [];
  try { installed = await ollama.tags(base); } catch { /* treated as nothing installed */ }
  if (entry && ollama.hasModel(installed, entry.id) && ollama.hasModel(installed, tag)) {
    console.log(ok(`${entry.id} is already downloaded`));
  } else {
    if (!ollama.hasModel(installed, tag)) {
      checkDisk(ollamaModelsDir(), size, "Free some space, or move Ollama's store with OLLAMA_MODELS.");
      if (entry && size) {
        const where = fit(size, hw, ctx);
        if (where === "no") console.log(warn(`${entry.name} is likely too big for this machine`, `${formatBytes(size)}; ${describeHardware(hw)}`));
      }
      const { signal, release } = interruptible();
      const bar = progress(`Downloading ${tag}`, { total: size });
      try {
        await ollama.pull(base, tag, { signal, onProgress: ({ done, total }) => { if (total) bar.update(done, total); } });
        bar.succeed(`Downloaded ${tag}`);
      } catch (e) {
        bar.fail(`Download of ${tag} stopped`);
        if (stoppedByUser(e, signal)) die("Stopped.", `Run the same command again to resume: \`aile local pull ${r.kind === "curated" ? entry.id : tag}\``, { code: 130 });
        die(e.message, /not found|manifest/i.test(e.message) ? "Check the name on ollama.com/library, or try `aile local models`." : null);
      } finally {
        release();
      }
    } else {
      console.log(ok(`${tag} is already downloaded`));
    }
    if (entry) {
      try {
        const how = await withSpinner(`Saving as ${entry.id}…`, ollama.alias(base, tag, entry.id, { ctx }));
        console.log(ok(`Saved as ${entry.id}`, how === "copy" ? "context window left at Ollama's default" : `${ctx}-token context`));
      } catch (e) {
        die(`Downloaded, but could not save it as ${entry.id}: ${e.message}`);
      }
    }
  }

  const manifest = loadManifest();
  saveManifest(upsertModel(manifest, {
    id, sellId: entry ? entry.id : null, engine: "ollama", source: `ollama:${tag}`,
    files: [], quant: quant || null, sizeBytes: size, ctx, pulledAt: new Date().toISOString(),
  }));
  return { id, sellId: entry ? entry.id : null, sizeBytes: size, tag };
}

async function pullLlama({ config, r, entry, quant, ctx, hw }) {
  const manifest = loadManifest();
  if (!manifest.engines.llamacpp?.bin || !fs.existsSync(manifest.engines.llamacpp.bin)) {
    die("llama.cpp is not installed here.", "Run `aile local install llamacpp`, or `aile local setup --engine llamacpp`.");
  }
  if (r.kind === "ollama") {
    const close = searchCurated(r.tag.split(":")[0]).slice(0, 2).map((m) => `\`aile local pull ${m.id}\``);
    die(`llama.cpp downloads from Hugging Face, and "${r.tag}" looks like an Ollama tag.`,
      close.length ? `Try ${close.join(" or ")}, or name a repo: hf.co/<user>/<repo>` : "Name a repo instead: `aile local pull hf.co/<user>/<repo>`");
  }
  const repo = entry ? entry.hf.repo : r.repo;
  let files;
  try {
    files = await withSpinner(`Looking up ${repo}…`, listRepoFiles(repo));
  } catch (e) {
    die(e.message);
  }
  let group;
  try {
    group = pickGguf(files, { quant, preferred: entry?.hf.quant || null });
  } catch (e) {
    die(e.message, e.code === "no-quant" ? "Pick one with --quant <name>." : null);
  }
  const id = entry ? entry.id : repo.toLowerCase().replace(/-gguf$/, "");
  const where = fit(group.bytes, hw, ctx);
  if (where === "no") console.log(warn(`This build is likely too big for this machine`, `${formatBytes(group.bytes)}; ${describeHardware(hw)}`));
  checkDisk(modelsDir(config), group.bytes, "Free some space, or point `aile config localModelDir <path>` at a bigger disk.");

  const { signal, release } = interruptible();
  const bar = progress(`Downloading ${repo} ${group.quant}`, { total: group.bytes });
  let pulled;
  try {
    pulled = await pullFromHf({
      repo, group, config, signal,
      onProgress: ({ phase, done, total }) => { bar.label(phase === "verify" ? "Checking what is already here" : `Downloading ${repo} ${group.quant}`); bar.update(done, total); },
    });
    bar.succeed(`${pulled.reused ? "Already downloaded" : "Downloaded"} ${repo} ${group.quant} (${formatBytes(group.bytes)})`);
  } catch (e) {
    bar.fail(`Download of ${repo} stopped`);
    if (stoppedByUser(e, signal)) die("Stopped.", `Run the same command again to resume where it left off: \`aile local pull ${entry ? entry.id : `hf.co/${repo}:${group.quant}`}\``, { code: 130 });
    die(e.message);
  } finally {
    release();
  }

  const prev = manifest.active;
  let m = upsertModel(loadManifest(), {
    id, sellId: entry ? entry.id : null, engine: "llamacpp", source: `hf:${repo}/${group.files[0].path}`,
    files: pulled.files, quant: group.quant, sizeBytes: group.bytes, ctx, gpu: where === "gpu" || where === "partial",
    pulledAt: new Date().toISOString(),
  });
  m = { ...m, active: id };
  saveManifest(m);
  if (prev && prev !== id) console.log(info(`llama.cpp serves one model at a time: now ${id} (was ${prev})`));
  return { id, sellId: entry ? entry.id : null, sizeBytes: group.bytes };
}

/** After a pull: where it stands, in one block. */
function reportPulled({ pre, engine, got, before }) {
  const adopted = adoptForLending({ config: before, pre, engine, id: got.id, sellable: got.sellable === true });
  const after = loadConfig();
  console.log();
  if (got.sellable === true) {
    const row = got.live?.prices?.get(got.id);
    console.log(ok(`Sells as ${C.cyan}local/${got.id}${C.reset}`, row?.priced ? `list ${priceText(row)} per million tokens` : ""));
  } else if (got.sellable === false) {
    console.log(warn(`Not sellable: ${got.id} has no published list price`, "it runs here for your own use"));
    console.log(`    ${hintText("`aile local models` lists models that sell.")}`);
  } else {
    console.log(info(`Could not check whether ${got.id} sells`, got.live?.reason || ""));
  }
  if (adopted.seeded.length) {
    console.log(info(`localModels now names what is offered: ${after.localModels}`, hintText("put it back with `aile config localModels \"\"`")));
  }
  if (adopted.elsewhere) {
    console.log(warn(`Your self-hosted lending points at ${before.localEndpoint}, not ${ENGINE_NAME[engine]}`, "left as it is"));
    console.log(`    ${hintText(`To lend this model instead: \`aile local setup --engine ${engine} --model ${got.id}\``)}`);
    console.log();
    return;
  }
  console.log();
  const steps = [];
  if (!after.localEnabled && adopted.advertised) steps.push(["aile local on", "offer it to buyers"]);
  else if (after.localEnabled && adopted.advertised) steps.push(["aile start", "serve it (restart if already running)"]);
  steps.push([`aile local run ${got.id}`, "talk to it here"]);
  console.log(next(steps));
  console.log();
}

// ---------------------------------------------------------------------------
// List / rm
// ---------------------------------------------------------------------------

async function listCommand(args) {
  const config = loadConfig();
  const manifest = loadManifest();
  const base = ollama.ollamaBase(config);
  let tags = [];
  const ollamaUp = Boolean(await ollama.version(base));
  if (ollamaUp) { try { tags = await ollama.tags(base); } catch { /* shown as empty */ } }
  const advertised = parseList(config.localModels);

  const rows = [];
  for (const t of tags) {
    const name = String(t.name || t.model).replace(/:latest$/, "");
    const m = findModel(manifest, name, "ollama");
    rows.push({ id: name, engine: "ollama", sizeBytes: Number(t.size) || null, quant: t.details?.quantization_level || null, managed: Boolean(m) });
  }
  for (const m of manifest.models.filter((x) => x.engine === "llamacpp")) {
    const present = (m.files || []).every((f) => fs.existsSync(f.path));
    rows.push({ id: m.id, engine: "llamacpp", sizeBytes: m.sizeBytes, quant: m.quant, managed: true, missing: !present, active: manifest.active === m.id });
  }
  const live = await livePrices(rows.map((r) => r.id), config);
  for (const r of rows) {
    const p = live.prices.get(r.id);
    r.priced = p ? p.priced : null;
    r.offered = config.localEnabled && (advertised.length ? advertised.includes(r.id) : r.engine === config.localEngine);
  }

  if (args.json) return console.log(JSON.stringify({ ollama: ollamaUp ? base : null, prices: live.available ? "live" : "unknown", models: rows }, null, 2));
  if (!rows.length) {
    console.log(`\n${C.dim}Nothing downloaded${ollamaUp ? "" : ` (and Ollama is not answering at ${base})`}.${C.reset}\n`);
    console.log(next([["aile local setup", "pick a model that fits this machine"], ["aile local models", "the list"]]));
    console.log();
    return;
  }
  console.log();
  console.log(table([
    { key: "id", label: "MODEL", shrink: true },
    { key: "engine", label: "ENGINE" },
    { key: "size", label: "SIZE", align: "right" },
    { key: "price", label: "LIST $/MTOK IN / OUT" },
    { key: "note", label: "" },
  ], rows.map((r) => ({
    id: r.id, engine: ENGINE_NAME[r.engine], size: r.sizeBytes ? formatBytes(r.sizeBytes) : "",
    price: priceCell(r.id, live),
    note: r.missing ? `${C.red}files missing${C.reset}` : r.offered ? `${C.green}lending${C.reset}` : r.engine === "llamacpp" && !r.active ? dim("not loaded") : "",
  }))));
  console.log();
}

async function rmCommand(args) {
  const ref = args._[2];
  if (!ref) die("Which model?", "`aile local list` shows what is downloaded.");
  const config = loadConfig();
  const manifest = loadManifest();
  const r = resolveModelRef(ref);
  const name = r.kind === "curated" ? r.entry.id : String(ref).replace(/^local\//, "").replace(/:latest$/, "");
  const entry = findModel(manifest, name);
  const engine = entry?.engine || (await engineForModels(args, config));
  if (!engine) die(`Nothing called ${name} is downloaded here.`, "`aile local list` shows what is.");

  const baseTag = entry?.engine === "ollama" && entry.source?.startsWith("ollama:") ? entry.source.slice(7) : null;
  const alsoBase = baseTag && baseTag !== name && !args["keep-base"];
  const what = engine === "ollama"
    ? `${name}${alsoBase ? ` and the ${baseTag} download it shares` : ""} from Ollama`
    : `${name} (${formatBytes(entry?.sizeBytes)}) from this machine`;
  if (!args.yes) {
    if (!isInteractive()) die(`Delete ${what}?`, "Add --yes to confirm without a terminal.");
    if (!(await promptConfirm(`Delete ${what}?`, { defaultYes: false }))) return console.log(`\n${dim("Kept.")}\n`);
  }

  if (engine === "ollama") {
    const base = ollama.ollamaBase(config);
    if (!(await ollama.version(base))) die(`Ollama is not running at ${base}; start it to delete models.`);
    const gone = await ollama.remove(base, name);
    if (alsoBase) await ollama.remove(base, baseTag).catch(() => false);
    if (!gone && !entry) die(`Ollama has no model called ${name}.`, "`aile local list` shows what is downloaded.");
  } else {
    for (const f of entry?.files || []) { try { fs.unlinkSync(f.path); } catch { /* already gone */ } }
    try { const d = entry?.files?.[0] ? path.dirname(entry.files[0].path) : null; if (d && !fs.readdirSync(d).length) fs.rmdirSync(d); } catch { /* not empty */ }
  }
  saveManifest(removeModel(loadManifest(), name));
  const r2 = removeAdvertised(name, config);
  if (r2.changed) {
    const res = updateSettings({ localModels: r2.value });
    if (!res.ok) die(res.error);
  }
  console.log(`\n${ok(`Deleted ${name}`)}`);
  if (r2.changed && !r2.value && config.localEnabled) {
    console.log(info("No model is named for lending now", hintText("the node will offer whatever the engine lists; `aile local --off` stops lending")));
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/**
 * The model server to talk to for `run`, started for the duration of the
 * command when it is a managed llama.cpp that is not running.
 */
async function reachModel(config, name) {
  const manifest = loadManifest();
  const entry = findModel(manifest, name);
  const engine = entry?.engine || (config.localEngine !== "external" ? config.localEngine : null);
  if (engine === "ollama" || (!engine && !config.localEndpoint)) {
    const base = ollama.ollamaBase(config);
    if (!(await ollama.version(base))) die(`Ollama is not running at ${base}.`, "Start Ollama, or run `aile local setup`.");
    return { base, stop: () => {} };
  }
  if (engine === "llamacpp") {
    const base = (config.localEngine === "llamacpp" && config.localEndpoint) || LLAMACPP_DEFAULT_ENDPOINT;
    const now = await detectEngine(base);
    if (now.kind === "llamacpp" && manifest.active === name) return { base, stop: () => {} };
    if (now.kind !== "down") {
      die(`${base} is busy serving another model.`, `Stop \`aile start\` first, or load this one with \`aile local pull ${name}\`.`);
    }
    if (!entry) die(`${name} is not downloaded for llama.cpp.`, `\`aile local pull ${name}\``);
    const bin = manifest.engines.llamacpp?.bin;
    if (!bin) die("llama.cpp is not installed.", "`aile local install llamacpp`");
    const server = new LlamaServer({
      bin, base, logFile: path.join(logsDir(config), "llama-server.log"),
      args: serverArgs({ gguf: entry.files[0].path, port: endpointPort(base), alias: entry.id, ctx: entry.ctx || config.localContext, gpu: entry.gpu !== false }),
    });
    const up = await withSpinner(`Loading ${name}…`, server.start());
    if (!up) { server.kill(); die(`llama-server did not start; see ${server.logFile}`); }
    return { base, stop: () => server.kill() };
  }
  return { base: config.localEndpoint, stop: () => {} };
}

async function runCommand(args) {
  const name = args._[2] ? String(args._[2]).replace(/^local\//, "") : null;
  if (!name) die("Which model?", "`aile local run <model> \"a prompt\"` — `aile local list` shows what is here.");
  const config = loadConfig();
  const r = resolveModelRef(name);
  const model = r.kind === "curated" ? r.entry.id : name;
  let prompt = args._.slice(3).join(" ");
  if (!prompt && !process.stdin.isTTY) prompt = (await new Response(process.stdin).text()).trim();

  const { base, stop } = await reachModel(config, model);
  try {
    if (prompt) {
      // Ctrl+C once stops the reply; twice leaves.
      const ctl = new AbortController();
      const onSig = () => { if (ctl.signal.aborted) { stop(); process.exit(130); } ctl.abort(); };
      process.on("SIGINT", onSig);
      try {
        await streamReply({ base, model, messages: [{ role: "user", content: prompt }], signal: ctl.signal });
      } finally {
        process.off("SIGINT", onSig);
      }
      return;
    }
    await chatLoop({ base, model });
  } finally {
    stop();
  }
}

/** The `ollama run` REPL: Ctrl+C stops a reply, or leaves at the prompt. */
async function chatLoop({ base, model }) {
  console.error(dim(`Talking to ${model}. Ctrl+C or /bye to leave.`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let turn = null;
  let closed = false;
  const closedP = new Promise((res) => rl.once("close", () => { closed = true; res(null); }));
  rl.on("SIGINT", () => { if (turn) turn.abort(); else rl.close(); });
  const messages = [];
  while (!closed) {
    const line = await Promise.race([new Promise((res) => rl.question(`${C.cyan}>>>${C.reset} `, res)), closedP]);
    if (line === null || /^\/(bye|exit|quit)$/i.test(line.trim())) break;
    if (!line.trim()) continue;
    messages.push({ role: "user", content: line });
    turn = new AbortController();
    const text = await streamReply({ base, model, messages, signal: turn.signal });
    turn = null;
    messages.push({ role: "assistant", content: text });
  }
  if (!closed) rl.close();
  process.stdout.write("\n");
}

async function streamReply({ base, model, messages, signal }) {
  const started = Date.now();
  let text = "";
  let usage = null;
  try {
    const it = chatStream({ base, model, messages, signal });
    for (;;) {
      const { value, done } = await it.next();
      if (done) { usage = value?.usage || null; break; }
      text += value;
      process.stdout.write(value);
    }
  } catch (e) {
    if (signal?.aborted) { process.stdout.write("\n"); return text; }
    process.stdout.write("\n");
    die(e instanceof ChatError ? e.message : `could not reach the model: ${e.message}`);
  }
  process.stdout.write("\n");
  const secs = (Date.now() - started) / 1000;
  const toks = usage?.completion_tokens;
  console.error(dim(toks ? `${toks} tokens in ${secs.toFixed(1)}s · ${(toks / secs).toFixed(1)} tokens/s` : `${secs.toFixed(1)}s`));
  return text;
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

async function installCommand(args) {
  const which = String(args._[2] || "ollama").toLowerCase().replace(/[^a-z]/g, "");
  if (which === "ollama") {
    const ready = await ensureOllama(args, { offerFallback: false });
    if (ready) console.log(`\n${next([["aile local setup --engine ollama", "pick a model and lend it"]])}\n`);
    return;
  }
  if (which === "llamacpp") {
    const eng = await ensureLlamaCpp(args, detectHardware());
    console.log(`\n${next([["aile local setup --engine llamacpp", "pick a model and lend it"]])}\n`);
    return eng;
  }
  die(`Install what? ollama or llamacpp (got "${args._[2]}")`);
}

/**
 * Make Ollama answer: running already, installed but stopped (start it), or
 * missing (install it, with permission). Resolves the base URL, or null when
 * the user declined or the install could not finish.
 */
async function ensureOllama(args, { offerFallback = true } = {}) {
  const config = loadConfig();
  const base = ollama.ollamaBase(config);
  const v = await ollama.version(base);
  if (v) { console.log(ok(`Ollama ${v} is running`, base)); return base; }

  let bin = ollama.findOllamaBin();
  if (!bin) {
    const plan = ollamaInstallPlan();
    if (plan.manual) {
      console.log(warn(`Ollama is not installed, and aile cannot install it here (${plan.note})`));
      console.log(`    ${hintText(`Install it from ${plan.manual}, then run this again${offerFallback ? " — or use llama.cpp, which needs no install" : ""}.`)}`);
      return null;
    }
    console.log(info("Ollama is not installed. aile will run:"));
    console.log(`    ${C.cyan}${plan.display}${C.reset} ${dim(`(${plan.note})`)}`);
    if (!args.yes) {
      if (!isInteractive()) { console.log(`    ${hintText("Add --yes to run it without a terminal.")}`); return null; }
      if (!(await promptConfirm("Install Ollama now?", { defaultYes: true }))) return null;
    }
    console.log();
    let code;
    try {
      code = runOllamaInstall(plan);
    } catch (e) {
      console.log(bad(e instanceof InstallError ? e.message : `install failed: ${e.message}`));
      return null;
    }
    if (code !== 0) { console.log(bad(`The installer exited with ${code}`)); return null; }
    bin = ollama.findOllamaBin();
    // The Windows and macOS apps start their own server; give it a moment.
    for (let i = 0; i < 20 && !(await ollama.version(base)); i++) await new Promise((r) => setTimeout(r, 500));
    const after = await ollama.version(base);
    if (after) { console.log(ok(`Ollama ${after} installed and running`)); return base; }
    if (!bin) { console.log(warn("Ollama installed, but this terminal cannot find it yet", "open a new terminal and run this again")); return null; }
  }
  const started = await withSpinner("Starting Ollama…", ollama.startServe({ bin, base, logFile: path.join(logsDir(config), "ollama.log") }));
  if (!started) { console.log(bad(`Started Ollama, but nothing answers at ${base}`, `see ${path.join(logsDir(config), "ollama.log")}`)); return null; }
  console.log(ok(`Ollama ${await ollama.version(base)} is running`, base));
  return base;
}

/** Download and unpack the pinned llama.cpp build for this machine (or reuse it). */
async function ensureLlamaCpp(args, hw) {
  // Your own build (a source build, a distro package): used as it is, nothing downloaded.
  const own = process.env.AILE_LLAMA_SERVER_BIN;
  if (own) {
    if (!fs.existsSync(own)) die(`AILE_LLAMA_SERVER_BIN points at ${own}, which does not exist.`);
    const m = loadManifest();
    saveManifest({ ...m, engines: { ...m.engines, llamacpp: { tag: "own", key: "own", dir: path.dirname(own), bin: own } } });
    console.log(ok("Using your own llama-server", own));
    return m.engines.llamacpp;
  }
  const accel = args.accel ? String(args.accel).toLowerCase() : args.cpu ? "cpu" : null;
  const pick = pickAsset(hw, { accel });
  if (!pick) die(`No llama.cpp build for ${hw.platform}/${hw.arch}${accel ? ` with ${accel}` : ""}.`, accel ? "Try without --accel." : null);
  const manifest = loadManifest();
  const have = manifest.engines.llamacpp;
  // The installed build is kept unless `--accel` asks for another one: a second
  // `setup` must not quietly swap a Vulkan install for a 650 MB CUDA download.
  if (have?.bin && fs.existsSync(have.bin) && have.tag === LLAMACPP_PINS.tag && (!accel || have.key === pick.key)) {
    console.log(ok(`llama.cpp ${have.tag} is installed`, have.key === pick.key ? pick.reason : `${have.key}; --accel ${pick.accel} switches`));
    return have;
  }
  checkDisk(localDir(loadConfig()), assetBytes(pick.asset) * 2, "Free some space, or set `aile config localModelDir <path>`.");
  const { signal, release } = interruptible();
  const bar = progress(`Downloading llama.cpp ${LLAMACPP_PINS.tag} (${pick.reason})`, { total: assetBytes(pick.asset) });
  let eng;
  try {
    eng = await installLlamaCpp({ hw, accel, config: loadConfig(), signal, onProgress: ({ done, total }) => bar.update(done, total) });
    bar.succeed(`llama.cpp ${eng.tag} ready (${pick.reason})`);
  } catch (e) {
    bar.fail("llama.cpp install stopped");
    if (stoppedByUser(e, signal)) die("Stopped.", "Run the same command again to resume.", { code: 130 });
    die(e.message);
  } finally {
    release();
  }
  const m = loadManifest();
  saveManifest({ ...m, engines: { ...m.engines, llamacpp: { tag: eng.tag, key: eng.key, dir: eng.dir, bin: eng.bin } } });
  return eng;
}

// ---------------------------------------------------------------------------
// Setup — the one command
// ---------------------------------------------------------------------------

async function setupWizard(args, { startNode }) {
  const interactive = isInteractive();
  if (!interactive && !args.yes) {
    die("aile local setup asks a few questions, and there is no terminal here.",
      "Run it in a terminal, or answer up front: `aile local setup --yes --model meta-llama/llama-3.1-8b-instruct`");
  }
  const config = loadConfig();
  const hw = detectHardware();
  console.log(`\n${heading("Self-host a model", "download it, run it here, lend it")}\n`);
  console.log(kv([
    ["This machine", describeHardware(hw)],
    ["Disk free", (() => { const f = diskFree(localDir(config)); return f === null ? null : `${formatBytes(f)}`; })()],
  ]));
  console.log();

  // 1. Engine
  let engine = engineArg(args);
  if (!engine) {
    const base = ollama.ollamaBase(config);
    if (await ollama.version(base)) engine = "ollama";
    else if (ollama.findOllamaBin()) engine = "ollama";
    else if (loadManifest().engines.llamacpp?.bin) engine = "llamacpp";
  }
  if (!engine) {
    const plan = ollamaInstallPlan();
    const pick = pickAsset(hw);
    const llamaNote = `no install; runs only while aile serves${pick ? ` · ${formatBytes(assetBytes(pick.asset))}, ${pick.reason}` : ""}`;
    if (args.yes) engine = plan.cmd ? "ollama" : "llamacpp";
    else {
      const choice = await promptChoice(heading("Which engine should run the model?"), [
        { label: "Ollama (recommended)", note: plan.cmd ? `installs with ${plan.note}` : `install from ${plan.manual}` },
        { label: "llama.cpp", note: llamaNote },
        { label: "Cancel", note: "" },
      ]);
      if (choice === null || choice === 2) return console.log(`\n${dim("Nothing changed.")}\n`);
      engine = choice === 0 ? "ollama" : "llamacpp";
    }
  }
  console.log(heading("Engine"));
  if (engine === "ollama") {
    const base = await ensureOllama(args);
    if (!base) {
      const fallback = args.yes || (interactive && await promptConfirm("Use llama.cpp instead? It needs no install.", { defaultYes: true }));
      if (!fallback) return console.log(`\n${dim("Nothing else changed.")}\n`);
      engine = "llamacpp";
    }
  }
  if (engine === "llamacpp") await ensureLlamaCpp(args, hw);
  console.log();

  // 2. Model
  let ref = args.model ? String(args.model) : null;
  const ctxWanted = ctxFor(args, config);
  if (!ref) {
    const live = await withSpinner("Checking list prices…", livePrices(CURATED.map((m) => m.id), config));
    const options = CURATED
      .map((m) => ({ m, size: sizeFor(m, engine), where: fit(sizeFor(m, engine), hw, Math.min(ctxWanted, m.ctx)) }))
      .filter((o) => o.where !== "no" && sellState(o.m.id, live) !== "unpriced")
      .sort((a, b) => FIT_RANK[a.where] - FIT_RANK[b.where] || b.size - a.size);
    if (!options.length) die("No curated model fits this machine.", "`aile local models` shows them all, with sizes.");
    if (args.yes) ref = options[0].m.id;
    else {
      const rows = options.map((o) => {
        const price = live.prices.get(o.m.id);
        return { label: `${o.m.name}`, note: `${formatBytes(o.size)} · ${FIT_LABEL[o.where]}${price?.priced ? ` · list ${priceText(price)}` : ""}${o.m.tags?.length ? ` · ${o.m.tags.join(", ")}` : ""}` };
      });
      rows[0].label += " (recommended)";
      rows.push({ label: "Another model…", note: "an Ollama tag or hf.co/<user>/<repo> (may not sell)" });
      const choice = await promptChoice(`${heading("Which model?")} ${dim("best that fits first")}`, rows);
      if (choice === null) return console.log(`\n${dim("Nothing downloaded.")}\n`);
      if (choice === rows.length - 1) {
        ref = (await promptLine(`  Model ${dim("(Ollama tag or hf.co/<user>/<repo>)")}: `)).trim();
        if (!ref) return console.log(`\n${dim("Nothing downloaded.")}\n`);
      } else ref = options[choice].m.id;
    }
  }

  // 3. Download
  console.log(heading("Model"));
  const pre = await snapshotAdvertising(config, (c) => discoverLocalModels(c));
  const got = await pullModel({ args, config: loadConfig(), engine, ref, hw });
  if (!got) return;

  // 4. Test it, the way a buyer's request will reach it.
  const cfgNow = loadConfig();
  const testBase = engine === "ollama" ? ollama.ollamaBase(cfgNow) : (cfgNow.localEngine === "llamacpp" && cfgNow.localEndpoint) || LLAMACPP_DEFAULT_ENDPOINT;
  let stopTest = () => {};
  try {
    if (engine === "llamacpp") {
      const r = await reachModel({ ...cfgNow, localEngine: "llamacpp", localEndpoint: testBase }, got.id);
      stopTest = r.stop;
    }
    const answer = await withSpinner(`Asking ${got.id} a question…`, chatOnce({ base: testBase, model: got.id, prompt: "Reply with one word: ready", maxTokens: 256 }));
    console.log(ok(`It answers`, `${answer.ms < 1000 ? "under a second" : formatDuration(answer.ms / 1000)} for the first reply, model load included`));
  } catch (e) {
    console.log(bad(`It did not answer: ${e.message}`));
    console.log(`    ${hintText(`Try it yourself: \`aile local run ${got.id} "hello"\``)}`);
  } finally {
    stopTest();
  }
  console.log();

  // 5. Lend it.
  const before = loadConfig();
  const { elsewhere } = servingPlan(before, engine);
  if (got.sellable === false) {
    console.log(warn(`${got.id} has no published list price, so the network will not sell it`, "it runs here for your own use"));
    console.log(`\n${next([["aile local models", "models that sell"], [`aile local run ${got.id}`, "talk to it"]])}\n`);
    return;
  }
  for (const l of privacyLines()) console.log(l);
  console.log();
  if (elsewhere && !args.yes) {
    if (!interactive || !(await promptConfirm(`Replace your current self-hosted endpoint (${before.localEndpoint})?`, { defaultYes: false }))) {
      return console.log(`\n${dim(`Kept lending ${before.localEndpoint}. ${got.id} is downloaded and ready.`)}\n`);
    }
  }
  const lend = args.yes || (await promptConfirm(`Lend ${got.id} to buyers?`, { defaultYes: true }));
  if (!lend) {
    // Recorded for a later `aile local on`, unless lending is live right now:
    // then adding it to the list would offer it anyway.
    if (!before.localEnabled) adoptForLending({ config: before, pre, engine, id: got.id, sellable: true });
    console.log(info("Not lending it yet", before.localEnabled ? "" : hintText("`aile local on` when you are ready")));
    console.log(`\n${next([[`aile local run ${got.id}`, "talk to it here"]])}\n`);
    return;
  }
  let seeded = [];
  if (elsewhere) {
    const res = updateSettings({ localEngine: engine, localEndpoint: testBase, localModels: got.id });
    if (!res.ok) die(res.error);
  } else {
    seeded = adoptForLending({ config: before, pre, engine, id: got.id, sellable: true }).seeded;
  }
  const res = updateSettings({ localEnabled: true });
  if (!res.ok) die(res.error);
  const after = loadConfig();
  if (seeded.length) console.log(info(`Still offering too: ${seeded.join(", ")}`));
  console.log(ok(`Lending ${C.cyan}local/${got.id}${C.reset}`, after.localEngine === "llamacpp" ? hintText("llama.cpp starts with `aile start`") : ""));
  console.log();

  if (lend && startNode && after.renterToken) {
    const go = args.start || (!args["no-start"] && interactive && await promptConfirm("Start serving now?", { defaultYes: true }));
    if (go) { console.log(); await startNode({ ...args, _: ["start"] }); return; }
  }
  console.log(next([
    !after.renterToken ? ["aile login", "sign in, so you are paid for what it serves"] : null,
    ["aile start", "serve it (Ctrl+C stops)"],
    [`aile local run ${got.id}`, "talk to it here"],
  ]));
  console.log();
}

// ---------------------------------------------------------------------------
// On / off / endpoint (the original commands)
// ---------------------------------------------------------------------------

function onCommand() {
  const config = loadConfig();
  if (!config.localEndpoint) die("Nothing to lend yet.", "Run `aile local setup` to download a model, or `aile local <url>` for a server you already run.");
  const res = updateSettings({ localEnabled: true });
  if (!res.ok) die(res.error);
  console.log(`\n${C.green}Lending your self-hosted model${C.reset} ${C.dim}${config.localEndpoint}${C.reset}\n`);
  for (const l of privacyLines()) console.log(l);
  console.log(`\nStart serving: ${C.cyan}aile start${C.reset}\n`);
}

function legacyOff() {
  const res = updateSettings({ localEnabled: false });
  if (!res.ok) die(res.error);
  console.log(`\n${C.green}Self-hosted lending is off.${C.reset} ${C.dim}The endpoint is remembered.${C.reset}\n`);
}

/**
 * Point at a model server the user already runs. Unchanged from before
 * managed engines existed, word for word: scripts and tests read it.
 */
async function legacyEndpoint(args, endpoint) {
  // Validate before saving. Writing a value that cannot serve, then reporting
  // success, would leave the user debugging a node that silently never gets work.
  let target;
  try {
    target = await resolveLocalTarget(endpoint);
  } catch (e) {
    die(`That endpoint will not work: ${e.message}`);
  }

  const res = updateSettings({ localEndpoint: endpoint, localEnabled: true, localEngine: "external" });
  if (!res.ok) die(res.error);

  console.log(`\n${C.green}Lending your self-hosted model${C.reset} ${C.dim}${endpoint}${C.reset}`);

  const models = await discoverLocalModels(res.value);
  const now = await localStatus(res.value);
  if (now.state === "down") {
    // Named models used to be reported as advertised whether or not anything
    // ran them; the node now lists them only while the endpoint answers.
    console.log(`${C.yellow}Nothing answers there yet${C.reset} ${C.dim}(${now.reason}). ${models.length ? models.join(", ") : "Its models"} will be listed once it does.${C.reset}`);
  } else if (models.length) {
    console.log(`${C.dim}Advertising: ${models.join(", ")}${C.reset}`);
    console.log(`${C.dim}Buyers send: ${C.reset}${C.cyan}${models.map((m) => `local/${m}`).join(", ")}${C.reset}`);
  } else {
    console.log(`${C.yellow}Could not list models${C.reset} ${C.dim}at ${target.host}:${target.port}.${C.reset}`);
    console.log(`${C.dim}Start it, or name them: ${C.reset}${C.cyan}aile config localModels llama3,mistral${C.reset}`);
  }

  console.log();
  for (const l of privacyLines()) console.log(l);
  console.log(`\nStart serving: ${C.cyan}aile start${C.reset}\n`);
}
