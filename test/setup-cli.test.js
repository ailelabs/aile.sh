/**
 * `aile setup`, run the way a user runs it, against a stub relay and a scratch
 * home directory.
 *
 * What has to hold, end to end:
 *   - it writes each tool's own file with the right keys and nothing else,
 *     keeping what the user already had;
 *   - shortcuts land in a directory on PATH;
 *   - `--remove` puts every file back exactly as it was, and deletes what it
 *     created;
 *   - a key it cannot verify is refused before anything is written.
 *
 * The scratch home is handed over through HOME/USERPROFILE (what `os.homedir()`
 * reads on each platform), APPDATA/LOCALAPPDATA, XDG_* and PATH, so nothing
 * here can reach the real configuration of whoever runs the suite.
 */

import { describe, expect, it, afterAll, beforeAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { browserKey } from "../src/setup/key.js";

const CLI = path.join(import.meta.dirname, "..", "src", "cli", "index.js");
const GOOD = `sk-aile-${"1a".repeat(24)}`;
const MINTED = `sk-aile-${"2b".repeat(24)}`;
const GRANTED = `sk-aile-${"3c".repeat(24)}`;
const OTHER = `sk-aile-${"4d".repeat(24)}`;

const scratches = [];
const scratch = (tag) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `aile-setup-${tag}-`));
  scratches.push(d);
  return d;
};

let stub;
beforeAll(() => {
  const calls = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text().catch(() => "");
      calls.push({ method: req.method, path: url.pathname, body, headers: Object.fromEntries(req.headers) });
      if (url.pathname === "/v1/models") {
        return Response.json({
          object: "list",
          data: [
            { id: "cc/claude-sonnet-5", type: "chat", display_name: "claude-sonnet-5 (Claude Code)", context_length: 1000000, max_output_tokens: 128000 },
            { id: "codex/gpt-5.5", type: "chat", display_name: "gpt-5.5 (Codex)", context_length: 1050000, max_output_tokens: 128000 },
            { id: "openrouter/some/model", type: "chat" },
            { id: "openai/dall-e", type: "image" },
          ],
        });
      }
      if (url.pathname === "/v1/messages/count_tokens") {
        const k = req.headers.get("x-api-key");
        if ([GOOD, MINTED, GRANTED, OTHER].includes(k)) return Response.json({ input_tokens: 1 });
        return Response.json({ type: "error", error: { type: "authentication_error", message: "unknown API key" } }, { status: 401 });
      }
      if (url.pathname === "/me") {
        if (!/^Bearer ail_/.test(req.headers.get("authorization") || "")) return Response.json({ success: false, message: "no" }, { status: 401 });
        return Response.json({ success: true, data: { renter: { id: "acct-new", email: "new@example.com" } } });
      }
      if (url.pathname.startsWith("/keys/") && req.method === "DELETE") {
        stub.revoked.push(url.pathname.slice("/keys/".length));
        return Response.json({ success: true, data: { ok: true } });
      }
      if (url.pathname === "/keys" && req.method === "POST") {
        if (!/^Bearer ail_/.test(req.headers.get("authorization") || "")) return Response.json({ success: false, message: "no" }, { status: 401 });
        return Response.json({ success: true, data: { secret: MINTED, key: { id: "k1", prefix: MINTED.slice(0, 16), name: JSON.parse(body).name } } });
      }
      if (url.pathname === "/auth/device" && req.method === "POST") {
        const b = JSON.parse(body || "{}");
        return Response.json({ success: true, data: {
          deviceCode: "dev-1", userCode: "ABCD-EFGH",
          verificationUri: `${stub.url}/login`, verificationUriComplete: `${stub.url}/login?code=ABCD-EFGH`,
          expiresIn: 600, interval: 0.01, ...(b.purpose === "key" && !stub.oldServer ? { purpose: "key" } : {}),
        } });
      }
      if (url.pathname === "/auth/device/token") {
        stub.polls++;
        if (stub.polls < 2) return Response.json({ success: true, data: { status: "pending", interval: 0.01 } }, { status: 202 });
        return Response.json({ success: true, data: { status: "approved", key: { secret: GRANTED, id: "k2", prefix: "x", name: "y" }, renter: { id: "acct-b", email: "b@example.com" } } });
      }
      if (url.pathname === "/health") return Response.json({ success: true, data: { ok: true } });
      return Response.json({ success: false, message: "not found" }, { status: 404 });
    },
  });
  stub = { url: `http://127.0.0.1:${server.port}`, calls, polls: 0, oldServer: false, revoked: [], stop: () => server.stop(true) };
});

