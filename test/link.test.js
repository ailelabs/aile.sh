/**
 * Connecting a provider account.
 *
 * The invariant worth testing here is a negative, and it is the one this
 * module's header promises: PROVIDER TOKENS ARE NEVER WRITTEN TO DISK ON THIS
 * MACHINE. They exist in memory for the seconds between the OAuth exchange and
 * the upload, and that is all. The server has to hold them anyway — it
 * terminates TLS with the provider — so a local copy would be a second place to
 * steal them from and buy nothing.
 *
 * The other property is ordering. The nonce must be fetched from the server
 * BEFORE the OAuth flow runs, because the whole point is that the server picks
 * it: a nonce chosen locally, or fetched afterwards and stapled on, proves
 * nothing about who authenticated. So these tests assert the sequence, not just
 * that each call happened.
 */

import { describe, expect, it, beforeEach, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { connectProvider } from "../src/providers/link.js";
import { isLinkable } from "../src/providers/flows.js";
import { PROVIDER_IDS, getProvider } from "../src/providers/catalog.js";
import { saveConfig } from "../src/relay/config.js";
import { saveState, loadNodeSecret } from "../src/relay/state.js";
import { TEST_AILE_DIR } from "./setup.js";

const SECRET = "sk-provider-PLAINTEXT-SECRET";
const REFRESH = "rt-provider-PLAINTEXT-SECRET";

/** A stub aile.sh that records the order it was called in. */
function stubServer({ attestable = true, nonce = "server-chosen-nonce-123", save = null } = {}) {
  const calls = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.json().catch(() => ({}));
      calls.push({ path: url.pathname, body, auth: req.headers.get("authorization") });

      if (url.pathname === "/providers/nonce") {
        return Response.json({ success: true, data: { nonce, expiresIn: 900, attestable }, message: "" });
      }
      if (url.pathname === "/providers") {
        if (save) return Response.json({ success: true, data: save(body), message: "" });
        return Response.json({
          success: true,
          data: { ok: true, account: { id: "acct-1", provider: body.provider, attested: attestable ? 1 : 0 } },
          message: "",
        });
      }
      return Response.json({ success: false, message: "not found", error: "not found" }, { status: 404 });
    },
  });
  return {
    calls,
    nonce,
    url: `http://127.0.0.1:${server.port}`,
    stop: () => { try { server.stop(true); } catch { /* ignore */ } },
  };
}

/** Every file under the data dir, flattened, so nothing can hide in a subdir. */
function filesOnDisk(dir = TEST_AILE_DIR, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) filesOnDisk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * Populate the data dir the way a signed-in machine has it.
 *
 * Without this the leak tests below scan an EMPTY directory and pass
 * vacuously — the strongest assertion in this file would be checking nothing.
 * So every persisted file the app writes must exist before we look for a token
 * in them, and `guardsAreLive` proves the search itself works.
 */
function populateDataDir() {
  saveConfig({ serverUrl: "https://api.aile.sh", renterToken: "ail_persisted_account_token" });
  saveState({ nodeId: "test-node", connectedAt: new Date().toISOString() });
  loadNodeSecret(); // generates and writes the node secret file
}

let stub;
const opened = [];
const logged = [];

beforeEach(() => {
  stub?.stop();
  stub = null;
  opened.length = 0;
  logged.length = 0;
});

afterAll(() => stub?.stop());

/** Run connectProvider against the stub, with the OAuth flow itself stubbed. */
function connect(providerId, { linkResult, ...opts } = {}) {
  return connectProvider(providerId, {
    serverUrl: stub.url,
    renterToken: "ail_test_token",
    log: (m) => logged.push(String(m)),
    openBrowser: (u) => opened.push(u),
    ...opts,
  });
}

// ---------------------------------------------------------------------------

