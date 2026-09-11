/**
 * Asking a provider whether a credential works, and what that answer is allowed
 * to mean.
 *
 * THE INVARIANT THAT MATTERS HERE IS A NEGATIVE, and it is a trust-model one: a
 * probe pass must never become `attested`. Attestation is a provider-SIGNED
 * id_token verified server-side against a JWKS with a server-chosen nonce — it
 * says WHOSE account this is. A probe says only that the credential is live, and
 * it is observed by the lender's own machine, which is the machine the trust
 * model does not trust. If this file ever goes green while `attested` is being
 * written from a probe, the badge on every account that earned it honestly has
 * become meaningless. See docs/PROTOCOL.md §7 and src/relay/attest.js.
 *
 * The second property is that a probe cannot cost a lender their sign-in. Unlike
 * a pasted key — unverified until proven otherwise — an OAuth token came from a
 * completed browser flow, so a probe that says no is more often a fussy endpoint
 * or a URL this repo has wrong than a bad credential. Every failure mode below
 * therefore asserts the upload still happened.
 *
 * NOTHING HERE LEAVES LOOPBACK. The real PROBES table points at api.anthropic.com,
 * so every test injects `fetchImpl` or points a synthetic provider at a local
 * server. A test that reached a real provider would fail in CI, leak whether a
 * machine has network, and — for the rejection cases — be asserting something
 * about Anthropic's uptime rather than about this code.
 */

import { describe, expect, it, beforeEach, afterAll } from "bun:test";

import { probeCredential, probeTarget, authHeaderFor, PROBES } from "../src/providers/probe.js";
import { connectProvider } from "../src/providers/link.js";
import { getProvider, PROVIDERS } from "../src/providers/index.js";
import { PROVIDER_HOSTS } from "../src/relay/provider-hosts.js";

const SECRET = "sk-probe-PLAINTEXT-SECRET";

