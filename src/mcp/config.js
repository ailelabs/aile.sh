/**
 * How a lender declares the MCP servers this machine will sell.
 *
 * SEPARATE FILE, ON PURPOSE. `src/config/settings.js` is a flat schema of
 * scalars — string, url, bool, int, enum — with `aile config <key> <value>` as
 * its only writer. An MCP server declaration is a nested record with an
 * argv array, an env map and a per-server egress list; expressing it through
 * that surface would mean either inventing an encoding for structure inside a
 * string (which no `coerce` case can validate) or widening the schema type
 * system for one feature. So this lives in its own file, `mcp-servers.json`,
 * and settings.js is left alone.
 *
 * THREE RULES HERE ARE SECURITY, NOT ERGONOMICS
 * ---------------------------------------------
 *
 *  1. **`mounts` / `volumes` / `binds` are REFUSED, not ignored.** The §5.2
 *     sandbox has no host filesystem at all: read-only root, tmpfs `/tmp`, no
 *     `$HOME`. A key that silently did nothing would let a lender believe they
 *     had mounted a project directory and had it work, and then wonder why the
 *     renter saw nothing; worse, a later version that started honouring the key
 *     would turn a stale config into a filesystem disclosure. Refusing at load
 *     time makes the boundary a fact rather than an omission.
 *
 *  2. **No syntax reads `process.env`.** Every env value is a literal from this
 *     file. There is deliberately no `${VAR}`, no `$VAR`, no `"inherit": true`
 *     and no passthrough list. The host environment of a node process holds the
 *     account token (`AILE_*`), whatever the user's shell exports, and on a
 *     developer machine usually a provider key or two — none of which the
 *     sandboxed child has any business seeing. A lender who wants their own key
 *     in the child writes it here, deliberately, in a file only they can read.
 *
 *  3. **Egress is per-server and closed by default.** `network` is `"none"`
 *     unless the lender names hosts, and naming hosts is the opt-in §5.2
 *     provides for. This file only records the list; `mcp/sandbox.js` is what
 *     turns it into `--network=none` or a restricted network.
 *
 * The file is OPTIONAL and its absence is not an error: a node that has never
 * heard of MCP advertises no MCP servers and behaves exactly as before.
 */

import fs from "node:fs";
import path from "node:path";
import { AILE_DIR } from "../relay/paths.js";
import { MCP_SERVER_ID_RE } from "../relay/framing.js";

export const MCP_CONFIG_FILE = path.join(AILE_DIR, "mcp-servers.json");

/** Keys that name a host path. Refused rather than ignored — see rule 1. */
const FORBIDDEN_KEYS = ["mounts", "volumes", "binds", "mount", "volume", "bind", "workdir", "user"];

/** Env var names. Same charset every shell and every container runtime agrees on. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A hostname a lender may open egress to. No scheme, no path, no port — the
 * value is a DNS name that a proxy or firewall rule is built from, and
 * accepting a URL here would invite `https://host/path` to read as if the path
 * were enforced when nothing enforces it.
 */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Bounds. Generous enough for a real agent, small enough that four cannot sink a laptop. */
export const LIMITS = {
  cpus: { min: 0.1, max: 8, default: 1 },
  memoryMb: { min: 128, max: 8192, default: 1024 },
  pids: { min: 16, max: 2048, default: 256 },
  // Wall clock for ONE session. The server's own MCP deadlines are shorter, so
  // this is the backstop for a child that ignores its stdin closing.
  timeoutMs: { min: 5000, max: 600000, default: 180000 },
};