describe("the sequence", () => {
  it("asks the server for a nonce BEFORE running the OAuth flow", async () => {
    stub = stubServer();
    let nonceSeenByFlow = null;
    let calledAt = -1;

    await connectProvider("codex", {
      serverUrl: stub.url,
      renterToken: "ail_test_token",
      log: () => {},
      openBrowser: () => {},
      // Injected in place of the real flow, so we observe what it was handed.
      runFlow: async (_id, { nonce }) => {
        nonceSeenByFlow = nonce;
        calledAt = stub.calls.length;
        return { accessToken: SECRET, refreshToken: REFRESH, idToken: "id.tok.sig" };
      },
    });

    // The flow ran after exactly one server call — the nonce request.
    expect(calledAt).toBe(1);
    expect(stub.calls[0].path).toBe("/providers/nonce");
    expect(nonceSeenByFlow).toBe(stub.nonce);
  });

  it("withholds the nonce from a provider the server cannot attest", async () => {
    // The nonce reaches the PROVIDER only where the server can check what comes
    // back. Elsewhere it asks the lender's provider to carry a value nothing
    // will verify — and against an endpoint that refuses parameters it does not
    // recognise, it costs the sign-in outright. `attestable` is the server's own
    // answer about its JWKS table, so this cannot drift from it.
    stub = stubServer({ attestable: false });
    let nonceSeenByFlow = "not-set";
    await connect("cursor", {
      runFlow: async (_id, { nonce }) => {
        nonceSeenByFlow = nonce;
        return { accessToken: SECRET };
      },
    });
    expect(nonceSeenByFlow).toBeNull();
  });

  it("still uploads it, because the server tracks nonces it did not use", async () => {
    // Withholding it from the provider is not the same as discarding it: the
    // server issued it against this renter and expects to see it back.
    stub = stubServer({ attestable: false });
    await connect("cursor", { runFlow: async () => ({ accessToken: SECRET }) });
    expect(stub.calls.find((c) => c.path === "/providers").body.nonce).toBe(stub.nonce);
  });

  it("uploads the same nonce the server issued, not one of its own", async () => {
    stub = stubServer();
    await connect("codex", {
      runFlow: async () => ({ accessToken: SECRET, idToken: "id.tok.sig" }),
    });

    const upload = stub.calls.find((c) => c.path === "/providers");
    expect(upload.body.nonce).toBe(stub.nonce);
  });

  it("authenticates both calls as the signed-in account", async () => {
    stub = stubServer();
    await connect("codex", { runFlow: async () => ({ accessToken: SECRET }) });
    for (const call of stub.calls) {
      expect(call.auth).toBe("Bearer ail_test_token");
    }
  });

  it("does not upload anything when the OAuth flow fails", async () => {
    stub = stubServer();
    await expect(connect("codex", {
      runFlow: async () => { throw new Error("user closed the browser"); },
    })).rejects.toThrow(/user closed the browser/);

    expect(stub.calls.map((c) => c.path)).toEqual(["/providers/nonce"]);
  });
});

describe("provider tokens never touch this disk", () => {
  beforeEach(() => populateDataDir());

  // A search that finds nothing proves nothing unless it can find something.
  // This asserts the sandbox is populated AND that reading it would surface a
  // planted secret — so a green run below is a real absence, not an empty scan.
  it("the search itself works: a planted secret in the data dir IS found", () => {
    const files = filesOnDisk();
    expect(files.length).toBeGreaterThan(0);

    const decoy = path.join(TEST_AILE_DIR, "decoy.json");
    fs.writeFileSync(decoy, JSON.stringify({ accessToken: SECRET }));
    try {
      const found = filesOnDisk().filter((f) => fs.readFileSync(f, "latin1").includes(SECRET));
      expect(found).toEqual([decoy]);
    } finally {
      fs.rmSync(decoy, { force: true });
    }
  });

  it("no file under the data dir contains the access or refresh token", async () => {
    stub = stubServer();
    await connect("codex", {
      runFlow: async () => ({
        accessToken: SECRET, refreshToken: REFRESH, idToken: "id.tok.sig",
      }),
    });

    const files = filesOnDisk();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = fs.readFileSync(file, "latin1");
      expect({ file, hasAccess: text.includes(SECRET), hasRefresh: text.includes(REFRESH) })
        .toEqual({ file, hasAccess: false, hasRefresh: false });
    }
  });

  it("not even after a failed upload, when nothing was persisted anywhere", async () => {
    stub = stubServer();
    stub.stop();
    // Point at a closed port: the upload throws after the tokens are in memory.
    await expect(connectProvider("codex", {
      serverUrl: stub.url,
      renterToken: "ail_test_token",
      log: () => {},
      openBrowser: () => {},
      runFlow: async () => ({ accessToken: SECRET, refreshToken: REFRESH }),
    })).rejects.toThrow();

    const files = filesOnDisk();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(fs.readFileSync(file, "latin1").includes(SECRET)).toBe(false);
    }
  });

  it("does not log the token either — the console is a disk on CI", async () => {
    stub = stubServer();
    await connect("codex", {
      runFlow: async () => ({ accessToken: SECRET, refreshToken: REFRESH }),
    });
    expect(logged.join("\n")).not.toContain(SECRET);
    expect(logged.join("\n")).not.toContain(REFRESH);
  });
});

