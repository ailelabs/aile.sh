/**
 * The pieces `aile setup` is built from, each on its own: the TOML surgery on
 * Codex's config, the JSON planner, the shortcut scripts, the launch recipes,
 * and the argv split that keeps a tool's own flags away from ours.
 *
 * Everything that touches a filesystem does it in a scratch directory; nothing
 * here may read or write the real home of whoever runs the suite.
 */

import { describe, expect, it, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTopLevel, setBlock, blockBody, topLevelLine, hasForeignTable, lineValue, BLOCK_START, BLOCK_END } from "../src/setup/toml.js";
import { planJson, commitEdit, revertJson, readJson, ownsBy, writeText } from "../src/setup/files.js";
import { shScript, cmdScript, validShortcutName, chooseBinDir, foreignShortcut, removeShortcut } from "../src/setup/shortcuts.js";
import { recipe, childEnv } from "../src/setup/runners.js";
import { getTool, revertTool } from "../src/setup/tools.js";
import { makeCtx, webOrigin, bases } from "../src/setup/ctx.js";
import { spawnPlan, cmdEscapeArg, batchReparses } from "../src/setup/exec.js";
import { splitRunArgv, routeHolders } from "../src/cli/setup-command.js";
import { curatedModels, defaultModel, isClaudeModel } from "../src/setup/models.js";
import { mergeRecords } from "../src/setup/manifest.js";

const scratches = [];
const scratch = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "aile-setup-unit-"));
  scratches.push(d);
  return d;
};
afterAll(() => { for (const d of scratches) fs.rmSync(d, { recursive: true, force: true }); });

const KEY = `sk-aile-${"ab".repeat(24)}`;

describe("Codex config.toml — surgical, never a rewrite", () => {
  const USER = [
    "# my codex settings",
    'model = "o3"',
    "",
    "[mcp_servers.docs]",
    'command = "docs-mcp"  # keep this comment',
    "",
  ].join("\n");

  it("puts a top-level key BEFORE the first table, where TOML files it at the top level", () => {
    const out = setTopLevel(USER, "model_provider", 'model_provider = "aile"');
    const lines = out.split("\n");
    expect(lines.indexOf('model_provider = "aile"')).toBeLessThan(lines.indexOf("[mcp_servers.docs]"));
    expect(out).toContain('command = "docs-mcp"  # keep this comment');
    expect(out).toContain("# my codex settings");
  });

  it("replaces an existing top-level key in place and can take it back out", () => {
    const set = setTopLevel(USER, "model", 'model = "gpt-5.5"');
    expect(topLevelLine(set, "model")).toBe('model = "gpt-5.5"');
    expect(set.match(/^model =/gm)).toHaveLength(1);
    const back = setTopLevel(set, "model", 'model = "o3"');
    expect(back).toBe(USER);
  });

  it("does not mistake model_provider for model, or a table's key for a top-level one", () => {
    const text = 'model_provider = "x"\n\n[profiles.fast]\nmodel = "o4-mini"\n';
    expect(topLevelLine(text, "model")).toBeNull();
    expect(lineValue(topLevelLine(text, "model_provider"))).toBe("x");
  });

  it("owns exactly one marked block, and removing it restores the file", () => {
    const body = ["[model_providers.aile]", 'name = "aile"'];
    const once = setBlock(USER, body);
    expect(once).toContain(BLOCK_START);
    expect(once).toContain(BLOCK_END);
    expect(blockBody(once)).toEqual(body);
    const twice = setBlock(once, body);
    expect(twice.split(BLOCK_START)).toHaveLength(2);
    expect(setBlock(once, null)).toBe(USER);
  });

  it("recognises a hand-written [model_providers.aile] and leaves ours alone", () => {
    expect(hasForeignTable('[model_providers.aile]\nname = "mine"\n', "model_providers.aile")).toBe(true);
    const ours = setBlock("", ["[model_providers.aile]", 'name = "aile"']);
    expect(hasForeignTable(ours, "model_providers.aile")).toBe(false);
  });

  it("keeps CRLF line endings as it found them", () => {
    const crlf = USER.replace(/\n/g, "\r\n");
    const out = setBlock(setTopLevel(crlf, "model_provider", 'model_provider = "aile"'), ["[x]"]);
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
  });
});

