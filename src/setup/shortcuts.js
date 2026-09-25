/**
 * Shortcuts: `claudeaile`, `codexaile`, … — a tool, started through aile.
 *
 * THE NON-INVASIVE OPTION. `claude` keeps its owner's own login and settings;
 * `claudeaile` is the same program with aile's address and key in its
 * environment. Nothing in the tool's own configuration is touched, so there is
 * nothing to undo in it either.
 *
 * A shortcut is a small script, not a link to `aile`: it sets the environment
 * from `runners.js` and hands over to the tool. So it keeps working after an
 * `npx aile.sh setup` whose package cache has since been cleared, and it starts
 * as fast as the tool itself.
 *
 * WHERE IT GOES is the first directory that is already on PATH and ours to
 * write, so the command works in a new terminal with no shell edits:
 *
 *   macOS/Linux  ~/.local/bin, ~/bin, /opt/homebrew/bin, /usr/local/bin
 *   Windows      %APPDATA%\npm (npm's own global bin, on PATH wherever Node
 *                was installed normally), then %LOCALAPPDATA%\Microsoft\WindowsApps
 *                (on PATH by default on Windows 10 and 11)
 *
 * WHAT IS WRITTEN on Windows is a `.cmd` (cmd.exe and PowerShell both run it)
 * plus an extensionless `sh` script for Git Bash, which does not look at
 * PATHEXT. No `.ps1`: under the default Restricted execution policy PowerShell
 * prefers a `.ps1` and then refuses to run it, which would break the `.cmd` that
 * works.
 *
 * The key is in the script, so the script is private (0700) — the same trust as
 * the tool's own settings file, which would otherwise hold it.
 */

import fs from "node:fs";
import { pathDirs } from "./exec.js";
import { writeText } from "./files.js";

export function shortcutName(tool, custom = null) {
  return custom || `${tool}aile`;
}

/** Is `name` a sane command name? Refuses anything that could escape its directory. */
export function validShortcutName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(name));
}

const norm = (ctx, d) => {
  const n = ctx.path.normalize(String(d)).replace(/[\\/]+$/, "");
  return ctx.platform === "win32" ? n.toLowerCase() : n;
};

function writable(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; }
}