afterAll(() => {
  stub?.stop();
  for (const d of scratches) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

/** A machine: a data dir, a home, and a PATH whose only writable entry is the shortcut dir. */
function machine({ config = {} } = {}) {
  const data = scratch("data");
  const home = scratch("home");
  const appData = path.join(home, "AppData", "Roaming");
  const localAppData = path.join(home, "AppData", "Local");
  const bin = process.platform === "win32" ? path.join(appData, "npm") : path.join(home, ".local", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({ serverUrl: stub.url, ...config }));
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(CLAUDE_CONFIG_DIR|CODEX_HOME|OPENCODE_DATA_DIR|XDG_CONFIG_HOME|XDG_DATA_HOME|ANTHROPIC_.*|OPENAI_.*)$/i.test(k)) delete env[k];
    // Whatever agent is running THIS suite (Claude Code sets CLAUDECODE, Codex
    // CODEX_THREAD_ID, …) must not leak into the CLI under test as its caller.
    if (/^(CLAUDECODE|CLAUDE_CODE_.*|CODEX_.*|OPENCODE.*|KILO.*|QWEN_CODE.*|GEMINI_CLI|CURSOR_.*|GOOSE_.*|CRUSH|OPENCLAW_.*|CLINE_.*|ROO_.*|COPILOT_.*|AMP_.*|AI_AGENT|AGENT)$/i.test(k)) delete env[k];
  }
  Object.assign(env, {
    AILE_DATA_DIR: data, NO_COLOR: "1", AILE_NO_UPDATE_CHECK: "1",
    HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: localAppData,
    PATH: bin,
  });
  return { data, home, bin, env, p: (...xs) => path.join(home, ...xs) };
}

async function run(m, args, { timeoutMs = 20_000 } = {}) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], { env: m.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, out: stdout + stderr };
}

const readJ = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

