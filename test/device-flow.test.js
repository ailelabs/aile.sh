/**
 * The device-authorization flows.
 *
 * WHY THIS FILE EXISTS. `aile connect claude` shipped broken because nothing
 * asserted the request we actually send, and an audit against the reference
 * implementation then found the same class of drift in most of the others: two
 * providers died on the initiate call, two more sent `client_id=undefined`, and
 * three sent parameters their endpoints do not accept. Every one of those is a
 * failure a lender meets AFTER opening a browser, which is the worst place to
 * discover it.
 *
 * These tests drive the real flow against a stub that answers on 127.0.0.1 and
 * records what it was sent, so what is asserted is the bytes on the wire rather
 * than a helper's return value. The catalog is rewritten per-test to point at
 * the stub — the URLs are the only thing swapped; the shape being tested is the
 * generated catalog's own.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { linkProvider } from "../src/providers/flows.js";
import { getProvider } from "../src/providers/index.js";

/**
 * A stub provider endpoint.
 *
 * `routes` maps a pathname to a handler. Everything it receives is recorded,
 * including headers, because for three of these providers the headers ARE the
 * thing under test.
 */
function stubProvider(routes) {
  const calls = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      calls.push({
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        method: req.method,
        headers: Object.fromEntries(req.headers),
        body,
        form: Object.fromEntries(new URLSearchParams(body)),
        json: (() => { try { return JSON.parse(body); } catch { return null; } })(),
      });
      const handler = routes[url.pathname];
      if (!handler) return Response.json({ error: "no stub route" }, { status: 404 });
      return handler(calls.filter((c) => c.path === url.pathname).length, calls.at(-1));
    },
  });
  return {
    calls,
    base: `http://127.0.0.1:${server.port}`,
    stop: () => { try { server.stop(true); } catch { /* already gone */ } },
  };
}

/**
 * Point one provider's endpoints at the stub for the duration of a test.
 *
 * The catalog object is mutated and restored rather than replaced, because the
 * flow reads it through `getProvider` at call time and a replacement would not
 * be seen. Only URLs and the poll interval move — the request shape under test
 * stays exactly the one the generator produced.
 *
 * A field name may be dotted (`deviceStyle.initiate.url`), because the generated
 * catalog bakes absolute endpoints into the `deviceStyle` request shapes rather
 * than pointing them at a top-level field. Without that, redirecting a provider
 * silently redirected nothing and the test dialled the real provider.
 *
 * The interval is overridden because these flows really do sleep between polls
 * (3–5 seconds, which is what the providers ask for) and a test that waited
 * would be measuring `setTimeout`. Nothing about the wire format depends on it.
 * `deviceStyle` is deep-copied rather than edited in place, so the restore below
 * — which puts back the top level — cannot leave a mutated nested object behind
 * for the next test to inherit.
 */
const restores = [];
function redirect(providerId, base, fields, { paceMs = 5 } = {}) {
  const o = getProvider(providerId).oauth;
  const saved = { ...o };
  restores.push(() => {
    for (const k of Object.keys(o)) delete o[k];
    Object.assign(o, saved);
  });
  if (o.deviceStyle) o.deviceStyle = { ...structuredClone(o.deviceStyle), intervalMs: paceMs };
  for (const [field, path] of Object.entries(fields)) {
    const keys = field.split(".");
    const target = keys.slice(0, -1).reduce((v, k) => v[k], o);
    target[keys.at(-1)] = base + path;
  }
  o.pollInterval = paceMs;
  return o;
}
afterEach(() => { while (restores.length) restores.pop()(); });

/** Run a device flow with the browser and the wait stubbed out. */
function run(providerId, { nonce = null } = {}) {
  const opened = [];
  const logged = [];
  return {
    opened,
    logged,
    done: linkProvider(providerId, {
      nonce,
      log: (m) => logged.push(String(m)),
      openBrowser: (u) => { opened.push(u); },
    }),
  };
}

// ---------------------------------------------------------------------------
// RFC 8628, with the per-provider requirements layered on
// ---------------------------------------------------------------------------