describe("what the user is told", () => {
  it("says so when a provider cannot be cryptographically verified", async () => {
    stub = stubServer({ attestable: false });
    await connect("cursor", { runFlow: async () => ({ accessToken: SECRET }) });

    const out = logged.join("\n");
    expect(out).toMatch(/no verification keys/i);
    expect(out).toMatch(/unverified claim/i);
  });

  it("stays quiet about attestation when the provider does publish keys", async () => {
    stub = stubServer({ attestable: true });
    await connect("codex", { runFlow: async () => ({ accessToken: SECRET }) });
    expect(logged.join("\n")).not.toMatch(/unverified claim/i);
  });

  it("refuses an unknown provider by name", async () => {
    stub = stubServer();
    await expect(connect("not-a-provider")).rejects.toThrow(/Unknown provider/);
  });

  it("refuses before any network call when the machine is not set up", async () => {
    stub = stubServer();
    await expect(connectProvider("codex", {
      serverUrl: stub.url, renterToken: "", log: () => {}, openBrowser: () => {},
    })).rejects.toThrow(/not set up/i);
    expect(stub.calls).toHaveLength(0);
  });
});

/**
 * Linking a second account of a provider.
 *
 * The distinction the server draws — added versus replaced — has to survive
 * back to the caller, because those are different events for the lender. A
 * re-link refreshes a credential; a second link adds capacity. Reporting the
 * first as the second is how someone ends up wondering where their other
 * account went.
 */
describe("a second account of the same provider", () => {
  it("passes the lender's own name and key through to the server", async () => {
    stub = stubServer({ attestable: false });
    await connect("cursor", {
      label: "Work laptop", accountKey: "work",
      runFlow: async () => ({ accessToken: SECRET }),
    });

    const upload = stub.calls.find((c) => c.path === "/providers");
    expect(upload.body).toMatchObject({ label: "Work laptop", accountKey: "work" });
  });

  it("sends both as null when the lender named neither", async () => {
    // Explicitly null rather than absent: the server distinguishes "no key was
    // chosen" from "this client predates keys", and only the first defaults.
    stub = stubServer({ attestable: false });
    await connect("cursor", { runFlow: async () => ({ accessToken: SECRET }) });

    const upload = stub.calls.find((c) => c.path === "/providers");
    expect(upload.body.label).toBeNull();
    expect(upload.body.accountKey).toBeNull();
  });

  it("sends the nodeless opt-in only when the caller asked for one", async () => {
    // `null` here means "say nothing", which is NOT the same as `false`. Sending
    // an explicit null would fail the server's boolean check outright, and this
    // client sent the field not at all until now — which is why a key linked from
    // a terminal could never serve nodeless while the same key linked in a browser
    // could.
    stub = stubServer({ attestable: false });
    await connect("cursor", { runFlow: async () => ({ accessToken: SECRET }) });
    let upload = stub.calls.find((c) => c.path === "/providers");
    expect("allowNodeless" in upload.body).toBe(false);

    stub.stop();
    stub = stubServer({ attestable: false });
    await connect("cursor", { allowNodeless: true, runFlow: async () => ({ accessToken: SECRET }) });
    upload = stub.calls.find((c) => c.path === "/providers");
    expect(upload.body.allowNodeless).toBe(true);
  });

  it("sends an explicit false when the caller opted OUT", async () => {
    // Distinct from silence: this is the lender saying no, and it must reach the
    // server rather than being folded into "unset".
    stub = stubServer({ attestable: false });
    await connect("cursor", { allowNodeless: false, runFlow: async () => ({ accessToken: SECRET }) });
    const upload = stub.calls.find((c) => c.path === "/providers");
    expect(upload.body.allowNodeless).toBe(false);
  });

  it("names the account to replace, and omits the field when replacing nothing", async () => {
    stub = stubServer({ attestable: false });
    await connect("cursor", { replaceAccountId: "acct-9", runFlow: async () => ({ accessToken: SECRET }) });
    let upload = stub.calls.find((c) => c.path === "/providers");
    expect(upload.body.replaceAccountId).toBe("acct-9");

    stub.stop();
    stub = stubServer({ attestable: false });
    await connect("cursor", { runFlow: async () => ({ accessToken: SECRET }) });
    upload = stub.calls.find((c) => c.path === "/providers");
    // Absent, not null: a null here would read as naming a row rather than none.
    expect("replaceAccountId" in upload.body).toBe(false);
  });

  it("carries the per-provider ceiling back, so the caller can warn before it bites", async () => {
    stub = stubServer({
      attestable: false,
      save: (b) => ({ ok: true, added: true, total: 9, maxAccountsPerProvider: 10, account: { id: "acct-9", provider: b.provider, attested: 0 } }),
    });
    const account = await connect("cursor", { runFlow: async () => ({ accessToken: SECRET }) });
    expect(account.maxPerProvider).toBe(10);
    // `total` from the server is the count for THIS provider, not the grand total.
    expect(account.providerTotal).toBe(9);
  });

  it("reports a new account as added", async () => {
    stub = stubServer({
      attestable: false,
      save: (b) => ({ ok: true, added: true, total: 2, account: { id: "acct-2", provider: b.provider, attested: 0 } }),
    });
    const account = await connect("cursor", { runFlow: async () => ({ accessToken: SECRET }) });
    expect(account).toMatchObject({ id: "acct-2", added: true, total: 2 });
  });

  it("reports a re-link as a replacement, not as an addition", async () => {
    stub = stubServer({
      attestable: false,
      save: (b) => ({ ok: true, added: false, total: 1, account: { id: "acct-1", provider: b.provider, attested: 0 } }),
    });
    const account = await connect("cursor", { runFlow: async () => ({ accessToken: SECRET }) });
    expect(account.added).toBe(false);
    expect(account.total).toBe(1);
  });

  it("assumes added when talking to a server too old to say", async () => {
    // The safe default is the truthful one for every server that predates the
    // field: before it existed, a successful link was always an add.
    stub = stubServer({
      attestable: false,
      save: (b) => ({ ok: true, account: { id: "acct-1", provider: b.provider, attested: 0 } }),
    });
    const account = await connect("cursor", { runFlow: async () => ({ accessToken: SECRET }) });
    expect(account.added).toBe(true);
    expect(account.total).toBeNull();
  });
});

