/**
 * The settings schema.
 *
 * Two of these tests are guards rather than unit tests, and they are the reason
 * this file matters more than its size suggests:
 *
 *   - defaults() must read the environment on every call. A module-level const
 *     that captures process.env at import looks correct until something sets the
 *     variable after startup, and then serves a stale value forever.
 *   - no setting may be able to widen the egress allowlist or waive a transport
 *     check without the user saying so. A config surface is exactly how such a
 *     hole gets added by accident later.
 */

import { describe, expect, test } from "bun:test";
import {
  SCHEMA, GROUPS, defaults, coerce, merge, validatePatch,
  pruneToOverrides, displayValue, settableKeys, isKnownKey,
} from "../src/config/settings.js";

describe("schema shape", () => {
  test("every setting is complete and lands in a real group", () => {
    for (const [key, spec] of Object.entries(SCHEMA)) {
      expect({ key, hasType: Boolean(spec.type) }).toEqual({ key, hasType: true });
      expect({ key, hasDefault: spec.default !== undefined }).toEqual({ key, hasDefault: true });
      expect({ key, hasDescribe: Boolean(spec.describe) }).toEqual({ key, hasDescribe: true });
      expect({ key, group: GROUPS.includes(spec.group) }).toEqual({ key, group: true });
    }
  });

  test("every default validates against its own rules", () => {
    // A default outside its own min/max would be unreachable: the user could
    // never set it back after changing it.
    for (const [key, spec] of Object.entries(SCHEMA)) {
      if (spec.default === "") continue;   // empty token
      expect(() => coerce(key, spec.default)).not.toThrow();
    }
  });

  test("defaults satisfy the cross-field rules", () => {
    const d = defaults();
    expect(d.pongTimeoutMs).toBeGreaterThan(d.pingIntervalMs);
    expect(d.reconnectMaxMs).toBeGreaterThanOrEqual(d.reconnectMinMs);
  });
});

describe("defaults() reads the environment on every call", () => {
  test("a variable set after import is still picked up", () => {
    const original = process.env.AILE_SERVER_URL;
    try {
      delete process.env.AILE_SERVER_URL;
      expect(defaults().serverUrl).toBe("https://api.aile.sh");

      // The regression this guards: a frozen const would still say api.aile.sh.
      process.env.AILE_SERVER_URL = "https://staging.example.com";
      expect(defaults().serverUrl).toBe("https://staging.example.com");

      delete process.env.AILE_SERVER_URL;
      expect(defaults().serverUrl).toBe("https://api.aile.sh");
    } finally {
      if (original === undefined) delete process.env.AILE_SERVER_URL;
      else process.env.AILE_SERVER_URL = original;
    }
  });

  test("a malformed environment value falls back instead of throwing", () => {
    const original = process.env.AILE_SERVER_URL;
    try {
      process.env.AILE_SERVER_URL = "not-a-url";
      expect(defaults().serverUrl).toBe("https://api.aile.sh");
    } finally {
      if (original === undefined) delete process.env.AILE_SERVER_URL;
      else process.env.AILE_SERVER_URL = original;
    }
  });
});

