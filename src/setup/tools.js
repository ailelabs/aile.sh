/**
 * Every tool `aile setup` knows, and exactly what it does to each.
 *
 * Three kinds, because tools differ in what they let an outsider do:
 *
 *   config   aile writes the tool's own config file. For Claude Code and Codex
 *            that makes aile their DEFAULT, so it is only done when asked
 *            (`--mode default`); for the rest it ADDS aile as one more provider
 *            and changes nothing else.
 *   shortcut the tool reads its settings from the environment, so aile writes a
 *            launcher (`claudeaile`) instead of touching the tool at all.
 *   manual   the tool keeps its settings in an app UI or an extension's secret
 *            store, which nothing outside it can safely write — so aile prints
 *            the three values to paste.
 *
 * Claude Code and Codex are both `config` and `shortcut`.
 *
 * Each writer PLANS first (returning the new file text and a record of every
 * key it replaced) and writes nothing; the command decides whether to commit.
 * Every file path is derived from `ctx`, never from the real home directory.
 */

import fs from "node:fs";
import { planJson, readJson, fileExists, dirExists, revertJson, writeText } from "./files.js";
import {
  tomlString, topLevelLine, hasForeignTable, setTopLevel, setBlock, blockBody, lineValue,
} from "./toml.js";
import { detectTool } from "./detect.js";
import { isClaudeModel, outputCap } from "./models.js";

export const OPENCODE_PLUGIN = "@ailelabs/opencode-plugin";
export const OPENCODE_PROVIDER = "opencode-aile";

// Detection lives in ./detect.js: PATH, the installers' own locations, app
// bundles, editor extensions and config directories, per tool.

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

// CLAUDE_CONFIG_DIR moves Claude Code's whole config directory; honour it, and
// resolve a relative one the way Claude Code itself would (from where it runs).
const claudeDir = (ctx) => (ctx.get("CLAUDE_CONFIG_DIR")
  ? ctx.path.resolve(ctx.get("CLAUDE_CONFIG_DIR"))
  : ctx.path.join(ctx.home, ".claude"));
const claudeFile = (ctx) => ctx.path.join(claudeDir(ctx), "settings.json");

const claude = {
  id: "claude",
  label: "Claude Code",
  kinds: ["shortcut", "config"],
  runner: "claude",
  changesDefault: true,
  detect: (ctx) => detectTool(ctx, "claude"),
  files: (ctx) => [claudeFile(ctx)],
  plan(ctx, { key, model = null }) {
    const file = claudeFile(ctx);
    let conflict = null;
    const edit = planJson(file, (ops) => {
      const base = ops.get(["env", "ANTHROPIC_BASE_URL"]);
      if (typeof base === "string" && base && base.replace(/\/+$/, "") !== ctx.anthropicBase) {
        conflict = `already points at ${base}`;
      }
      ops.set(["env", "ANTHROPIC_BASE_URL"], ctx.anthropicBase);
      ops.set(["env", "ANTHROPIC_AUTH_TOKEN"], key);
      ops.set(["env", "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"], "1");
      // A second credential in the same file wins over ours in some paths
      // and conflicts in the rest; both are set aside, and restored on undo.
      ops.unset(["env", "ANTHROPIC_API_KEY"]);
      if (ops.get(["apiKeyHelper"]) !== undefined) {
        conflict = conflict || "uses an apiKeyHelper, which would replace the aile key";
        ops.unset(["apiKeyHelper"]);
      }
      if (model) ops.set(["env", "ANTHROPIC_MODEL"], model);
    }, { secret: true });
    if (!edit.ok) return { ok: false, reason: edit.reason };
    return { ok: true, edits: [edit], conflict };
  },
  status(ctx) {
    const r = readJson(claudeFile(ctx));
    const base = r.value?.env?.ANTHROPIC_BASE_URL;
    if (typeof base !== "string" || !base) return { state: "none" };
    return base.replace(/\/+$/, "") === ctx.anthropicBase ? { state: "aile" } : { state: "other", detail: base };
  },
};

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

const codexDir = (ctx) => ctx.get("CODEX_HOME") || ctx.path.join(ctx.home, ".codex");
const codexFile = (ctx) => ctx.path.join(codexDir(ctx), "config.toml");
const readText = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return null; } };