/** A stub aile.sh, recording what was uploaded. */
function stubServer({ attestable = false, account = null } = {}) {
  const calls = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.json().catch(() => ({}));
      calls.push({ path: url.pathname, body });

      if (url.pathname === "/providers/nonce") {
        return Response.json({ nonce: "server-nonce-1", expiresIn: 900, attestable });
      }
      if (url.pathname === "/providers") {
        return Response.json({
          ok: true, added: true, total: 1,
          account: account || { id: "acct-1", provider: body.provider, attested: 0 },
        });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  return {
    calls,
    url: `http://127.0.0.1:${server.port}`,
    upload: () => calls.find((c) => c.path === "/providers"),
    stop: () => { try { server.stop(true); } catch { /* ignore */ } },
  };
}

let stub;
const logged = [];

beforeEach(() => {
  stub?.stop();
  stub = null;
  logged.length = 0;
});

afterAll(() => stub?.stop());

/** connectProvider against the stub with the OAuth flow itself stubbed out. */
function connect(providerId, { probe, ...opts } = {}) {
  return connectProvider(providerId, {
    serverUrl: stub.url,
    renterToken: "ail_test_token",
    log: (m) => logged.push(String(m)),
    openBrowser: () => {},
    runFlow: async () => ({ accessToken: SECRET }),
    ...(probe !== undefined ? { probe } : {}),
    ...opts,
  });
}

// ---------------------------------------------------------------------------

describe("a probe result is not attestation", () => {
  it("does not report a passing probe as attested", async () => {
    // The whole point. `attested` comes from a signed id_token the SERVER
    // verified; a probe is this machine's own observation and can never earn it.
    stub = stubServer({ attestable: false });
    const account = await connect("cursor", { probe: async () => ({ ok: true, reason: "ok" }) });
    expect(account.attested).toBe(0);
    expect(account.probe_ok).toBe(1);
  });

  it("uploads the probe result in its own field, never as attested", async () => {
    stub = stubServer({ attestable: false });
    await connect("cursor", { probe: async () => ({ ok: true, reason: "ok" }) });

    const body = stub.upload().body;
    expect(body.probe).toEqual({ ok: true, reason: "ok" });
    // A client that could set this could mint the strong claim from the weak one.
    expect("attested" in body).toBe(false);
  });

  it("lets the server's own answer win over what this machine observed", async () => {
    // A server that checks for itself has an answer worth more than ours: it
    // watched the provider accept the credential, rather than being told so by
    // the machine under test.
    stub = stubServer({
      attestable: false,
      account: { id: "acct-1", provider: "cursor", attested: 0, probe_ok: 0 },
    });
    const account = await connect("cursor", { probe: async () => ({ ok: true, reason: "ok" }) });
    expect(account.probe_ok).toBe(0);
  });
});

describe("a probe cannot cost a lender their sign-in", () => {
  for (const reason of ["rejected", "network", "upstream", "blocked", "no-target"]) {
    it(`still uploads when the probe answers "${reason}"`, async () => {
      stub = stubServer({ attestable: false });
      const account = await connect("cursor", { probe: async () => ({ ok: false, reason }) });
      expect(stub.upload()).toBeTruthy();
      expect(account.probe_ok).toBe(0);
    });
  }

  it("says so out loud when the provider actually rejected the credential", async () => {
    // The one failure worth a lender's attention: not a flaky network, but the
    // provider declining what the sign-in just produced.
    stub = stubServer({ attestable: false });
    await connect("cursor", { probe: async () => ({ ok: false, reason: "rejected" }) });
    expect(logged.join("\n")).toMatch(/did not accept/i);
  });

  it("stays quiet when it merely could not ask", async () => {
    // A lender on a flaky connection must not be told their account is bad.
    stub = stubServer({ attestable: false });
    await connect("cursor", { probe: async () => ({ ok: false, reason: "network" }) });
    expect(logged.join("\n")).not.toMatch(/did not accept/i);
  });

  it("links exactly as before when probing is switched off", async () => {
    stub = stubServer({ attestable: false });
    const account = await connect("cursor", { probe: null });
    expect(stub.upload().body.probe).toBeNull();
    expect(account.probe_ok).toBe(0);
  });
});

describe("what the probe sends", () => {
  /** A provider whose probe target is on this machine. */
  function localProvider(port, auth) {
    return {
      id: "stubprobe",
      name: "StubProbe",
      oauth: { userInfoUrl: `http://127.0.0.1:${port}/whoami` },
      transport: auth ? { auth } : undefined,
    };
  }

  function echoServer({ status = 200 } = {}) {
    const seen = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        seen.push({ method: req.method, headers: Object.fromEntries(req.headers) });
        return status === 200
          ? Response.json({ ok: true })
          : new Response("no", { status });
      },
    });
    return {
      seen, port: server.port,
      stop: () => { try { server.stop(true); } catch { /* ignore */ } },
    };
  }

  let echo;
  beforeEach(() => { echo?.stop(); echo = null; });
  afterAll(() => echo?.stop());

  /**
   * 127.0.0.1 is not in the baked allowlist, so these tests widen it for the
   * duration of one call. Takes a THUNK, not a promise: an argument is evaluated
   * before the function it is passed to runs, so `allowLocal(probe(...))` would
   * add the host after the probe had already been refused — which is how the
   * first draft of these tests failed against a correct allowlist check.
   */
  const allowLocal = async (fn) => {
    PROVIDER_HOSTS.add("127.0.0.1");
    try { return await fn(); } finally { PROVIDER_HOSTS.delete("127.0.0.1"); }
  };

  it("presents the credential the way the relay will when it serves", async () => {
    // Reusing transport.auth is the point: a probe that authenticated
    // differently to the real request could pass while every buyer request fails.
    echo = echoServer();
    const provider = localProvider(echo.port, { oauth: { header: "Authorization", scheme: "bearer" } });
    const res = await allowLocal(() => probeCredential(provider, { accessToken: SECRET }));

    expect(res.ok).toBe(true);
    expect(echo.seen[0].headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(echo.seen[0].method).toBe("GET");
  });

  it("honours a raw-scheme provider rather than assuming bearer", async () => {
    echo = echoServer();
    const provider = localProvider(echo.port, { combined: true, header: "x-api-key", scheme: "raw" });
    await allowLocal(() => probeCredential(provider, { accessToken: SECRET }));

    expect(echo.seen[0].headers["x-api-key"]).toBe(SECRET);
    expect(echo.seen[0].headers.authorization).toBeUndefined();
  });

  it("reads 401 as a rejection and 500 as the provider being unwell", async () => {
    // They are not the same event: one means the credential is bad, the other
    // means we learned nothing. Only the first is worth telling a lender about.
    echo = echoServer({ status: 401 });
    const rejected = await allowLocal(() => probeCredential(localProvider(echo.port), { accessToken: SECRET }));
    expect(rejected).toMatchObject({ ok: false, reason: "rejected" });
    echo.stop();

    echo = echoServer({ status: 500 });
    const unwell = await allowLocal(() => probeCredential(localProvider(echo.port), { accessToken: SECRET }));
    expect(unwell).toMatchObject({ ok: false, reason: "upstream" });
  });

  it("reports a failure to ask as network, not as a bad credential", async () => {
    const provider = { id: "x", name: "X", oauth: { userInfoUrl: "http://127.0.0.1:1/whoami" } };
    const res = await allowLocal(() => probeCredential(provider, { accessToken: SECRET }, { timeoutMs: 1000 }));
    expect(res.reason).toBe("network");
  });
});