describe("planJson / commitEdit / revertJson", () => {
  it("changes only what it is told, keeps everything else, and undo restores the original", () => {
    const dir = scratch();
    const file = path.join(dir, "settings.json");
    const original = { theme: "dark", env: { FOO: "1", ANTHROPIC_API_KEY: "sk-ant-mine" }, permissions: { allow: ["Bash(ls)"] } };
    fs.writeFileSync(file, `${JSON.stringify(original, null, 4)}\n`);

    const edit = planJson(file, (ops) => {
      ops.set(["env", "ANTHROPIC_BASE_URL"], "https://api.aile.test");
      ops.unset(["env", "ANTHROPIC_API_KEY"]);
    });
    expect(edit.ok).toBe(true);
    const records = commitEdit(edit);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(after).toEqual({ theme: "dark", env: { FOO: "1", ANTHROPIC_BASE_URL: "https://api.aile.test" }, permissions: { allow: ["Bash(ls)"] } });
    // Indentation survives: the user's file used four spaces.
    expect(fs.readFileSync(file, "utf8")).toContain('\n    "theme"');
    expect(fs.existsSync(`${file}.aile-backup`)).toBe(true);

    revertJson(file, records);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(original);
  });

  it("refuses a file that is not plain JSON rather than rewriting it", () => {
    const dir = scratch();
    const file = path.join(dir, "opencode.json");
    fs.writeFileSync(file, '{\n  // my comment\n  "a": 1,\n}\n');
    const edit = planJson(file, (ops) => ops.set(["b"], 2));
    expect(edit.ok).toBe(false);
    expect(edit.reason).toMatch(/not plain JSON/);
    expect(fs.readFileSync(file, "utf8")).toContain("// my comment");
  });

  it("owns array elements by a data rule, and undo removes only those", () => {
    const dir = scratch();
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ customModels: [{ model: "mine", baseUrl: "https://other.test" }] }));
    const own = { field: "baseUrl", prefix: "https://api.aile.test" };
    const edit = planJson(file, (ops) => ops.ownArray(["customModels"], own, [{ model: "cc/x", baseUrl: "https://api.aile.test" }]));
    const records = commitEdit(edit);
    // The user adds one of their own after setup; undo must keep it.
    const mid = JSON.parse(fs.readFileSync(file, "utf8"));
    mid.customModels.push({ model: "later", baseUrl: "https://mine.test" });
    fs.writeFileSync(file, JSON.stringify(mid));
    revertJson(file, records);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).customModels.map((m) => m.model)).toEqual(["mine", "later"]);
  });

  it.skipIf(process.platform === "win32")("writeText keeps an existing file's mode unless the caller names one", () => {
    const dir = scratch();
    const file = path.join(dir, "config.toml");
    fs.writeFileSync(file, "a = 1\n");
    fs.chmodSync(file, 0o600);
    writeText(file, "a = 2\n");
    expect(fs.readFileSync(file, "utf8")).toBe("a = 2\n");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    writeText(file, "a = 3\n", { mode: 0o640 });
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
  });

  it("deletes a file it created once nothing else is in it", () => {
    const dir = scratch();
    const file = path.join(dir, "new", "auth.json");
    const edit = planJson(file, (ops) => ops.set(["opencode-aile"], { type: "api", key: KEY }), { secret: true });
    expect(edit.created).toBe(true);
    const records = commitEdit(edit);
    expect(records[0].kind).toBe("file-created");
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    revertJson(file, records.slice(1), { created: true });
    expect(fs.existsSync(file)).toBe(false);
  });

  it("ownsBy reads a plugin tuple's name as well as a bare string", () => {
    const owns = ownsBy({ field: null, prefix: "@ailelabs/opencode-plugin" });
    expect(owns(["@ailelabs/opencode-plugin", {}])).toBe(true);
    expect(owns("@ailelabs/opencode-plugin@1.2.0")).toBe(true);
    expect(owns("opencode-other")).toBe(false);
  });

  it("an empty file reads as an empty object, not an error", () => {
    const dir = scratch();
    const file = path.join(dir, "e.json");
    fs.writeFileSync(file, "\n");
    expect(readJson(file).value).toEqual({});
  });
});

