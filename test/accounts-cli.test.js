/**
 * The account commands, tested through the real CLI.
 *
 * `src/cli/index.js` dispatches at import time, so as in first-run.test.js the
 * only honest test is to run it the way a user does.
 *
 * WHAT IS ACTUALLY AT RISK HERE. Once a lender can have several accounts of one
 * provider, they stop referring to them by provider name and start referring to
 * them by position — "remove 2". A resolver that maps a position to the wrong
 * row deletes a working credential and leaves the lender re-running an OAuth
 * flow to find out. So the tests below are mostly about refusing: an ambiguous
 * prefix, a number past the end, and a missing argument with no terminal to ask
 * on must all decline WITHOUT deleting anything.
 *
 * The stub records which id each request named, because "it printed Removed" is
 * not the property under test — which account it removed is.
 */

import { describe, expect, it, beforeEach, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dirname, "..", "src", "cli", "index.js");
const scratches = [];

const ACCOUNTS = [
  { id: "aaaa1111", provider: "codex", account_key: "sub-work", label: "Work", email: "work@example.com", attested: 1 },
  { id: "bbbb2222", provider: "codex", account_key: "sub-home", label: null, email: "home@example.com", attested: 1 },
  { id: "cccc3333", provider: "cursor", account_key: "default", label: null, email: null, attested: 0 },
];

/** The same list plus a pasted key, which is unverified for a different reason. */
const WITH_KEY = [
  ...ACCOUNTS,
  { id: "dddd4444", provider: "openrouter", account_key: "default", label: "Spare", email: null, attested: 0 },
];

/** An aile.sh that records what each request named. */
function stubServer({ accounts = ACCOUNTS } = {}) {
  const calls = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.json().catch(() => null);
      calls.push({ path: url.pathname, method: req.method, body });

      if (url.pathname === "/providers" && req.method === "GET") {
        const filter = url.searchParams.get("provider");
        return Response.json({
          success: true,
          data: { accounts: filter ? accounts.filter((a) => a.provider === filter) : accounts },
          message: "",
        });
      }
      if (url.pathname.startsWith("/providers/") && req.method === "DELETE") {
        const id = url.pathname.slice("/providers/".length);
        const account = accounts.find((a) => a.id === id);
        return account
          ? Response.json({ success: true, data: { ok: true, removed: account }, message: "" })
          : Response.json({ success: false, message: "not found", error: "not found" }, { status: 404 });
      }
      if (url.pathname.startsWith("/providers/") && req.method === "PATCH") {
        const id = url.pathname.slice("/providers/".length);
        const account = accounts.find((a) => a.id === id);
        return account
          ? Response.json({ success: true, data: { ok: true, account: { ...account, label: body.label } }, message: "" })
          : Response.json({ success: false, message: "not found", error: "not found" }, { status: 404 });
      }
      return Response.json({ success: false, message: "not found", error: "not found" }, { status: 404 });
    },
  });
  return {
    calls,
    url: `http://127.0.0.1:${server.port}`,
    /** Ids this run actually asked the server to delete. */
    deleted: () => calls.filter((c) => c.method === "DELETE").map((c) => c.path.slice("/providers/".length)),
    stop: () => { try { server.stop(true); } catch { /* ignore */ } },
  };
}

/** A data directory belonging to a machine signed in against `serverUrl`. */
function signedInData(serverUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-accounts-"));
  scratches.push(dir);
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ serverUrl, renterToken: "ail_" + "a".repeat(48) }),
  );
  return dir;
}

/**
 * Run the CLI with stdin closed. That is deliberate and not merely convenient:
 * it is the shape a pipe, a cron job, or a container gives it, and every command
 * here has an interactive branch that must not be reachable without a terminal.
 */
async function run(args, { data, timeoutMs = 15_000 } = {}) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, AILE_DATA_DIR: data, NO_COLOR: "1" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
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
let data;
beforeEach(() => {
  stub?.stop();
  stub = stubServer();
  data = signedInData(stub.url);
});

