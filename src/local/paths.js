/**
 * Where self-hosted models and engines live on disk.
 *
 * NOT IN THE CONFIG DIRECTORY ON WINDOWS. That one is `%APPDATA%` — Roaming —
 * which a domain profile copies to every machine the user signs in to. A 5 GB
 * model does not belong there, so Windows uses `%LOCALAPPDATA%\aile\local`.
 * Everywhere else it sits beside the config under `~/.aile/local`.
 *
 * Every path is resolved per call, never frozen at import, for the reason
 * `config/settings.js` gives: a test preload or a supervisor can set the
 * environment after this module loads.
 */

import os from "node:os";
import path from "node:path";
import { aileDataDir } from "../relay/paths.js";

/** The root for models and engines: the setting, else the platform default. */
export function localDir(config = {}) {
  if (config.localModelDir) return config.localModelDir;
  if (process.env.AILE_DATA_DIR) return path.join(process.env.AILE_DATA_DIR, "local");
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "aile", "local");
  }
  return path.join(os.homedir(), ".aile", "local");
}

export const modelsDir = (config) => path.join(localDir(config), "models");
export const enginesDir = (config) => path.join(localDir(config), "engines");
export const logsDir = (config) => path.join(localDir(config), "logs");

/**
 * The record of what aile installed. Beside the config rather than under
 * `localDir`, so moving `localModelDir` does not lose track of what is where.
 */
export const manifestFile = () => path.join(aileDataDir(), "local.json");

/** A repo id as one safe directory name: `bartowski/Foo-GGUF` → `bartowski__Foo-GGUF`. */
export function repoDirName(repo) {
  return String(repo).replace(/[\\/]+/g, "__").replace(/[^A-Za-z0-9._-]/g, "_");
}