const codex = {
  id: "codex",
  label: "Codex",
  kinds: ["shortcut", "config"],
  runner: "codex",
  changesDefault: true,
  detect: (ctx) => detectTool(ctx, "codex"),
  files: (ctx) => [codexFile(ctx)],
  plan(ctx, { key, model = null }) {
    const file = codexFile(ctx);
    const before = readText(file);
    const text0 = before ?? "";
    if (hasForeignTable(text0, "model_providers.aile")) {
      return { ok: false, reason: `${file} already defines [model_providers.aile] by hand — aile will not overwrite it` };
    }
    const records = [];
    let text = text0;
    let conflict = null;

    const setKey = (k, line) => {
      const prev = topLevelLine(text0, k);
      if (prev !== null && prev.trim() === line) return;
      records.push({ kind: "toml-key", file, key: k, had: prev !== null, prev, value: line });
      text = setTopLevel(text, k, line);
    };
    const prevProvider = lineValue(topLevelLine(text0, "model_provider"));
    if (prevProvider && prevProvider !== "aile") conflict = `uses model_provider = "${prevProvider}"`;
    setKey("model_provider", `model_provider = ${tomlString("aile")}`);
    // No model unless asked: Codex's own default is a bare id, which aile
    // serves on the codex provider for this client.
    if (model) setKey("model", `model = ${tomlString(model)}`);

    const body = [
      "[model_providers.aile]",
      `name = ${tomlString("aile")}`,
      `base_url = ${tomlString(ctx.openaiBase)}`,
      `wire_api = ${tomlString("responses")}`,
      `experimental_bearer_token = ${tomlString(key)}`,
    ];
    if (JSON.stringify(blockBody(text0)) !== JSON.stringify(body)) {
      records.push({ kind: "toml-block", file });
      text = setBlock(text, body);
    }
    return {
      ok: true,
      conflict,
      edits: [{
        ok: true, file, text, records,
        created: before === null,
        changed: text !== text0 || before === null,
        mode: before === null ? 0o600 : null,
      }],
    };
  },
  revert(ctx, records) {
    const byFile = groupBy(records.filter((r) => r.kind.startsWith("toml") || r.kind === "file-created"), (r) => r.file);
    for (const [file, recs] of byFile) {
      let text = readText(file);
      if (text === null) continue;
      for (const r of [...recs].reverse()) {
        if (r.kind === "toml-key") {
          const cur = topLevelLine(text, r.key);
          // Only a line still as we left it goes back; one the user changed is theirs.
          if (cur !== null && cur.trim() === r.value) text = setTopLevel(text, r.key, r.had ? r.prev : null);
        } else if (r.kind === "toml-block") {
          text = setBlock(text, null);
        }
      }
      if (recs.some((r) => r.kind === "file-created") && !text.trim()) {
        try { fs.unlinkSync(file); } catch { /* gone */ }
      } else {
        writeText(file, text);
      }
    }
    return [];
  },
  status(ctx) {
    const text = readText(codexFile(ctx));
    if (text === null) return { state: "none" };
    const prov = lineValue(topLevelLine(text, "model_provider"));
    if (prov === "aile" && blockBody(text)) return { state: "aile" };
    return prov ? { state: "other", detail: `model_provider = ${prov}` } : { state: "none" };
  },
};

// ---------------------------------------------------------------------------
// opencode — through aile's own plugin, which discovers every model itself
// ---------------------------------------------------------------------------

const opencodeDir = (ctx) => ctx.path.join(ctx.xdgConfig, "opencode");
const opencodeFile = (ctx) => ctx.path.join(opencodeDir(ctx), "opencode.json");
const opencodeAuth = (ctx) =>
  ctx.path.join(ctx.get("OPENCODE_DATA_DIR") || ctx.path.join(ctx.xdgData, "opencode"), "auth.json");

