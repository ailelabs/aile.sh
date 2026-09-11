/**
 * Connecting a provider by pasting an API key.
 *
 * WHAT IS ACTUALLY AT RISK. A key is a secret typed on a command line, and the
 * ways it leaks are all invisible when they happen:
 *
 *   - `--key sk-...` puts it in the process list, where anyone else on the box
 *     can read it with `ps`, and in shell history. It exists because scripts
 *     need it, and `--key -` exists so nobody has to use it.
 *   - a prompt that echoes puts it in scrollback, in a screen share, and in
 *     whatever the terminal logs.
 *   - a non-interactive run that reads stdin anyway hangs a cron job forever on
 *     a pipe nobody is writing to — no output, no exit, no clue why.
 *
 * And a key that uploads WITHOUT being checked becomes advertised capacity that
 * 401s on every buyer request: the lender was told it worked, the buyer sees
 * failures, and neither can see the other's half. So the stub provider is what
 * decides here, and the tests assert that nothing reached aile.sh when it said no.
 *
 * TWO LEVELS, for one reason. The credential path is exercised in-process
 * against a stub provider on loopback, because a spawned CLI would have to be
 * told to check a key somewhere other than the real openrouter.ai — and a
 * production env hook that redirects credential verification is a worse thing to
 * add than a mock. The CLI's own argument handling is exercised as a real
 * process, restricted to the paths that make no network call at all.
 *
 * `mock.module` is process-wide in Bun; the suite runs with `--isolate` so this
 * file's substitution cannot reach another's. See test/transport.test.js.
 */

import { describe, expect, it, beforeEach, afterAll, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TEST_AILE_DIR } from "./setup.js";

const CLI = path.join(import.meta.dirname, "..", "src", "cli", "index.js");
const scratches = [];

/**
 * A key-based provider whose verification endpoint is on this machine.
 *
 * `verifyPort` is filled in per test, so one synthetic entry serves every case
 * rather than the catalog gaining a fake provider.
 */
const STUB_PROVIDER = {
  id: "stubkey",
  name: "StubKey",
  flow: "apikey",
  apiKey: {
    host: "127.0.0.1",
    verifyUrl: null,
    // Where this provider names the key back to us — the only source a label
    // suggestion can come from.
    nameFrom: ["data", "label"],
    prefix: "sk-stub-",
    keyUrl: "https://example.invalid/keys",
  },
};

const real = await import("../src/providers/index.js");
mock.module("../src/providers/index.js", () => ({
  ...real,
  getProvider: (id) => (id === STUB_PROVIDER.id ? STUB_PROVIDER : real.getProvider(id)),
}));

const { connectProvider } = await import("../src/providers/link.js");
const { saveConfig } = await import("../src/relay/config.js");
const { saveState, loadNodeSecret } = await import("../src/relay/state.js");

/**
 * Plays both halves the flow talks to: aile.sh, and the provider's own
 * verification endpoint. One origin, so nothing in these tests leaves loopback.
 */
function stubServer({ verifyStatus = 200, verifyBody = { data: { label: "laptop" } } } = {}) {
  const calls = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/provider/key") {
        calls.push({ path: url.pathname, auth: req.headers.get("authorization") });
        return verifyStatus === 200
          ? Response.json(verifyBody)
          : new Response("no", { status: verifyStatus });
      }

      const body = await req.json().catch(() => null);
      calls.push({ path: url.pathname, method: req.method, body });

      if (url.pathname === "/providers/nonce") {
        return Response.json({
          success: true, data: { nonce: "server-nonce-1", expiresIn: 900, attestable: false }, message: "",
        });
      }
      if (url.pathname === "/providers" && req.method === "POST") {
        return Response.json({
          success: true,
          data: {
            ok: true, added: true, total: 1,
            account: { id: "acct-1", provider: body.provider, attested: 0, label: body.label },
          },
          message: "",
        });
      }
      return Response.json({ success: false, message: "not found", error: "not found" }, { status: 404 });
    },
  });

  const url = `http://127.0.0.1:${server.port}`;
  STUB_PROVIDER.apiKey.verifyUrl = `${url}/provider/key`;

  return {
    calls, url,
    /** What was uploaded, if anything. The negative is the assertion that matters. */
    uploads: () => calls.filter((c) => c.path === "/providers" && c.method === "POST"),
    verifies: () => calls.filter((c) => c.path === "/provider/key"),
    stop: () => { try { server.stop(true); } catch { /* ignore */ } },
  };
}

