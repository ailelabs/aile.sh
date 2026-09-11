/**
 * Settings for aile.sh.
 *
 * One schema is the only source of truth for defaults, types and bounds. The
 * file on disk holds **overrides only**, and every read merges them over the
 * defaults — so a key added in a later version is backward-compatible by
 * construction, and a default that changes reaches every user who never touched
 * that key.
 *
 * Three rules here are load-bearing rather than stylistic:
 *
 *   1. Defaults that read the environment are resolved on **every** read, never
 *      frozen into a module-level const. A const captured at first import looks
 *      correct until something sets the variable after startup — a test preload,
 *      a supervisor, a long-running process — and then silently serves a stale
 *      value.
 *   2. `protected` keys cannot be written through this surface at all. Mass
 *      assignment from a patch object is how credentials get clobbered by
 *      accident; the account token is written by `aile login` and by nothing
 *      else.
 *   3. Unknown keys are rejected on write and preserved on read. Rejecting
 *      catches typos at the moment they are made; preserving means a config
 *      written by a newer version survives a downgrade instead of being
 *      silently truncated.
 *
 * Nothing here can widen the egress allowlist. That list is static data compiled
 * into the bundle precisely so that no configuration — the server's, ours, or
 * the renter's own — can aim this node at a non-provider host. See
 * `relay/allowlist.js`, and the test that asserts it.
 */

/** @typedef {"string"|"url"|"bool"|"int"|"enum"} SettingType */

export const SCHEMA = {
  // --- Account ------------------------------------------------------------
  renterToken: {
    type: "string",
    default: "",
    group: "Account",
    secret: true,
    protected: true,
    describe: "bearer token for your aile.sh account (set by `aile login`)",
  },

  // --- Connection ---------------------------------------------------------
  serverUrl: {
    type: "url",
    // No port: the server listens on 443 and terminates its own TLS there. It
    // also still answers on 20443 for machines enrolled before the move, so an
    // existing config carrying that port keeps working — but a new install has
    // no reason to name a port, and plenty of networks only permit 443.
    default: "https://api.aile.sh",
    env: "AILE_SERVER_URL",
    group: "Connection",
    describe: "relay server this machine connects to",
  },
  allowInsecure: {
    type: "bool",
    default: false,
    group: "Connection",
    dangerous: true,
    describe: "permit plain http:// to the server (staging only)",
  },
  maxConcurrent: {
    type: "int",
    default: 4,
    min: 1,
    max: 64,
    group: "Connection",
    describe: "streams this machine will carry at once",
  },
  autoReconnect: {
    type: "bool",
    default: true,
    group: "Connection",
    describe: "reconnect on its own after the link drops",
  },
  reconnectMinMs: {
    type: "int",
    default: 1000,
    min: 250,
    max: 60000,
    group: "Connection",
    describe: "first backoff delay before a retry",
  },
  reconnectMaxMs: {
    type: "int",
    default: 60000,
    min: 1000,
    max: 3600000,
    group: "Connection",
    describe: "longest backoff delay between retries",
  },

  // --- Self-hosted model --------------------------------------------------
  // Lending your own running model rather than a subscription. Off by default:
  // this path cannot be blind (see localEndpoint), so it is never entered
  // without the owner explicitly asking for it.
  localEnabled: {
    type: "bool",
    default: false,
    group: "Self-hosted",
    describe: "also lend a model running on this machine",
  },
  localEndpoint: {
    type: "url",
    default: "",
    group: "Self-hosted",
    // Constrained to loopback/private in relay/local.js, and deliberately so.
    // A public value here would turn the node back into an open proxy — the
    // exact thing the egress allowlist exists to prevent.
    describe: "OpenAI-compatible base URL of your local model (loopback or LAN only)",
  },
  localModels: {
    type: "string",
    default: "",
    group: "Self-hosted",
    describe: "comma-separated model names to advertise (blank = ask the endpoint)",
  },

  // --- Streams ------------------------------------------------------------
  connectTimeoutMs: {
    type: "int",
    default: 15000,
    min: 1000,
    max: 120000,
    group: "Streams",
    describe: "give up opening a provider socket after this",
  },
  idleTimeoutMs: {
    type: "int",
    default: 300000,
    min: 10000,
    max: 3600000,
    group: "Streams",
    describe: "drop a provider socket that goes silent this long",
  },
  maxPendingBytes: {
    type: "int",
    default: 256 * 1024,
    min: 16 * 1024,
    max: 4 * 1024 * 1024,
    group: "Streams",
    describe: "bytes held for a stream whose DNS lookup is still in flight",
  },

  // --- Liveness -----------------------------------------------------------
  pingIntervalMs: {
    type: "int",
    default: 30000,
    min: 5000,
    max: 300000,
    group: "Liveness",
    describe: "how often this machine pings the server",
  },
  pongTimeoutMs: {
    type: "int",
    default: 90000,
    min: 15000,
    max: 900000,
    group: "Liveness",
    describe: "reconnect if no reply arrives within this",
  },

  // --- Requests -----------------------------------------------------------
  // The buying side. One key, and its whole job is to make `aile price` quote
  // the same request you are about to send.
  quoteMaxTokens: {
    type: "int",
    default: 4096,
    min: 1,
    max: 1000000,
    group: "Requests",
    /**
     * READ BY `aile price` AND SENT WITH NOTHING.
     *
     * The server prices output at `max_tokens` FROM THE REQUEST BODY — never a
     * header, never a setting — so that the figure it quotes is the ceiling the
     * provider will actually enforce. This client must not touch that number:
     * defaulting or rewriting `max_tokens` on the way past would change what a
     * buyer asked for, in the one direction that changes their bill, and the
     * relay is a byte pipe that does not read bodies at all.
     *
     * So this is an ASSUMPTION FOR AN ESTIMATE and nothing else. It matches the
     * server's own default for a request that names no ceiling (4096), which is
     * what makes the quote correct for the common case. The describe line says
     * "not sent with any request" out loud because a settings key that silently
     * altered traffic would be the exact bug the paragraph above rules out, and
     * a key whose description left the reader guessing which of the two it was
     * would be worse than not having it.
     */
    describe: "output tokens `aile price` assumes (an estimate only — not sent with any request)",
  },

  // --- Output -------------------------------------------------------------
  logLevel: {
    type: "enum",
    default: "info",
    values: ["silent", "error", "warn", "info", "debug"],
    group: "Output",
    describe: "how much this machine prints while running",
  },
};

