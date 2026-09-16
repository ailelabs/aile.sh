/**
 * Bring-your-own-key providers: the entries a lender pastes a key into, the merge
 * that decides which entries a node can actually serve, and the key check that
 * runs before anything is uploaded.
 *
 * THE FAILURE MODE THIS FILE GUARDS is quiet in every direction. A wrong `host`
 * produces capacity a node refuses to dial, a wrong `verifyUrl` checks the key
 * against one provider and relays it to another, and a `network` error misread as
 * a rejection tells a lender their perfectly good key is invalid. None of those
 * crash. Each one just makes the product wrong for one person at a time. These
 * rows are generated from the relay's registry now rather than hand-written here,
 * which fixes the drift but not one of those failures — a regeneration can still
 * move a host out from under the allowlist.
 *
 * The other property asserted here is a NEGATIVE one, and it is the security
 * control: this merge can only ever intersect with the generated egress
 * allowlist, never widen it. See ../src/providers/index.js.
 */

import { describe, expect, it } from "bun:test";

import {
  PROVIDERS, PROVIDER_IDS, UNSERVABLE_OAUTH_EXTRA, getProvider, isApiKeyProvider,
} from "../src/providers/index.js";
import { PROVIDER_HOSTS } from "../src/relay/provider-hosts.js";
import { isLinkable, needsApiKey, linkProvider } from "../src/providers/flows.js";
import { verifyApiKey, runApiKeyFlow } from "../src/providers/apikey.js";

/** A fetch that never leaves the machine, and records what it was asked. */
function stubFetch(responder) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, headers: init.headers || {} });
    return responder(url, init);
  };
  impl.calls = calls;
  return impl;
}

const ok = (body = {}) => stubFetch(async () => new Response(JSON.stringify(body), {
  status: 200, headers: { "content-type": "application/json" },
}));

const status = (code) => stubFetch(async () => new Response("nope", { status: code }));

const OPENROUTER = getProvider("openrouter");

/** Every key-based entry, whichever file it came from. */
const KEYED = PROVIDERS.filter((p) => p.flow === "apikey");

// ---------------------------------------------------------------------------

describe("the key-based entries", () => {
  it("offers any at all", () => {
    // A regeneration that emitted none would remove `aile connect groq` without
    // one error message anywhere.
    expect(KEYED.length).toBeGreaterThan(0);
  });

  it("every entry declares the three things the flow needs", () => {
    for (const p of KEYED) {
      expect({
        id: p.id,
        hasName: Boolean(p.name),
        hasHost: Boolean(p.apiKey?.host),
        hasVerifyUrl: Boolean(p.apiKey?.verifyUrl),
      }).toEqual({ id: p.id, hasName: true, hasHost: true, hasVerifyUrl: true });
    }
  });

  it("verifies the key against the SAME host it will be relayed to", () => {
    // A mismatch is the nastiest bug this file can catch: the key checks out
    // against one provider and is then relayed to a different one, so the lender
    // is told it works and every buyer request 401s.
    for (const p of KEYED) {
      expect({ id: p.id, host: new URL(p.apiKey.verifyUrl).hostname })
        .toEqual({ id: p.id, host: p.apiKey.host });
    }
  });

  it("only ever speaks https, to the provider and to the lender", () => {
    for (const p of KEYED) {
      expect({ id: p.id, verify: new URL(p.apiKey.verifyUrl).protocol }).toEqual({ id: p.id, verify: "https:" });
      if (p.apiKey.keyUrl) {
        expect({ id: p.id, keyUrl: new URL(p.apiKey.keyUrl).protocol }).toEqual({ id: p.id, keyUrl: "https:" });
      }
    }
  });
});

