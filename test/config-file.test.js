/**
 * The config file on disk.
 *
 * Runs against the sandboxed data dir that test/setup.js provisions (see the
 * long comment there — the redirection must happen in the preload, not here, or
 * these tests would read and write the developer's real node data).
 *
 * The claims worth defending are about durability and blast radius: a write must
 * not be able to leave a half-file that reads as "signed out", a settings change
 * must not be able to touch the account token, and a reset must not log the user
 * out.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import fs from "node:fs";

const { AILE_DIR } = await import("../src/relay/paths.js");
const {
  loadConfig, saveConfig, updateSettings, resetSettings,
  storedOverrides, isLinked, CONFIG_FILE,
} = await import("../src/relay/config.js");
const { defaults } = await import("../src/config/settings.js");

function readFileRaw() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
}

beforeEach(() => {
  try { fs.unlinkSync(CONFIG_FILE); } catch { /* absent */ }
});

describe("sandbox", () => {
  test("is not the real data dir", () => {
    expect(process.env.AILE_DATA_DIR).toBeTruthy();
    expect(AILE_DIR).toContain("aile-test-");
    expect(CONFIG_FILE).toContain("aile-test-");
  });
});

describe("reading", () => {
  test("a missing file yields defaults, not a crash", () => {
    expect(fs.existsSync(CONFIG_FILE)).toBe(false);
    expect(loadConfig()).toEqual(defaults());
    expect(isLinked()).toBe(false);
  });

  test("a corrupt file yields defaults, not a crash", () => {
    // The CLI that would let you fix a broken config must survive it.
    fs.mkdirSync(AILE_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, "{ this is not json");
    expect(loadConfig().maxConcurrent).toBe(defaults().maxConcurrent);
  });

  test("a JSON array is not mistaken for a settings object", () => {
    fs.mkdirSync(AILE_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, "[1,2,3]");
    expect(loadConfig()).toEqual(defaults());
  });
});

/**
 * Retiring a stored server URL.
 *
 * THE FAILURE THIS FIXES WAS REPORTED FROM THE FIELD, and it is worth writing down
 * because the shape of it is easy to get wrong twice. The deployment moved to 443
 * and now terminates TLS on both ports, so `http://49.51.159.242:20443` stops
 * completing a handshake — the socket is closed, `fetch` reports "fetch failed",
 * and `aile login` tells the user the server could not be reached. The server was
 * healthy the whole time.
 *
 * Raising the default fixed nothing for the machines that had the problem: the file
 * holds OVERRIDES, so any install that ever named the staging address keeps using
 * it forever. The repair has to happen on READ, because the affected install is
 * precisely the one that never writes again — it signed in months ago and has been
 * running `aile start` ever since.
 */
describe("a retired server URL", () => {
  const RETIRED = "http://49.51.159.242:20443";

  test("is dropped on read, so the current default applies", () => {
    fs.mkdirSync(AILE_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ serverUrl: RETIRED, renterToken: "tok" }));

    expect(loadConfig().serverUrl).toBe(defaults().serverUrl);
    expect(loadConfig().serverUrl).toStartWith("https://");
  });

  test("does not sign the machine out", () => {
    // This repoints a node. Losing the token would turn a fixable address into a
    // re-login for every affected install.
    fs.mkdirSync(AILE_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ serverUrl: RETIRED, renterToken: "tok-keep" }));

    expect(loadConfig().renterToken).toBe("tok-keep");
    expect(isLinked()).toBe(true);
  });

  test("is caught whatever scheme or port it was stored with", () => {
    // Someone who met the plain-HTTP failure very likely tried https next, and
    // that fails differently — the certificate is for the hostname, not the IP —
    // while looking like the same outage.
    for (const url of [
      "http://49.51.159.242:20443",
      "https://49.51.159.242:20443",
      "https://49.51.159.242",
      "http://49.51.159.242",
    ]) {
      fs.mkdirSync(AILE_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify({ serverUrl: url }));
      expect({ url, effective: loadConfig().serverUrl }).toEqual({ url, effective: defaults().serverUrl });
    }
  });

  test("takes allowInsecure with it, since the reason for it is gone", () => {
    // Leaving it set would mean a future typo'd http:// URL is accepted without a
    // word — the failure the flag exists to prevent.
    fs.mkdirSync(AILE_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ serverUrl: RETIRED, allowInsecure: true }));

    expect(loadConfig().allowInsecure).toBe(false);
  });

  test("leaves allowInsecure alone when the URL is somebody else's box", () => {
    // Only cleared alongside a retired URL, never on its own: a developer pointing
    // at their own staging server has made a deliberate choice.
    fs.mkdirSync(AILE_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
      serverUrl: "http://192.168.1.50:20443", allowInsecure: true,
    }));

    expect(loadConfig().serverUrl).toBe("http://192.168.1.50:20443");
    expect(loadConfig().allowInsecure).toBe(true);
  });

  test("leaves every other override untouched", () => {
    fs.mkdirSync(AILE_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ serverUrl: RETIRED, maxConcurrent: 16 }));
    expect(loadConfig().maxConcurrent).toBe(16);
  });

  test("stops reporting it as an override, so status does not show a dead value", () => {
    fs.mkdirSync(AILE_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ serverUrl: RETIRED, maxConcurrent: 16 }));

    expect(Object.keys(storedOverrides()).sort()).toEqual(["maxConcurrent"]);
  });

  test("self-heals on the next write, rather than needing a repair command", () => {
    fs.mkdirSync(AILE_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ serverUrl: RETIRED, renterToken: "tok" }));

    saveConfig({ maxConcurrent: 8 });

    expect(readFileRaw().serverUrl).toBeUndefined();
    expect(readFileRaw().renterToken).toBe("tok");
  });

  test("prints nothing, because loadConfig runs inside --json commands", () => {
    // A friendly notice on stdout here would land inside the payload of every
    // `--json` command and break whatever is parsing it.
    fs.mkdirSync(AILE_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ serverUrl: RETIRED }));

    const said = [];
    const real = console.log;
    console.log = (...a) => said.push(a.join(" "));
    try { loadConfig(); } finally { console.log = real; }

    expect(said).toEqual([]);
  });
});

