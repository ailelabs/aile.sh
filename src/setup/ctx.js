/**
 * The machine `aile setup` is configuring, as one object.
 *
 * Every tool writer takes this instead of reaching for `os.homedir()` or
 * `process.env` itself, for one reason: a test must be able to hand in a scratch
 * home, a scratch PATH and a platform, and be certain that nothing it runs can
 * touch the real `~/.claude` of whoever is running the suite. Reading the
 * environment in one place is what makes that a property of the code rather
 * than a hope.
 */

import os from "node:os";
import path from "node:path";

/**
 * Read an environment variable the way the platform does.
 *
 * Windows environment names are case-insensitive — `Path` and `PATH` are the
 * same variable, and which spelling a process inherits depends on who started
 * it. `process.env` hides that, but a plain object handed in by a caller (or a
 * test) does not, so the lookup is done by hand.
 */
export function envGet(env, name, platform = process.platform) {
  if (env[name] !== undefined) return env[name];
  if (platform !== "win32") return undefined;
  const want = name.toLowerCase();
  for (const k of Object.keys(env)) if (k.toLowerCase() === want) return env[k];
  return undefined;
}

/** `https://api.aile.sh/` → `https://api.aile.sh` — every base below is built from this. */
export function trimServer(serverUrl) {
  return String(serverUrl || "https://api.aile.sh").replace(/\/+$/, "");
}

/**
 * The two base URLs a tool is given, and why there are two.
 *
 * Anthropic-format clients (Claude Code, the Anthropic SDK, Factory's
 * `anthropic` provider) append `/v1/messages` themselves, so they take the bare
 * origin. OpenAI-format clients append `/chat/completions` or `/responses` to a
 * base that already ends in `/v1`. Getting it the wrong way round is a 404 that
 * looks like an outage, which is why nothing below builds either by hand.
 */
export function bases(serverUrl) {
  const origin = trimServer(serverUrl);
  return { serverUrl: origin, anthropicBase: origin, openaiBase: `${origin}/v1` };
}

/**
 * The website that belongs to a server — the dashboard, the funding page.
 * `api.aile.sh` → `aile.sh`, `api.dev.aile.sh` → `dev.aile.sh`; anything else is
 * left as it is, because a self-hosted relay serves its own pages.
 */
export function webOrigin(serverUrl) {
  try {
    const u = new URL(trimServer(serverUrl));
    u.hostname = u.hostname.replace(/^api\./, "");
    return u.origin;
  } catch {
    return "https://aile.sh";
  }
}

export function makeCtx({ env = process.env, platform = process.platform, home = null, serverUrl } = {}) {
  const h = home || os.homedir();
  const p = platform === "win32" ? path.win32 : path.posix;
  const get = (name) => envGet(env, name, platform);
  const appData = get("APPDATA") || p.join(h, "AppData", "Roaming");
  const localAppData = get("LOCALAPPDATA") || p.join(h, "AppData", "Local");
  return {
    env, platform, home: h, path: p, get,
    ...bases(serverUrl),
    web: webOrigin(serverUrl),
    // Windows-only locations; harmless strings elsewhere, never used there.
    appData,
    localAppData,
    // XDG locations. Several of these tools use them on EVERY platform —
    // opencode keeps `~/.config/opencode` on Windows too — so they are not gated.
    xdgConfig: get("XDG_CONFIG_HOME") || p.join(h, ".config"),
    xdgData: get("XDG_DATA_HOME") || p.join(h, ".local", "share"),
  };
}