export const GROUPS = ["Account", "Connection", "Self-hosted", "Streams", "Liveness", "Requests", "Output"];

/**
 * Hosts a stored `serverUrl` must no longer point at.
 *
 * WHY THIS EXISTS AT ALL, because a changed default looks like it should be
 * enough and is not: the file on disk holds OVERRIDES, so an install that ever
 * named the staging address keeps using it forever. Raising the default to
 * `https://api.aile.sh` reaches every new install and none of the existing ones.
 *
 * WHAT ACTUALLY BROKE, first time round. The deployment moved to 443 and now
 * terminates its own TLS on both ports, so `http://49.51.159.242:20443` no longer
 * completes a handshake — the socket is simply closed. The user-visible symptom is
 * `fetch failed` at the start of `aile login`, which reads as "the service is down"
 * when the service is healthy and only the address is stale.
 *
 * AND NOW `ai.aile.sh`. The relay moved to `api.aile.sh` on a new host, and the
 * `ai` DNS record is DELETED rather than repointed. So a stored `ai.aile.sh` does
 * not fail with a certificate error or a closed socket — it fails at name
 * resolution, `ENOTFOUND`, which reads as a broken network rather than a stale
 * config. Every node enrolled before the move carries it in its config file, so
 * without this entry they would all silently stop connecting.
 *
 * ONLY THIS DEPLOYMENT'S OWN ADDRESSES, matched by host and ignoring scheme and
 * port. Retiring "any IP address" would be tidier and wrong: someone running their
 * own box by IP is doing something legitimate, and silently repointing their node
 * at ours would be the worst possible reading of a config file. An address that can
 * never present a valid certificate for the real host is only *our* problem when it
 * is our host.
 */
export const RETIRED_SERVER_HOSTS = ["49.51.159.242", "ai.aile.sh"];

/**
 * Is this stored URL one that cannot work any more?
 *
 * Compares hosts, so `http://…:20443`, `https://…:20443` and `https://…` are all
 * caught — someone who met the plain-HTTP failure very likely tried https next,
 * and that fails differently (the certificate is for the hostname, not the IP)
 * while looking like the same outage.
 */
export function isRetiredServerUrl(value) {
  try {
    return RETIRED_SERVER_HOSTS.includes(new URL(String(value)).hostname);
  } catch {
    return false;
  }
}

/**
 * Cross-field rules. A single key can be individually valid and still combine
 * into a configuration that cannot work — a pong timeout below the ping
 * interval, for instance, makes the node tear down a healthy link on schedule.
 * Catching that at write time beats debugging a reconnect loop later.
 */
const CHECKS = [
  {
    test: (s) => s.pongTimeoutMs > s.pingIntervalMs,
    message: "pongTimeoutMs must be greater than pingIntervalMs, or the node will drop a healthy link every cycle",
  },
  {
    test: (s) => s.reconnectMaxMs >= s.reconnectMinMs,
    message: "reconnectMaxMs must be greater than or equal to reconnectMinMs",
  },
  {
    test: (s) => !s.localEnabled || Boolean(s.localEndpoint),
    message: "localEndpoint must be set before localEnabled can be turned on",
  },
];

/** Keys a user may write. */
export function settableKeys() {
  return Object.keys(SCHEMA).filter((k) => !SCHEMA[k].protected);
}

export function isKnownKey(key) {
  return Object.prototype.hasOwnProperty.call(SCHEMA, key);
}

/**
 * Fresh defaults, with `env` overrides resolved now rather than at import.
 * See rule 1 in the file header — this function existing is the whole point.
 */