describe("Kimi", () => {
  /** The device endpoint answers, then the token endpoint pends once. */
  function stub() {
    return stubProvider({
      "/device": () => Response.json({
        device_code: "dc-kimi", user_code: "KIMI-1234",
        verification_uri: "https://www.kimi.com/code/authorize_device",
      }),
      "/token": (n) => (n === 1
        ? Response.json({ error: "authorization_pending" })
        : Response.json({ access_token: "at-kimi", refresh_token: "rt-kimi", expires_in: 3600 })),
    });
  }

  it("sends the X-Msh headers the endpoint requires", async () => {
    const s = stub();
    try {
      redirect("kimi", s.base, { deviceCodeUrl: "/device", tokenUrl: "/token" });
      await run("kimi").done;
      const h = s.calls[0].headers;
      expect(h["x-msh-platform"]).toBeTruthy();
      expect(h["x-msh-version"]).toBeTruthy();
      expect(h["x-msh-device-name"]).toBeTruthy();
      expect(h["x-msh-device-model"]).toBeTruthy();
      expect(h["x-msh-device-id"]).toBeTruthy();
    } finally { s.stop(); }
  });

  it("reuses ONE device id across the initiate and every poll", async () => {
    // Kimi ties the pending authorization to this id. A fresh one per request
    // polls for an approval that will never be granted, and the flow then times
    // out looking exactly like a lender who never clicked approve.
    const s = stub();
    try {
      redirect("kimi", s.base, { deviceCodeUrl: "/device", tokenUrl: "/token" });
      await run("kimi").done;
      expect(s.calls.length).toBeGreaterThanOrEqual(3);
      const ids = new Set(s.calls.map((c) => c.headers["x-msh-device-id"]));
      expect(ids.size).toBe(1);
      expect([...ids][0]).not.toBe("undefined");
    } finally { s.stop(); }
  });

  it("treats a 200 carrying an error field as still pending", async () => {
    // Kimi answers 200 while the lender is deciding, so the token — not the
    // status — has to be what ends the loop.
    const s = stub();
    try {
      redirect("kimi", s.base, { deviceCodeUrl: "/device", tokenUrl: "/token" });
      const tokens = await run("kimi").done;
      expect(tokens.accessToken).toBe("at-kimi");
      expect(tokens.refreshToken).toBe("rt-kimi");
    } finally { s.stop(); }
  });
});

describe("Grok CLI", () => {
  it("identifies itself with the referrer auth.x.ai routes on", async () => {
    const s = stubProvider({
      "/device": () => Response.json({ device_code: "dc", user_code: "G-1", verification_uri: "https://x.ai/v" }),
      "/token": () => Response.json({ access_token: "at-grok" }),
    });
    try {
      redirect("grok-cli", s.base, { deviceCodeUrl: "/device", tokenUrl: "/token" });
      await run("grok-cli").done;
      expect(s.calls[0].form.referrer).toBe("grok-build");
      expect(s.calls[0].form.client_id).toBe(getProvider("grok-cli").oauth.clientId);
    } finally { s.stop(); }
  });
});

describe("Qwen", () => {
  it("runs PKCE, and sends the verifier only because it sent a challenge", async () => {
    const s = stubProvider({
      "/device": () => Response.json({ device_code: "dc-qwen", user_code: "Q-1", verification_uri: "https://qwen/v" }),
      "/token": () => Response.json({ access_token: "at-qwen", expires_in: 3600 }),
    });
    try {
      redirect("qwen", s.base, { deviceCodeUrl: "/device", tokenUrl: "/token" });
      await run("qwen").done;
      expect(s.calls[0].form.code_challenge_method).toBe("S256");
      expect(s.calls[0].form.code_challenge?.length).toBeGreaterThan(20);
      expect(s.calls[1].form.code_verifier?.length).toBeGreaterThan(20);
    } finally { s.stop(); }
  });
});

describe("GitHub", () => {
  it("is left alone — it was already RFC 8628 and correct", async () => {
    const s = stubProvider({
      "/device": () => Response.json({ device_code: "dc-gh", user_code: "GH-1", verification_uri: "https://github.com/login/device" }),
      "/token": () => Response.json({ access_token: "at-gh" }),
    });
    try {
      redirect("github", s.base, { deviceCodeUrl: "/device", tokenUrl: "/token" });
      const tokens = await run("github").done;
      expect(tokens.accessToken).toBe("at-gh");
      expect(s.calls[0].form.client_id).toBe(getProvider("github").oauth.clientId);
      expect(s.calls[0].form.scope).toBe("read:user");
      // No PKCE in this provider's catalog entry, so no verifier may appear.
      expect(s.calls[1].form.code_verifier).toBeUndefined();
    } finally { s.stop(); }
  });
});

