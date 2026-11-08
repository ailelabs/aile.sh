/**
 * Finishing a browser link on another device, by pasting the redirect.
 *
 * WHY THIS FILE EXISTS. The authcode flows redirect to `http://localhost:<port>`,
 * which is only this machine when the browser runs here. A node on a VPS has no
 * browser: the lender approves on their laptop, the laptop's browser lands on a
 * localhost page that does not load, and before this the CLI waited five minutes
 * for a callback that could never arrive. Now a paste prompt races the loopback
 * listener, and the address from the browser's bar finishes the link.
 *
 * Driven through the real listener and a stub token endpoint, so what is asserted
 * is the exchange the provider would receive, not a helper's return value.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { linkProvider, parsePastedCallback } from "../src/providers/flows.js";
import { getProvider } from "../src/providers/index.js";

function stubToken(handler) {
  const calls = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.text();
      calls.push({
        form: Object.fromEntries(new URLSearchParams(body)),
        json: (() => { try { return JSON.parse(body); } catch { return null; } })(),
      });
      return handler ? handler(calls.at(-1)) : Response.json({ access_token: "at", expires_in: 3600 });
    },
  });
  return {
    calls,
    base: `http://127.0.0.1:${server.port}`,
    stop: () => { try { server.stop(true); } catch { /* already gone */ } },
  };
}

const restores = [];
function redirect(providerId, fields) {
  const o = getProvider(providerId).oauth;
  const saved = { ...o };
  restores.push(() => {
    for (const k of Object.keys(o)) delete o[k];
    Object.assign(o, saved);
  });
  Object.assign(o, fields);
  return o;
}
afterEach(() => { while (restores.length) restores.pop()(); });

/** The address a browser on another device lands on after approving. */
function landedOn(authUrl, { code = "the-pasted-code", state } = {}) {
  const u = new URL(authUrl);
  const back = new URL(u.searchParams.get("redirect_uri"));
  back.searchParams.set("code", code);
  back.searchParams.set("state", state ?? u.searchParams.get("state"));
  return back.toString();
}

/**
 * A scripted paste prompt: each answer is a function of the authorize URL, read
 * in order. Records every question and whether the prompt was stopped.
 */
function scriptedPaste(answers) {
  const seen = { asked: 0, aborted: false };
  let authUrl = null;
  return {
    seen,
    openBrowser: async (url) => { authUrl = url; },
    readPaste: (_question, { signal } = {}) => {
      const next = answers[seen.asked++];
      if (!next) {
        // Out of answers: wait like a person would, until the race is over.
        return new Promise((resolve) => {
          signal?.addEventListener("abort", () => { seen.aborted = true; resolve(null); });
        });
      }
      return Promise.resolve(next(authUrl));
    },
  };
}

// ---------------------------------------------------------------------------

describe("parsePastedCallback", () => {
  it("reads the whole address a browser landed on", () => {
    expect(parsePastedCallback("http://localhost:1455/auth/callback?code=abc123&state=st"))
      .toEqual({ code: "abc123", state: "st" });
  });

  it("reads the address without its scheme, and its query alone", () => {
    expect(parsePastedCallback("localhost:56121/callback?code=abc123&state=st"))
      .toEqual({ code: "abc123", state: "st" });
    expect(parsePastedCallback("?code=abc123&state=st")).toEqual({ code: "abc123", state: "st" });
    expect(parsePastedCallback("code=abc123&state=st")).toEqual({ code: "abc123", state: "st" });
  });

  it("takes a bare code, including Anthropic's code#state", () => {
    expect(parsePastedCallback("Zm9vYmFyYmF6cXV4MTIz")).toEqual({ code: "Zm9vYmFyYmF6cXV4MTIz" });
    expect(parsePastedCallback("abcdefghijkl#the-state")).toEqual({ code: "abcdefghijkl#the-state" });
  });

  it("forgives the quotes, angle brackets and paste markers a terminal adds", () => {
    expect(parsePastedCallback("  'http://localhost:1/callback?code=abc123&state=st'  "))
      .toEqual({ code: "abc123", state: "st" });
    expect(parsePastedCallback("<http://localhost:1/callback?code=abc123>")).toEqual({ code: "abc123" });
    expect(parsePastedCallback("\x1b[200~http://localhost:1/callback?code=abc123\x1b[201~"))
      .toEqual({ code: "abc123" });
  });

  it("passes a provider's refusal through, so the flow can say it", () => {
    expect(parsePastedCallback("http://localhost:1/callback?error=access_denied&state=st"))
      .toEqual({ error: "access_denied", state: "st" });
  });

  it("refuses the sign-in link itself, whose code=true is no code", () => {
    // Claude's authorize URL carries `code=true`; pasted back by mistake it
    // must not be exchanged as an authorization code.
    expect(parsePastedCallback(
      "https://claude.ai/oauth/authorize?code=true&client_id=x&response_type=code&code_challenge=y",
    )).toBeNull();
  });

  it("refuses what holds no code", () => {
    expect(parsePastedCallback("")).toBeNull();
    expect(parsePastedCallback("http://localhost:1455/auth/callback")).toBeNull();
    expect(parsePastedCallback("yes")).toBeNull();
    expect(parsePastedCallback("this is not a code at all")).toBeNull();
  });
});

