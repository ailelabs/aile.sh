/**
 * "A newer aile.sh is out" — detection, notice, and the update itself.
 *
 * This is a client convenience, not a security boundary. The relay does not
 * trust the client's version and never will (see scripts/build.js) — a stale
 * node is a worse experience, not a hole. So everything here is best-effort and
 * fails silent: an offline machine, a blocked registry, or a parse error must
 * cost nothing and never delay a command.
 *
 * THREE RULES, mirrored from prompt.js's philosophy of never getting in the way:
 *
 *   NEVER BLOCK THE COMMAND. The notice is drawn from a cache file, read
 *   synchronously in microseconds. The network refresh that fills that cache
 *   runs in a DETACHED child that we `unref()` and forget — the parent exits
 *   without waiting on it, exactly as `npm` and `update-notifier` do. The first
 *   run after an update ships silent; the next run shows the notice.
 *
 *   THROTTLE ON THE CLOCK, NOT ON SUCCESS. The cache stamps `checkedAt` on every
 *   refresh attempt, success or failure. An offline machine therefore tries the
 *   registry at most once per {@link TTL_MS}, instead of spawning a doomed
 *   refresher on every single invocation.
 *
 *   RESPECT THE OFF SWITCH. `AILE_NO_UPDATE_CHECK`, the de-facto `NO_UPDATE_
 *   NOTIFIER`, and `CI` all silence this completely — no cache, no network, no
 *   notice. A checkout whose version could not be read (`0.0.0`) is treated the
 *   same, so `bun run` in this repo never nags a developer about "updating".
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { AILE_DIR } from "../relay/paths.js";
import { APP_VERSION } from "./version.js";
import { C } from "../cli/colors.js";
import { spawnPlan } from "../setup/exec.js";

/**
 * The published package. `bin.aile` → this CLI, so `-g` puts `aile` on PATH.
 *
 * A CONSTANT, AND IT MUST STAY ONE. Neither this nor {@link REGISTRY_URL} may ever
 * be read from a server response — not from the relay, not from anywhere. The
 * moment an update source is something a server names, a compromise of that server
 * becomes code execution on every lender's machine, and this client's whole posture
 * is that the server is not trusted with more than it needs. The trust anchor for
 * code distribution is npm, deliberately not our own infrastructure.
 */
const PACKAGE_NAME = "aile.sh";

/**
 * The dist-tags endpoint, not the full packument. It returns a tiny
 * `{ "latest": "x.y.z", … }` instead of every version's metadata — kinder to
 * the registry and to a metered connection, and all we need is `latest`.
 */
const REGISTRY_URL = `https://registry.npmjs.org/-/package/${PACKAGE_NAME}/dist-tags`;

/** Once a day. A node left running for a week does not poll the registry hourly. */
const TTL_MS = 24 * 60 * 60 * 1000;

/** A refresh that has not answered in this long is treated as offline. */
const FETCH_TIMEOUT_MS = 1500;

/** Where the last check is remembered, next to the node identity and lock. */
const CACHE_FILE = path.join(AILE_DIR, "update-check.json");

/** The hidden argv that a spawned refresher runs under (see index.js top). */
export const REFRESH_ARGV = "__update-refresh";

/**
 * Is the whole mechanism switched off for this process?
 *
 * `0.0.0` is the {@link version.js} fallback — the package.json could not be
 * read, which in practice means a build that has no business advertising
 * updates. `CI` is out because a pipeline neither reads nor acts on the notice,
 * and a surprise line on stdout there only corrupts captured output.
 */
export function updateCheckDisabled(env = process.env) {
  return Boolean(
    env.AILE_NO_UPDATE_CHECK ||
    env.NO_UPDATE_NOTIFIER ||
    env.CI ||
    !isSemver(APP_VERSION) ||
    APP_VERSION === "0.0.0",
  );
}

/** Plain `major.minor.patch`, the only shape npm publishes for this package. */
function isSemver(v) {
  return /^\d+\.\d+\.\d+/.test(String(v || ""));
}

/**
 * Is `latest` strictly newer than `current`? Numeric compare on the leading
 * three fields; a prerelease suffix (`-rc.1`) is ignored, because we only ever
 * nudge toward a published stable and comparing prerelease ordering is more
 * subtlety than this earns.
 */
export function isNewer(latest, current) {
  const parse = (v) => String(v).split(".").slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const a = parse(latest), b = parse(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

/** Read the cache, or null on anything unexpected. Never throws. */
function readCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf8");
    const c = JSON.parse(raw);
    if (c && typeof c.checkedAt === "number") return c;
  } catch { /* missing, unreadable, or corrupt — treat as no cache */ }
  return null;
}

/**
 * Stamp the cache. `checkedAt` is written on every attempt — including a failed
 * fetch, where `latest` stays whatever it was — so the TTL throttles retries
 * whether or not the registry answered.
 */
function writeCache(latest, prev) {
  try {
    fs.mkdirSync(AILE_DIR, { recursive: true });
    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify({ checkedAt: Date.now(), latest: latest ?? prev?.latest ?? null }),
    );
  } catch { /* a read-only home is not worth failing a command over */ }
}