// ---------------------------------------------------------------------------
// Device-SHAPED flows that are not RFC 8628 at all
// ---------------------------------------------------------------------------

/**
 * Where each of these two keeps its endpoints. Both bake an absolute URL into
 * the `deviceStyle` request shape, so redirecting the top-level field the entry
 * still carries would move nothing. `@deviceCode` is left in the poll path for
 * the flow to resolve — that substitution is part of what is under test.
 */
const KILOCODE = {
  "deviceStyle.initiate.url": "/codes",
  "deviceStyle.poll.url": "/codes/@deviceCode",
};
const CODEBUDDY = {
  "deviceStyle.initiate.url": "/state?platform=CLI",
  tokenUrl: "/token",
};

describe("Kilocode", () => {
  function stub() {
    return stubProvider({
      "/codes": () => Response.json({ code: "dc-kilo", verificationUrl: "https://kilo/v", expiresIn: 300 }),
      "/codes/dc-kilo": (n) => (n === 1
        ? new Response(null, { status: 202 })
        : Response.json({ status: "approved", token: "at-kilo", userEmail: "a@b.c" })),
    });
  }

  it("POSTs JSON with no client at all", async () => {
    // Form-encoding a `client_id=undefined` to this endpoint is what it did
    // before; it has no registered client and does not read a body.
    const s = stub();
    try {
      redirect("kilocode", s.base, KILOCODE);
      await run("kilocode").done;
      expect(s.calls[0].method).toBe("POST");
      expect(s.calls[0].headers["content-type"]).toContain("application/json");
      expect(s.calls[0].body).not.toContain("client_id");
      expect(s.calls[0].body).not.toContain("undefined");
    } finally { s.stop(); }
  });

  it("polls by path — the code goes in the URL, not a body", async () => {
    const s = stub();
    try {
      redirect("kilocode", s.base, KILOCODE);
      await run("kilocode").done;
      expect(s.calls[1].path).toBe("/codes/dc-kilo");
      expect(s.calls[1].method).toBe("GET");
    } finally { s.stop(); }
  });

  it("reads 202 as pending and an approved body as success", async () => {
    // Here the HTTP status carries the state the RFC puts in an error field,
    // and approval is a field inside a 200 rather than the 200 itself.
    const s = stub();
    try {
      redirect("kilocode", s.base, KILOCODE);
      const tokens = await run("kilocode").done;
      expect(tokens.accessToken).toBe("at-kilo");
      expect(s.calls.filter((c) => c.path === "/codes/dc-kilo")).toHaveLength(2);
    } finally { s.stop(); }
  });

  it("does not mistake a 200 that is not yet approved for a token", async () => {
    const s = stubProvider({
      "/codes": () => Response.json({ code: "dc-kilo", verificationUrl: "https://kilo/v" }),
      "/codes/dc-kilo": (n) => (n < 2
        ? Response.json({ status: "pending" })
        : Response.json({ status: "approved", token: "at-late" })),
    });
    try {
      redirect("kilocode", s.base, KILOCODE);
      expect((await run("kilocode").done).accessToken).toBe("at-late");
    } finally { s.stop(); }
  });

  it("surfaces a denial rather than waiting out the five minutes", async () => {
    const s = stubProvider({
      "/codes": () => Response.json({ code: "dc-kilo", verificationUrl: "https://kilo/v" }),
      "/codes/dc-kilo": () => new Response(null, { status: 403 }),
    });
    try {
      redirect("kilocode", s.base, KILOCODE);
      await expect(run("kilocode").done).rejects.toThrow(/denied/i);
    } finally { s.stop(); }
  });
});