describe("the merged view", () => {
  it("cannot widen the egress allowlist — every served key host is already in it", () => {
    // The whole point of provider-hosts.js being generated and baked at build
    // time is that no hand-maintained file can add to it. If this ever fails, an
    // entry has become a host a node will dial without the allowlist saying so.
    for (const p of KEYED) {
      expect({ id: p.id, allowed: PROVIDER_HOSTS.has(p.apiKey.host) })
        .toEqual({ id: p.id, allowed: true });
    }
  });

  it("drops a hand-written entry only for a reason the merge actually has", () => {
    // Dropped is the honest outcome for unservable capacity or for an entry the
    // generator has taken over, but a drop for any OTHER reason would silently
    // remove a provider a lender can see documented.
    for (const p of UNSERVABLE_OAUTH_EXTRA) {
      const shadowed = PROVIDER_IDS.includes(p.id);
      const host = p.apiKey?.host || (p.transport?.baseUrl && new URL(p.transport.baseUrl).host);
      expect({ id: p.id, justified: shadowed || !PROVIDER_HOSTS.has(host) })
        .toEqual({ id: p.id, justified: true });
    }
  });

  it("still offers key-based providers at all", () => {
    // A regenerated provider-hosts.js that no longer lists these would remove
    // every key-based provider from `aile connect` without one error message.
    // This asserts the feature exists, not merely that the filter runs.
    for (const id of ["openrouter", "groq"]) {
      expect({ id, offered: PROVIDER_IDS.includes(id) }).toEqual({ id, offered: true });
    }
  });

  it("finds a key-based provider by id, alongside the OAuth ones", () => {
    expect(getProvider("openrouter")?.name).toBe("OpenRouter");
    expect(getProvider("codex")).toBeTruthy();
    expect(getProvider("no-such-provider")).toBeNull();
  });

  it("sorts by id and never lists one twice", () => {
    expect(PROVIDER_IDS).toEqual([...PROVIDER_IDS].sort());
    expect(PROVIDER_IDS.length).toBe(new Set(PROVIDER_IDS).size);
  });

  it("classifies by flow, not by which file the entry came from", () => {
    expect(isApiKeyProvider("openrouter")).toBe(true);
    expect(isApiKeyProvider("codex")).toBe(false);
    expect(isApiKeyProvider("unknown")).toBe(false);
  });
});

describe("dispatch", () => {
  it("treats a key-based provider as linkable", () => {
    expect(isLinkable("openrouter")).toBe(true);
    expect(needsApiKey("openrouter")).toBe(true);
    expect(needsApiKey("codex")).toBe(false);
    expect(needsApiKey("unknown")).toBe(false);
  });

  it("does not demand a browser for a flow that opens nothing", async () => {
    // The bug this catches: requiring an opener for every flow makes
    // `aile connect groq` fail on a headless box for no reason. An empty key
    // fails at the key check, which is proof the browser guard was skipped.
    await expect(linkProvider("groq", { apiKey: "" })).rejects.toThrow(/no key given/i);
  });

  it("still demands one for a flow that does open something", async () => {
    await expect(linkProvider("codex", {})).rejects.toThrow(/openBrowser is required/);
  });
});

describe("checking a key with the provider", () => {
  it("sends the key as a bearer token to the configured endpoint", async () => {
    const fetchImpl = ok({ data: { label: "laptop" } });
    await verifyApiKey(OPENROUTER, "sk-or-abc", { fetchImpl });

    expect(fetchImpl.calls[0].url).toBe(OPENROUTER.apiKey.verifyUrl);
    expect(fetchImpl.calls[0].headers.authorization).toBe("Bearer sk-or-abc");
  });

  it("accepts a key the provider answers 200 for", async () => {
    const res = await verifyApiKey(OPENROUTER, "sk-or-abc", { fetchImpl: ok({}) });
    expect(res.ok).toBe(true);
  });

  it("reads the key's own name back, when the provider says one", async () => {
    const res = await verifyApiKey(OPENROUTER, "sk-or-abc", { fetchImpl: ok({ data: { label: "  laptop  " } }) });
    expect(res).toMatchObject({ ok: true, name: "laptop" });
  });

  it("returns no name rather than a broken one when the shape differs", async () => {
    for (const body of [{}, { data: null }, { data: { label: 42 } }, { data: { label: "   " } }]) {
      const res = await verifyApiKey(OPENROUTER, "k", { fetchImpl: ok(body) });
      expect({ body, name: res.name }).toEqual({ body, name: null });
    }
  });

  it("reports a 401 and a 403 as a rejected key", async () => {
    for (const code of [401, 403]) {
      const res = await verifyApiKey(OPENROUTER, "sk-or-abc", { fetchImpl: status(code) });
      expect({ code, ok: res.ok, reason: res.reason }).toEqual({ code, ok: false, reason: "rejected" });
    }
  });

  it("offers the prefix hint only after the provider has already said no", async () => {
    // A prefix check that ran on its own would lock out every lender the day a
    // provider changed its key format, so it may only ever explain a rejection.
    const wrong = await verifyApiKey(OPENROUTER, "definitely-not-a-key", { fetchImpl: status(401) });
    expect(wrong.message).toMatch(/sk-or-/);

    const right = await verifyApiKey(OPENROUTER, "sk-or-abc", { fetchImpl: status(401) });
    expect(right.message).not.toMatch(/sk-or-/);

    // And a well-formed key that the provider accepts is never commented on.
    const good = await verifyApiKey(OPENROUTER, "definitely-not-a-key", { fetchImpl: ok({}) });
    expect(good.ok).toBe(true);
  });

  it("does not blame the key when the provider itself is having a bad day", async () => {
    const res = await verifyApiKey(OPENROUTER, "sk-or-abc", { fetchImpl: status(500) });
    expect({ ok: res.ok, reason: res.reason }).toEqual({ ok: false, reason: "upstream" });
    expect(res.message).toMatch(/500/);
  });

  it("does not blame the key when the network is the problem", async () => {
    // A lender on a flaky connection must not be sent hunting for a fault in the
    // one thing that is probably fine.
    const fetchImpl = stubFetch(async () => { throw new Error("getaddrinfo ENOTFOUND"); });
    const res = await verifyApiKey(OPENROUTER, "sk-or-abc", { fetchImpl });
    expect({ ok: res.ok, reason: res.reason }).toEqual({ ok: false, reason: "network" });
    expect(res.message).toMatch(/could not reach/i);
  });

  it("gives up on a provider that never answers, and says so as a timeout", async () => {
    const fetchImpl = stubFetch((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const e = new Error("aborted"); e.name = "AbortError"; reject(e);
      });
    }));
    const res = await verifyApiKey(OPENROUTER, "sk-or-abc", { fetchImpl, timeoutMs: 20 });
    expect({ ok: res.ok, reason: res.reason }).toEqual({ ok: false, reason: "network" });
    expect(res.message).toMatch(/did not respond/i);
  });

  it("declines a provider with no verification endpoint instead of assuming the key is good", async () => {
    const res = await verifyApiKey({ name: "Nowhere", apiKey: {} }, "k", { fetchImpl: ok({}) });
    expect({ ok: res.ok, reason: res.reason }).toEqual({ ok: false, reason: "no-verify-url" });
  });
});

