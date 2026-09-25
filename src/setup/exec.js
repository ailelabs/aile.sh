/**
 * Finding a tool on PATH, and starting it, on every platform.
 *
 * Both are harder on Windows than they look. A tool installed with npm is a
 * `.cmd` file there, not an executable: `spawn("codex")` finds nothing, and
 * spawning `codex.cmd` directly is refused by current Node (the CVE-2024-27980
 * fix) unless it goes through `cmd.exe` — which then re-parses every argument,
 * so a prompt containing `&` or `"` would be cut short or run as a second
 * command. `spawnTool` quotes for cmd.exe the way the well-known
 * cross-platform spawners do, so what the user typed is what the tool receives.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { envGet } from "./ctx.js";

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isExecutable(p, platform) {
  if (!isFile(p)) return false;
  if (platform === "win32") return true;
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

/** The directories on PATH, in order, empty entries dropped. */
export function pathDirs({ env = process.env, platform = process.platform } = {}) {
  const raw = envGet(env, "PATH", platform) || "";
  const sep = platform === "win32" ? ";" : ":";
  return raw.split(sep).map((d) => d.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
}

/** Absolute path of `name` on PATH, or null. Honours PATHEXT on Windows. */
export function which(name, { env = process.env, platform = process.platform } = {}) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const exts = platform === "win32"
    ? (envGet(env, "PATHEXT", platform) || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const hasExt = platform === "win32" && exts.some((e) => name.toLowerCase().endsWith(e.toLowerCase()));
  for (const dir of pathDirs({ env, platform })) {
    const candidates = hasExt ? [name] : exts.map((e) => name + e.toLowerCase());
    for (const c of candidates) {
      const full = p.join(dir, c);
      if (isExecutable(full, platform)) return full;
    }
  }
  return null;
}

// cmd.exe metacharacters. Escaped with `^` after the argument is quoted —
// the algorithm from https://qntm.org/cmd, as cross-spawn implements it.
const META = /([()\][%!^"`<>&|;, *?])/g;

export function cmdEscapeCommand(arg) {
  return String(arg).replace(META, "^$1");
}

export function cmdEscapeArg(arg, doubleEscape = false) {
  let a = String(arg);
  a = a.replace(/(?=(\\+?)?)\1"/g, "$1$1\\\"");
  a = a.replace(/(?=(\\+?)?)\1$/, "$1$1");
  a = `"${a}"`;
  a = a.replace(META, "^$1");
  if (doubleEscape) a = a.replace(META, "^$1");
  return a;
}

/**
 * The argv a spawn needs to run `file args…` faithfully. Separate from the spawn
 * itself so it can be tested on any platform.
 */
export function spawnPlan(file, args, { platform = process.platform, env = process.env, reparses = null } = {}) {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
    // A shim that forwards `%*` hands its arguments to cmd.exe a SECOND time,
    // so their metacharacters need escaping twice. Every npm shim does —
    // `%APPDATA%\npm\codex.cmd` as much as a node_modules/.bin one — which is
    // measured, not assumed: escaped once, `-c model="x & y"` ran `y` as a
    // command. The caller reads the file to know; unknown means assume it does.
    const dbl = reparses ?? true;
    const line = [cmdEscapeCommand(path.win32.normalize(file)), ...args.map((a) => cmdEscapeArg(a, dbl))].join(" ");
    return {
      command: envGet(env, "COMSPEC", platform) || "cmd.exe",
      args: ["/d", "/s", "/c", `"${line}"`],
      options: { windowsVerbatimArguments: true },
    };
  }
  return { command: file, args, options: {} };
}

/**
 * Run a tool in the foreground with the terminal handed straight to it, and
 * resolve with its exit code. Ctrl+C reaches the tool, not us: the signal goes
 * to the whole process group, and ignoring it here keeps us alive long enough
 * to pass the tool's own exit code on.
 */
/** Does this batch file forward its arguments with `%*` (and so re-parse them)? */
export function batchReparses(file) {
  try { return /%\*/.test(fs.readFileSync(file, "utf8")); } catch { return true; }
}

export function spawnTool(file, args, { env, platform = process.platform } = {}) {
  const reparses = platform === "win32" && /\.(cmd|bat)$/i.test(file) ? batchReparses(file) : null;
  const plan = spawnPlan(file, args, { platform, env, reparses });
  return new Promise((resolve) => {
    const child = spawn(plan.command, plan.args, { stdio: "inherit", env, ...plan.options });
    const ignore = () => {};
    process.on("SIGINT", ignore);
    child.on("error", (e) => {
      process.off("SIGINT", ignore);
      console.error(`Could not start ${file}: ${e.message}`);
      resolve(127);
    });
    child.on("exit", (code, signal) => {
      process.off("SIGINT", ignore);
      resolve(code ?? (signal ? 128 + 2 : 1));
    });
  });
}