describe("the probe cannot widen egress", () => {
  it("refuses a target that is not in the baked allowlist", async () => {
    // provider-hosts.js is generated and baked at build time so no
    // hand-maintained list can turn a node into a proxy. A check here that could
    // also ADD would be worthless.
    let called = false;
    const provider = { id: "x", name: "X", oauth: { userInfoUrl: "https://evil.example/whoami" } };
    const res = await probeCredential(provider, { accessToken: SECRET }, {
      fetchImpl: async () => { called = true; return new Response("{}"); },
    });

    expect(res).toMatchObject({ ok: false, reason: "blocked" });
    expect(called).toBe(false);
  });

  it("every hand-written probe target is already allowlisted", () => {
    for (const [id, probe] of Object.entries(PROBES)) {
      expect({ id, allowed: PROVIDER_HOSTS.has(new URL(probe.url).hostname) })
        .toEqual({ id, allowed: true });
    }
  });

  it("every probe target this build would use is allowlisted", () => {
    // PROBES is only one of three sources. A catalog `userInfoUrl` pointing at a
    // host the relay will not dial produces a permanent `blocked` — an account
    // stuck unverified for a reason no lender could diagnose.
    for (const p of PROVIDERS) {
      const target = probeTarget(p);
      if (!target) continue;
      expect({ id: p.id, allowed: PROVIDER_HOSTS.has(new URL(target.url).hostname) })
        .toEqual({ id: p.id, allowed: true });
    }
  });

  it("asks nothing at all when there is no target and no token", async () => {
    let called = false;
    const fetchImpl = async () => { called = true; return new Response("{}"); };

    // No endpoint known for this provider.
    expect(await probeCredential({ id: "x", name: "X" }, { accessToken: SECRET }, { fetchImpl }))
      .toMatchObject({ reason: "no-target" });
    // And no credential to ask with.
    expect(await probeCredential(getProvider("claude"), {}, { fetchImpl }))
      .toMatchObject({ reason: "no-target" });

    expect(called).toBe(false);
  });
});