/** A data directory belonging to a machine signed in against `serverUrl`. */
function signedInData(serverUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-apikey-"));
  scratches.push(dir);
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ serverUrl, renterToken: "ail_" + "a".repeat(48), allowInsecure: true }),
  );
  return dir;
}

/** Run the real CLI. `stdin` is a string to pipe, or "ignore" for none at all. */
async function runCli(args, { data, stdin = "ignore", timeoutMs = 15_000 } = {}) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, AILE_DATA_DIR: data, NO_COLOR: "1" },
    stdin: stdin === "ignore" ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe", stderr: "pipe",
  });

  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  const strip = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  return { code, stdout: strip(stdout), stderr: strip(stderr), all: strip(stdout + stderr) };
}

let stub;
const logged = [];

beforeEach(() => {
  stub?.stop();
  stub = null;
  logged.length = 0;
});

afterAll(() => {
  stub?.stop();
  for (const dir of scratches) fs.rmSync(dir, { recursive: true, force: true });
});

/** connectProvider against the stub, with the REAL apikey flow underneath. */
function connect(apiKey, opts = {}) {
  return connectProvider(STUB_PROVIDER.id, {
    serverUrl: stub.url,
    renterToken: "ail_test_token",
    log: (m) => logged.push(String(m)),
    apiKey,
    ...opts,
  });
}

// ---------------------------------------------------------------------------

describe("the key is checked before it is uploaded", () => {
  it("asks the provider, with the key as a bearer token", async () => {
    stub = stubServer();
    await connect("sk-stub-good");
    expect(stub.verifies()[0].auth).toBe("Bearer sk-stub-good");
  });

  it("checks it BEFORE uploading, not after", async () => {
    // The order is the whole feature: a check that runs after the upload has
    // already advertised capacity that does not work.
    stub = stubServer();
    await connect("sk-stub-good");
    const paths = stub.calls.map((c) => c.path);
    expect(paths.indexOf("/provider/key")).toBeLessThan(paths.indexOf("/providers"));
  });

  it("uploads nothing when the provider rejects the key", async () => {
    stub = stubServer({ verifyStatus: 401 });
    await expect(connect("sk-stub-wrong")).rejects.toThrow(/rejected that key/i);
    expect(stub.uploads().length).toBe(0);
  });

  it("does not call the key invalid when the provider was merely unwell", async () => {
    stub = stubServer({ verifyStatus: 500 });
    await expect(connect("sk-stub-fine")).rejects.toThrow(/500/);
    expect(stub.uploads().length).toBe(0);
  });

  it("refuses an empty key without asking the provider about it", async () => {
    stub = stubServer();
    await expect(connect("   ")).rejects.toThrow(/no key given/i);
    expect(stub.verifies().length).toBe(0);
    expect(stub.uploads().length).toBe(0);
  });
});

describe("what reaches the server", () => {
  it("fetches the nonce first, as every other flow does", async () => {
    stub = stubServer();
    await connect("sk-stub-good");
    const paths = stub.calls.map((c) => c.path);
    expect(paths.indexOf("/providers/nonce")).toBeLessThan(paths.indexOf("/providers"));
  });

  it("uploads the key as the credential, with no refresh token and no expiry", async () => {
    stub = stubServer();
    await connect("sk-stub-good");
    expect(stub.uploads()[0].body.tokens).toMatchObject({
      accessToken: "sk-stub-good", refreshToken: null, expiresIn: null,
    });
  });

  it("keeps the provider's display hint out of the credential blob", async () => {
    stub = stubServer();
    await connect("sk-stub-good");
    const upload = stub.uploads()[0];
    expect("suggestedLabel" in upload.body.tokens).toBe(false);
    expect(upload.body.label).toBe("laptop");
  });

  it("lets the lender's own label win over the provider's suggestion", async () => {
    stub = stubServer();
    await connect("sk-stub-good", { label: "Spare" });
    expect(stub.uploads()[0].body.label).toBe("Spare");
  });

  it("sends a null label when neither named it", async () => {
    stub = stubServer({ verifyBody: {} });
    await connect("sk-stub-good");
    expect(stub.uploads()[0].body.label).toBeNull();
  });

  it("says out loud that a key cannot be cryptographically verified", async () => {
    // Nothing signs anything in a key exchange. Reporting it as verified would
    // make the badge meaningless for the accounts that earned it.
    stub = stubServer();
    const account = await connect("sk-stub-good");
    expect(account.attested).toBe(0);
    expect(logged.join("\n")).toMatch(/unverified claim/i);
  });
});