describe("the manifest keeps the user's value, not our previous write", () => {
  it("a re-run merges and keeps the first 'before'", () => {
    const first = [{ kind: "json-set", file: "f", path: ["env", "X"], had: true, prev: "users", value: "aile-1" }];
    const second = [{ kind: "json-set", file: "f", path: ["env", "X"], had: true, prev: "aile-1", value: "aile-2" }];
    const merged = mergeRecords(first, second);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ prev: "users", value: "aile-2" });
  });
});

describe("launch recipes", () => {
  const c = { key: KEY, ...bases("https://api.aile.test") };

  it("Claude Code: gateway, key as a bearer token, discovery on, and no competing API key", () => {
    const r = recipe("claude", c);
    expect(r.env).toEqual({
      ANTHROPIC_BASE_URL: "https://api.aile.test",
      ANTHROPIC_AUTH_TOKEN: KEY,
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    });
    expect(r.unset).toContain("ANTHROPIC_API_KEY");
    const env = childEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-x" }, r);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });

  it("Codex: a per-run provider over the Responses API, and the key only in the environment", () => {
    const r = recipe("codex", c);
    expect(r.args).toContain("model_providers.aile.base_url=https://api.aile.test/v1");
    expect(r.args).toContain("model_providers.aile.wire_api=responses");
    expect(r.args.join(" ")).not.toContain(KEY);
    expect(r.env.AILE_API_KEY).toBe(KEY);
  });

  it("a route names the model: Claude Code's main and haiku slots, and only with a small model the haiku one", () => {
    const routed = recipe("claude", { ...c, model: "aile/auto", smallModel: "aile/auto" });
    expect(routed.env.ANTHROPIC_MODEL).toBe("aile/auto");
    expect(routed.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("aile/auto");
    const mainOnly = recipe("claude", { ...c, model: "aile/auto" });
    expect(mainOnly.env.ANTHROPIC_MODEL).toBe("aile/auto");
    expect(mainOnly.env).not.toHaveProperty("ANTHROPIC_DEFAULT_HAIKU_MODEL");
  });

  it("a route names the model: Codex gets it as its model override", () => {
    expect(recipe("codex", { ...c, model: "aile/auto" }).args).toContain("model=aile/auto");
  });

  it("tools with no picker get aile's default model", () => {
    expect(recipe("aider", { ...c, defaultModel: "cc/claude-sonnet-5" }).args).toEqual(["--model", "openai/cc/claude-sonnet-5"]);
    expect(recipe("qwen", { ...c, model: "codex/gpt-5.5" }).env.OPENAI_MODEL).toBe("codex/gpt-5.5");
  });
});

describe("Claude Code's settings.json with a route", () => {
  it("writes the haiku slot beside the model, and undo takes both back out", () => {
    const home = scratch();
    const dir = path.join(home, ".claude");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "settings.json");
    const original = { theme: "dark", env: { FOO: "1" } };
    fs.writeFileSync(file, JSON.stringify(original));
    const ctx = makeCtx({ env: { CLAUDE_CONFIG_DIR: dir }, home, serverUrl: "https://api.aile.test" });
    const claude = getTool("claude");

    const plan = claude.plan(ctx, { key: KEY, model: "aile/auto", smallModel: "aile/auto" });
    expect(plan.ok).toBe(true);
    const records = plan.edits.flatMap((e) => commitEdit(e));
    const env = JSON.parse(fs.readFileSync(file, "utf8")).env;
    expect(env.ANTHROPIC_MODEL).toBe("aile/auto");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("aile/auto");
    expect(env.FOO).toBe("1");

    revertTool(claude, ctx, records);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(original);
  });
});

describe("a route taken back out of the tools", () => {
  const ctxFor = (home, env = {}) => makeCtx({ env, home, serverUrl: "https://api.aile.test" });

  it("Claude Code: both slots go when they still hold the route; a model of the user's own stays", () => {
    const home = scratch();
    const dir = path.join(home, ".claude");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "settings.json");
    const original = { env: { FOO: "1" } };
    fs.writeFileSync(file, JSON.stringify(original));
    const ctx = ctxFor(home, { CLAUDE_CONFIG_DIR: dir });
    const claude = getTool("claude");
    const records = [
      ...claude.plan(ctx, { key: KEY, model: "aile/auto", smallModel: "aile/auto" }).edits.flatMap((e) => commitEdit(e)),
    ];
    const out = claude.plan(ctx, { key: KEY, staleRoute: "aile/auto" });
    records.push(...out.edits.flatMap((e) => commitEdit(e)));
    const env = JSON.parse(fs.readFileSync(file, "utf8")).env;
    expect(env).not.toHaveProperty("ANTHROPIC_MODEL");
    expect(env).not.toHaveProperty("ANTHROPIC_DEFAULT_HAIKU_MODEL");
    expect(env.FOO).toBe("1");

    // A model the user picked since is theirs, and a new one replaces the route's.
    const mine = JSON.parse(fs.readFileSync(file, "utf8"));
    mine.env.ANTHROPIC_MODEL = "my-model";
    mine.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = "aile/auto";
    fs.writeFileSync(file, JSON.stringify(mine));
    for (const e of claude.plan(ctx, { key: KEY, staleRoute: "aile/auto" }).edits) commitEdit(e);
    const after = JSON.parse(fs.readFileSync(file, "utf8")).env;
    expect(after.ANTHROPIC_MODEL).toBe("my-model");
    expect(after).not.toHaveProperty("ANTHROPIC_DEFAULT_HAIKU_MODEL");

    // Undo still goes back to the file as it was before any route.
    const merged = mergeRecords([], records);
    revertTool(claude, ctx, merged);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).env).toEqual(original.env);
  });

  it("Codex: the model line goes when it holds the route, and undo gives back the user's own", () => {
    const home = scratch();
    const dir = path.join(home, ".codex");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "config.toml");
    const original = 'model = "o3"\n';
    fs.writeFileSync(file, original);
    const ctx = ctxFor(home, { CODEX_HOME: dir });
    const codex = getTool("codex");
    const first = codex.plan(ctx, { key: KEY, model: "aile/auto" });
    const records = first.edits.flatMap((e) => commitEdit(e));
    expect(fs.readFileSync(file, "utf8")).toContain('model = "aile/auto"');

    // Not the route any more (the user changed it): left alone.
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("aile/auto", "gpt-5.5"));
    expect(codex.plan(ctx, { key: KEY, staleRoute: "aile/auto" }).edits[0].text).toContain('model = "gpt-5.5"');
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("gpt-5.5", "aile/auto"));

    const out = codex.plan(ctx, { key: KEY, staleRoute: "aile/auto" });
    records.push(...out.edits.flatMap((e) => commitEdit(e)));
    expect(fs.readFileSync(file, "utf8")).not.toMatch(/^model = /m);

    revertTool(codex, ctx, mergeRecords([], records));
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  });

  it("Claude Code: given the recorded changes, a slot gets back the value the route replaced, and is emptied when there was none", () => {
    const home = scratch();
    const dir = path.join(home, ".claude");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "settings.json");
    const original = { env: { FOO: "1", ANTHROPIC_MODEL: "claude-opus-4" } };
    fs.writeFileSync(file, JSON.stringify(original));
    const ctx = ctxFor(home, { CLAUDE_CONFIG_DIR: dir });
    const claude = getTool("claude");
    const envOf = () => JSON.parse(fs.readFileSync(file, "utf8")).env;

    let records = claude.plan(ctx, { key: KEY, model: "aile/auto", smallModel: "aile/auto" }).edits.flatMap((e) => commitEdit(e));
    expect(envOf()).toMatchObject({ ANTHROPIC_MODEL: "aile/auto", ANTHROPIC_DEFAULT_HAIKU_MODEL: "aile/auto" });

    // The haiku slot had nothing before the route; the main slot had the user's own model.
    records = mergeRecords([], records);
    const out = claude.plan(ctx, { key: KEY, staleRoute: "aile/auto", prior: records });
    records = mergeRecords(records, out.edits.flatMap((e) => commitEdit(e)));
    expect(envOf().ANTHROPIC_MODEL).toBe("claude-opus-4");
    expect(envOf()).not.toHaveProperty("ANTHROPIC_DEFAULT_HAIKU_MODEL");

    // Taking the route out again is a no-op, and undo goes back to the file as it was.
    expect(claude.plan(ctx, { key: KEY, staleRoute: "aile/auto", prior: records }).edits[0].changed).toBe(false);
    revertTool(claude, ctx, records);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(original);
  });

  it("Claude Code: a slot the user changed since is left alone, with or without the recorded changes", () => {
    const home = scratch();
    const dir = path.join(home, ".claude");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_MODEL: "claude-opus-4", ANTHROPIC_DEFAULT_HAIKU_MODEL: "my-haiku" } }));
    const ctx = ctxFor(home, { CLAUDE_CONFIG_DIR: dir });
    const claude = getTool("claude");
    const records = mergeRecords([], claude.plan(ctx, { key: KEY, model: "aile/auto", smallModel: "aile/auto" }).edits.flatMap((e) => commitEdit(e)));
    const mine = JSON.parse(fs.readFileSync(file, "utf8"));
    mine.env.ANTHROPIC_MODEL = "my-model";
    fs.writeFileSync(file, JSON.stringify(mine));
    for (const e of claude.plan(ctx, { key: KEY, staleRoute: "aile/auto", prior: records }).edits) commitEdit(e);
    const env = JSON.parse(fs.readFileSync(file, "utf8")).env;
    expect(env.ANTHROPIC_MODEL).toBe("my-model");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("my-haiku");
  });

  it("Codex: given the recorded changes, the model line the route replaced comes back, and goes when there was none", () => {
    const home = scratch();
    const dir = path.join(home, ".codex");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "config.toml");
    const ctx = ctxFor(home, { CODEX_HOME: dir });
    const codex = getTool("codex");

    const original = 'model = "o3" # mine\n';
    fs.writeFileSync(file, original);
    let records = mergeRecords([], codex.plan(ctx, { key: KEY, model: "aile/auto" }).edits.flatMap((e) => commitEdit(e)));
    expect(fs.readFileSync(file, "utf8")).toContain('model = "aile/auto"');
    const out = codex.plan(ctx, { key: KEY, staleRoute: "aile/auto", prior: records });
    records = mergeRecords(records, out.edits.flatMap((e) => commitEdit(e)));
    expect(fs.readFileSync(file, "utf8")).toContain('model = "o3" # mine');
    expect(fs.readFileSync(file, "utf8")).not.toContain("aile/auto");
    revertTool(codex, ctx, records);
    expect(fs.readFileSync(file, "utf8")).toBe(original);

    // No model of the user's before the route: none after it either.
    fs.writeFileSync(file, "");
    records = mergeRecords([], codex.plan(ctx, { key: KEY, model: "aile/auto" }).edits.flatMap((e) => commitEdit(e)));
    for (const e of codex.plan(ctx, { key: KEY, staleRoute: "aile/auto", prior: records }).edits) commitEdit(e);
    expect(fs.readFileSync(file, "utf8")).not.toMatch(/^model = /m);

    // A model line that is not the route any more is the user's.
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("model_provider", 'model = "gpt-5.5"\nmodel_provider'));
    expect(codex.plan(ctx, { key: KEY, staleRoute: "aile/auto", prior: records }).edits[0].text).toContain('model = "gpt-5.5"');
  });
});