describe("the apikey flow", () => {
  it("returns the same shape the OAuth runners do, so upload has no branch", async () => {
    const out = await runApiKeyFlow(OPENROUTER, { key: "sk-or-abc", fetchImpl: ok({}) });
    expect(out).toEqual({
      provider: "openrouter",
      accessToken: "sk-or-abc",
      refreshToken: null,
      expiresIn: null,
      suggestedLabel: null,
      // This flow verified the key against the provider to get here, which is
      // the same request a probe would make to the same URL. Reporting it means
      // link.js does not repeat it. See src/providers/probe.js.
      probed: { ok: true, reason: "ok" },
    });
  });

  it("only ever reports a check it actually performed", async () => {
    // `probed` is an observation, not a default. It is reachable only past the
    // point where a failed verification has already thrown, so there is no path
    // on which an unverified key reports itself as checked.
    await expect(runApiKeyFlow(OPENROUTER, {
      key: "sk-or-bad",
      fetchImpl: async () => new Response("no", { status: 401 }),
    })).rejects.toThrow(/rejected that key/i);
  });

  it("carries no idToken at all, rather than a null one", async () => {
    // There is nothing to attest in a key exchange. A present-but-empty field
    // invites someone downstream to try to verify it.
    const out = await runApiKeyFlow(OPENROUTER, { key: "k", fetchImpl: ok({}) });
    expect("idToken" in out).toBe(false);
  });

  it("claims no expiry, because nothing told us one", async () => {
    // An expiry we invented would make the server try to refresh a credential
    // that has no refresh flow.
    const out = await runApiKeyFlow(OPENROUTER, { key: "k", fetchImpl: ok({}) });
    expect(out.expiresIn).toBeNull();
    expect(out.refreshToken).toBeNull();
  });

  it("passes the key's own name up as a label suggestion", async () => {
    const out = await runApiKeyFlow(OPENROUTER, { key: "k", fetchImpl: ok({ data: { label: "laptop" } }) });
    expect(out.suggestedLabel).toBe("laptop");
  });

  it("survives the copy that brought a newline with it", async () => {
    const fetchImpl = ok({});
    const out = await runApiKeyFlow(OPENROUTER, { key: "  sk-or-abc\n", fetchImpl });
    expect(out.accessToken).toBe("sk-or-abc");
    expect(fetchImpl.calls[0].headers.authorization).toBe("Bearer sk-or-abc");
  });

  it("refuses an empty key without asking the provider about it", async () => {
    const fetchImpl = ok({});
    for (const key of ["", "   ", null, undefined]) {
      await expect(runApiKeyFlow(OPENROUTER, { key, fetchImpl })).rejects.toThrow(/no key given/i);
    }
    expect(fetchImpl.calls.length).toBe(0);
  });

  it("fails with the message the check produced, not a generic one", async () => {
    // This message is the whole reason the key is verified on the lender's own
    // machine: it is read by the one person who can fix the key, seconds after
    // they typed it.
    await expect(runApiKeyFlow(OPENROUTER, { key: "bad", fetchImpl: status(401) }))
      .rejects.toThrow(/rejected that key/i);
  });

  it("never returns a key the provider would not confirm", async () => {
    const attempt = runApiKeyFlow(OPENROUTER, { key: "bad", fetchImpl: status(500) });
    await expect(attempt).rejects.toThrow();
  });
});