const opencode = {
  id: "opencode",
  label: "opencode",
  kinds: ["config"],
  changesDefault: false,
  detect: (ctx) => detectTool(ctx, "opencode"),
  files: (ctx) => [opencodeFile(ctx), opencodeAuth(ctx)],
  plan(ctx, { key }) {
    const file = opencodeFile(ctx);
    if (!fileExists(file) && fileExists(ctx.path.join(opencodeDir(ctx), "opencode.jsonc"))) {
      return { ok: false, reason: "opencode keeps its settings in opencode.jsonc (with comments), which aile does not rewrite" };
    }
    const cfg = planJson(file, (ops) => {
      if (ops.created) ops.set(["$schema"], "https://opencode.ai/config.json");
      ops.ownArray(["plugin"], { field: null, prefix: OPENCODE_PLUGIN }, [[OPENCODE_PLUGIN, { baseURL: ctx.openaiBase }]]);
    });
    if (!cfg.ok) return { ok: false, reason: cfg.reason };
    const auth = planJson(opencodeAuth(ctx), (ops) => {
      ops.set([OPENCODE_PROVIDER], { type: "api", key });
    }, { secret: true });
    if (!auth.ok) return { ok: false, reason: auth.reason };
    return { ok: true, edits: [cfg, auth], conflict: null };
  },
  status(ctx) {
    const plugins = readJson(opencodeFile(ctx)).value?.plugin;
    const has = Array.isArray(plugins) && plugins.some((p) => (Array.isArray(p) ? p[0] : p) === OPENCODE_PLUGIN
      || String(Array.isArray(p) ? p[0] : p).startsWith(`${OPENCODE_PLUGIN}@`));
    return has ? { state: "aile" } : { state: "none" };
  },
};

// ---------------------------------------------------------------------------
// Factory Droid — custom models in ~/.factory/settings.json
// ---------------------------------------------------------------------------

const droidFile = (ctx) => ctx.path.join(ctx.home, ".factory", "settings.json");

const droid = {
  id: "droid",
  label: "Factory Droid",
  kinds: ["config"],
  changesDefault: false,
  needsModels: true,
  detect: (ctx) => detectTool(ctx, "droid"),
  files: (ctx) => [droidFile(ctx)],
  plan(ctx, { key, models }) {
    if (!models?.length) return { ok: false, reason: `could not read the model list from ${ctx.serverUrl}` };
    // Claude models go over Anthropic's own format (prompt caching, thinking),
    // everything else over chat completions; aile serves both.
    const entries = models.map((m) => {
      const claudeish = isClaudeModel(m.id);
      return {
        model: m.id,
        displayName: `aile · ${m.name}`,
        baseUrl: claudeish ? ctx.anthropicBase : ctx.openaiBase,
        apiKey: key,
        provider: claudeish ? "anthropic" : "generic-chat-completion-api",
        maxOutputTokens: outputCap(m),
      };
    });
    const edit = planJson(droidFile(ctx), (ops) => {
      ops.ownArray(["customModels"], { field: "baseUrl", prefix: ctx.serverUrl }, entries);
    }, { secret: true });
    if (!edit.ok) return { ok: false, reason: edit.reason };
    return { ok: true, edits: [edit], conflict: null };
  },
  status(ctx) {
    const list = readJson(droidFile(ctx)).value?.customModels;
    const n = Array.isArray(list) ? list.filter((e) => String(e?.baseUrl || "").startsWith(ctx.serverUrl)).length : 0;
    return n ? { state: "aile", detail: `${n} models` } : { state: "none" };
  },
};

// ---------------------------------------------------------------------------
// OpenClaw — a provider in ~/.openclaw/openclaw.json (JSON5; plain JSON only)
// ---------------------------------------------------------------------------

const openclawFile = (ctx) => ctx.path.join(ctx.home, ".openclaw", "openclaw.json");

const openclaw = {
  id: "openclaw",
  label: "OpenClaw",
  kinds: ["config"],
  changesDefault: false,
  needsModels: true,
  detect: (ctx) => detectTool(ctx, "openclaw"),
  files: (ctx) => [openclawFile(ctx)],
  plan(ctx, { key, models }) {
    if (!models?.length) return { ok: false, reason: `could not read the model list from ${ctx.serverUrl}` };
    const edit = planJson(openclawFile(ctx), (ops) => {
      ops.set(["models", "providers", "aile"], {
        baseUrl: ctx.openaiBase,
        apiKey: key,
        api: "openai-completions",
        models: models.map((m) => ({ id: m.id, name: m.name, contextWindow: m.context || 200000, maxTokens: outputCap(m) })),
      });
    }, { secret: true });
    if (!edit.ok) return { ok: false, reason: `${edit.reason} — OpenClaw allows JSON5, which aile does not rewrite` };
    return { ok: true, edits: [edit], conflict: null };
  },
  status(ctx) {
    const p = readJson(openclawFile(ctx)).value?.models?.providers?.aile;
    return p ? { state: "aile" } : { state: "none" };
  },
};