describe("who holds the saved route", () => {
  const tools = { claude: {}, codex: {}, opencode: {} };

  it("is the list on the record, for the tools still set up", () => {
    expect(routeHolders({ tools, route: { name: "aile/auto", prefix: "k", tools: ["codex", "droid"] } })).toEqual(["codex"]);
    expect(routeHolders({ tools: {}, route: { name: "aile/auto", prefix: "k", tools: ["codex"] } })).toEqual([]);
    expect(routeHolders({ tools })).toEqual([]);
  });

  it("is Claude Code and Codex, whichever are set up, for a record from before the list", () => {
    const route = { name: "aile/auto", prefix: "k" };
    expect(routeHolders({ tools, route })).toEqual(["claude", "codex"]);
    expect(routeHolders({ tools: { opencode: {}, codex: {} }, route })).toEqual(["codex"]);
  });
});

describe("shortcut scripts", () => {
  const rec = recipe("codex", { key: KEY, ...bases("https://api.aile.test") });

  it("sh: exports, then execs the tool with the user's arguments last", () => {
    const s = shScript("codexaile", rec, { tool: "codex" });
    expect(s.startsWith("#!/bin/sh\n")).toBe(true);
    expect(s).toContain(`export AILE_API_KEY='${KEY}'`);
    expect(s).toMatch(/\nexec codex -c model_provider=aile .* "\$@"\n$/);
    expect(s).toContain("Written by `aile setup`");
  });

  it("cmd: setlocal, set, then the tool with %*", () => {
    const s = cmdScript("codexaile", rec, { tool: "codex" });
    expect(s).toContain("@echo off\r\n");
    expect(s).toContain("setlocal\r\n");
    expect(s).toContain(`set "AILE_API_KEY=${KEY}"`);
    expect(s).toMatch(/codex -c model_provider=aile .* %\*\r\n$/);
  });

  it("clears a competing variable in both shells", () => {
    const r = recipe("claude", { key: KEY, ...bases("https://api.aile.test") });
    expect(shScript("claudeaile", r, { tool: "claude" })).toContain("unset ANTHROPIC_API_KEY");
    expect(cmdScript("claudeaile", r, { tool: "claude" })).toContain('set "ANTHROPIC_API_KEY="');
  });

  it("refuses a name that could escape its directory", () => {
    expect(validShortcutName("claudeaile")).toBe(true);
    expect(validShortcutName("cc-aile")).toBe(true);
    for (const bad of ["../x", "a b", "", "x/y", "x\\y", ".hidden"]) expect(validShortcutName(bad)).toBe(false);
  });

  it("will not overwrite or delete a command that is not ours", () => {
    const dir = scratch();
    const theirs = path.join(dir, "claudeaile");
    fs.writeFileSync(theirs, "#!/bin/sh\necho mine\n");
    expect(foreignShortcut([{ file: theirs }])).toBe(theirs);
    expect(removeShortcut([theirs])).toEqual([]);
    expect(fs.existsSync(theirs)).toBe(true);
  });

  it("goes into a directory already on PATH, creating it if needed", () => {
    const home = scratch();
    const appData = path.join(home, "AppData", "Roaming");
    const want = process.platform === "win32" ? path.join(appData, "npm") : path.join(home, ".local", "bin");
    if (process.platform === "win32") fs.mkdirSync(appData, { recursive: true });
    else fs.mkdirSync(home, { recursive: true });
    const ctx = makeCtx({ env: { PATH: want, APPDATA: appData, LOCALAPPDATA: path.join(home, "AppData", "Local") }, home, serverUrl: "https://api.aile.test" });
    expect(chooseBinDir(ctx)).toEqual({ dir: want, onPath: true });
  });

  it("falls back, and says it is not on PATH, when no candidate is", () => {
    const home = scratch();
    const ctx = makeCtx({ env: { PATH: path.join(home, "elsewhere"), APPDATA: path.join(home, "r"), LOCALAPPDATA: path.join(home, "l") }, home, serverUrl: "https://api.aile.test" });
    const got = chooseBinDir(ctx);
    expect(got.onPath).toBe(false);
  });
});