/** Hit the registry for the `latest` dist-tag. Returns null on any failure. */
async function fetchLatest(timeoutMs = FETCH_TIMEOUT_MS) {
  try {
    const res = await fetch(REGISTRY_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const latest = json?.latest;
    return isSemver(latest) ? String(latest) : null;
  } catch { /* offline, DNS, timeout, non-JSON — all the same to us */ }
  return null;
}

/**
 * The body of the detached refresher. Fetches once, writes the cache, returns.
 * Called from index.js when argv is {@link REFRESH_ARGV}; also safe to await
 * directly (that is what `aile update` does for a fresh answer).
 */
export async function refreshCache({ timeoutMs } = {}) {
  if (updateCheckDisabled()) return null;
  const prev = readCache();
  // The background refresher keeps its 1.5 s: nobody is waiting on it. A person
  // who typed `aile update` is, and a slow registry is not "offline".
  const latest = await fetchLatest(timeoutMs);
  writeCache(latest, prev);
  return latest ?? prev?.latest ?? null;
}

/**
 * Fork a silent, detached child to refresh the cache and exit. We `unref()` it
 * so the parent's event loop does not wait on it — the refresh outlives the
 * command that triggered it and its result is read next time.
 *
 * `process.argv[1]` is this CLI's own entry (dist/cli.js installed, or
 * src/cli/index.js in a checkout); re-running it with the hidden argv reaches
 * the intercept at the top of index.js. Best-effort: a platform that refuses
 * the spawn just means the notice waits for a foreground refresh.
 */
function spawnDetachedRefresh() {
  try {
    const entry = process.argv[1];
    if (!entry) return;
    const child = spawn(process.execPath, [entry, REFRESH_ARGV], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {});   // ENOENT / EPERM — swallow
    child.unref();
  } catch { /* spawning is a nicety, not a requirement */ }
}

/**
 * The one call the CLI makes before dispatch. Returns `{ current, latest }` when
 * a newer version is known from cache, else null — and, as a side effect, kicks
 * off a background refresh whenever the cache is stale or missing so the answer
 * is ready next time. Pure cache read on the hot path; never awaits the network.
 */
export function pendingUpdate() {
  if (updateCheckDisabled()) return null;

  const cache = readCache();
  const stale = !cache || (Date.now() - cache.checkedAt) > TTL_MS;
  if (stale) spawnDetachedRefresh();

  // Show from whatever we last knew, even if that snapshot is now stale — a
  // stale "0.2.0 is out" is still true, and the refresh above corrects it.
  if (cache?.latest && isNewer(cache.latest, APP_VERSION)) {
    return { current: APP_VERSION, latest: cache.latest };
  }
  return null;
}

/**
 * A single dim line, drawn only when an update is actually pending. Called at
 * the top of a command so it sits above that command's output rather than
 * getting lost under it. Silent when up to date, offline, or opted out.
 *
 * It points at `aile update` rather than prompting inline: a command the user
 * typed should run, not be interrupted by a yes/no on every invocation. The
 * prompt lives in `aile update`, which is where someone who wants to act goes.
 */
export function printUpdateNotice() {
  const u = pendingUpdate();
  if (!u) return;
  console.log(
    `${C.dim}◆ aile.sh ${u.current} → ${C.reset}${C.green}${u.latest}${C.reset}` +
    `${C.dim} available · run ${C.reset}${C.cyan}aile update${C.reset}`,
  );
}

/**
 * Run the global install and resolve its exit code. stdio is inherited so npm's
 * own progress and errors reach the user unfiltered — this is the one place we
 * deliberately hand the terminal to another tool.
 *
 * INTEGRITY IS NPM'S, AND THAT IS THE POINT. This shells out rather than fetching
 * and unpacking anything itself, so the tarball is verified by npm against the
 * registry's own sha512 over TLS. A hand-rolled downloader here would be a second,
 * worse implementation of that — and the one place an open-source client absolutely
 * cannot afford a weaker check is the code path that replaces itself.
 *
 * PIN THE VERSION RATHER THAN RESOLVE `latest` AGAIN. The caller has already been
 * SHOWN a version ("0.1.0 → 0.2.0"); installing `@latest` asks the registry a second
 * time and can therefore install something else entirely — a newer publish, or a
 * tag moved between the two requests. Installing the exact version the user agreed
 * to is both more honest and one less moving part. `latest` remains the fallback for
 * a caller that genuinely has no version in hand.
 *
 * `--ignore-scripts` because this package has none, so it costs nothing — and it
 * removes arbitrary code execution from an install that runs unattended, at the one
 * moment the user has been told to expect churn on their terminal.
 */
export function runSelfUpdate({ tag = "latest" } = {}) {
  return new Promise((resolve) => {
    // npm is a batch file on Windows, and Node (since the 2024 batch-file fix)
    // refuses to spawn one without a shell — so this failed on every Windows
    // machine. spawnPlan runs it through cmd.exe with its arguments escaped.
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const plan = spawnPlan(npm, ["install", "-g", "--ignore-scripts", `${PACKAGE_NAME}@${tag}`]);
    let child;
    try {
      child = spawn(plan.command, plan.args, {
        stdio: "inherit",
        windowsHide: true,
        ...plan.options,
      });
    } catch {
      return resolve(1);
    }
    child.on("error", () => resolve(1));   // npm not on PATH
    child.on("close", (code) => resolve(code ?? 1));
  });
}