export function defaults() {
  const out = {};
  for (const [key, spec] of Object.entries(SCHEMA)) {
    const fromEnv = spec.env ? process.env[spec.env] : undefined;
    if (fromEnv !== undefined && fromEnv !== "") {
      try {
        out[key] = coerce(key, fromEnv);
        continue;
      } catch {
        // A malformed environment variable must not make the app unusable;
        // fall through to the built-in default rather than throwing at import.
      }
    }
    out[key] = spec.default;
  }
  return out;
}

/** Parse one value into the schema's type. Throws with a usable message. */
export function coerce(key, raw) {
  const spec = SCHEMA[key];
  if (!spec) throw new Error(`unknown setting "${key}"`);

  switch (spec.type) {
    case "bool": {
      if (typeof raw === "boolean") return raw;
      const v = String(raw).trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(v)) return true;
      if (["false", "0", "no", "off"].includes(v)) return false;
      throw new Error(`${key} must be true or false (got "${raw}")`);
    }
    case "int": {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isInteger(n)) throw new Error(`${key} must be a whole number (got "${raw}")`);
      if (spec.min !== undefined && n < spec.min) throw new Error(`${key} must be at least ${spec.min}`);
      if (spec.max !== undefined && n > spec.max) throw new Error(`${key} must be at most ${spec.max}`);
      return n;
    }
    case "url": {
      const v = String(raw).trim().replace(/\/+$/, "");
      let parsed;
      try {
        parsed = new URL(v);
      } catch {
        throw new Error(`${key} must be a URL (got "${raw}")`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`${key} must be http:// or https:// (got "${parsed.protocol}")`);
      }
      return v;
    }
    case "enum": {
      const v = String(raw).trim().toLowerCase();
      if (!spec.values.includes(v)) {
        throw new Error(`${key} must be one of: ${spec.values.join(", ")} (got "${raw}")`);
      }
      return v;
    }
    default:
      return String(raw);
  }
}

/**
 * Merge stored overrides over the defaults.
 *
 * Values that fail validation are dropped in favour of the default rather than
 * thrown: a hand-edited or partially-written config file must not brick the CLI
 * that would let you fix it. Writes are validated strictly — see validatePatch.
 */
export function merge(stored) {
  const base = defaults();
  const raw = migrate(stored && typeof stored === "object" ? stored : {});
  const out = { ...base };

  for (const [key, value] of Object.entries(raw)) {
    if (!isKnownKey(key)) {
      out[key] = value; // preserved for downgrade safety; see rule 3
      continue;
    }
    try {
      out[key] = coerce(key, value);
    } catch {
      out[key] = base[key];
    }
  }

  // A stored pair that violates a cross-field rule falls back to both defaults,
  // for the same reason: an unusable file must still be fixable.
  for (const check of CHECKS) {
    if (!check.test(out)) return { ...out, ...pickCheckDefaults(check, base) };
  }
  return out;
}

function pickCheckDefaults(check, base) {
  const restored = {};
  for (const key of Object.keys(SCHEMA)) {
    if (check.message.includes(key)) restored[key] = base[key];
  }
  return restored;
}

/** Renames carried forward so an existing install keeps its settings. */
function migrate(stored) {
  const out = { ...stored };
  // autoStart described "keep the node running"; autoReconnect says what it
  // actually governs. Only carry it if the new key was never written.
  if (out.autoStart !== undefined) {
    if (out.autoReconnect === undefined) out.autoReconnect = out.autoStart;
    delete out.autoStart;
  }
  return out;
}

/**
 * Validate a patch before it is written.
 *
 * Strict where `merge` is lenient: unknown keys and protected keys are refused
 * outright, so a typo is a visible error rather than a setting that silently
 * never takes effect, and a patch object can never reach the account token.
 */
export function validatePatch(patch, { allowProtected = false } = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (!isKnownKey(key)) {
      return { ok: false, error: `unknown setting "${key}" — run \`aile config\` to list them` };
    }
    if (SCHEMA[key].protected && !allowProtected) {
      return { ok: false, error: `"${key}" cannot be set here (it is managed by \`aile login\`)` };
    }
    try {
      clean[key] = coerce(key, value);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  const combined = { ...merge({}), ...clean };
  for (const check of CHECKS) {
    if (!check.test(combined)) return { ok: false, error: check.message };
  }
  return { ok: true, value: clean };
}

/**
 * Strip values that equal the current default, so the file holds overrides only.
 * That is what lets a future default reach a user who never expressed an
 * opinion about the key.
 */
export function pruneToOverrides(settings) {
  const base = defaults();
  const out = {};
  for (const [key, value] of Object.entries(settings || {})) {
    if (!isKnownKey(key)) {
      out[key] = value;
      continue;
    }
    if (value !== base[key]) out[key] = value;
  }
  return out;
}

/** Display form of one value — secrets never render in full. */
export function displayValue(key, value) {
  const spec = SCHEMA[key];
  if (spec?.secret) {
    const s = String(value || "");
    return s ? `set (…${s.slice(-4)})` : "not set";
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}