// ---------------------------------------------------------------------------
// Shortcut-only tools: they read everything from the environment
// ---------------------------------------------------------------------------

const envTool = (id, label) => ({
  id, label, kinds: ["shortcut"], runner: id, changesDefault: false,
  detect: (ctx) => detectTool(ctx, id),
  files: () => [],
  status: () => ({ state: "none" }),
});

// ---------------------------------------------------------------------------
// Manual: app UIs and extension secret stores
// ---------------------------------------------------------------------------

const KEY_HINT = "your aile key";

const manualTool = (id, label, steps) => ({
  id, label, kinds: ["manual"], changesDefault: false,
  detect: (ctx) => detectTool(ctx, id),
  files: () => [],
  status: () => ({ state: "none" }),
  steps,
});

const cursor = manualTool("cursor", "Cursor", (ctx, { key, model }) => [
  "Cursor Settings → Models:",
  `  OpenAI API Key            ${key || KEY_HINT}`,
  `  Override OpenAI Base URL  ${ctx.openaiBase}`,
  `  Add a custom model        ${model}`,
  "Cursor calls this from its own servers, and Tab completion keeps using Cursor's models.",
]);

const cline = manualTool("cline", "Cline, Roo Code", (ctx, { key, model }) => [
  "In the extension's settings, API Provider → OpenAI Compatible:",
  `  Base URL  ${ctx.openaiBase}`,
  `  API Key   ${key || KEY_HINT}`,
  `  Model ID  ${model}`,
]);

// Kilo is an opencode fork whose CLI, VS Code and JetBrains clients share
// ~/.config/kilo/kilo.jsonc — a file with comments, which aile does not rewrite.
const kilo = manualTool("kilo", "Kilo Code", (ctx, { key, model }) => [
  "Settings → Providers → OpenAI Compatible (or /connect in the Kilo CLI):",
  `  Base URL  ${ctx.openaiBase}`,
  `  API Key   ${key || KEY_HINT}`,
  `  Model ID  ${model}`,
]);

const continueTool = manualTool("continue", "Continue", (ctx, { key, model }) => [
  "Add to ~/.continue/config.yaml under `models:`",
  "  - name: aile",
  "    provider: openai",
  `    model: ${model}`,
  `    apiBase: ${ctx.openaiBase}`,
  `    apiKey: ${key || KEY_HINT}`,
  "    roles: [chat, edit, apply]",
]);

const zed = manualTool("zed", "Zed", (ctx, { key, model }) => [
  "Add to Zed's settings.json (Zed: Open Settings):",
  '  "language_models": { "openai_compatible": { "aile": {',
  `    "api_url": "${ctx.openaiBase}",`,
  `    "available_models": [{ "name": "${model}", "max_tokens": 200000 }]`,
  "  } } }",
  `Then set AILE_API_KEY=${key || "<your aile key>"} in the environment Zed starts from, or paste it in the Agent panel.`,
]);

const vscodeClaude = manualTool("vscode", "Claude Code in VS Code", (ctx, { key }) => [
  "The extension shares ~/.claude/settings.json with the CLI, so",
  "`aile setup claude --mode default` covers it. Its sign-in check reads its own",
  "setting, though — to skip the login prompt, add to your VS Code user settings",
  "(Preferences: Open User Settings (JSON)):",
  '  "claudeCode.disableLoginPrompt": true,',
  '  "claudeCode.environmentVariables": [',
  `    { "name": "ANTHROPIC_BASE_URL", "value": "${ctx.anthropicBase}" },`,
  `    { "name": "ANTHROPIC_AUTH_TOKEN", "value": "${key || KEY_HINT}" },`,
  '    { "name": "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", "value": "1" }',
  "  ]",
]);

