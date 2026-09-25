/**
 * Which coding tools are installed on this machine, and where.
 *
 * "Is it on PATH?" is the wrong question on its own, and it was the only one
 * asked: most of these tools install themselves somewhere PATH may not reach
 * yet. Claude Code's native installer writes `~/.local/bin/claude`, which is
 * not on PATH on a stock macOS; opencode's script falls back to
 * `~/.opencode/bin`; Goose and Droid use `~/.local/bin`; a Python tool lands
 * wherever uv or pipx put it. And several "tools" are not commands at all:
 * Cursor, Windsurf and Zed are apps, and Cline, Roo, Kilo and Continue are
 * editor extensions that live inside VS Code, Cursor or Windsurf.
 *
 * So each tool lists every kind of sign it leaves, most specific first, and
 * detection reports the first that matches:
 *
 *   path       a command on PATH — runnable as typed
 *   location   the command at a known install location, off PATH — runnable by
 *              its full path, which is what a shortcut then uses
 *   app        an application bundle or install directory
 *   extension  an editor extension, with the editors it is in
 *   config     only the tool's config directory — installed once, maybe gone
 *
 * Sources for the locations (checked 2026-09-25): Claude Code's setup docs and
 * installer (~/.local/bin, ~/.claude/local), opencode's install script
 * (OPENCODE_INSTALL_DIR, XDG_BIN_DIR, ~/bin, ~/.opencode/bin), Goose's
 * download_cli.sh (GOOSE_BIN_DIR, default ~/.local/bin), Factory's quickstart
 * (~/.local/bin, ~/.factory/bin), Cursor's CLI docs (`agent`, ~/.local/bin),
 * the VS Code marketplace ids of each extension, and VS Code's extension
 * directory rules (VSCODE_EXTENSIONS, `.obsolete`); Kilo's settings docs, the
 * Devin Desktop FAQ (Windsurf's rename), Cursor's Windows installer, uv's
 * storage reference, and the GitHub Copilot CLI, Amp, Kiro, Warp, Augment and
 * Junie install docs. Cross-checked against the per-agent tables of
 * vercel-labs/skills and HarnessKit.
 *
 * Nothing here runs a tool except `probeVersion`, which is opt-in and bounded.
 */

import fs from "node:fs";
import { spawn } from "node:child_process";
import { which, spawnPlan, batchReparses } from "./exec.js";

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const list = (d) => { try { return fs.readdirSync(d); } catch { return []; } };

/**
 * Where user-level command-line tools commonly land, whether or not the
 * directory is on PATH: the installers' own defaults and the package
 * managers' global bins.
 */
export function userBinDirs(ctx) {
  const j = ctx.path.join;
  const h = ctx.home;
  const dirs = [
    j(h, ".local", "bin"),         // Claude Code, Goose, Droid, Cursor CLI, uv/pipx (aider)
    j(h, "bin"),
    j(h, ".bun", "bin"),
    j(h, ".volta", "bin"),
    j(h, ".npm-global", "bin"),
    j(h, ".cargo", "bin"),
    j(h, "go", "bin"),             // `go install` (crush)
  ];
  if (ctx.get("XDG_BIN_DIR")) dirs.unshift(ctx.get("XDG_BIN_DIR"));
  if (ctx.platform === "win32") {
    dirs.push(
      j(ctx.appData, "npm"),                                   // npm -g
      j(ctx.localAppData, "pnpm"),
      j(ctx.localAppData, "Microsoft", "WinGet", "Links"),     // winget
      j(h, "scoop", "shims"),
    );
  } else {
    dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin", j(h, ".local", "share", "pnpm"));
    // nvm keeps one global bin per installed Node; a tool installed under any
    // of them is still installed.
    const nvm = j(ctx.get("NVM_DIR") || j(h, ".nvm"), "versions", "node");
    for (const v of list(nvm)) dirs.push(j(nvm, v, "bin"));
  }
  return dirs;
}

/** The command in `dir`, with the platform's executable extensions. */
function inDir(ctx, dir, name) {
  const exts = ctx.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const e of exts) {
    const p = ctx.path.join(dir, name + e);
    if (isFile(p)) return p;
  }
  return null;
}