afterAll(() => {
  stub?.stop();
  for (const dir of scratches) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("listing", () => {
  it("groups by provider and numbers straight through", async () => {
    const { stdout, code } = await run(["accounts"], { data });
    expect(code).toBe(0);
    // Two codex accounts under one heading, then cursor — numbered 1..3 across
    // the groups, because those numbers are what `disconnect` takes.
    expect(stdout).toMatch(/Codex[\s\S]*1[\s\S]*Work[\s\S]*2[\s\S]*home@example\.com/);
    // `unchecked`, not `unverified`: nothing has tested this credential yet,
    // which is a different statement from having tested it and failed.
    expect(stdout).toMatch(/3\s+unchecked/);
  });

  it("shows the count when a provider has more than one", async () => {
    const { stdout } = await run(["accounts"], { data });
    expect(stdout).toMatch(/\(2\)/);
  });

  it("falls back to the email, then to the account key, when there is no name", async () => {
    const { stdout } = await run(["accounts"], { data });
    expect(stdout).toContain("home@example.com");   // no label
    expect(stdout).toContain("account default");    // no label, no email
  });

  it("still prints the ids, so a script is not forced to count", async () => {
    const { stdout } = await run(["accounts"], { data });
    for (const a of ACCOUNTS) expect(stdout).toContain(a.id);
  });

  it("emits the server's own shape under --json", async () => {
    const { stdout } = await run(["accounts", "--json"], { data });
    expect(JSON.parse(stdout)).toEqual(ACCOUNTS);
  });

  it("puts NOTHING but the JSON on stdout", async () => {
    // The whole value of the flag is being pipeable: a banner line sits inside
    // the payload and makes `aile accounts --json | jq` fail.
    const { stdout } = await run(["accounts", "--json"], { data });
    expect(stdout.trim().startsWith("[")).toBe(true);
    expect(stdout).not.toMatch(/aile\.sh/);
  });

  it("keeps the plain-HTTP warning off stdout too", async () => {
    // The stub is on loopback, which is exempt from the transport check — so to
    // see the warning at all this has to name a non-loopback address. `.invalid`
    // is reserved precisely so it cannot resolve, which makes the request fail
    // on DNS rather than sitting in a connect timeout. The run fails, and that
    // is fine: the assertion is about which stream the warning went to.
    const { stdout, stderr } = await run(
      ["accounts", "--json", "--server", "http://nope.invalid", "--insecure"], { data },
    );
    expect(stderr).toMatch(/plain HTTP/);
    expect(stdout).not.toMatch(/plain HTTP/);
  }, 20_000);

  it("says what to do when there is nothing connected", async () => {
    stub.stop();
    stub = stubServer({ accounts: [] });
    const { stdout } = await run(["accounts"], { data: signedInData(stub.url) });
    expect(stdout).toMatch(/No accounts connected/i);
    expect(stdout).toMatch(/aile connect/);
  });
});

/**
 * Two accounts can read `unverified` for entirely different reasons, and only
 * one of them is fixable. A subscription that failed attestation might pass
 * later; a pasted key never will, because nothing signs anything in a key
 * exchange. Printing the same word for both sends a lender looking for a
 * verification step that does not exist — and hides the fact that the key has no
 * monthly ceiling to stop a busy week from becoming an invoice.
 */
describe("a key is unverified for a different reason than a subscription", () => {
  beforeEach(() => {
    stub.stop();
    stub = stubServer({ accounts: WITH_KEY });
    data = signedInData(stub.url);
  });

  it("says why a key can never be verified, next to the badge that says it is not", async () => {
    const { stdout } = await run(["accounts"], { data });
    // The phrasing now lives on the identity line, where it is said of EVERY kind
    // that cannot be attested rather than only of pasted keys — but the promise to
    // the lender is the same one: say why, not just that.
    expect(stdout).toMatch(/identity cannot be proven/i);
  });

  it("says who pays for it, which the badge cannot", async () => {
    const { stdout } = await run(["accounts"], { data });
    expect(stdout).toMatch(/billed to you per token/i);
  });

  it("says it once, about the key, and not about the subscriptions", async () => {
    // cursor (account 3) is `attested: 0` too, and it may yet be verified — so
    // the note appearing there would be wrong, not merely noisy. Counting is
    // what separates "explained the key" from "printed it under everything".
    const { stdout } = await run(["accounts"], { data });
    const notes = stdout.split("\n").filter((l) => /identity cannot be proven/i.test(l));
    expect(notes).toHaveLength(1);
  });

  it("attaches it to the key's own entry, not to whatever came last", async () => {
    const { stdout } = await run(["accounts"], { data });
    const lines = stdout.split("\n");
    const noteAt = lines.findIndex((l) => /billed to you per token/i.test(l));
    const idAt = lines.findIndex((l) => l.includes("dddd4444"));
    // The previous account's id closes its block; the note must sit AFTER it, so
    // it attaches to this key rather than trailing whatever came last.
    const prevIdAt = lines.findIndex((l) => l.includes("cccc3333"));
    // Printed within the key's own block: after the prior account, before this id.
    expect(noteAt).toBeGreaterThan(-1);
    expect(noteAt).toBeGreaterThan(prevIdAt);
    expect(idAt).toBeGreaterThan(noteAt);
    // …and the reason it can never be verified sits in the same block, above it.
    const whyAt = lines.findIndex((l) => /identity cannot be proven/i.test(l));
    expect(whyAt).toBeGreaterThan(-1);
    expect(whyAt).toBeLessThan(noteAt);
  });
});

/**
 * The other way an account earns the green badge.
 *
 * `probe_ok` means the provider's own API accepted the credential when this
 * machine asked. `attested` means the provider SIGNED a statement about whose
 * account it is and the server verified that signature. They answer different
 * questions, and the listing shows both as "verified" because the question a
 * lender is asking of that column — did connecting my account work? — has the
 * same answer either way.
 *
 * What these tests pin is that showing them alike does not MERGE them: a probe
 * pass must never produce a tier, because a tier is only ever read from a
 * verified id_token. That is the line where rendering them together would stop
 * being a presentation choice and start being a false claim.
 */
describe("an account the provider itself accepted", () => {
  const listWith = async (accounts) => {
    stub.stop();
    stub = stubServer({ accounts });
    return run(["accounts"], { data: signedInData(stub.url) });
  };

  it("reads as working — not verified — when only the credential was accepted", async () => {
    const { stdout } = await listWith([
      { id: "eeee5555", provider: "claude", account_key: "default", label: "Accepted", email: null, attested: 0, probe_ok: 1 },
    ]);
    // Matched on the label, not the provider name: "Claude" also appears in the
    // group heading "Claude Code", which carries no badge and would make this
    // pass or fail for reasons that have nothing to do with the badge.
    const line = stdout.split("\n").find((l) => l.includes("Accepted"));
    // A probe says the credential works. It says NOTHING about whose account
    // it is, so the strong word is not available here — that distinction is the
    // whole reason liveness and identity are now two facts.
    expect(line).toMatch(/working/);
    expect(line).not.toMatch(/verified/);
  });

  it("reads as unchecked — not failing — when it was never checked", async () => {
    const { stdout } = await listWith([
      { id: "ffff6666", provider: "claude", account_key: "default", label: "Unchecked", email: null, attested: 0, probe_ok: 0 },
    ]);
    // Never tested is not the same as tested and broken, and rendering them
    // the same makes a freshly linked account look faulty.
    expect(stdout.split("\n").find((l) => l.includes("Unchecked"))).toMatch(/unchecked/);
  });

  it("claims no tier from a probe, which signs nothing", async () => {
    // A tier is read from a verified id_token. A probe is this machine saying
    // the credential works — it carries no signed claim about anything, so a
    // tier appearing beside one would be invented.
    const { stdout } = await listWith([{
      id: "eeee5555", provider: "codex", account_key: "default", label: "Probed",
      email: null, attested: 0, probe_ok: 1,
      attest_detail: JSON.stringify({ chatgptPlanType: "pro" }),
    }]);
    const line = stdout.split("\n").find((l) => l.includes("Probed"));
    expect(line).toMatch(/working/);
    expect(line).not.toMatch(/pro/);
  });
});

/**
 * The tier the provider signed, shown beside the account it belongs to.
 *
 * Two verified subscriptions of one provider, each with an email, are otherwise
 * indistinguishable in the listing — and their ceilings are not. The value comes
 * from `attest_detail`, which the server writes only from a verified id_token,
 * so these tests also pin that a tier is never invented: no attestation, no
 * claim, or unreadable JSON must all print nothing rather than a guess.
 */
describe("the plan tier, where the provider signed one", () => {
  const TIERED = [
    {
      id: "aaaa1111", provider: "codex", account_key: "sub-work", label: "Work",
      email: "work@example.com", attested: 1,
      attest_detail: JSON.stringify({
        issuer: "https://auth.openai.com", chatgptAccountId: "acct-w", chatgptPlanType: "pro",
      }),
    },
    {
      id: "bbbb2222", provider: "codex", account_key: "sub-home", label: "Home",
      email: "home@example.com", attested: 1,
      attest_detail: JSON.stringify({
        issuer: "https://auth.openai.com", chatgptAccountId: "acct-h", chatgptPlanType: "plus",
      }),
    },
  ];

  const listWith = async (accounts) => {
    stub.stop();
    stub = stubServer({ accounts });
    return run(["accounts"], { data: signedInData(stub.url) });
  };

  it("tells two verified accounts of one provider apart by what they can serve", async () => {
    const { stdout } = await listWith(TIERED);
    const line = (name) => stdout.split("\n").find((l) => l.includes(name));
    expect(line("Work")).toMatch(/pro/);
    expect(line("Home")).toMatch(/plus/);
  });

  it("prints it on the account's own line, not under some other account", async () => {
    const { stdout } = await listWith(TIERED);
    const lines = stdout.split("\n");
    expect(lines.findIndex((l) => /\bpro\b/.test(l))).toBe(lines.findIndex((l) => l.includes("Work")));
  });

  it("says nothing when the verified token carried no tier", async () => {
    // An account linked before the claim existed, or any issuer that does not
    // emit one. Absent is normal and must read as absent.
    const { stdout } = await listWith([{
      ...TIERED[0], label: "Bare",
      attest_detail: JSON.stringify({ issuer: "https://auth.openai.com" }),
    }]);
    const line = stdout.split("\n").find((l) => l.includes("Bare"));
    expect(line).not.toMatch(/pro|plus/);
  });

  it("claims no tier for an account that was never attested", async () => {
    // The point of the field is that a provider vouched for it. An unattested
    // row carrying one is not evidence of anything, so it is not shown.
    const { stdout } = await listWith([{
      ...TIERED[0], label: "Unverified", attested: 0,
    }]);
    const line = stdout.split("\n").find((l) => l.includes("Unverified"));
    expect(line).not.toMatch(/pro/);
  });

  it("lists the account anyway when the detail is unreadable", async () => {
    // A listing must not fail over a malformed metadata field. The account is
    // still the lender's, and they still need to be able to `disconnect` it.
    const { stdout, code } = await listWith([{ ...TIERED[0], attest_detail: "{not json" }]);
    expect(code).toBe(0);
    expect(stdout).toContain("Work");
    expect(stdout).toContain("aaaa1111");
  });

  it("survives a detail that is valid JSON but not an object", async () => {
    const { stdout, code } = await listWith([{ ...TIERED[0], attest_detail: '"pro"' }]);
    expect(code).toBe(0);
    expect(stdout).toContain("Work");
  });
});

describe("removing by number", () => {
  it("removes the account at that position", async () => {
    const { code } = await run(["disconnect", "2"], { data });
    expect(code).toBe(0);
    expect(stub.deleted()).toEqual(["bbbb2222"]);
  });

  it("reads the listing first, so the number means what the user last saw", async () => {
    await run(["disconnect", "1"], { data });
    expect(stub.calls[0]).toMatchObject({ method: "GET", path: "/providers" });
    expect(stub.deleted()).toEqual(["aaaa1111"]);
  });

  it("says how many are left, which is the fact the lender is checking", async () => {
    const { stdout } = await run(["disconnect", "3"], { data });
    expect(stdout).toMatch(/2 accounts still connected/);
  });

  it("refuses a number past the end WITHOUT deleting anything", async () => {
    const { code, all } = await run(["disconnect", "9"], { data });
    expect(code).toBe(1);
    expect(all).toMatch(/no account 9/i);
    expect(stub.deleted()).toEqual([]);
  });

  it("refuses zero rather than wrapping to the last account", async () => {
    const { code } = await run(["disconnect", "0"], { data });
    expect(code).toBe(1);
    expect(stub.deleted()).toEqual([]);
  });
});

describe("removing by id", () => {
  it("takes a full id", async () => {
    await run(["disconnect", "cccc3333"], { data });
    expect(stub.deleted()).toEqual(["cccc3333"]);
  });

  it("takes an unambiguous prefix", async () => {
    await run(["disconnect", "bbbb"], { data });
    expect(stub.deleted()).toEqual(["bbbb2222"]);
  });

  it("refuses an ambiguous prefix rather than picking one", async () => {
    // The failure this prevents: two accounts share a prefix, we delete the
    // first match, and the lender loses a credential they never named.
    stub.stop();
    stub = stubServer({
      accounts: [
        { id: "dead0001", provider: "codex", account_key: "a", attested: 1 },
        { id: "dead0002", provider: "codex", account_key: "b", attested: 1 },
      ],
    });
    const { code, all } = await run(["disconnect", "dead"], { data: signedInData(stub.url) });
    expect(code).toBe(1);
    expect(all).toMatch(/matches 2 accounts/);
    expect(stub.deleted()).toEqual([]);
  });

  it("refuses an id that matches nothing", async () => {
    const { code, all } = await run(["disconnect", "nope"], { data });
    expect(code).toBe(1);
    expect(all).toMatch(/No account matching/i);
    expect(stub.deleted()).toEqual([]);
  });
});

describe("with no terminal to ask on", () => {
  it("does not hang or guess when told to remove nothing in particular", async () => {
    // The interactive branch picks from a menu. Without a TTY there is nothing
    // to pick with, and both blocking forever and defaulting to the first
    // account are worse than declining.
    const { code, all } = await run(["disconnect"], { data });
    expect(code).toBe(1);
    expect(all).toMatch(/Which account/i);
    expect(stub.deleted()).toEqual([]);
  });

  it("skips the confirmation, because there is no one to confirm", async () => {
    const { code } = await run(["disconnect", "1"], { data });
    expect(code).toBe(0);
    expect(stub.deleted()).toEqual(["aaaa1111"]);
  });

  it("lists the providers instead of opening a chooser", async () => {
    const { stdout, code } = await run(["connect"], { data });
    expect(code).toBe(0);
    expect(stdout).toMatch(/aile connect <name>/);
  });
});

describe("naming an account", () => {
  it("renames the account at that position", async () => {
    const { code } = await run(["label", "2", "Home", "laptop"], { data });
    expect(code).toBe(0);
    const patch = stub.calls.find((c) => c.method === "PATCH");
    expect(patch.path).toBe("/providers/bbbb2222");
    // The rest of the line is the name, so it does not need quoting to survive.
    expect(patch.body).toEqual({ label: "Home laptop" });
  });

  it("takes an id as readily as a number", async () => {
    await run(["label", "cccc3333", "Spare"], { data });
    expect(stub.calls.find((c) => c.method === "PATCH").path).toBe("/providers/cccc3333");
  });

  it("refuses a name for an account that does not exist, without a PATCH", async () => {
    const { code } = await run(["label", "9", "Nope"], { data });
    expect(code).toBe(1);
    expect(stub.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("declines rather than clearing the name when none was given", async () => {
    const { code, all } = await run(["label", "1"], { data });
    expect(code).toBe(1);
    expect(all).toMatch(/No name given/i);
    expect(stub.calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});

describe("a machine that is not set up", () => {
  it("every account command says so instead of calling the server", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "aile-accounts-out-"));
    scratches.push(empty);
    for (const argv of [["accounts"], ["disconnect", "1"], ["label", "1", "x"]]) {
      const { code, all } = await run([...argv, "--server", stub.url], { data: empty });
      expect({ argv, code }).toEqual({ argv, code: 1 });
      expect(all).toMatch(/not set up/i);
      // Both ways forward, not just the paid one: a machine whose owner does
      // not want an account can still serve, and a message naming only `login`
      // reads as though it cannot.
      expect(all).toMatch(/aile login/);
      expect(all).toMatch(/aile donate/);
    }
    expect(stub.calls).toHaveLength(0);
  });
});