describe("writing", () => {
  test("stores overrides only, so future default changes still reach the user", () => {
    saveConfig({ renterToken: "tok-abc", maxConcurrent: 4 });   // 4 IS the default
    const onDisk = readFileRaw();
    expect(onDisk.maxConcurrent).toBeUndefined();
    expect(onDisk.renterToken).toBe("tok-abc");
  });

  test("a changed value is written", () => {
    saveConfig({ maxConcurrent: 16 });
    expect(readFileRaw().maxConcurrent).toBe(16);
    expect(loadConfig().maxConcurrent).toBe(16);
  });

  test("the file is 0600", () => {
    saveConfig({ renterToken: "tok" });
    const mode = fs.statSync(CONFIG_FILE).mode & 0o777;
    // Windows does not implement POSIX permission bits; assert where it means
    // something rather than assert something false everywhere.
    if (process.platform !== "win32") expect(mode).toBe(0o600);
    else expect(fs.existsSync(CONFIG_FILE)).toBe(true);
  });

  test("no .tmp file is left behind", () => {
    saveConfig({ maxConcurrent: 5 });
    expect(fs.existsSync(`${CONFIG_FILE}.tmp`)).toBe(false);
  });
});

describe("updateSettings — the checked path", () => {
  test("applies a valid change and reports what changed", () => {
    const r = updateSettings({ maxConcurrent: "12" });
    expect(r.ok).toBe(true);
    expect(r.changed).toEqual(["maxConcurrent"]);
    expect(loadConfig().maxConcurrent).toBe(12);
  });

  test("rejects a bad value and leaves the file untouched", () => {
    saveConfig({ maxConcurrent: 8 });
    const r = updateSettings({ maxConcurrent: "999" });
    expect(r.ok).toBe(false);
    expect(loadConfig().maxConcurrent).toBe(8);   // not partially applied
  });

  test("cannot reach the account token", () => {
    saveConfig({ renterToken: "real-token" });
    const r = updateSettings({ renterToken: "attacker-token" });
    expect(r.ok).toBe(false);
    expect(loadConfig().renterToken).toBe("real-token");
  });

  test("a patch mixing a valid key with the token changes nothing", () => {
    // All-or-nothing: a rejected key must not let its neighbours through.
    saveConfig({ renterToken: "real-token", maxConcurrent: 8 });
    const r = updateSettings({ maxConcurrent: 16, renterToken: "attacker" });
    expect(r.ok).toBe(false);
    const after = loadConfig();
    expect(after.renterToken).toBe("real-token");
    expect(after.maxConcurrent).toBe(8);
  });

  test("signing in is preserved across an unrelated settings change", () => {
    saveConfig({ renterToken: "tok-xyz" });
    updateSettings({ logLevel: "debug" });
    expect(loadConfig().renterToken).toBe("tok-xyz");
    expect(isLinked()).toBe(true);
  });
});

describe("resetSettings", () => {
  test("restores everything settable but keeps the sign-in", () => {
    saveConfig({ renterToken: "tok-keep", maxConcurrent: 32, logLevel: "debug" });
    const r = resetSettings();
    expect(r.ok).toBe(true);

    const after = loadConfig();
    expect(after.maxConcurrent).toBe(defaults().maxConcurrent);
    expect(after.logLevel).toBe(defaults().logLevel);
    expect(after.renterToken).toBe("tok-keep");   // a reset is not a logout
    expect(isLinked()).toBe(true);
  });

  test("resets only the named keys", () => {
    saveConfig({ maxConcurrent: 32, logLevel: "debug" });
    resetSettings(["logLevel"]);
    const after = loadConfig();
    expect(after.logLevel).toBe(defaults().logLevel);
    expect(after.maxConcurrent).toBe(32);
  });

  test("naming the token does not wipe it", () => {
    saveConfig({ renterToken: "tok-keep" });
    resetSettings(["renterToken"]);
    expect(loadConfig().renterToken).toBe("tok-keep");
  });
});

describe("storedOverrides", () => {
  test("reports what this install actually changed", () => {
    saveConfig({ maxConcurrent: 7 });
    expect(storedOverrides().maxConcurrent).toBe(7);
    expect(storedOverrides().logLevel).toBeUndefined();
  });
});