describe("linking with a pasted address", () => {
  it("exchanges the pasted code with the verifier, and no listener is ever called", async () => {
    const s = stubToken(() => Response.json({ access_token: "at-pasted", refresh_token: "rt" }));
    try {
      redirect("xai-oauth", { tokenUrl: `${s.base}/token`, fixedPort: 0 });
      const p = scriptedPaste([(url) => landedOn(url)]);
      const tokens = await linkProvider("xai-oauth", { log: () => {}, ...p });

      expect(s.calls[0].form.grant_type).toBe("authorization_code");
      expect(s.calls[0].form.code).toBe("the-pasted-code");
      expect(s.calls[0].form.code_verifier?.length).toBeGreaterThan(20);
      // The exchange names the redirect the provider issued the code for.
      expect(s.calls[0].form.redirect_uri).toMatch(/^http:\/\/localhost:\d+\/callback$/);
      expect(tokens.accessToken).toBe("at-pasted");
    } finally { s.stop(); }
  });

  it("says so and asks again when the paste is from an earlier attempt", async () => {
    const s = stubToken(() => Response.json({ access_token: "at" }));
    const lines = [];
    try {
      redirect("xai-oauth", { tokenUrl: `${s.base}/token`, fixedPort: 0 });
      const p = scriptedPaste([
        (url) => landedOn(url, { code: "stale-code", state: "some-other-state" }),
        (url) => landedOn(url, { code: "fresh-code" }),
      ]);
      await linkProvider("xai-oauth", { log: (l) => lines.push(l), ...p });

      expect(p.seen.asked).toBe(2);
      expect(lines.join("\n")).toMatch(/earlier sign-in/);
      // Only the right code ever reached the provider.
      expect(s.calls.map((c) => c.form.code)).toEqual(["fresh-code"]);
    } finally { s.stop(); }
  });

  it("asks again after a paste with no code, such as the sign-in link", async () => {
    const s = stubToken(() => Response.json({ access_token: "at" }));
    const lines = [];
    try {
      redirect("xai-oauth", { tokenUrl: `${s.base}/token`, fixedPort: 0 });
      const p = scriptedPaste([
        (url) => url,                 // the authorize link, copied back by mistake
        () => "",                     // an enter on an empty line
        (url) => landedOn(url),
      ]);
      await linkProvider("xai-oauth", { log: (l) => lines.push(l), ...p });

      expect(p.seen.asked).toBe(3);
      expect(lines.join("\n")).toMatch(/holds no sign-in code/);
      expect(s.calls).toHaveLength(1);
    } finally { s.stop(); }
  });

  it("sends Claude the state from a pasted code#state", async () => {
    const s = stubToken((c) => (c.json?.state
      ? Response.json({ access_token: "at-claude" })
      : Response.json({ error: "Invalid request format" }, { status: 400 })));
    try {
      redirect("claude", { tokenUrl: `${s.base}/token` });
      let authorizeState = null;
      const p = scriptedPaste([(url) => {
        authorizeState = new URL(url).searchParams.get("state");
        return `the-claude-code#${authorizeState}`;
      }]);
      const tokens = await linkProvider("claude", { log: () => {}, ...p });

      expect(s.calls[0].json.code).toBe("the-claude-code");
      expect(s.calls[0].json.state).toBe(authorizeState);
      expect(tokens.accessToken).toBe("at-claude");
    } finally { s.stop(); }
  });

  it("reports a refusal pasted from the provider", async () => {
    redirect("xai-oauth", { fixedPort: 0 });
    const p = scriptedPaste([(url) => {
      const back = new URL(new URL(url).searchParams.get("redirect_uri"));
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("error_description", "The user denied access");
      return back.toString();
    }]);
    await expect(linkProvider("xai-oauth", { log: () => {}, ...p })).rejects.toThrow(/denied access/);
  });

  it("stops the prompt when the browser on this machine answers first", async () => {
    const s = stubToken(() => Response.json({ access_token: "at-loopback" }));
    try {
      redirect("xai-oauth", { tokenUrl: `${s.base}/token`, fixedPort: 0 });
      const p = scriptedPaste([]);     // the lender never pastes
      const tokens = await linkProvider("xai-oauth", {
        log: () => {},
        readPaste: p.readPaste,
        openBrowser: async (url) => { await fetch(landedOn(url, { code: "loopback-code" })).catch(() => {}); },
      });

      expect(tokens.accessToken).toBe("at-loopback");
      expect(s.calls[0].form.code).toBe("loopback-code");
      // The prompt was released, so the terminal is handed back.
      expect(p.seen.aborted).toBe(true);
    } finally { s.stop(); }
  });

  it("asks nothing where there is no terminal to ask on", async () => {
    // No readPaste: the listener alone, exactly as before, and no paste hint.
    const s = stubToken(() => Response.json({ access_token: "at" }));
    const lines = [];
    try {
      redirect("xai-oauth", { tokenUrl: `${s.base}/token`, fixedPort: 0 });
      await linkProvider("xai-oauth", {
        log: (l) => lines.push(l),
        openBrowser: async (url) => { await fetch(landedOn(url)).catch(() => {}); },
      });
      expect(lines.join("\n")).not.toMatch(/paste/i);
    } finally { s.stop(); }
  });
});