describe("the key never touches this disk", () => {
  it("is not written anywhere under the data dir", async () => {
    // Same custody rule as every other credential here: aile.sh has to hold it
    // anyway, so a local copy is a second place to steal it from.
    const KEY = "sk-stub-NEVER-ON-DISK";

    // Populate first, or this scans an empty directory and passes vacuously.
    saveConfig({ serverUrl: "https://api.aile.sh", renterToken: "ail_persisted_account_token" });
    saveState({ nodeId: "test-node", connectedAt: new Date().toISOString() });
    loadNodeSecret();

    stub = stubServer();
    await connect(KEY);

    const files = [];
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(TEST_AILE_DIR);

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect({ file, leaks: fs.readFileSync(file, "utf8").includes(KEY) }).toEqual({ file, leaks: false });
    }
  });

  it("is not logged either — the console is a disk on CI", async () => {
    const KEY = "sk-stub-NEVER-LOGGED";
    stub = stubServer();
    await connect(KEY);
    expect(logged.join("\n")).not.toContain(KEY);
  });
});

// ---------------------------------------------------------------------------
// The CLI's own argument handling, as a real process. Restricted to paths that
// make no network call, so nothing here can reach a real provider.
// ---------------------------------------------------------------------------

describe("collecting the key from the command line", () => {
  let data;
  beforeEach(() => { data = signedInData("http://127.0.0.1:1"); });

  it("declines rather than blocking when there is no terminal and no --key", async () => {
    // The bug this catches produces no output at all: a cron job waiting forever
    // on a stdin nobody is writing to.
    const { code, all } = await runCli(
      ["connect", "openrouter", "--server", "http://127.0.0.1:1", "--insecure"],
      { data },
    );
    expect(code).toBe(1);
    expect(all).toMatch(/no terminal/i);
    // And it names both ways out, since whoever reads this is in a script.
    expect(all).toMatch(/--key <key>/);
    expect(all).toMatch(/--key -/);
  });

  it("declines an empty pipe by name, not by hanging", async () => {
    const { code, all } = await runCli(
      ["connect", "openrouter", "--key", "-", "--server", "http://127.0.0.1:1", "--insecure"],
      { data, stdin: "\n" },
    );
    expect(code).toBe(1);
    expect(all).toMatch(/no key on stdin/i);
  });

  it("declines a --key - with nothing on stdin at all", async () => {
    const { code, all } = await runCli(
      ["connect", "openrouter", "--key", "-", "--server", "http://127.0.0.1:1", "--insecure"],
      { data },
    );
    expect(code).toBe(1);
    expect(all).toMatch(/no key on stdin/i);
  });

  it("refuses to run at all on a machine that is not set up", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "aile-apikey-out-"));
    scratches.push(empty);
    const { code, all } = await runCli(
      ["connect", "openrouter", "--key", "sk-or-abc", "--server", "http://127.0.0.1:1", "--insecure"],
      { data: empty },
    );
    expect(code).toBe(1);
    expect(all).toMatch(/not set up/i);
    // The key was on the command line, so failing here must not read as though
    // the key were the problem — it names what to run, both ways.
    expect(all).toMatch(/aile login/);
    expect(all).toMatch(/aile donate/);
  });
});

describe("the provider menu", () => {
  let data;
  beforeEach(() => { data = signedInData("http://127.0.0.1:1"); });

  it("shows subscriptions and API keys as different things to lend", async () => {
    // A subscription has a monthly ceiling; a key bills per token with none. A
    // flat list of names gives a lender no way to tell which they picked.
    const { all } = await runCli(["connect", "--server", "http://127.0.0.1:1", "--insecure"], { data });
    expect(all).toMatch(/Subscriptions/);
    expect(all).toMatch(/API keys/);
    expect(all).toMatch(/openrouter/);
  });

  it("says who is billed, before anyone pastes anything", async () => {
    const { all } = await runCli(["connect", "--server", "http://127.0.0.1:1", "--insecure"], { data });
    expect(all).toMatch(/billed to you/i);
  });

  it("documents both key forms in the usage text", async () => {
    const { all } = await runCli(["--help"], { data });
    expect(all).toMatch(/--key <key>/);
    expect(all).toMatch(/--key -/);
  });
});