describe("aile run keeps the tool's own flags for the tool", () => {
  it("everything after the tool name is passed through untouched", () => {
    expect(splitRunArgv(["run", "claude", "--resume", "-p", "hi there"]))
      .toEqual({ ours: {}, tool: "claude", rest: ["--resume", "-p", "hi there"] });
  });

  it("our flags come before the tool name", () => {
    expect(splitRunArgv(["run", "--model", "cc/claude-opus-5", "aider", "--yes"]))
      .toEqual({ ours: { model: "cc/claude-opus-5" }, tool: "aider", rest: ["--yes"] });
  });

  it("a `--` after the tool is dropped once", () => {
    expect(splitRunArgv(["run", "codex", "--", "--version"]).rest).toEqual(["--version"]);
  });
});

describe("starting a .cmd tool on Windows goes through cmd.exe, quoted", () => {
  it("wraps a .cmd in cmd.exe with every argument escaped", () => {
    const plan = spawnPlan("C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd", ["exec", "fix a & b"], { platform: "win32", env: {} });
    expect(plan.command).toBe("cmd.exe");
    expect(plan.options.windowsVerbatimArguments).toBe(true);
    expect(plan.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    // `&` is escaped, so cmd.exe cannot read it as a second command.
    expect(plan.args[3]).toContain("^&");
  });

  it("runs an .exe, or anything on macOS/Linux, directly", () => {
    expect(spawnPlan("/usr/bin/claude", ["-p", "x"], { platform: "linux" })).toEqual({ command: "/usr/bin/claude", args: ["-p", "x"], options: {} });
    expect(spawnPlan("C:\\bin\\claude.exe", ["-p"], { platform: "win32", env: {} }).command).toBe("C:\\bin\\claude.exe");
  });

  it("quotes an argument with a quote inside it", () => {
    expect(cmdEscapeArg('say "hi"')).toBe('^"say^ \\^"hi\\^"^"');
  });

  /**
   * The real thing, on Windows: a batch shim that forwards `%*` — what npm
   * installs for every global CLI — must hand the tool exactly what the user
   * typed. Escaped once, `model="x & y"` ran `y` as a second command.
   */
  it.skipIf(process.platform !== "win32")("arguments survive an npm-style %* shim byte for byte", async () => {
    const dir = scratch();
    fs.writeFileSync(path.join(dir, "echo.js"), "console.log(JSON.stringify(process.argv.slice(2)))");
    fs.writeFileSync(path.join(dir, "echoargs.cmd"), `@ECHO off\r\n"${process.execPath}" "%~dp0echo.js" %*\r\n`);
    const file = path.join(dir, "echoargs.cmd");
    const args = ['model="x & y"', "a ^ b | c % d !e (f) <g>", 'say "hi" \\', "50%", "x=$HOME", "trailing\\"];
    const plan = spawnPlan(file, args, { platform: "win32", env: process.env, reparses: batchReparses(file) });
    const proc = Bun.spawn([plan.command, ...plan.args], { windowsVerbatimArguments: true, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(JSON.parse(out.trim().split(/\r?\n/).pop())).toEqual(args);
  });
});

describe("models and web origin", () => {
  const models = [
    { id: "openrouter/foo", name: "foo" },
    { id: "codex/gpt-5.5", name: "gpt-5.5" },
    { id: "cc/claude-sonnet-5", name: "claude-sonnet-5" },
  ];

  it("lists the Claude and Codex models for tools that need a list", () => {
    expect(curatedModels(models).map((m) => m.id)).toEqual(["codex/gpt-5.5", "cc/claude-sonnet-5"]);
    expect(curatedModels(models, { all: true })).toHaveLength(3);
  });

  it("defaults to Claude Sonnet when it is served", () => {
    expect(defaultModel(models)).toBe("cc/claude-sonnet-5");
    expect(defaultModel([])).toBe("cc/claude-sonnet-5");
  });

  it("tells a Claude model by its id", () => {
    expect(isClaudeModel("cc/claude-opus-5")).toBe(true);
    expect(isClaudeModel("codex/gpt-5.5")).toBe(false);
  });

  it("the website is the API host without its api. prefix", () => {
    expect(webOrigin("https://api.aile.sh")).toBe("https://aile.sh");
    expect(webOrigin("https://api.dev.aile.sh/")).toBe("https://dev.aile.sh");
    expect(webOrigin("http://127.0.0.1:4000")).toBe("http://127.0.0.1:4000");
  });
});