const crush = manualTool("crush", "Crush", (ctx, { key, models }) => [
  "Add to your crushrc (~/.config/crush/crushrc):",
  `  provider add aile --type openai-compat --base-url "${ctx.openaiBase}" --api-key "${key || KEY_HINT}"`,
  ...(models || []).slice(0, 6).map((m) =>
    `  model add aile/${m.id} --name "${m.name}" --context-window ${m.context || 200000} --default-max-tokens ${outputCap(m)}`),
]);

const windsurf = manualTool("windsurf", "Windsurf (Devin Desktop)", (ctx, { key, model }) => [
  "Its own agent has no custom endpoint. Use aile through an extension inside it —",
  "Cline, Roo Code, Kilo Code or Continue — with:",
  `  Base URL  ${ctx.openaiBase}`,
  `  API Key   ${key || KEY_HINT}`,
  `  Model ID  ${model}`,
]);

const jetbrains = manualTool("jetbrains", "JetBrains AI Assistant", (ctx, { key, model }) => [
  "Settings → Tools → AI Assistant → Models → Third-party AI providers → OpenAI-compatible:",
  `  URL      ${ctx.openaiBase}`,
  `  API key  ${key || KEY_HINT}`,
  `  Model    ${model}`,
]);

/**
 * Found by `aile detect`, but with no setting that points them at another
 * provider — so there is nothing for setup to write. Listed so a user asking
 * "why not X?" gets the reason rather than silence.
 */
const unsupportedTool = (id, label, reason) => ({
  id, label, kinds: ["unsupported"], changesDefault: false,
  detect: (ctx) => detectTool(ctx, id),
  files: () => [],
  status: () => ({ state: "none" }),
  steps: () => [`Not supported yet: ${reason}`],
});

const gemini = unsupportedTool("gemini", "Gemini CLI", "it speaks only Google's own API format, which aile does not serve.");

export const TOOLS = [
  claude, codex, opencode, droid, openclaw,
  envTool("qwen", "Qwen Code"),
  envTool("aider", "Aider"),
  envTool("goose", "Goose"),
  cursor, cline, kilo, continueTool, zed, vscodeClaude, windsurf, jetbrains, crush,
  gemini,
  unsupportedTool("copilot", "GitHub Copilot", "it uses GitHub's own models and has no custom endpoint."),
  unsupportedTool("amp", "Amp", "it has no setting for another provider."),
  unsupportedTool("kiro", "Kiro", "it has no setting for another provider."),
  unsupportedTool("warp", "Warp", "its agent has no setting for another provider."),
  unsupportedTool("augment", "Augment (auggie)", "it has no setting for another provider."),
  unsupportedTool("trae", "Trae", "its agent has no setting for another provider; use an extension inside it (Cline, Roo, Kilo, Continue)."),
];

/** Setup can only print something for these — steps to paste, or why not. */
export const printsOnly = (t) => t.kinds.includes("manual") || t.kinds.includes("unsupported");

const ALIASES = {
  "claude-code": "claude", cc: "claude",
  "codex-cli": "codex",
  "factory": "droid", "factory-droid": "droid",
  "roo": "cline", "roo-code": "cline", "kilocode": "kilo", "kilo-code": "kilo",
  "devin": "windsurf", "devin-desktop": "windsurf", "junie": "jetbrains", "intellij": "jetbrains",
  "github-copilot": "copilot", "auggie": "augment",
  "vscode-claude": "vscode", "code": "vscode",
  "qwen-code": "qwen",
  "gemini-cli": "gemini",
};

export function getTool(id) {
  const k = String(id || "").toLowerCase();
  return TOOLS.find((t) => t.id === (ALIASES[k] || k)) || null;
}

/** Undo one tool's recorded file changes. Returns notes for anything left alone. */
export function revertTool(tool, ctx, records) {
  if (tool.revert) return tool.revert(ctx, records);
  const notes = [];
  const byFile = groupBy(records.filter((r) => r.file), (r) => r.file);
  for (const [file, recs] of byFile) {
    const created = recs.some((r) => r.kind === "file-created");
    const note = revertJson(file, recs.filter((r) => r.kind !== "file-created"), { created });
    if (note) notes.push(note);
  }
  return notes;
}

function groupBy(list, keyOf) {
  const m = new Map();
  for (const x of list) {
    const k = keyOf(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}