/** A command by name: on PATH first, then at any known location. */
export function findBin(ctx, names, extraDirs = []) {
  for (const n of names) {
    const hit = which(n, { env: ctx.env, platform: ctx.platform });
    if (hit) return { bin: hit, onPath: true };
  }
  const dirs = [...extraDirs, ...userBinDirs(ctx)];
  for (const n of names) {
    for (const d of dirs) {
      const hit = inDir(ctx, d, n);
      if (hit) return { bin: hit, onPath: false };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Editors and their extensions
// ---------------------------------------------------------------------------

/**
 * The editors that install VS Code extensions, and where each keeps them.
 * An extension folder is `<publisher>.<name>-<version>[-<platform>]`, lower
 * case; one listed in the directory's `.obsolete` file is uninstalled and only
 * waiting to be cleaned up.
 */
export function extensionDirs(ctx) {
  const j = ctx.path.join;
  const h = ctx.home;
  return [
    { host: "VS Code", dir: ctx.get("VSCODE_EXTENSIONS") || j(h, ".vscode", "extensions") },
    { host: "VS Code Insiders", dir: j(h, ".vscode-insiders", "extensions") },
    { host: "VSCodium", dir: j(h, ".vscode-oss", "extensions") },
    { host: "Cursor", dir: j(h, ".cursor", "extensions") },
    // Windsurf became Devin Desktop; its old folder stays readable.
    { host: "Devin Desktop", dir: j(h, ".devin", "extensions") },
    { host: "Windsurf", dir: j(h, ".windsurf", "extensions") },
    { host: "Kiro", dir: j(h, ".kiro", "extensions") },
    { host: "Trae", dir: j(h, ".trae", "extensions") },
  ];
}

function obsolete(dir) {
  try { return JSON.parse(fs.readFileSync(`${dir}/.obsolete`, "utf8")) || {}; } catch { return {}; }
}

/** Every editor holding any of these extension ids: `[{host, id, version}]`. */
export function findExtension(ctx, ids) {
  const want = ids.map((i) => i.toLowerCase());
  const out = [];
  for (const { host, dir } of extensionDirs(ctx)) {
    const gone = obsolete(dir);
    for (const name of list(dir)) {
      if (gone[name]) continue;
      const lower = name.toLowerCase();
      for (const id of want) {
        if (!lower.startsWith(`${id}-`)) continue;
        const rest = name.slice(id.length + 1);
        if (!/^\d/.test(rest)) continue;          // `…claude-dev-3.2.0`, not `…claude-dev-nightly`
        out.push({ host, id, version: rest.match(/^\d+(?:\.\d+)*/)[0] });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The signs each tool leaves
// ---------------------------------------------------------------------------

const j = (ctx, ...xs) => ctx.path.join(...xs);
const envDir = (ctx, name) => (ctx.get(name) ? ctx.path.resolve(ctx.get(name)) : null);

/**
 * Per tool:
 *   bins        command names, looked for on PATH and at every known location
 *   dirs        the tool's own install locations, beyond the shared ones
 *   guarded     `{names, dirs, owners}` — a command name too generic to trust
 *               (Cursor's `agent`; Grok ships one too), accepted only in
 *               `dirs` and only when its real path lies under one of `owners`
 *   apps        bundles or install directories, per platform
 *   extensions  VS Code marketplace ids
 *   config      things it creates on first run — directories, or a FILE where
 *               a bare directory is not evidence (another tool makes it too)
 *
 * Every override variable a tool documents for its own locations is honoured.
 */
export const SIGNS = {
  claude: {
    bins: ["claude"],
    dirs: (ctx) => [j(ctx, ctx.home, ".claude", "local")],
    config: (ctx) => [envDir(ctx, "CLAUDE_CONFIG_DIR") || j(ctx, ctx.home, ".claude")],
  },
  codex: {
    bins: ["codex"],
    // OpenAI's IDE extension shares ~/.codex/config.toml with the CLI.
    extensions: ["openai.chatgpt"],
    config: (ctx) => [envDir(ctx, "CODEX_HOME") || j(ctx, ctx.home, ".codex")],
  },
  opencode: {
    bins: ["opencode"],
    dirs: (ctx) => [ctx.get("OPENCODE_INSTALL_DIR"), j(ctx, ctx.home, ".opencode", "bin")].filter(Boolean),
    config: (ctx) => [j(ctx, ctx.xdgConfig, "opencode")],
  },
  kilo: {
    // An opencode fork. Its CLI, VS Code and JetBrains clients all read
    // ~/.config/kilo (on Windows too); ~/.kilocode is the older extension's.
    bins: ["kilo", "kilocode"],
    extensions: ["kilocode.kilo-code"],
    config: (ctx) => [j(ctx, ctx.home, ".config", "kilo"), j(ctx, ctx.home, ".kilocode")],
  },
  droid: {
    bins: ["droid"],
    dirs: (ctx) => [j(ctx, ctx.home, ".factory", "bin")],
    config: (ctx) => [j(ctx, ctx.home, ".factory")],
  },
  openclaw: {
    bins: ["openclaw"],
    // It was clawdbot, then moltbot; an old install keeps the old folder.
    config: (ctx) => [j(ctx, ctx.home, ".openclaw"), j(ctx, ctx.home, ".clawdbot"), j(ctx, ctx.home, ".moltbot")],
  },
  qwen: {
    bins: ["qwen"],
    config: (ctx) => [j(ctx, ctx.home, ".qwen")],
  },
  aider: {
    bins: ["aider"],
    // uv and pipx keep their tools beside the shims they put on PATH.
    dirs: (ctx) => [
      envDir(ctx, "UV_TOOL_BIN_DIR"),
      envDir(ctx, "UV_TOOL_DIR") && j(ctx, envDir(ctx, "UV_TOOL_DIR"), "aider-chat", ctx.platform === "win32" ? "Scripts" : "bin"),
      ctx.platform === "win32"
        ? j(ctx, ctx.appData, "uv", "data", "tools", "aider-chat", "Scripts")
        : j(ctx, ctx.xdgData, "uv", "tools", "aider-chat", "bin"),
      j(ctx, ctx.home, ".local", "pipx", "venvs", "aider-chat", ctx.platform === "win32" ? "Scripts" : "bin"),
    ].filter(Boolean),
    config: (ctx) => [j(ctx, ctx.home, ".aider.conf.yml")],
  },
  goose: {
    bins: ["goose"],
    dirs: (ctx) => [ctx.get("GOOSE_BIN_DIR")].filter(Boolean),
    apps: { darwin: ["/Applications/Goose.app"], win32: (ctx) => [j(ctx, ctx.localAppData, "Programs", "Goose")] },
    config: (ctx) => [ctx.platform === "win32" ? j(ctx, ctx.appData, "Block", "goose", "config") : j(ctx, ctx.xdgConfig, "goose")],
  },
  crush: {
    bins: ["crush"],
    config: (ctx) => [
      envDir(ctx, "CRUSH_GLOBAL_CONFIG"),
      ctx.platform === "win32" ? j(ctx, ctx.localAppData, "crush") : j(ctx, ctx.xdgConfig, "crush"),
    ].filter(Boolean),
  },
  gemini: {
    bins: ["gemini"],
    // Not the bare ~/.gemini: Antigravity creates ~/.gemini/antigravity, so
    // only Gemini CLI's own settings file says Gemini CLI was here.
    config: (ctx) => [j(ctx, ctx.home, ".gemini", "settings.json")],
  },
  cursor: {
    bins: ["cursor", "cursor-agent"],
    dirs: (ctx) => (ctx.platform === "win32" ? [j(ctx, ctx.localAppData, "cursor-agent")] : []),
    // The Cursor CLI is `agent`, symlinked from ~/.local/bin into its own
    // ~/.local/share/cursor-agent — and ~/.local/bin is shared, so the link is
    // only Cursor's if it resolves there.
    guarded: {
      names: ["agent"],
      dirs: (ctx) => [j(ctx, ctx.home, ".local", "bin"), j(ctx, ctx.localAppData, "cursor-agent")],
      owners: (ctx) => [j(ctx, ctx.home, ".local", "share", "cursor-agent"), j(ctx, ctx.localAppData, "cursor-agent")],
    },
    apps: {
      darwin: (ctx) => ["/Applications/Cursor.app", j(ctx, ctx.home, "Applications", "Cursor.app")],
      win32: (ctx) => [j(ctx, ctx.localAppData, "Programs", "cursor")],
      linux: (ctx) => ["/opt/cursor", "/usr/share/cursor", ...appImages(ctx, /^cursor.*\.appimage$/i)],
    },
    config: (ctx) => [j(ctx, ctx.home, ".cursor")],
  },
  windsurf: {
    // Windsurf is Devin Desktop now. Not `devin` or a bare ~/.devin: the Devin
    // CLI makes those too.
    bins: ["devin-desktop", "windsurf", "surf"],
    dirs: (ctx) => [j(ctx, ctx.home, ".codeium", "windsurf", "bin")],
    apps: {
      darwin: ["/Applications/Devin.app", "/Applications/Windsurf.app"],
      win32: (ctx) => [j(ctx, ctx.localAppData, "Programs", "Devin"), j(ctx, ctx.localAppData, "Programs", "Windsurf")],
      linux: ["/usr/share/windsurf", "/opt/windsurf", "/opt/devin"],
    },
    config: (ctx) => [j(ctx, ctx.home, ".codeium", "windsurf"), j(ctx, ctx.home, ".devin", "extensions")],
  },
  zed: {
    bins: ["zed", "zeditor"],
    apps: {
      darwin: ["/Applications/Zed.app"],
      win32: (ctx) => [j(ctx, ctx.localAppData, "Programs", "Zed")],
      linux: (ctx) => [j(ctx, ctx.home, ".local", "zed.app")],
    },
    config: (ctx) => [
      ctx.get("FLATPAK_XDG_CONFIG_HOME") && j(ctx, ctx.get("FLATPAK_XDG_CONFIG_HOME"), "zed"),
      ctx.platform === "win32" ? j(ctx, ctx.appData, "Zed") : j(ctx, ctx.xdgConfig, "zed"),
    ].filter(Boolean),
  },
  cline: {
    // Cline and Roo Code are configured the same way, so one entry covers
    // both; detection says which it found.
    bins: ["cline"],
    extensions: ["saoudrizwan.claude-dev", "rooveterinaryinc.roo-cline"],
    config: (ctx) => [envDir(ctx, "CLINE_DATA_DIR") || j(ctx, ctx.home, ".cline")],
  },
  continue: {
    bins: ["cn"],
    extensions: ["continue.continue"],
    config: (ctx) => [envDir(ctx, "CONTINUE_GLOBAL_DIR") || j(ctx, ctx.home, ".continue")],
  },
  vscode: {
    // The Claude Code extension. It shares ~/.claude/settings.json with the
    // CLI, and has its own settings for a gateway too.
    extensions: ["anthropic.claude-code"],
  },
  jetbrains: {
    // JetBrains AI Assistant takes an OpenAI-compatible provider; Junie is
    // JetBrains' agent CLI.
    bins: ["junie"],
    config: (ctx) => [j(ctx, ctx.home, ".junie"), j(ctx, ctx.xdgData, "junie")],
  },
  // --- Detected, but no custom endpoint to point at aile (yet) --------------
  copilot: {
    bins: ["copilot"],
    extensions: ["github.copilot", "github.copilot-chat"],
    config: (ctx) => [envDir(ctx, "COPILOT_HOME") || j(ctx, ctx.home, ".copilot")],
  },
  amp: {
    bins: ["amp"],
    dirs: (ctx) => [j(ctx, envDir(ctx, "AMP_HOME") || j(ctx, ctx.home, ".amp"), "bin"), j(ctx, ctx.home, ".bin")],
    config: (ctx) => [j(ctx, ctx.xdgConfig, "amp")],
  },
  kiro: {
    bins: ["kiro", "kiro-cli"],
    apps: {
      darwin: ["/Applications/Kiro.app", "/Applications/Kiro CLI.app"],
      win32: (ctx) => [j(ctx, ctx.localAppData, "Programs", "Kiro")],
    },
    config: (ctx) => [j(ctx, ctx.home, ".kiro")],
  },
  warp: {
    bins: ["warp-terminal", "warp"],
    apps: {
      darwin: ["/Applications/Warp.app"],
      win32: (ctx) => [j(ctx, ctx.localAppData, "Programs", "Warp")],
    },
  },
  augment: {
    bins: ["auggie"],
    config: (ctx) => [j(ctx, ctx.home, ".augment")],
  },
  trae: {
    bins: ["trae"],
    config: (ctx) => [j(ctx, ctx.home, ".trae"), j(ctx, ctx.home, ".trae-cn")],
  },
};

function appImages(ctx, re) {
  const out = [];
  for (const d of [j(ctx, ctx.home, "Applications"), j(ctx, ctx.home, ".local", "bin"), j(ctx, ctx.home, "Downloads")]) {
    for (const f of list(d)) if (re.test(f)) out.push(j(ctx, d, f));
  }
  return out;
}

const resolve = (ctx, v) => (typeof v === "function" ? v(ctx) : v || []);

const EXTENSION_NAMES = {
  "saoudrizwan.claude-dev": "Cline",
  "rooveterinaryinc.roo-cline": "Roo Code",
  "kilocode.kilo-code": "Kilo Code",
  "continue.continue": "Continue",
  "anthropic.claude-code": "Claude Code",
  "openai.chatgpt": "Codex",
  "github.copilot": "GitHub Copilot",
  "github.copilot-chat": "GitHub Copilot Chat",
};

/** A generic command name, accepted only where it really belongs to the tool. */
function findGuarded(ctx, g) {
  const owners = resolve(ctx, g.owners).map((o) => ctx.path.resolve(o).toLowerCase());
  for (const d of resolve(ctx, g.dirs)) {
    for (const n of g.names) {
      const p = inDir(ctx, d, n);
      if (!p) continue;
      let real = p;
      try { real = fs.realpathSync(p); } catch { /* keep p */ }
      const r = ctx.path.resolve(real).toLowerCase();
      if (owners.some((o) => r.startsWith(o))) return { bin: p, onPath: false };
    }
  }
  return null;
}

/**
 * What is installed for one tool:
 *
 *   { found, via, where, bin, onPath, extensions: [{host, id, name, version}] }
 *
 * `bin` is set when there is a command to run (on PATH or not); `onPath` says
 * whether it runs as typed. `extensions` lists every editor an extension was
 * found in, even when a command was found first.
 */
export function detectTool(ctx, id) {
  const s = SIGNS[id];
  const none = { found: false, via: null, where: null, bin: null, onPath: false, extensions: [] };
  if (!s) return none;

  const exts = s.extensions
    ? findExtension(ctx, s.extensions).map((e) => ({ ...e, name: EXTENSION_NAMES[e.id] || e.id }))
    : [];
  const cmd = (s.bins ? findBin(ctx, s.bins, resolve(ctx, s.dirs)) : null)
    || (s.guarded ? findGuarded(ctx, s.guarded) : null);
  if (cmd) return { found: true, via: cmd.onPath ? "path" : "location", where: cmd.bin, bin: cmd.bin, onPath: cmd.onPath, extensions: exts };

  const app = resolve(ctx, s.apps?.[ctx.platform]).find((p) => isDir(p) || isFile(p));
  if (app) return { ...none, found: true, via: "app", where: app, extensions: exts };

  if (exts.length) {
    return { ...none, found: true, via: "extension", where: [...new Set(exts.map((e) => `${e.name} in ${e.host}`))].join(", "), extensions: exts };
  }

  const cfg = resolve(ctx, s.config).find((p) => isDir(p) || isFile(p));
  if (cfg) return { ...none, found: true, via: "config", where: cfg };
  return none;
}

/**
 * `<bin> --version`, first version-looking token, or null. Bounded: a tool that
 * prompts, hangs or opens a window is killed after `timeoutMs` and reads as
 * unknown. Only ever called for a command found by `detectTool`.
 */
export function probeVersion(bin, { platform = process.platform, env = process.env, timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const reparses = platform === "win32" && /\.(cmd|bat)$/i.test(bin) ? batchReparses(bin) : null;
    const plan = spawnPlan(bin, ["--version"], { platform, env, reparses });
    let out = "";
    let child;
    try {
      child = spawn(plan.command, plan.args, { ...plan.options, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch {
      return resolve(null);
    }
    const done = (v) => { clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } done(null); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("error", () => done(null));
    child.on("close", () => {
      const m = out.match(/\b(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.]+)?)\b/);
      done(m ? m[1] : null);
    });
  });
}