function parentWritable(dir, ctx) {
  let cur = ctx.path.dirname(dir);
  for (let i = 0; i < 6 && cur; i++) {
    try {
      if (fs.statSync(cur).isDirectory()) return writable(cur);
    } catch { /* keep walking up */ }
    const up = ctx.path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return false;
}

export function binCandidates(ctx) {
  const j = ctx.path.join;
  return ctx.platform === "win32"
    ? [j(ctx.appData, "npm"), j(ctx.localAppData, "Microsoft", "WindowsApps")]
    : [j(ctx.home, ".local", "bin"), j(ctx.home, "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
}

/**
 * Where shortcuts go: `{dir, onPath}`. A candidate that is on PATH but does not
 * exist yet is created (npm's bin directory is on PATH from the moment Node is
 * installed, before anything was ever installed into it). With none usable, the
 * fallback is created and the caller says how to put it on PATH.
 */
export function chooseBinDir(ctx) {
  const onPath = new Set(pathDirs({ env: ctx.env, platform: ctx.platform }).map((d) => norm(ctx, d)));
  for (const dir of binCandidates(ctx)) {
    if (!onPath.has(norm(ctx, dir))) continue;
    let exists = false;
    try { exists = fs.statSync(dir).isDirectory(); } catch { /* absent */ }
    if (exists ? writable(dir) : parentWritable(dir, ctx)) return { dir, onPath: true };
  }
  const fallback = ctx.platform === "win32"
    ? ctx.path.join(ctx.localAppData, "aile", "bin")
    : ctx.path.join(ctx.home, ".local", "bin");
  return { dir: fallback, onPath: false };
}

const shQuote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
// cmd.exe: `set "NAME=value"` needs only `%` doubled; the quotes keep & | < >
// literal. None of our values carry `"`.
const cmdValue = (v) => String(v).replace(/%/g, "%%");
// Arguments are all ours (no user text) and carry no spaces or quotes, so
// they need no quoting in either shell; this guards that assumption.
const plainArg = (a) => {
  if (!/^[A-Za-z0-9_./:=@+-]+$/.test(a)) throw new Error(`shortcut argument needs quoting: ${a}`);
  return a;
};

/**
 * The tool as a shortcut names it: the bare command when it is on PATH, else
 * its full path — found by detect.js at a known install location — quoted for
 * the shell. In sh on Windows (Git Bash) a path is written with forward
 * slashes, which it reads as the same file.
 */
const shBin = (bin) => (/[\\/\s]/.test(bin) ? shQuote(bin.replace(/\\/g, "/")) : bin);
const cmdBin = (bin) => (/[\\/\s]/.test(bin) ? `"${bin}"` : bin);

export function shScript(name, rec, { tool }) {
  const lines = [
    "#!/bin/sh",
    `# ${name}: ${rec.label} through aile (https://aile.sh).`,
    `# Written by \`aile setup\`. Remove it with: aile setup --remove ${tool}`,
    ...Object.entries(rec.env).map(([k, v]) => `export ${k}=${shQuote(v)}`),
    ...rec.unset.map((k) => `unset ${k}`),
    `exec ${shBin(rec.bin)}${rec.args.map((a) => ` ${plainArg(a)}`).join("")} "$@"`,
  ];
  return `${lines.join("\n")}\n`;
}

export function cmdScript(name, rec, { tool }) {
  const lines = [
    "@echo off",
    `rem ${name}: ${rec.label} through aile (https://aile.sh).`,
    `rem Written by "aile setup". Remove it with: aile setup --remove ${tool}`,
    "setlocal",
    ...Object.entries(rec.env).map(([k, v]) => `set "${k}=${cmdValue(v)}"`),
    ...rec.unset.map((k) => `set "${k}="`),
    // Last line, no `call`: control passes to the tool (often itself a .cmd)
    // and its exit code becomes ours.
    `${cmdBin(rec.bin)}${rec.args.map((a) => ` ${plainArg(a)}`).join("")} %*`,
  ];
  return `${lines.join("\r\n")}\r\n`;
}

/** The files a shortcut consists of on this platform: `[{file, text, mode}]`. */
export function shortcutFiles(ctx, dir, name, rec, { tool }) {
  const j = ctx.path.join;
  if (ctx.platform === "win32") {
    return [
      { file: j(dir, `${name}.cmd`), text: cmdScript(name, rec, { tool }), mode: null },
      { file: j(dir, name), text: shScript(name, rec, { tool }), mode: null },
    ];
  }
  return [{ file: j(dir, name), text: shScript(name, rec, { tool }), mode: 0o700 }];
}

/**
 * Would writing these files clobber something that is not ours? A file already
 * there that does not carry our header is somebody else's command.
 */
export function foreignShortcut(files) {
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f.file, "utf8"); } catch { continue; }
    if (!/Written by .aile setup./.test(text)) return f.file;
  }
  return null;
}

export function installShortcut(files) {
  for (const f of files) {
    writeText(f.file, f.text, { mode: f.mode });
  }
  return files.map((f) => f.file);
}

export function removeShortcut(paths) {
  const gone = [];
  for (const p of paths || []) {
    try {
      const text = fs.readFileSync(p, "utf8");
      // Only a file we wrote. If something else has taken the name since, it
      // is not ours to delete.
      if (!/Written by .aile setup./.test(text)) continue;
      fs.unlinkSync(p);
      gone.push(p);
    } catch { /* already gone */ }
  }
  return gone;
}

/**
 * The one line that puts a directory on PATH for this user, per shell. Printed
 * rather than run: a shell profile is the user's, and editing it silently is
 * the kind of change that is found months later and never explained.
 */
export function pathHint(ctx, dir) {
  if (ctx.platform === "win32") {
    return `[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path","User") + ";${dir}", "User")`;
  }
  const shell = String(ctx.get("SHELL") || "");
  if (/fish$/.test(shell)) return `fish_add_path ${dir}`;
  const rc = /zsh$/.test(shell) ? "~/.zshrc" : ctx.platform === "darwin" ? "~/.bash_profile" : "~/.bashrc";
  return `echo 'export PATH="${dir}:$PATH"' >> ${rc}`;
}