describe("coerce", () => {
  test("parses booleans from the words people actually type", () => {
    for (const yes of [true, "true", "1", "yes", "on", "ON", " True "]) {
      expect(coerce("autoReconnect", yes)).toBe(true);
    }
    for (const no of [false, "false", "0", "no", "off", "OFF"]) {
      expect(coerce("autoReconnect", no)).toBe(false);
    }
    expect(() => coerce("autoReconnect", "maybe")).toThrow(/true or false/);
  });

  test("enforces integer bounds", () => {
    expect(coerce("maxConcurrent", "8")).toBe(8);
    expect(() => coerce("maxConcurrent", "0")).toThrow(/at least 1/);
    expect(() => coerce("maxConcurrent", "65")).toThrow(/at most 64/);
    expect(() => coerce("maxConcurrent", "4.5")).toThrow(/whole number/);
    expect(() => coerce("maxConcurrent", "eight")).toThrow(/whole number/);
  });

  test("requires a real http(s) URL and strips trailing slashes", () => {
    expect(coerce("serverUrl", "https://aile.sh/")).toBe("https://aile.sh");
    expect(coerce("serverUrl", "http://10.0.0.1:20443//")).toBe("http://10.0.0.1:20443");
    expect(() => coerce("serverUrl", "aile.sh")).toThrow(/must be a URL/);
    // A file:// or ws:// server URL would be nonsense the fetch layer would
    // fail on much later, with a worse message.
    expect(() => coerce("serverUrl", "file:///etc/passwd")).toThrow(/http:\/\/ or https:\/\//);
  });

  test("constrains enums", () => {
    expect(coerce("logLevel", "DEBUG")).toBe("debug");
    expect(() => coerce("logLevel", "verbose")).toThrow(/must be one of/);
  });

  test("rejects a key that is not in the schema", () => {
    expect(() => coerce("nope", "x")).toThrow(/unknown setting/);
  });
});

describe("merge", () => {
  test("stored values win over defaults", () => {
    expect(merge({ maxConcurrent: 16 }).maxConcurrent).toBe(16);
  });

  test("a missing key takes the current default", () => {
    expect(merge({}).logLevel).toBe(SCHEMA.logLevel.default);
  });

  test("a corrupt stored value falls back rather than bricking the CLI", () => {
    // The CLI that could fix a bad config must still start with a bad config.
    const merged = merge({ maxConcurrent: "banana", logLevel: "loud" });
    expect(merged.maxConcurrent).toBe(SCHEMA.maxConcurrent.default);
    expect(merged.logLevel).toBe(SCHEMA.logLevel.default);
  });

  test("a stored pair that breaks a cross-field rule reverts both", () => {
    const merged = merge({ pingIntervalMs: 60000, pongTimeoutMs: 30000 });
    expect(merged.pongTimeoutMs).toBeGreaterThan(merged.pingIntervalMs);
  });

  test("unknown keys survive a round trip", () => {
    // Config written by a newer version must not be truncated by an older one.
    expect(merge({ futureSetting: "keep me" }).futureSetting).toBe("keep me");
  });

  test("non-object input is handled", () => {
    for (const bad of [null, undefined, "string", 42, []]) {
      expect(merge(bad).maxConcurrent).toBe(SCHEMA.maxConcurrent.default);
    }
  });

  test("autoStart is carried forward to autoReconnect", () => {
    expect(merge({ autoStart: false }).autoReconnect).toBe(false);
    expect(merge({ autoStart: false }).autoStart).toBeUndefined();
    // An explicit new-key value is not overwritten by the old one.
    expect(merge({ autoStart: false, autoReconnect: true }).autoReconnect).toBe(true);
  });
});

describe("validatePatch — the write path is strict", () => {
  test("accepts and coerces a good patch", () => {
    const r = validatePatch({ maxConcurrent: "12", logLevel: "warn" });
    expect(r).toEqual({ ok: true, value: { maxConcurrent: 12, logLevel: "warn" } });
  });

  test("refuses an unknown key instead of silently storing it", () => {
    // A typo must be an error at the moment it is made, not a setting that
    // quietly never takes effect.
    const r = validatePatch({ maxConcurent: 8 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown setting/);
  });

  test("refuses to write a protected key", () => {
    const r = validatePatch({ renterToken: "stolen" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/managed by/);
  });

  test("the protected key is reachable only with an explicit opt-in", () => {
    expect(validatePatch({ renterToken: "t" }, { allowProtected: true }).ok).toBe(true);
  });

  test("refuses a patch that breaks a cross-field rule", () => {
    const r = validatePatch({ pongTimeoutMs: 15000 });   // below default ping of 30s
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/pongTimeoutMs/);
  });

  test("an empty patch is valid and changes nothing", () => {
    expect(validatePatch({})).toEqual({ ok: true, value: {} });
  });
});

describe("pruneToOverrides", () => {
  test("keeps only what differs from the default", () => {
    const pruned = pruneToOverrides({ ...defaults(), maxConcurrent: 9 });
    expect(pruned).toEqual({ maxConcurrent: 9 });
  });

  test("a value equal to the default is dropped, so a future default reaches the user", () => {
    expect(pruneToOverrides({ maxConcurrent: SCHEMA.maxConcurrent.default })).toEqual({});
  });

  test("unknown keys are preserved", () => {
    expect(pruneToOverrides({ futureSetting: 1 })).toEqual({ futureSetting: 1 });
  });
});

describe("display", () => {
  test("the token is never rendered in full", () => {
    const shown = displayValue("renterToken", "aile_live_supersecretvalue1234");
    expect(shown).not.toContain("supersecret");
    expect(shown).toBe("set (…1234)");
    expect(displayValue("renterToken", "")).toBe("not set");
  });
});

/**
 * `quoteMaxTokens` — AN ASSUMPTION FOR AN ESTIMATE, AND NOTHING ELSE.
 *
 * This is the only key on the buying side, and the risk it carries is unlike
 * every other key here. The server prices output at `max_tokens` FROM THE
 * REQUEST BODY — never a header, never a setting — so that the figure it quotes
 * is the ceiling the provider will actually enforce. A settings key that
 * silently altered outbound traffic would therefore change what a buyer asked
 * for in the one direction that changes their bill, and the relay is a byte pipe
 * that does not read bodies at all.
 *
 * So there are two things to hold: the bounds (an ordinary schema concern), and
 * the fact that the key's own description says out loud which of the two it is.
 * A user who could not tell from the description whether this number reached
 * their requests would be worse off than one who never had the setting.
 */
describe("quoteMaxTokens, the only key on the buying side", () => {
  test("matches the server's own default for a request that names no ceiling", () => {
    // 4096 is `DEFAULT_MAX_TOKENS` on the server. Agreeing with it is what makes
    // `aile price` correct for the common case rather than merely plausible.
    expect(SCHEMA.quoteMaxTokens.default).toBe(4096);
    expect(defaults().quoteMaxTokens).toBe(4096);
  });

  test("takes any ceiling a real model would accept, and refuses a non-count", () => {
    expect(coerce("quoteMaxTokens", "1024")).toBe(1024);
    expect(coerce("quoteMaxTokens", 200_000)).toBe(200_000);
    expect(() => coerce("quoteMaxTokens", "0")).toThrow(/at least 1/);
    expect(() => coerce("quoteMaxTokens", "-1")).toThrow(/at least 1/);
    expect(() => coerce("quoteMaxTokens", "2000000")).toThrow(/at most 1000000/);
    expect(() => coerce("quoteMaxTokens", "lots")).toThrow(/whole number/);
  });

  test("IS ORDINARILY SETTABLE — it is a preference, not a credential", () => {
    expect(SCHEMA.quoteMaxTokens.protected).toBeUndefined();
    expect(settableKeys()).toContain("quoteMaxTokens");
    expect(validatePatch({ quoteMaxTokens: 8192 })).toEqual({ ok: true, value: { quoteMaxTokens: 8192 } });
  });

  test("SAYS IN ITS OWN DESCRIPTION THAT IT IS NOT SENT", () => {
    // The whole hazard of this key in one assertion. Somebody reading
    // `aile config` must be able to tell that setting it cannot move their bill
    // — only what `aile price` guesses their bill would be.
    expect(SCHEMA.quoteMaxTokens.describe).toMatch(/not sent with any request/i);
    expect(SCHEMA.quoteMaxTokens.describe).toMatch(/estimate/i);
  });

  test("is not flagged dangerous, because it cannot reach the wire to be", () => {
    // The inverse guard: if this key ever DID alter traffic it would belong with
    // `allowInsecure`, and the test above would have to change too.
    expect(SCHEMA.quoteMaxTokens.dangerous).toBeUndefined();
  });
});

describe("security invariants", () => {
  test("the token is the only protected key, and it is not settable", () => {
    const locked = Object.keys(SCHEMA).filter((k) => SCHEMA[k].protected);
    expect(locked).toEqual(["renterToken"]);
    expect(settableKeys()).not.toContain("renterToken");
  });

  test("no setting can name a host, port, or allowlist entry", () => {
    // The egress allowlist is static data in the bundle precisely so that no
    // configuration can aim this node somewhere else. If a future setting needs
    // one of these names, that is a design conversation, not a test to update.
    const forbidden = /host|port|allow.*(host|target|egress)|provider.*host|proxy/i;
    const offenders = Object.keys(SCHEMA).filter((k) => forbidden.test(k));
    expect(offenders).toEqual([]);
  });

  test("anything that weakens a protection is flagged dangerous and defaults off", () => {
    expect(SCHEMA.allowInsecure.dangerous).toBe(true);
    expect(SCHEMA.allowInsecure.default).toBe(false);
    for (const [key, spec] of Object.entries(SCHEMA)) {
      if (spec.dangerous) {
        expect({ key, default: spec.default }).toEqual({ key, default: false });
      }
    }
  });

  test("isKnownKey does not treat inherited object properties as settings", () => {
    // Otherwise `aile config constructor x` would pass validation.
    for (const proto of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect({ proto, known: isKnownKey(proto) }).toEqual({ proto, known: false });
    }
  });
});