describe("aile setup — writes each tool's own config, and undoes it exactly", () => {
  it("configures Claude Code, Codex, opencode and Droid, then --remove restores every file", async () => {
    const m = machine();
    const claudeFile = m.p(".claude", "settings.json");
    const codexFile = m.p(".codex", "config.toml");
    fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
    fs.mkdirSync(path.dirname(codexFile), { recursive: true });
    const claudeBefore = `${JSON.stringify({ theme: "dark", env: { FOO: "1", ANTHROPIC_API_KEY: "sk-ant-mine" } }, null, 2)}\n`;
    const codexBefore = '# mine\nmodel = "o3"\n\n[mcp_servers.docs]\ncommand = "docs"\n';
    fs.writeFileSync(claudeFile, claudeBefore);
    fs.writeFileSync(codexFile, codexBefore);

    const res = await run(m, ["setup", "claude", "codex", "opencode", "droid", "--mode", "both", "--key", GOOD, "--yes"]);
    expect(res.code).toBe(0);

    // Claude Code: aile, the key as a bearer token, discovery on; the user's
    // own settings kept, and their competing API key set aside.
    const claude = readJ(claudeFile);
    expect(claude.theme).toBe("dark");
    expect(claude.env).toEqual({
      FOO: "1",
      ANTHROPIC_BASE_URL: stub.url,
      ANTHROPIC_AUTH_TOKEN: GOOD,
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    });

    // Codex: the provider key before the first table, our block after it,
    // the user's model and comment untouched.
    const codex = fs.readFileSync(codexFile, "utf8");
    expect(codex.indexOf('model_provider = "aile"')).toBeLessThan(codex.indexOf("[mcp_servers.docs]"));
    expect(codex).toContain('model = "o3"');
    expect(codex).toContain("# mine");
    expect(codex).toContain(`base_url = "${stub.url}/v1"`);
    expect(codex).toContain('wire_api = "responses"');
    expect(codex).toContain(`experimental_bearer_token = "${GOOD}"`);

    // opencode: our plugin, and its key where the plugin reads it.
    const oc = readJ(m.p(".config", "opencode", "opencode.json"));
    expect(oc.plugin).toEqual([["@ailelabs/opencode-plugin", { baseURL: `${stub.url}/v1` }]]);
    expect(readJ(m.p(".local", "share", "opencode", "auth.json"))["opencode-aile"]).toEqual({ type: "api", key: GOOD });

    // Droid: the Claude and Codex models only, each on the format that fits it.
    const droid = readJ(m.p(".factory", "settings.json")).customModels;
    expect(droid.map((e) => e.model)).toEqual(["cc/claude-sonnet-5", "codex/gpt-5.5"]);
    expect(droid[0]).toMatchObject({ provider: "anthropic", baseUrl: stub.url, apiKey: GOOD });
    expect(droid[1]).toMatchObject({ provider: "generic-chat-completion-api", baseUrl: `${stub.url}/v1` });

    // Shortcuts, on PATH.
    const sc = process.platform === "win32" ? ["claudeaile.cmd", "claudeaile", "codexaile.cmd"] : ["claudeaile", "codexaile"];
    for (const f of sc) expect(fs.existsSync(path.join(m.bin, f))).toBe(true);

    // The key is kept for `aile run` and the next setup; the manifest exists.
    expect(readJ(path.join(m.data, "config.json")).buyerKey).toBe(GOOD);
    expect(fs.existsSync(path.join(m.data, "integrations.json"))).toBe(true);

    // Status agrees.
    const st = await run(m, ["setup", "status", "--json"]);
    const status = JSON.parse(st.out);
    const byId = Object.fromEntries(status.tools.map((t) => [t.id, t]));
    expect(byId.claude.config.state).toBe("aile");
    expect(byId.claude.shortcut).toBe("claudeaile");
    expect(byId.codex.config.state).toBe("aile");
    expect(byId.opencode.config.state).toBe("aile");

    // A second run is a no-op on the files and keeps the ORIGINAL "before".
    const again = await run(m, ["setup", "claude", "codex", "--mode", "both", "--yes"]);
    expect(again.code).toBe(0);

    // Undo.
    const undo = await run(m, ["setup", "--remove", "--yes"]);
    expect(undo.code).toBe(0);
    expect(fs.readFileSync(claudeFile, "utf8")).toBe(claudeBefore);
    expect(fs.readFileSync(codexFile, "utf8")).toBe(codexBefore);
    expect(fs.existsSync(m.p(".config", "opencode", "opencode.json"))).toBe(false);
    expect(fs.existsSync(m.p(".local", "share", "opencode", "auth.json"))).toBe(false);
    expect(fs.existsSync(m.p(".factory", "settings.json"))).toBe(false);
    for (const f of sc) expect(fs.existsSync(path.join(m.bin, f))).toBe(false);
  });

  it("defaults to shortcuts for Claude Code and Codex, leaving their config alone", async () => {
    const m = machine();
    const res = await run(m, ["setup", "claude", "codex", "--key", GOOD, "--yes"]);
    expect(res.code).toBe(0);
    expect(fs.existsSync(m.p(".claude", "settings.json"))).toBe(false);
    expect(fs.existsSync(m.p(".codex", "config.toml"))).toBe(false);
    const name = process.platform === "win32" ? "claudeaile.cmd" : "claudeaile";
    const script = fs.readFileSync(path.join(m.bin, name), "utf8");
    expect(script).toContain(stub.url);
    expect(script).toContain(GOOD);
    expect(script).toContain("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY");
  });

  it("a tool installed off PATH gets a shortcut that runs it by its full path", async () => {
    const m = machine();
    // Claude Code's older self-contained install location, never on PATH.
    const dir = m.p(".claude", "local");
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, process.platform === "win32" ? "claude.exe" : "claude");
    fs.writeFileSync(exe, "", { mode: 0o755 });
    const res = await run(m, ["setup", "claude", "--key", GOOD, "--yes"]);
    expect(res.code).toBe(0);
    const name = process.platform === "win32" ? "claudeaile.cmd" : "claudeaile";
    const script = fs.readFileSync(path.join(m.bin, name), "utf8");
    expect(script).toContain(process.platform === "win32" ? `"${exe}" %*` : `exec '${exe}' "$@"`);
  });

  it("aile detect lists what is installed, as JSON", async () => {
    const m = machine();
    fs.mkdirSync(m.p(".vscode", "extensions", "saoudrizwan.claude-dev-3.20.1"), { recursive: true });
    const res = await run(m, ["detect", "--json", "--fast"]);
    expect(res.code).toBe(0);
    const cline = JSON.parse(res.out).tools.find((t) => t.id === "cline");
    expect(cline).toMatchObject({ installed: true, via: "extension", version: "3.20.1", setup: "steps" });
  });

  it("refuses a key the server does not accept, before writing anything", async () => {
    const m = machine();
    const bad = `sk-aile-${"0f".repeat(24)}`;
    const res = await run(m, ["setup", "claude", "--mode", "default", "--key", bad, "--yes"]);
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/refused/i);
    expect(fs.existsSync(m.p(".claude", "settings.json"))).toBe(false);
  });

  it("a signed-in machine mints a key on its account — no browser", async () => {
    const m = machine({ config: { renterToken: `ail_${"a".repeat(48)}` } });
    const res = await run(m, ["setup", "claude", "--yes"]);
    expect(res.code).toBe(0);
    expect(readJ(path.join(m.data, "config.json")).buyerKey).toBe(MINTED);
    const mint = stub.calls.filter((c) => c.path === "/keys").at(-1);
    expect(JSON.parse(mint.body).name).toMatch(/^aile setup · /);
  });

  it("with no tools named and no terminal, says how to name them instead of hanging", async () => {
    const m = machine();
    const res = await run(m, ["setup"]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("aile setup claude codex --yes");
  });

  it("run from inside a coding agent, it names that agent's own setup command", async () => {
    const m = machine();
    m.env.CODEX_THREAD_ID = "thread-1";
    const res = await run(m, ["setup"]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("running inside Codex: aile setup codex --yes");
  });

  it("--dry-run writes nothing and shows no full file", async () => {
    const m = machine();
    const res = await run(m, ["setup", "opencode", "--dry-run", "--yes"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("Dry run");
    expect(fs.existsSync(m.p(".config", "opencode", "opencode.json"))).toBe(false);
  });

  it("prints the values to paste for an app it cannot configure", async () => {
    const m = machine();
    const res = await run(m, ["setup", "cursor", "--yes"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("Override OpenAI Base URL");
    expect(res.out).toContain(`${stub.url}/v1`);
  });
});

describe("keys change, accounts change, and uninstall", () => {
  it("refresh puts a new key into every tool already set up, the way each was set up", async () => {
    const m = machine();
    expect((await run(m, ["setup", "claude", "codex", "--mode", "both", "--key", GOOD, "--yes"])).code).toBe(0);
    const res = await run(m, ["setup", "refresh", "--key", OTHER]);
    expect(res.code).toBe(0);
    expect(readJ(m.p(".claude", "settings.json")).env.ANTHROPIC_AUTH_TOKEN).toBe(OTHER);
    expect(fs.readFileSync(m.p(".codex", "config.toml"), "utf8")).toContain(OTHER);
    const sc = fs.readFileSync(path.join(m.bin, process.platform === "win32" ? "claudeaile.cmd" : "claudeaile"), "utf8");
    expect(sc).toContain(OTHER);
    expect(sc).not.toContain(GOOD);
    expect(readJ(path.join(m.data, "config.json")).buyerKey).toBe(OTHER);
    // …and undo still restores the state from BEFORE the first setup.
    expect((await run(m, ["setup", "--remove", "--yes"])).code).toBe(0);
    expect(fs.existsSync(m.p(".claude", "settings.json"))).toBe(false);
  });

  it("a full uninstall forgets the key on this machine; --revoke also revokes it", async () => {
    const m = machine({ config: { renterToken: `ail_${"a".repeat(48)}` } });
    expect((await run(m, ["setup", "claude", "--yes"])).code).toBe(0);
    expect(readJ(path.join(m.data, "config.json")).buyerKey).toBe(MINTED);
    const res = await run(m, ["setup", "--remove", "--revoke", "--yes"]);
    expect(res.code).toBe(0);
    expect(readJ(path.join(m.data, "config.json")).buyerKey ?? "").toBe("");
    expect(stub.revoked).toContain("k1");
  });

  it("removing ONE tool keeps the key for the others", async () => {
    const m = machine();
    await run(m, ["setup", "claude", "codex", "--key", GOOD, "--yes"]);
    await run(m, ["setup", "--remove", "codex", "--yes"]);
    expect(readJ(path.join(m.data, "config.json")).buyerKey).toBe(GOOD);
  });

  it("a saved key from ANOTHER account is not reused after signing in as someone else", async () => {
    // The tools were set up with a key from acct-old; this machine is now signed
    // in as acct-new (the stub's /me). Setup must mint on acct-new.
    const m = machine({ config: { renterToken: `ail_${"a".repeat(48)}`, buyerKey: GOOD } });
    fs.writeFileSync(path.join(m.data, "integrations.json"), JSON.stringify({
      version: 1, tools: {}, key: { prefix: `${GOOD.slice(0, 12)}…${GOOD.slice(-4)}`, id: "k0", account: { id: "acct-old", email: "old@example.com" } },
    }));
    const res = await run(m, ["setup", "claude", "--yes"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("belongs to old@example.com");
    expect(readJ(path.join(m.data, "config.json")).buyerKey).toBe(MINTED);
    expect(readJ(path.join(m.data, "integrations.json")).key.account).toEqual({ id: "acct-new", email: "new@example.com" });
  });

  it("logout --tools takes aile out of the tools and revokes the key before signing out", async () => {
    const m = machine({ config: { renterToken: `ail_${"a".repeat(48)}` } });
    await run(m, ["setup", "claude", "--mode", "default", "--yes"]);
    expect(fs.existsSync(m.p(".claude", "settings.json"))).toBe(true);
    stub.revoked.length = 0;
    const res = await run(m, ["logout", "--tools"]);
    expect(res.code).toBe(0);
    expect(fs.existsSync(m.p(".claude", "settings.json"))).toBe(false);
    expect(stub.revoked).toContain("k1");
    const cfg = readJ(path.join(m.data, "config.json"));
    expect(cfg.renterToken ?? "").toBe("");
    expect(cfg.buyerKey ?? "").toBe("");
  });

  it("signing in as a different account offers to move the tools over, and --yes does it", async () => {
    const m = machine();
    await run(m, ["setup", "claude", "--key", GOOD, "--yes"]);
    // Record GOOD as belonging to acct-old, as a browser grant would have.
    const man = readJ(path.join(m.data, "integrations.json"));
    man.key.account = { id: "acct-old", email: "old@example.com" };
    fs.writeFileSync(path.join(m.data, "integrations.json"), JSON.stringify(man));

    const quiet = await run(m, ["login", "--token", `ail_${"b".repeat(48)}`]);
    expect(quiet.out).toContain("use a key from old@example.com");
    expect(quiet.out).toContain("aile setup refresh --new-key");
    expect(readJ(path.join(m.data, "config.json")).buyerKey).toBe(GOOD);

    const moved = await run(m, ["login", "--token", `ail_${"b".repeat(48)}`, "--yes"]);
    expect(moved.code).toBe(0);
    expect(readJ(path.join(m.data, "config.json")).buyerKey).toBe(MINTED);
    const sc = fs.readFileSync(path.join(m.bin, process.platform === "win32" ? "claudeaile.cmd" : "claudeaile"), "utf8");
    expect(sc).toContain(MINTED);
  });

  it("plain logout says the tools still use aile", async () => {
    const m = machine({ config: { renterToken: `ail_${"a".repeat(48)}` } });
    await run(m, ["setup", "claude", "--yes"]);
    const res = await run(m, ["logout"]);
    expect(res.out).toContain("Your coding tools still use aile");
    expect(res.out).toContain("aile setup --remove");
  });
});

describe("aile env", () => {
  it("prints the environment for a tool, in the requested shell", async () => {
    const m = machine({ config: { buyerKey: GOOD } });
    const sh = await run(m, ["env", "--shell", "sh", "claude"]);
    expect(sh.out).toContain(`export ANTHROPIC_BASE_URL='${stub.url}'`);
    expect(sh.out).toContain(`export ANTHROPIC_AUTH_TOKEN='${GOOD}'`);
    expect(sh.out).toContain("unset ANTHROPIC_API_KEY");
    const ps = await run(m, ["env", "--shell", "powershell", "claude"]);
    expect(ps.out).toContain(`$env:ANTHROPIC_AUTH_TOKEN = "${GOOD}"`);
  });

  it("refuses without a key, and says how to get one", async () => {
    const m = machine();
    const res = await run(m, ["env", "claude"]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("aile setup");
  });
});

describe("the browser key grant", () => {
  it("approves a KEY, not a sign-in, and returns it", async () => {
    stub.polls = 0;
    stub.oldServer = false;
    let opened = null;
    const got = await browserKey({
      serverUrl: stub.url, keyName: "aile setup · test", log: () => {},
      openBrowser: async (u) => { opened = u; }, interactive: false,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    });
    // The key, and whose it is — so a later sign-in as somebody else is noticed.
    expect(got).toEqual({ key: GRANTED, id: "k2", account: { id: "acct-b", email: "b@example.com" } });
    expect(opened).toContain("/login?code=ABCD-EFGH");
    const start = stub.calls.filter((c) => c.path === "/auth/device").at(-1);
    expect(JSON.parse(start.body)).toMatchObject({ purpose: "key", keyName: "aile setup · test" });
  });

  it("stops before anyone approves when the server does not know about keys", async () => {
    stub.oldServer = true;
    let opened = false;
    await expect(browserKey({
      serverUrl: stub.url, keyName: "x", log: () => {}, openBrowser: async () => { opened = true; }, interactive: false,
    })).rejects.toMatchObject({ reason: "unsupported" });
    // Nothing opened: an old relay would have approved a LOGIN and rotated the token.
    expect(opened).toBe(false);
    stub.oldServer = false;
  });
});
