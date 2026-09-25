/**
 * Harness detection, one sign at a time, in a scratch home: a command on PATH,
 * a command at an installer's own location off PATH, an editor extension, an
 * app, and a config directory left behind — plus the cases that must NOT count.
 */

import { describe, expect, it, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectTool, findExtension, findBin, probeVersion } from "../src/setup/detect.js";
import { makeCtx } from "../src/setup/ctx.js";
import { recipe } from "../src/setup/runners.js";
import { shScript, cmdScript } from "../src/setup/shortcuts.js";
import { bases } from "../src/setup/ctx.js";
import { isInstalled } from "../src/cli/setup-command.js";

const WIN = process.platform === "win32";
const scratches = [];
afterAll(() => { for (const d of scratches) fs.rmSync(d, { recursive: true, force: true }); });

function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "aile-detect-"));
  scratches.push(h);
  return h;
}

/** An executable named `name` in `dir` — `.cmd` on Windows, mode 755 elsewhere. */
function tool(dir, name, body = "echo 1.2.3") {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, WIN ? `${name}.cmd` : name);
  fs.writeFileSync(file, WIN ? `@echo off\r\n${body}\r\n` : `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

function ctxFor(h, { PATH = path.join(h, "nowhere"), ...env } = {}) {
  return makeCtx({
    home: h,
    serverUrl: "https://api.aile.test",
    env: { PATH, PATHEXT: ".EXE;.CMD;.BAT", APPDATA: path.join(h, "AppData", "Roaming"), LOCALAPPDATA: path.join(h, "AppData", "Local"), ...env },
  });
}

describe("commands", () => {
  it("on PATH: runnable as typed", () => {
    const h = home();
    const bin = path.join(h, "pathbin");
    const file = tool(bin, "codex");
    const d = detectTool(ctxFor(h, { PATH: bin }), "codex");
    expect(d).toMatchObject({ found: true, via: "path", bin: file, onPath: true });
  });

  it("at an installer's own location, off PATH: found, with its full path", () => {
    const h = home();
    const file = tool(path.join(h, ".local", "bin"), "claude");
    const d = detectTool(ctxFor(h), "claude");
    expect(d).toMatchObject({ found: true, via: "location", bin: file, onPath: false });
    expect(isInstalled(d)).toBe(true);
  });

  it("opencode's own fallback directory, and OPENCODE_INSTALL_DIR", () => {
    const h = home();
    tool(path.join(h, ".opencode", "bin"), "opencode");
    expect(detectTool(ctxFor(h), "opencode").via).toBe("location");
    const h2 = home();
    const custom = path.join(h2, "custom-bin");
    tool(custom, "opencode");
    expect(detectTool(ctxFor(h2, { OPENCODE_INSTALL_DIR: custom }), "opencode").bin).toContain("custom-bin");
  });

  it("a generic name (`agent`) counts only when it really is Cursor's", () => {
    const h = home();
    const elsewhere = path.join(h, "elsewhere");
    tool(elsewhere, "agent");
    expect(detectTool(ctxFor(h, { PATH: elsewhere }), "cursor").found).toBe(false);
    // Somebody else's `agent` in the shared ~/.local/bin (Grok ships one).
    tool(path.join(h, ".local", "bin"), "agent");
    expect(detectTool(ctxFor(h, { PATH: elsewhere }), "cursor").found).toBe(false);
  });

  it.skipIf(WIN)("…and Cursor's `agent`, linked into ~/.local/bin from its own folder, does count", () => {
    const h = home();
    const real = tool(path.join(h, ".local", "share", "cursor-agent", "versions", "1"), "cursor-agent-bin");
    fs.mkdirSync(path.join(h, ".local", "bin"), { recursive: true });
    fs.symlinkSync(real, path.join(h, ".local", "bin", "agent"));
    expect(detectTool(ctxFor(h), "cursor").via).toBe("location");
  });

  it.skipIf(!WIN)("…and on Windows, in %LOCALAPPDATA%\\cursor-agent", () => {
    const h = home();
    tool(path.join(h, "AppData", "Local", "cursor-agent"), "agent");
    expect(detectTool(ctxFor(h), "cursor").via).toBe("location");
  });

  it("findBin prefers PATH over a known location", () => {
    const h = home();
    const onPath = path.join(h, "p");
    const a = tool(onPath, "goose");
    tool(path.join(h, ".local", "bin"), "goose");
    expect(findBin(ctxFor(h, { PATH: onPath }), ["goose"])).toEqual({ bin: a, onPath: true });
  });
});

describe("editor extensions", () => {
  it("finds an extension in every editor that has it, with its version", () => {
    const h = home();
    fs.mkdirSync(path.join(h, ".vscode", "extensions", "saoudrizwan.claude-dev-3.20.1"), { recursive: true });
    fs.mkdirSync(path.join(h, ".cursor", "extensions", "rooveterinaryinc.roo-cline-4.1.0-win32-x64"), { recursive: true });
    const d = detectTool(ctxFor(h), "cline");
    expect(d.via).toBe("extension");
    expect(d.extensions.map((e) => [e.name, e.host, e.version])).toEqual([
      ["Cline", "VS Code", "3.20.1"],
      ["Roo Code", "Cursor", "4.1.0"],
    ]);
  });

  it("Kilo is its own tool — an opencode fork, not a Cline variant", () => {
    const h = home();
    fs.mkdirSync(path.join(h, ".vscode", "extensions", "kilocode.kilo-code-5.0.0"), { recursive: true });
    expect(detectTool(ctxFor(h), "kilo").extensions[0]).toMatchObject({ name: "Kilo Code", version: "5.0.0" });
    expect(detectTool(ctxFor(h), "cline").found).toBe(false);
  });

  it("Codex's IDE extension counts for Codex, and Devin Desktop's extension folder is read", () => {
    const h = home();
    fs.mkdirSync(path.join(h, ".devin", "extensions", "openai.chatgpt-26.5.1"), { recursive: true });
    const d = detectTool(ctxFor(h), "codex");
    expect(d.via).toBe("extension");
    expect(d.extensions[0]).toMatchObject({ host: "Devin Desktop", name: "Codex" });
  });

  it("ignores an extension VS Code has uninstalled but not yet cleaned up", () => {
    const h = home();
    const dir = path.join(h, ".vscode", "extensions");
    fs.mkdirSync(path.join(dir, "continue.continue-1.0.0"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".obsolete"), JSON.stringify({ "continue.continue-1.0.0": true }));
    expect(findExtension(ctxFor(h), ["continue.continue"])).toEqual([]);
  });

  it("does not mistake a different extension that shares a prefix", () => {
    const h = home();
    fs.mkdirSync(path.join(h, ".vscode", "extensions", "saoudrizwan.claude-dev-nightly-1.0.0"), { recursive: true });
    expect(findExtension(ctxFor(h), ["saoudrizwan.claude-dev"])).toEqual([]);
  });

  it("honours VSCODE_EXTENSIONS", () => {
    const h = home();
    const dir = path.join(h, "my-ext");
    fs.mkdirSync(path.join(dir, "anthropic.claude-code-2.1.0"), { recursive: true });
    expect(detectTool(ctxFor(h, { VSCODE_EXTENSIONS: dir }), "vscode").found).toBe(true);
  });
});

describe("apps and leftovers", () => {
  it.skipIf(!WIN)("an app's install directory counts as installed (Windows)", () => {
    const h = home();
    fs.mkdirSync(path.join(h, "AppData", "Local", "Programs", "Windsurf"), { recursive: true });
    const d = detectTool(ctxFor(h), "windsurf");
    expect(d.via).toBe("app");
    expect(isInstalled(d)).toBe(true);
  });

  it.skipIf(process.platform !== "linux")("a Cursor AppImage counts (Linux)", () => {
    const h = home();
    fs.mkdirSync(path.join(h, "Applications"), { recursive: true });
    fs.writeFileSync(path.join(h, "Applications", "Cursor-3.2.0-x86_64.AppImage"), "");
    expect(detectTool(ctxFor(h), "cursor").via).toBe("app");
  });

  it("a config folder alone is a hint, not an install", () => {
    const h = home();
    fs.mkdirSync(path.join(h, ".codex"), { recursive: true });
    const d = detectTool(ctxFor(h), "codex");
    expect(d).toMatchObject({ found: true, via: "config" });
    expect(isInstalled(d)).toBe(false);
  });

  it("a bare ~/.gemini is not Gemini CLI — Antigravity makes one too; its settings.json is", () => {
    const h = home();
    fs.mkdirSync(path.join(h, ".gemini", "antigravity"), { recursive: true });
    expect(detectTool(ctxFor(h), "gemini").found).toBe(false);
    fs.writeFileSync(path.join(h, ".gemini", "settings.json"), "{}");
    expect(detectTool(ctxFor(h), "gemini").via).toBe("config");
  });

  it("honours a tool's own directory override", () => {
    const h = home();
    const dir = path.join(h, "elsewhere", "continue");
    fs.mkdirSync(dir, { recursive: true });
    expect(detectTool(ctxFor(h, { CONTINUE_GLOBAL_DIR: dir }), "continue").where).toBe(dir);
  });

  it("nothing at all is nothing", () => {
    const d = detectTool(ctxFor(home()), "droid");
    expect(d.found).toBe(false);
    expect(isInstalled(d)).toBe(false);
  });
});

describe("a tool found off PATH is launched by its full path", () => {
  it("shortcuts quote the full path, forward-slashed for sh", () => {
    const rec = { ...recipe("claude", { key: "k", ...bases("https://api.aile.test") }), bin: "C:\\Users\\Jo Doe\\.local\\bin\\claude.exe" };
    expect(shScript("claudeaile", rec, { tool: "claude" })).toContain(`exec 'C:/Users/Jo Doe/.local/bin/claude.exe' "$@"`);
    expect(cmdScript("claudeaile", rec, { tool: "claude" })).toContain(`"C:\\Users\\Jo Doe\\.local\\bin\\claude.exe" %*`);
  });

  it("a bare command stays bare", () => {
    const rec = recipe("claude", { key: "k", ...bases("https://api.aile.test") });
    expect(shScript("claudeaile", rec, { tool: "claude" })).toContain(`exec claude "$@"`);
  });
});

describe("versions", () => {
  it("reads the first version-looking token, and gives up on a tool that hangs", async () => {
    const h = home();
    // Quoted: bare parentheses are a syntax error to sh (cmd prints the quotes,
    // which the version match does not mind).
    const good = tool(path.join(h, "b"), "vtool", `echo "vtool 4.5.6 (build 7)"`);
    expect(await probeVersion(good)).toBe("4.5.6");
    const slow = tool(path.join(h, "b"), "slowtool", WIN ? "ping -n 6 127.0.0.1 >nul" : "sleep 5");
    expect(await probeVersion(slow, { timeoutMs: 300 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Which agent is running this command — from the environment it sets.
// Fixtures follow environments recorded from real harness runs.
// ---------------------------------------------------------------------------

import { detectInvoker, aiAgentName } from "../src/setup/invoker.js";

describe("detectInvoker", () => {
  it("names the harness from its own variables", () => {
    expect(detectInvoker({ CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" })).toMatchObject({ id: "claude", strong: false });
    expect(detectInvoker({ CLAUDE_CODE_CHILD_SESSION: "1" })).toMatchObject({ id: "claude", strong: true });
    expect(detectInvoker({ CODEX_THREAD_ID: "t1" })).toMatchObject({ id: "codex", strong: true });
    expect(detectInvoker({ OPENCODE: "1", OPENCODE_PID: "42" })).toMatchObject({ id: "opencode", strong: true });
    expect(detectInvoker({ GEMINI_CLI: "1" })).toMatchObject({ id: "gemini" });
    expect(detectInvoker({ CURSOR_EXTENSION_HOST_ROLE: "agent-exec" })).toMatchObject({ id: "cursor", strong: true });
    expect(detectInvoker({ AGENT: "goose", GOOSE_TERMINAL: "1" })).toMatchObject({ id: "goose" });
  });

  it("checks the imitators before the originals", () => {
    // Amp sets CLAUDECODE; Kilo sets OPENCODE; Qwen Code descends from Gemini CLI.
    expect(detectInvoker({ AMP_CURRENT_THREAD_ID: "T", CLAUDECODE: "1" }).id).toBe("amp");
    expect(detectInvoker({ KILO: "1", OPENCODE: "1", AGENT: "1" }).id).toBe("kilo");
    expect(detectInvoker({ QWEN_CODE: "1", GEMINI_CLI: "1" }).id).toBe("qwen");
  });

  it("reads AI_AGENT in both of its spellings", () => {
    expect(aiAgentName("claude-code_2-1-281_agent")).toBe("claude-code");
    expect(aiAgentName("crush@0.9.0")).toBe("crush");
    expect(detectInvoker({ AI_AGENT: "claude-code_2-1-281_agent" })).toMatchObject({ id: "claude", strong: true });
  });

  it("is null for a plain terminal, and ignores Cursor's everywhere-variable", () => {
    expect(detectInvoker({ PATH: "/bin", TERM: "xterm" })).toBeNull();
    expect(detectInvoker({ CURSOR_TRACE_ID: "abc" })).toBeNull();
    expect(detectInvoker({ CLAUDECODE: "0" })).toBeNull();
  });
});
