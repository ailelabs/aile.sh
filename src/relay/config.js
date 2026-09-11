/**
 * aile.sh's config file.
 *
 * Note what is absent: provider credentials. Those are held server-side, so this
 * file holds only the account token and preferences. Losing it costs the user a
 * re-login, not an account.
 *
 * The shape of every setting — its type, default, bounds and whether it may be
 * written at all — lives in `src/config/settings.js`. This module is only the
 * disk half: read, merge, write. Keeping the two apart is what lets the settings
 * surface be tested without touching a filesystem.
 */

import fs from "node:fs";
import path from "node:path";
import { AILE_DIR } from "./paths.js";
import { ensureRelayDir } from "./state.js";
import { merge, validatePatch, pruneToOverrides, defaults, isRetiredServerUrl } from "../config/settings.js";

const CONFIG_FILE = path.join(AILE_DIR, "config.json");

function readFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};   // first run, or a corrupt file → defaults, never a crash
  }
}

/**
 * Drop overrides that can no longer work, so the current default applies.
 *
 * ON READ, NOT ON WRITE, because the whole problem is an install that never
 * writes again: a machine that signed in months ago and has been running `aile
 * start` ever since would keep dialling a dead address until someone thought to
 * run a settings command. Applying it here means the very next command is correct.
 *
 * SILENT, DELIBERATELY. This runs inside `loadConfig`, which is called by every
 * command including the `--json` ones — a friendly notice on stdout there would
 * land inside the payload and break whatever is parsing it. `aile status` already
 * prints the effective server URL and lists overridden keys, so the change is
 * visible where someone would look for it, and `storedOverrides()` stops reporting
 * a key this no longer honours.
 *
 * `allowInsecure` GOES WITH IT, and that is not overreach: the only reason to have
 * turned it on was the plain-HTTP staging address being retired here. Leaving it
 * set would mean a future typo'd `http://` URL is accepted without a word, which is
 * the failure the flag exists to prevent. It is only cleared alongside a retired
 * URL, never on its own.
 *
 * The token is never touched. This repoints a machine; it does not sign it out.
 */
function migrate(raw) {
  if (!isRetiredServerUrl(raw.serverUrl)) return raw;
  const { serverUrl, allowInsecure, ...rest } = raw;
  return rest;
}

function readRaw() {
  return migrate(readFile());
}

/** Full effective settings: stored overrides merged over current defaults. */
export function loadConfig() {
  return merge(readRaw());
}

/**
 * Write a patch.
 *
 * Unvalidated by default because the callers that use it — `aile login`,
 * `aile logout`, `aile register` — set the account token, which the settings
 * surface deliberately refuses. `updateSettings` is the checked path for
 * anything a user types.
 */
export function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  writeAll(next);
  return next;
}

/**
 * Checked write for user input: rejects unknown keys, out-of-range values, and
 * any attempt to reach a protected key. Returns the same `{ok}` shape as
 * validatePatch so a caller can report the reason rather than a generic failure.
 */
export function updateSettings(patch) {
  const checked = validatePatch(patch);
  if (!checked.ok) return checked;
  const next = { ...loadConfig(), ...checked.value };
  writeAll(next);
  return { ok: true, value: next, changed: Object.keys(checked.value) };
}

/** Restore one key, or every settable key, to its default. */
export function resetSettings(keys = null) {
  const stored = readRaw();
  const base = defaults();
  const targets = keys?.length ? keys : Object.keys(stored).filter((k) => k !== "renterToken");

  for (const key of targets) {
    if (key === "renterToken") continue;   // never wiped by a reset
    delete stored[key];
  }
  // Merge back through the schema so the file reflects a valid state.
  const next = merge(stored);
  writeAll(next);
  return { ok: true, value: next, reset: targets.filter((k) => k !== "renterToken"), defaults: base };
}

function writeAll(settings) {
  ensureRelayDir();
  const overrides = pruneToOverrides(settings);
  // Keep the token even though it equals no default — it is the one value the
  // file exists to persist.
  if (settings.renterToken) overrides.renterToken = settings.renterToken;

  // 0600 and write-then-rename: the token is a bearer credential, and a crash
  // mid-write must not leave a truncated file that reads as "signed out".
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(overrides, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
}

export function isLinked() {
  return Boolean(loadConfig().renterToken);
}

/** Which keys this install has actually overridden. */
export function storedOverrides() {
  return readRaw();
}

// Exported as a function, not a frozen object: `env`-backed defaults must be
// resolved when asked, not when this module first loaded.
export { CONFIG_FILE, defaults };