describe("the providers we can actually check", () => {
  it("knows where to ask Claude, which the catalog cannot tell us", () => {
    // claude has no `openid` scope and no userInfoUrl, so it can never be
    // attested — a probe is the only signal available for it at all.
    const target = probeTarget(getProvider("claude"));
    expect(target).toBeTruthy();
    expect(target.url).toStartWith("https://api.anthropic.com/");
    // Mandatory on every api.anthropic.com route; without it the call 400s and
    // would read as a rejected credential.
    expect(target.headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("prefers the generated catalog's own endpoint over the hand-written table", () => {
    // The registry-derived URL is refreshed by the sync script; a URL written
    // here rots silently.
    expect(probeTarget(getProvider("github")).url).toBe("https://api.github.com/user");
  });

  it("reuses the key-verification endpoint byok.js already maintains", () => {
    // Not a second URL for the same question. `verifyUrl` is fetched on every
    // key link, so it is the best-tested endpoint we have for these providers,
    // and one notion of "does this credential work" cannot drift from itself.
    for (const id of ["groq", "together", "mistral"]) {
      expect({ id, url: probeTarget(getProvider(id))?.url })
        .toEqual({ id, url: getProvider(id).apiKey.verifyUrl });
    }
  });

  it("uses OpenRouter's authenticated route, not its public model list", () => {
    // https://openrouter.ai/api/v1/models answers 200 with NO credential, so a
    // probe against it would pass for any garbage string — the exact "guessed a
    // URL" failure this module's PROBES comment warns about. /api/v1/key is
    // authenticated, and is what byok.js already verifies keys against.
    expect(probeTarget(getProvider("openrouter")).url).toBe("https://openrouter.ai/api/v1/key");
  });

  it("a PROBES entry is a fallback, so it cannot shadow a catalog URL", () => {
    // Precedence runs weakest-rot-first. If a hand-written entry could override
    // the generated one, a stale local URL would silently win over the value the
    // sync script keeps fresh — and the fix would land in the wrong repo.
    const withBoth = {
      id: "claude",                                  // has a PROBES entry
      oauth: { userInfoUrl: "https://api.github.com/user" },
    };
    expect(probeTarget(withBoth).url).toBe("https://api.github.com/user");
  });

  it("never probes a completions endpoint, which would bill the lender", () => {
    // Checking a credential must be free. On a metered account a completions
    // call is a real charge for a link the lender may then abandon.
    for (const [id, probe] of Object.entries(PROBES)) {
      expect({ id, billable: /completions|\/v1\/messages|responses/.test(probe.url) })
        .toEqual({ id, billable: false });
    }
  });

  it("believes a flow that already checked, rather than asking twice", async () => {
    // runApiKeyFlow fetches `verifyUrl` and throws unless it passed, so by the
    // time link.js runs, the answer is already in hand. Probing again would send
    // a second identical request to learn it.
    stub = stubServer({ attestable: false });
    let probes = 0;
    const account = await connect("openrouter", {
      runFlow: async () => ({ accessToken: SECRET, probed: { ok: true, reason: "ok" } }),
      probe: async () => { probes++; return { ok: false, reason: "rejected" }; },
    });

    expect(probes).toBe(0);
    expect(stub.upload().body.probe).toEqual({ ok: true, reason: "ok" });
    expect(account.probe_ok).toBe(1);
  });

  it("still probes a flow that reports nothing", async () => {
    // The OAuth flows report no `probed`, so they must keep being asked — the
    // shortcut above is for the one flow that genuinely already knows.
    stub = stubServer({ attestable: false });
    let probes = 0;
    await connect("cursor", {
      probe: async () => { probes++; return { ok: true, reason: "ok" }; },
    });
    expect(probes).toBe(1);
  });

  it("returns no target for a provider we have no free endpoint for", () => {
    // The honest outcome — such a provider keeps exactly the behaviour it has
    // today. Guessing a URL would report live credentials as dead.
    expect(probeTarget(getProvider("codex"))).toBeNull();
  });

  it("defaults to bearer for a provider that describes no auth", () => {
    expect(authHeaderFor({ id: "x" }, "tok")).toEqual({ Authorization: "Bearer tok" });
  });
});
