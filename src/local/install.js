/**
 * Installing an engine — only ever because the user asked, in a command they
 * typed, after being shown exactly what will run.
 *
 * Ollama goes through the platform's own installer (winget, Homebrew, or
 * Ollama's official script on Linux), run in the foreground with the
 * terminal attached so a password prompt or a licence screen reaches the
 * person it is meant for. llama.cpp is one pinned archive, checked against
 * its recorded sha256 and unpacked under aile's own directory: no system
 * changes, no administrator rights.
 *
 * `AILE_LOCAL_NO_INSTALL=1` refuses the Ollama install outright. The test
 * preload sets it, so no test can ever run a package manager.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { downloadFile } from "./download.js";
import { llamacppBase, OLLAMA_INSTALL_SCRIPT, OLLAMA_DOWNLOAD_PAGE } from "./sources.js";
import { LLAMACPP_PINS } from "./llamacpp-pins.js";
import { pickAsset, findServerBin } from "./llamacpp.js";
import { enginesDir } from "./paths.js";

export class InstallError extends Error {
  constructor(message) { super(message); this.name = "InstallError"; }
}

/** Is `cmd` on PATH? (No shell: `where`/`command -v` would need one.) */
export function onPath(cmd, { env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  const exts = platform === "win32" ? String(env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  for (const d of String(env.PATH || env.Path || "").split(path.delimiter).filter(Boolean)) {
    for (const e of exts) {
      if (exists(path.join(d, cmd + e.toLowerCase())) || exists(path.join(d, cmd + e))) return true;
    }
  }
  return false;
}

/**
 * How Ollama would be installed here, without running anything.
 * @returns {{ cmd: string, args: string[], display: string, note: string } | { manual: string, note: string }}
 */
export function ollamaInstallPlan({ platform = process.platform, has = (c) => onPath(c) } = {}) {
  if (platform === "win32") {
    if (has("winget")) {
      const args = ["install", "-e", "--id", "Ollama.Ollama", "--accept-source-agreements", "--accept-package-agreements"];
      return { cmd: "winget", args, display: `winget ${args.join(" ")}`, note: "Windows Package Manager" };
    }
    return { manual: `${OLLAMA_DOWNLOAD_PAGE}/windows`, note: "winget is not available here" };
  }
  if (platform === "darwin") {
    if (has("brew")) return { cmd: "brew", args: ["install", "ollama"], display: "brew install ollama", note: "Homebrew" };
    return { manual: `${OLLAMA_DOWNLOAD_PAGE}/mac`, note: "Homebrew is not installed" };
  }
  if (platform === "linux") {
    if (has("curl") && has("sh")) {
      const script = `curl -fsSL ${OLLAMA_INSTALL_SCRIPT} | sh`;
      return { cmd: "sh", args: ["-c", script], display: script, note: "Ollama's official script (asks for sudo)" };
    }
    return { manual: `${OLLAMA_DOWNLOAD_PAGE}/linux`, note: "curl is not installed" };
  }
  return { manual: OLLAMA_DOWNLOAD_PAGE, note: `no installer for ${platform}` };
}

/** Run an install plan in the foreground. Resolves to the exit status. */
export function runOllamaInstall(plan, { run = spawnSync } = {}) {
  if (process.env.AILE_LOCAL_NO_INSTALL === "1") throw new InstallError("installs are disabled here (AILE_LOCAL_NO_INSTALL=1)");
  if (!plan?.cmd) throw new InstallError("nothing to run");
  const r = run(plan.cmd, plan.args, { stdio: "inherit", windowsHide: false });
  if (r.error) throw new InstallError(`could not run ${plan.cmd}: ${r.error.message}`);
  return r.status ?? 1;
}

/**
 * Unpack `file` into `dir`. Windows' own bsdtar (System32) reads both .zip
 * and .tar.gz; it is called by absolute path because a Git-for-Windows `tar`
 * earlier on PATH reads `C:` as a remote host. Elsewhere `tar`, and `unzip`
 * for a zip on Linux.
 */
export function extractArchive(file, dir, { platform = process.platform, run = spawnSync, env = process.env } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const zip = /\.zip$/i.test(file);
  const attempts = [];
  if (platform === "win32") {
    const sysTar = path.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "tar.exe");
    attempts.push([sysTar, ["-xf", file, "-C", dir]]);
    if (zip) {
      const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
      attempts.push(["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath ${q(file)} -DestinationPath ${q(dir)} -Force`]]);
    }
  } else if (zip) {
    attempts.push(["unzip", ["-o", "-q", file, "-d", dir]], ["tar", ["-xf", file, "-C", dir]]);
  } else {
    attempts.push(["tar", ["-xzf", file, "-C", dir]]);
  }
  const errors = [];
  for (const [cmd, args] of attempts) {
    const r = run(cmd, args, { stdio: "pipe", windowsHide: true, encoding: "utf8" });
    if (!r.error && r.status === 0) return cmd;
    errors.push(`${path.basename(cmd)}: ${r.error?.message || String(r.stderr || "").trim().split("\n").pop() || `exit ${r.status}`}`);
  }
  throw new InstallError(`could not unpack ${path.basename(file)} (${errors.join("; ")})`);
}

/**
 * Download, verify and unpack the pinned llama.cpp build for `hw` (or the one
 * named by `accel`). Idempotent: a build already unpacked is reused.
 *
 * @returns {Promise<{ tag: string, key: string, dir: string, bin: string, accel: string, reused: boolean }>}
 */
export async function installLlamaCpp({
  hw, accel = null, config = {}, pins = LLAMACPP_PINS,
  onProgress = () => {}, signal, fetchImpl = fetch, extract = extractArchive,
}) {
  const pick = pickAsset(hw, { accel, pins });
  if (!pick) throw new InstallError(`no llama.cpp build for ${hw.platform}/${hw.arch}${accel ? ` with ${accel}` : ""}`);
  const root = path.join(enginesDir(config), "llama.cpp", pins.tag);
  const dir = path.join(root, pick.key);
  const existing = findServerBin(dir, hw.platform);
  if (existing) return { tag: pins.tag, key: pick.key, dir, bin: existing, accel: pick.accel, reused: true };

  const archives = [pick.asset, pick.asset.extra].filter(Boolean);
  const total = archives.reduce((n, a) => n + a.size, 0);
  let before = 0;
  for (const a of archives) {
    const dest = path.join(root, "downloads", a.file);
    await downloadFile({
      url: `${llamacppBase()}/${pins.tag}/${a.file}`, dest, size: a.size, sha256: a.sha256, signal, fetchImpl,
      onProgress: ({ phase, done }) => onProgress({ phase, done: before + done, total }),
    });
    before += a.size;
    extract(dest, dir, { platform: hw.platform });
    try { fs.unlinkSync(dest); } catch { /* keep going */ }
  }
  const bin = findServerBin(dir, hw.platform);
  if (!bin) throw new InstallError(`the ${pins.tag} archive has no llama-server in it`);
  if (hw.platform !== "win32") {
    try { fs.chmodSync(bin, 0o755); } catch { /* best effort */ }
  }
  return { tag: pins.tag, key: pick.key, dir, bin, accel: pick.accel, reused: false };
}