describe("CodeBuddy", () => {
  function stub() {
    return stubProvider({
      "/state": () => Response.json({ code: 0, data: { state: "st-cb", authUrl: "https://copilot/v" } }),
      "/token": (n) => (n === 1
        ? Response.json({ code: 11217 })
        : Response.json({ code: 0, data: { accessToken: "at-cb", refreshToken: "rt-cb", expiresIn: 86400 } })),
    });
  }

  it("starts at all — it has no device endpoint and used to die here", async () => {
    const s = stub();
    try {
      redirect("codebuddy-cn", s.base, CODEBUDDY);
      const tokens = await run("codebuddy-cn").done;
      expect(tokens.accessToken).toBe("at-cb");
      expect(tokens.refreshToken).toBe("rt-cb");
    } finally { s.stop(); }
  });

  it("carries the routing headers Tencent requires instead of a client_id", async () => {
    const s = stub();
    try {
      redirect("codebuddy-cn", s.base, CODEBUDDY);
      await run("codebuddy-cn").done;
      for (const call of s.calls) {
        expect(call.headers["x-requested-with"]).toBe("XMLHttpRequest");
        expect(call.headers["x-domain"]).toBe("copilot.tencent.com");
        expect(call.headers["x-no-authorization"]).toBe("true");
        expect(call.headers["x-product"]).toBe("SaaS");
      }
    } finally { s.stop(); }
  });

  it("puts the platform on the initiate and the state on the poll", async () => {
    const s = stub();
    try {
      redirect("codebuddy-cn", s.base, CODEBUDDY);
      await run("codebuddy-cn").done;
      expect(s.calls[0].query.platform).toBe("CLI");
      expect(s.calls[1].method).toBe("GET");
      expect(s.calls[1].query.state).toBe("st-cb");
    } finally { s.stop(); }
  });

  it("reads code 11217 as pending, not as a failure", async () => {
    // The application code inside a 200 is the whole pending signal here;
    // treating a 200 as success would link an unapproved account.
    const s = stub();
    try {
      redirect("codebuddy-cn", s.base, CODEBUDDY);
      await run("codebuddy-cn").done;
      expect(s.calls.filter((c) => c.path === "/token")).toHaveLength(2);
    } finally { s.stop(); }
  });

  it("escapes the state it puts in a query string", async () => {
    // A device code carrying an `&` would otherwise truncate the parameter and
    // poll for a state the provider never issued — a link that hangs until it
    // times out, with a correct-looking request on the wire.
    const s = stubProvider({
      "/state": () => Response.json({ code: 0, data: { state: "a&b=c d", authUrl: "https://c/v" } }),
      "/token": () => Response.json({ code: 0, data: { accessToken: "at-cb" } }),
    });
    try {
      redirect("codebuddy-cn", s.base, CODEBUDDY);
      await run("codebuddy-cn").done;
      expect(s.calls[1].query.state).toBe("a&b=c d");
    } finally { s.stop(); }
  });

  it("fails loudly on any other application code", async () => {
    const s = stubProvider({
      "/state": () => Response.json({ code: 0, data: { state: "st", authUrl: "https://c/v" } }),
      "/token": () => Response.json({ code: 40001, msg: "session expired" }),
    });
    try {
      redirect("codebuddy-cn", s.base, CODEBUDDY);
      await expect(run("codebuddy-cn").done).rejects.toThrow(/session expired/);
    } finally { s.stop(); }
  });
});

// ---------------------------------------------------------------------------

describe("what every device flow shows the lender", () => {
  it("opens the verification page and prints the code", async () => {
    const s = stubProvider({
      "/device": () => Response.json({
        device_code: "dc", user_code: "SHOW-ME",
        verification_uri: "https://provider.example/activate",
      }),
      "/token": () => Response.json({ access_token: "at" }),
    });
    try {
      redirect("github", s.base, { deviceCodeUrl: "/device", tokenUrl: "/token" });
      const r = run("github");
      await r.done;
      expect(r.opened).toEqual(["https://provider.example/activate"]);
      expect(r.logged.join("\n")).toContain("SHOW-ME");
    } finally { s.stop(); }
  });

  it("prefers the complete verification URI when the provider sends one", async () => {
    // It embeds the code, so the lender does not have to type anything.
    const s = stubProvider({
      "/device": () => Response.json({
        device_code: "dc", user_code: "X-1",
        verification_uri: "https://p/activate",
        verification_uri_complete: "https://p/activate?user_code=X-1",
       
      }),
      "/token": () => Response.json({ access_token: "at" }),
    });
    try {
      redirect("github", s.base, { deviceCodeUrl: "/device", tokenUrl: "/token" });
      const r = run("github");
      await r.done;
      expect(r.opened).toEqual(["https://p/activate?user_code=X-1"]);
    } finally { s.stop(); }
  });
});