function bounded(name, raw, spec, where) {
  if (raw === undefined || raw === null) return spec.default;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${where}: ${name} must be a number (got ${JSON.stringify(raw)})`);
  if (n < spec.min || n > spec.max) {
    throw new Error(`${where}: ${name} must be between ${spec.min} and ${spec.max} (got ${n})`);
  }
  return n;
}

/**
 * Validate one declaration into the shape the rest of the module uses.
 *
 * Exported so tests and `aile mcp check` can validate without a file on disk.
 * Throws with the offending server named — a config error a lender cannot
 * locate is a config error they cannot fix.
 */
export function normalizeServer(raw, index = 0) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`servers[${index}] must be an object`);
  }
  const id = raw.id;
  if (typeof id !== "string" || !MCP_SERVER_ID_RE.test(id)) {
    throw new Error(
      `servers[${index}]: id must match /^[a-z0-9][a-z0-9._-]{0,63}$/ (got ${JSON.stringify(id)})`,
    );
  }
  const where = `mcp server "${id}"`;

  for (const key of FORBIDDEN_KEYS) {
    if (key in raw) {
      throw new Error(
        `${where}: "${key}" is not supported and is refused rather than ignored — ` +
        `a rented MCP server runs with a read-only root, a tmpfs /tmp and no host ` +
        `filesystem at all. Nothing on this machine is reachable from it by design.`,
      );
    }
  }

  if (typeof raw.image !== "string" || !raw.image.trim()) {
    throw new Error(`${where}: image is required (the container image to run)`);
  }
  const image = raw.image.trim();

  let command = [];
  if (raw.command !== undefined) {
    if (!Array.isArray(raw.command) || raw.command.some((a) => typeof a !== "string")) {
      throw new Error(`${where}: command must be an array of strings, e.g. ["claude","mcp","serve"]`);
    }
    command = [...raw.command];
  }

  // Env: literal values only. See rule 2 — there is no syntax here that reads
  // the host environment, and a value that looks like one is refused so that a
  // lender learns it does not work rather than shipping a literal "$VAR".
  const env = {};
  if (raw.env !== undefined) {
    if (!raw.env || typeof raw.env !== "object" || Array.isArray(raw.env)) {
      throw new Error(`${where}: env must be an object of NAME: "value"`);
    }
    for (const [k, v] of Object.entries(raw.env)) {
      if (!ENV_NAME_RE.test(k)) throw new Error(`${where}: env name ${JSON.stringify(k)} is not a valid variable name`);
      if (typeof v !== "string") throw new Error(`${where}: env ${k} must be a string (values are literal)`);
      if (/\$\{?[A-Za-z_]/.test(v)) {
        throw new Error(
          `${where}: env ${k} looks like it expects the host environment to be substituted. ` +
          `It is not — values here are literal, deliberately: the node's own environment ` +
          `holds this machine's account token and is never handed to a rented child. ` +
          `Write the value itself. A value that genuinely contains a "$" followed by a ` +
          `letter is refused for the same reason: nothing here can tell the two apart, ` +
          `and guessing wrong ships a broken credential into a rented container.`,
        );
      }
      env[k] = v;
    }
  }

  // Egress. `"none"` (the default) or an explicit host list; nothing else.
  let egress = [];
  const net = raw.network === undefined ? "none" : raw.network;
  if (net !== "none") {
    if (!Array.isArray(net) || net.length === 0) {
      throw new Error(`${where}: network must be "none" or a non-empty array of hostnames`);
    }
    for (const host of net) {
      if (typeof host !== "string" || !HOSTNAME_RE.test(host)) {
        throw new Error(
          `${where}: network entry ${JSON.stringify(host)} must be a bare hostname ` +
          `(no scheme, no port, no path) — e.g. "api.anthropic.com"`,
        );
      }
      egress.push(host);
    }
  }

  return {
    id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id,
    enabled: raw.enabled !== false,
    image,
    command,
    env,
    egress,
    // A CLAIM, never evidence: the server rediscovers tools over a real MCP
    // session before anything is sold. Advertising them only makes a listing
    // legible before the first rent.
    tools: Array.isArray(raw.tools) ? raw.tools.filter((t) => typeof t === "string").slice(0, 64) : [],
    cpus: bounded("cpus", raw.cpus, LIMITS.cpus, where),
    memoryMb: bounded("memoryMb", raw.memoryMb, LIMITS.memoryMb, where),
    pids: bounded("pids", raw.pids, LIMITS.pids, where),
    timeoutMs: bounded("timeoutMs", raw.timeoutMs, LIMITS.timeoutMs, where),
  };
}

/**
 * Parse a whole config document.
 *
 * Accepts either `{ "servers": [...] }` or a bare array, because both are what
 * people write and neither is ambiguous.
 */
export function parseMcpConfig(doc) {
  if (doc === null || doc === undefined) return [];
  const list = Array.isArray(doc) ? doc : doc.servers;
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error("mcp-servers.json: `servers` must be an array");

  const seen = new Set();
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const server = normalizeServer(list[i], i);
    if (seen.has(server.id)) throw new Error(`mcp-servers.json: duplicate server id "${server.id}"`);
    seen.add(server.id);
    out.push(server);
  }
  return out;
}

/**
 * Read the file.
 *
 * A MISSING file is empty and silent; a MALFORMED one throws. The asymmetry is
 * deliberate: not declaring MCP servers is the normal state of a node, but a
 * file that exists and does not parse means a lender wrote something and it is
 * not doing what they think — advertising nothing while looking configured is
 * the worst of the three outcomes.
 */
export function loadMcpServers({ file = MCP_CONFIG_FILE } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return [];
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e.message}`);
  }
  return parseMcpConfig(doc);
}

/** The declarations this node would actually serve, in `hello` order. */
export function enabledMcpServers(opts = {}) {
  return loadMcpServers(opts).filter((s) => s.enabled);
}

/** One server by id, or null. The lookup MCP_OPEN resolves against. */
export function findMcpServer(id, opts = {}) {
  if (typeof id !== "string" || !MCP_SERVER_ID_RE.test(id)) return null;
  return enabledMcpServers(opts).find((s) => s.id === id) || null;
}