/**
 * A pasted key travels the same upload path as an OAuth token, which is the
 * point — one credential type reaching the server one way, with no branch to get
 * wrong. What must NOT travel with it is the display hint the provider offered
 * back: `suggestedLabel` is a label, and the rest of that object goes into the
 * encrypted credential blob.
 */
describe("a key-based provider uploads by the same path", () => {
  it("keeps the display hint out of the credential blob", async () => {
    stub = stubServer({ attestable: false });
    await connect("cursor", {
      runFlow: async () => ({ accessToken: SECRET, suggestedLabel: "laptop" }),
    });

    const upload = stub.calls.find((c) => c.path === "/providers");
    expect(upload.body.tokens).toEqual({ accessToken: SECRET });
    expect("suggestedLabel" in upload.body.tokens).toBe(false);
    expect(upload.body.label).toBe("laptop");
  });

  it("lets the lender's own --label win over the provider's suggestion", async () => {
    // They named it deliberately; the provider named it incidentally.
    stub = stubServer({ attestable: false });
    await connect("cursor", {
      label: "Work",
      runFlow: async () => ({ accessToken: SECRET, suggestedLabel: "laptop" }),
    });

    expect(stub.calls.find((c) => c.path === "/providers").body.label).toBe("Work");
  });

  it("sends a null label when neither named it", async () => {
    stub = stubServer({ attestable: false });
    await connect("cursor", { runFlow: async () => ({ accessToken: SECRET }) });
    expect(stub.calls.find((c) => c.path === "/providers").body.label).toBeNull();
  });

  it("hands the collected key down to the flow rather than inventing one", async () => {
    stub = stubServer({ attestable: false });
    let seen;
    await connect("cursor", {
      apiKey: "sk-or-collected",
      runFlow: async (_id, ctx) => { seen = ctx.apiKey; return { accessToken: SECRET }; },
    });
    expect(seen).toBe("sk-or-collected");
  });
});

describe("the catalog agrees with itself", () => {
  it("every provider declares a flow, and linkable means we implement it", () => {
    for (const id of PROVIDER_IDS) {
      const p = getProvider(id);
      expect({ id, hasFlow: Boolean(p.flow) }).toEqual({ id, hasFlow: true });
      // isLinkable is what `aile connect` filters on; it must agree with the
      // dispatch table rather than being a second, drifting list.
      expect({ id, linkable: isLinkable(id) })
        .toEqual({ id, linkable: ["authcode", "device", "google"].includes(p.flow) });
    }
  });

  it("a manual-token provider is refused by the flow runner, not half-run", async () => {
    const manual = PROVIDER_IDS.filter((id) => !isLinkable(id));
    expect(manual.length).toBeGreaterThan(0);

    stub = stubServer({ attestable: false });
    // No __linkProvider override: this exercises the real dispatch.
    await expect(connect(manual[0])).rejects.toThrow(/pasting a token|not supported/i);
  });
});
