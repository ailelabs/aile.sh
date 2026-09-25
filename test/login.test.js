/**
 * Sign-in, both ways in.
 *
 * The browser flow is the happy path and was already covered by the shape of
 * the code. What was never covered — and what this file exists for — is the
 * fallback, because the fallback is what a user meets on their worst day: a
 * headless box, an expired code, a proxy that ate the callback.
 *
 * The invariant that matters more than any other here: **a token is verified
 * before it is written to disk.** Saving first and checking later leaves the
 * user believing they are signed in while every later command fails somewhere
 * far away from the mistake. Several tests below are that one assertion viewed
 * from different angles.
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Doubles. The API and the disk are stubbed; the login logic is real.
// ---------------------------------------------------------------------------

const calls = { me: [], saved: [], enrolled: [], device: [], poll: [] };
let meImpl = async () => ({ renter: { id: "r1", email: "a@b.c" }, accounts: [] });
let deviceStart = async () => ({
  deviceCode: "dc", userCode: "ABCD-EFGH", verificationUri: "https://aile.test/login",
  verificationUriComplete: "https://aile.test/login?code=ABCD-EFGH", expiresIn: 600, interval: 0,
});
let devicePoll = async () => ({ status: "approved", token: "ail_browserflow", renter: { email: "a@b.c" } });
let enrollImpl = async () => ({ ok: true });

class ApiError extends Error {
  constructor(message, status, body) { super(message); this.name = "ApiError"; this.status = status; this.body = body; }
}

mock.module("../src/api/client.js", () => ({
  ApiError,
  isSecureUrl: () => true,
  api: {
    me: async (opts) => { calls.me.push(opts); return meImpl(opts); },
    startDeviceLogin: async (opts) => { calls.device.push(opts); return deviceStart(opts); },
    pollDeviceLogin: async (opts) => { calls.poll.push(opts); return devicePoll(opts); },
  },
}));

mock.module("../src/relay/config.js", () => ({
  saveConfig: (patch) => { calls.saved.push(patch); return patch; },
  loadConfig: () => ({ serverUrl: "https://aile.test" }),
}));

// login.js calls the rotating variant, so that is what has to be stubbed —
// stubbing only `enrollNode` would leave the import undefined and every
// enrolment here would fail for a reason that has nothing to do with the test.
mock.module("../src/relay/enroll.js", () => ({
  enrollNode: async (opts) => { calls.enrolled.push(opts); return enrollImpl(opts); },
  enrollNodeOrRotate: async (opts) => { calls.enrolled.push(opts); return enrollImpl(opts); },
}));

const { signIn, applyToken, deviceLogin, normalizeToken, screenToken, LoginError } =
  await import("../src/auth/login.js");

const SERVER = "https://aile.test";
const GOOD = "ail_" + "a".repeat(48);

/** A reader that replays a scripted sequence of pastes. */
function scriptedReader(...answers) {
  const queue = [...answers];
  const reader = async () => (queue.length ? queue.shift() : "");
  reader.remaining = () => queue.length;
  return reader;
}

const silent = () => {};

beforeEach(() => {
  calls.me.length = 0; calls.saved.length = 0; calls.enrolled.length = 0; calls.device.length = 0;
  calls.poll.length = 0;
  meImpl = async () => ({ renter: { id: "r1", email: "a@b.c" }, accounts: [] });
  deviceStart = async () => ({
    deviceCode: "dc", userCode: "ABCD-EFGH", verificationUri: "https://aile.test/login",
    verificationUriComplete: "https://aile.test/login?code=ABCD-EFGH", expiresIn: 600, interval: 0,
  });
  devicePoll = async () => ({ status: "approved", token: "ail_browserflow", renter: { email: "a@b.c" } });
  enrollImpl = async () => ({ ok: true });
});

// ---------------------------------------------------------------------------

describe("normalizeToken", () => {
  it("strips the noise a real paste carries", () => {
    // Each of these is a correct token with something around it. Rejecting them
    // teaches the user nothing except to try the same thing again.
    for (const raw of [
      `  ${GOOD}  `,
      `"${GOOD}"`,
      `'${GOOD}'`,
      `Bearer ${GOOD}`,
      `bearer ${GOOD}`,
      `${GOOD}\n`,
    ]) {
      expect({ raw: raw.slice(0, 12), out: normalizeToken(raw) }).toEqual({ raw: raw.slice(0, 12), out: GOOD });
    }
  });

  it("rejoins a token a terminal wrapped across lines", () => {
    const wrapped = `${GOOD.slice(0, 20)}\n${GOOD.slice(20)}`;
    expect(normalizeToken(wrapped)).toBe(GOOD);
  });

  it("survives being handed nothing", () => {
    expect([normalizeToken(null), normalizeToken(undefined), normalizeToken("")]).toEqual(["", "", ""]);
  });
});

describe("screenToken", () => {
  it("accepts anything plausible — the server is the authority", () => {
    expect(screenToken(GOOD)).toBeNull();
  });

  it("names what was pasted instead of the token", () => {
    // A generic "invalid token" leaves the user re-pasting the same wrong thing.
    expect(screenToken("https://aile.test/token")).toMatch(/URL/);
    expect(screenToken("ABCD-EFGH")).toMatch(/device code/);
    expect(screenToken("short")).toMatch(/short/);
    expect(screenToken("")).toMatch(/Nothing/);
    expect(screenToken("x".repeat(600))).toMatch(/long/);
  });
});

describe("applyToken", () => {
  it("verifies against the server before writing anything", async () => {
    await applyToken({ token: GOOD, serverUrl: SERVER, log: silent });
    // Order is the assertion: the check happened, and only then the write.
    expect(calls.me.length).toBe(1);
    expect(calls.saved).toEqual([{ serverUrl: SERVER, renterToken: GOOD }]);
  });

  it("writes NOTHING when the server rejects the token", async () => {
    meImpl = async () => { throw new ApiError("unauthorized", 401, { error: "unauthorized" }); };
    await expect(applyToken({ token: GOOD, serverUrl: SERVER, log: silent }))
      .rejects.toThrow(/rejected that token/);
    expect(calls.saved).toEqual([]);
    expect(calls.enrolled).toEqual([]);
  });

  it("writes NOTHING when the server is unreachable, and says so", async () => {
    // An unreachable server says nothing about whether the token is good, so
    // reporting it as a bad token would send the user to fix the wrong thing.
    meImpl = async () => { throw new Error("connect ECONNREFUSED"); };
    const err = await applyToken({ token: GOOD, serverUrl: SERVER, log: silent }).catch((e) => e);
    expect({ reason: err.reason, saved: calls.saved.length }).toEqual({ reason: "unreachable", saved: 0 });
    expect(err.message).toMatch(/Could not reach/);
  });

  it("writes NOTHING for input that cannot be a token", async () => {
    const err = await applyToken({ token: "ABCD-EFGH", serverUrl: SERVER, log: silent }).catch((e) => e);
    expect({ reason: err.reason, me: calls.me.length, saved: calls.saved.length })
      .toEqual({ reason: "malformed", me: 0, saved: 0 });
  });

  it("enrols the machine, so `aile start` works straight after", async () => {
    const res = await applyToken({ token: GOOD, serverUrl: SERVER, log: silent });
    expect({ enrolled: res.enrolled, via: res.via, token: calls.enrolled[0].renterToken })
      .toEqual({ enrolled: true, via: "token", token: GOOD });
  });

  it("stays signed in when enrolment fails — the token is still good", async () => {
    // Enrolment needs the server too, but a failure there costs the user their
    // relay, not their sign-in. Throwing would discard a verified token.
    enrollImpl = async () => { throw new Error("server busy"); };
    const res = await applyToken({ token: GOOD, serverUrl: SERVER, log: silent });
    expect({ ok: res.ok, enrolled: res.enrolled, error: res.enrolError })
      .toEqual({ ok: true, enrolled: false, error: "server busy" });
    expect(calls.saved.length).toBe(1);
  });
});

describe("deviceLogin", () => {
  it("returns on approval and enrols", async () => {
    const res = await deviceLogin({ serverUrl: SERVER, log: silent, openBrowser: async () => {}, sleep: async () => {} });
    expect({ ok: res.ok, via: res.via, enrolled: res.enrolled }).toEqual({ ok: true, via: "browser", enrolled: true });
    expect(calls.saved).toEqual([{ serverUrl: SERVER, renterToken: "ail_browserflow" }]);
  });

  it("carries a machine-readable reason for each way it fails", async () => {
    for (const [status, reason] of [["denied", "denied"], ["expired", "expired"], ["invalid", "invalid"]]) {
      devicePoll = async () => ({ status });
      const err = await deviceLogin({
        serverUrl: SERVER, log: silent, openBrowser: async () => {}, sleep: async () => {},
      }).catch((e) => e);
      // The CLI branches on `reason`; matching prose would break on a reword.
      expect({ status, reason: err.reason, isLoginError: err instanceof LoginError })
        .toEqual({ status, reason, isLoginError: true });
    }
  });

  it("times out rather than polling forever", async () => {
    devicePoll = async () => ({ status: "pending" });
    let clock = 0;
    const err = await deviceLogin({
      serverUrl: SERVER, log: silent, openBrowser: async () => {},
      now: () => clock, sleep: async () => { clock += 60_000; },
    }).catch((e) => e);
    expect(err.reason).toBe("timeout");
  });

  it("backs off when the server says slow_down", async () => {
    let polls = 0;
    devicePoll = async () => (++polls < 3 ? { status: "slow_down" } : { status: "approved", token: GOOD, renter: {} });
    const waits = [];
    const res = await deviceLogin({
      serverUrl: SERVER, log: silent, openBrowser: async () => {}, sleep: async (ms) => { waits.push(ms); },
    });
    expect(res.ok).toBe(true);
    // Each slow_down must lengthen the next wait, or the client keeps being
    // told to slow down and never does.
    expect(waits[1]).toBeGreaterThan(waits[0]);
    expect(waits[2]).toBeGreaterThan(waits[1]);
  });
});

describe("signIn — the fallback", () => {
  it("uses the browser when the browser works", async () => {
    const res = await signIn({
      serverUrl: SERVER, log: silent, openBrowser: async () => {}, sleep: async () => {},
      interactive: true, readSecret: scriptedReader("should-not-be-read"),
    });
    expect(res.via).toBe("browser");
  });

  it("falls back to paste after EVERY way the browser can fail", async () => {
    // This is the whole point of the change: each of these used to be a dead
    // end with nothing offered to the user.
    for (const status of ["denied", "expired", "invalid"]) {
      calls.saved.length = 0;
      devicePoll = async () => ({ status });
      const res = await signIn({
        serverUrl: SERVER, log: silent, openBrowser: async () => {}, sleep: async () => {},
        interactive: true, readSecret: scriptedReader(GOOD),
      });
      expect({ status, via: res.via, ok: res.ok }).toEqual({ status, via: "token", ok: true });
    }
  });

  it("falls back to paste when the server cannot even start a device flow", async () => {
    deviceStart = async () => { throw new Error("ECONNREFUSED"); };
    const res = await signIn({
      serverUrl: SERVER, log: silent, openBrowser: async () => {}, sleep: async () => {},
      interactive: true, readSecret: scriptedReader(GOOD),
    });
    expect(res.via).toBe("token");
  });

  it("falls back to paste on timeout", async () => {
    devicePoll = async () => ({ status: "pending" });
    let clock = 0;
    const res = await signIn({
      serverUrl: SERVER, log: silent, openBrowser: async () => {},
      now: () => clock, sleep: async () => { clock += 60_000; },
      interactive: true, readSecret: scriptedReader(GOOD),
    });
    expect(res.via).toBe("token");
  });

  it("skips the browser entirely with --paste", async () => {
    const res = await signIn({
      serverUrl: SERVER, mode: "paste", log: silent,
      interactive: true, readSecret: scriptedReader(GOOD),
    });
    // Not even a request to start one: opening a browser on a box that has none
    // wastes the user's time and produces a confusing URL they cannot use.
    expect({ via: res.via, deviceCalls: calls.device.length }).toEqual({ via: "token", deviceCalls: 0 });
  });

  it("does not fall back when --browser was asked for explicitly", async () => {
    devicePoll = async () => ({ status: "denied" });
    const err = await signIn({
      serverUrl: SERVER, mode: "browser", log: silent, openBrowser: async () => {}, sleep: async () => {},
      interactive: true, readSecret: scriptedReader(GOOD),
    }).catch((e) => e);
    expect(err.reason).toBe("denied");
  });

  it("takes --token without prompting or opening anything", async () => {
    const reader = scriptedReader("unused");
    const res = await signIn({ serverUrl: SERVER, token: GOOD, log: silent, interactive: true, readSecret: reader });
    expect({ via: res.via, deviceCalls: calls.device.length, unread: reader.remaining() })
      .toEqual({ via: "token", deviceCalls: 0, unread: 1 });
  });

  it("re-prompts after a rejected paste — a truncated copy is the usual cause", async () => {
    let seen = 0;
    meImpl = async ({ token }) => {
      seen++;
      if (token !== GOOD) throw new ApiError("unauthorized", 401, {});
      return { renter: { email: "a@b.c" } };
    };
    const res = await signIn({
      serverUrl: SERVER, mode: "paste", log: silent, interactive: true,
      readSecret: scriptedReader(GOOD.slice(0, 30), GOOD),
    });
    expect({ via: res.via, attempts: seen }).toEqual({ via: "token", attempts: 2 });
    expect(calls.saved.length).toBe(1);
  });

  it("gives up after three rejected pastes rather than looping forever", async () => {
    meImpl = async () => { throw new ApiError("unauthorized", 401, {}); };
    const reader = scriptedReader(GOOD, GOOD, GOOD, GOOD);
    const err = await signIn({
      serverUrl: SERVER, mode: "paste", log: silent, interactive: true, readSecret: reader,
    }).catch((e) => e);
    expect({ reason: err.reason, unused: reader.remaining() }).toEqual({ reason: "rejected", unused: 1 });
  });

  it("does NOT re-prompt when the server is unreachable", async () => {
    // Retrying cannot fix a connection problem, and asking three times implies
    // the paste was at fault when it was not.
    meImpl = async () => { throw new Error("ECONNREFUSED"); };
    const reader = scriptedReader(GOOD, GOOD, GOOD);
    const err = await signIn({
      serverUrl: SERVER, mode: "paste", log: silent, interactive: true, readSecret: reader,
    }).catch((e) => e);
    expect({ reason: err.reason, unused: reader.remaining() }).toEqual({ reason: "unreachable", unused: 2 });
  });

  it("treats an empty paste as cancelling, not as a wrong answer", async () => {
    const err = await signIn({
      serverUrl: SERVER, mode: "paste", log: silent, interactive: true, readSecret: scriptedReader(""),
    }).catch((e) => e);
    expect({ reason: err.reason, saved: calls.saved.length }).toEqual({ reason: "cancelled", saved: 0 });
  });

  it("refuses to prompt when stdin is not a terminal, and says what to run", async () => {
    // Under systemd or in a container there is no console. Blocking on a prompt
    // nobody can answer is a hang with no explanation.
    const err = await signIn({
      serverUrl: SERVER, mode: "paste", log: silent, interactive: false, readSecret: scriptedReader(GOOD),
    }).catch((e) => e);
    expect(err.reason).toBe("no-tty");
    expect(err.hint).toMatch(/--token/);
  });

  it("points a non-interactive session at --token when the browser fails", async () => {
    devicePoll = async () => ({ status: "expired" });
    const err = await signIn({
      serverUrl: SERVER, log: silent, openBrowser: async () => {}, sleep: async () => {},
      interactive: false, readSecret: scriptedReader(GOOD),
    }).catch((e) => e);
    expect({ reason: err.reason, hint: /--token/.test(err.hint) }).toEqual({ reason: "expired", hint: true });
  });

  it("tells the user where to go, including the /login URL", async () => {
    const lines = [];
    await signIn({
      serverUrl: SERVER, mode: "paste", log: (m) => lines.push(String(m)),
      interactive: true, readSecret: scriptedReader(GOOD),
    });
    const text = lines.join("\n");
    expect(text).toContain(`${SERVER}/login`);
    expect(text).toMatch(/hidden/i);          // says the input is masked, so a blank prompt is not alarming
  });
});

// ---------------------------------------------------------------------------
// The race. Both ways in are live from the first second — this is what the
// tests above cannot distinguish, because a reader that answers instantly wins
// whether or not the browser flow was ever given a chance.
// ---------------------------------------------------------------------------

/**
 * A user who is still deciding: the prompt is up, nothing has been typed, and
 * it only ends when the race is called off. This is the ordinary case on a
 * machine where the browser did open.
 *
 * `reader.answer(value)` lets a test type into the still-open prompt, which is
 * the only way to end a race whose browser half has already failed — there, by
 * design, the prompt waits indefinitely.
 */
function undecidedReader() {
  const reader = (question, opts = {}) => new Promise((resolve) => {
    reader.calls.push({ question, opts });
    reader.answer = resolve;
    if (opts.signal?.aborted) return resolve(null);
    opts.signal?.addEventListener("abort", () => resolve(null));
  });
  reader.calls = [];
  reader.answer = () => {};
  return reader;
}

/** Answers after `delayMs`, so the browser flow gets a real chance to finish first. */
function slowReader(value, delayMs = 20) {
  return (question, opts = {}) => new Promise((resolve) => {
    if (opts.signal?.aborted) return resolve(null);
    const t = setTimeout(() => resolve(value), delayMs);
    opts.signal?.addEventListener("abort", () => { clearTimeout(t); resolve(null); });
  });
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("signIn — the browser and the paste run at the same time", () => {
  it("cancels the prompt when the browser wins, instead of leaving it hanging", async () => {
    // The failure this prevents: approving in the browser and then being left
    // staring at a "Paste code here" prompt that has already been satisfied.
    const reader = undecidedReader();
    const res = await signIn({
      serverUrl: SERVER, log: silent, openBrowser: async () => {}, sleep: async () => {},
      interactive: true, readSecret: reader,
    });
    expect({ via: res.via, prompted: reader.calls.length > 0 }).toEqual({ via: "browser", prompted: true });
  });

  it("stops polling when the paste wins, so the server is not left tracking a dead code", async () => {
    let polls = 0;
    devicePoll = async () => { polls++; return { status: "pending" }; };

    const res = await signIn({
      serverUrl: SERVER, log: silent, openBrowser: async () => {}, sleep: () => realSleep(2),
      interactive: true, readSecret: scriptedReader(GOOD),
    });
    const atFinish = polls;
    await realSleep(30);

    expect({ via: res.via, keptPolling: polls > atFinish }).toEqual({ via: "token", keptPolling: false });
  });

  it("offers the prompt immediately — not after the browser flow has failed", async () => {
    // The old shape made a headless user wait out a ten-minute poll before the
    // way out was even mentioned. The prompt must be up while the poll is still
    // running, so this checks the prompt appeared BEFORE the poll ended rather
    // than waiting for sign-in to return — it deliberately never does here,
    // which is itself correct: the prompt stays live indefinitely.
    const reader = undecidedReader();
    let polls = 0;
    devicePoll = async () => { polls++; return { status: "pending" }; };

    const running = signIn({
      serverUrl: SERVER, log: silent, openBrowser: async () => {},
      sleep: () => realSleep(2), interactive: true, readSecret: reader,
    }).catch(() => {});

    await realSleep(20);
    expect({ prompted: reader.calls.length, stillPolling: polls > 0 })
      .toEqual({ prompted: 1, stillPolling: true });

    // Leave nothing running behind this test: answering the prompt ends the
    // race and stops the poll, the way a real paste would. An orphaned poll
    // loop leaks into whatever runs next.
    reader.answer(GOOD);
    await running;
  });

  it("keeps the browser flow alive after a mistyped paste", async () => {
    // Someone who fumbles a token and then approves in the browser has done
    // nothing wrong. Killing the poll on their typo strands them.
    meImpl = async ({ token }) => {
      if (token !== GOOD) throw new ApiError("unauthorized", 401, {});
      return { renter: { email: "a@b.c" } };
    };
    let polls = 0;
    devicePoll = async () => {
      polls++;
      return polls >= 3 ? { status: "approved", token: "ail_browserflow", renter: {} } : { status: "pending" };
    };

    const bad = "ail_" + "b".repeat(48);
    let served = false;
    const reader = (question, opts = {}) => new Promise((resolve) => {
      if (!served) { served = true; return resolve(bad); }   // one bad paste, then wait
      opts.signal?.addEventListener("abort", () => resolve(null));
    });

    const res = await signIn({
      serverUrl: SERVER, log: silent, openBrowser: async () => {}, sleep: () => realSleep(2),
      interactive: true, readSecret: reader,
    });
    expect({ via: res.via, polled: polls >= 3 }).toEqual({ via: "browser", polled: true });
  });

  it("keeps the prompt alive after the browser flow fails", async () => {
    // The same rule in reverse: a denied or expired code is reported inline and
    // the prompt stays up, because the user can still finish by pasting.
    devicePoll = async () => ({ status: "denied" });
    const res = await signIn({
      serverUrl: SERVER, log: silent, openBrowser: async () => {}, sleep: async () => {},
      interactive: true, readSecret: slowReader(GOOD, 15),
    });
    expect(res.via).toBe("token");
  });

  it("says the browser path died, and that pasting still works", async () => {
    // Silence here is the cruel case: the code expired, the poll is dead, and
    // the user is left staring at a prompt with no reason to think it is still
    // connected to anything.
    const lines = [];
    devicePoll = async () => ({ status: "expired" });
    await signIn({
      serverUrl: SERVER, log: (m) => lines.push(String(m)),
      openBrowser: async () => {}, sleep: async () => {},
      interactive: true, readSecret: slowReader(GOOD, 15),
    });
    const text = lines.join("\n");
    expect(text).toMatch(/expired/i);
    expect(text).toMatch(/still finish by pasting/i);
  });

  it("stays quiet about the poll it cancelled when the paste won", async () => {
    // The poll is aborted deliberately at that point. Reporting it as a failure
    // would tell the user something went wrong immediately after it went right.
    const lines = [];
    devicePoll = async () => ({ status: "pending" });
    await signIn({
      serverUrl: SERVER, log: (m) => lines.push(String(m)),
      openBrowser: async () => {}, sleep: () => realSleep(2),
      interactive: true, readSecret: slowReader(GOOD, 5),
    });
    await realSleep(20);
    expect(lines.join("\n")).not.toMatch(/completed another way|Sign-in finished the other way/i);
  });

  it("survives a browser that cannot be opened at all", async () => {
    // Headless: `open` throws. That must not fail the sign-in — the URL was
    // printed and the prompt is live. Nobody approves, because nothing opened,
    // so the paste is the only way this can finish.
    devicePoll = async () => ({ status: "pending" });
    const res = await signIn({
      serverUrl: SERVER, log: silent,
      openBrowser: async () => { throw new Error("no display"); },
      sleep: () => realSleep(2), interactive: true,
      readSecret: slowReader(GOOD, 5),
    });
    expect({ via: res.via, started: calls.device.length }).toEqual({ via: "token", started: 1 });
  });

  it("puts the prompt BELOW the instructions, not above them", async () => {
    // Concurrent means both are live, not that they print in whatever order the
    // event loop produces. The prompt writes synchronously while the browser
    // half is still on a network round trip, so without an explicit wait the
    // user's first sight is a bare "Paste code here >" with the URL scrolling
    // in underneath — which reads as a broken screen.
    const seen = [];
    const reader = (question) => new Promise(() => { seen.push(`PROMPT:${question}`); });
    deviceStart = async () => {
      await realSleep(10);                       // a real round trip is not instant
      return {
        deviceCode: "dc", userCode: "ABCD-EFGH",
        verificationUri: "https://aile.test/login",
        verificationUriComplete: "https://aile.test/login?code=ABCD-EFGH",
        expiresIn: 600, interval: 0,
      };
    };
    devicePoll = async () => ({ status: "pending" });

    signIn({
      serverUrl: SERVER, log: (m) => seen.push(`LOG:${m}`),
      openBrowser: async () => {}, sleep: () => realSleep(5),
      interactive: true, readSecret: reader,
    }).catch(() => {});
    await realSleep(60);

    const promptAt = seen.findIndex((l) => l.startsWith("PROMPT:"));
    const urlAt = seen.findIndex((l) => l.includes("aile.test/login?code="));
    expect({ promptShown: promptAt >= 0, urlShown: urlAt >= 0, promptIsLast: promptAt > urlAt })
      .toEqual({ promptShown: true, urlShown: true, promptIsLast: true });
  });

  it("does not strand the prompt when the server never answers", async () => {
    // The prompt waits on the browser half announcing itself. If that half dies
    // before announcing, the wait has to be released anyway — otherwise the one
    // remaining way in never opens.
    deviceStart = async () => { throw new Error("ECONNREFUSED"); };
    const res = await signIn({
      serverUrl: SERVER, log: silent, openBrowser: async () => {}, sleep: async () => {},
      interactive: true, readSecret: slowReader(GOOD, 5),
    });
    expect(res.via).toBe("token");
  });

  it("prints the URL and the way to recover when the browser stays shut", async () => {
    const lines = [];
    const reader = undecidedReader();
    await signIn({
      serverUrl: SERVER, log: (m) => lines.push(String(m)),
      openBrowser: async () => {}, sleep: async () => {},
      interactive: true, readSecret: reader,
    });
    const text = lines.join("\n");
    expect(text).toMatch(/Browser didn't open\?/);
    expect(text).toContain("https://aile.test/login?code=ABCD-EFGH");
    expect(text).toContain("ABCD-EFGH");        // the code to confirm against the page
  });

  it("copies the sign-in URL on the advertised hotkey", async () => {
    // The offer says "(c to copy)". If the key does nothing the offer is a lie,
    // and over SSH the printed URL is the only thing that works. It copies the
    // URL printed right above it — the one carrying the code — not a bare
    // /login, which was a different page from the one on screen.
    const copied = [];
    const reader = (question, opts = {}) => new Promise((resolve) => {
      opts.hotkeys?.c?.();                                    // the user presses c
      opts.signal?.addEventListener("abort", () => resolve(null));
    });
    await signIn({
      serverUrl: SERVER, log: silent, openBrowser: async () => {}, sleep: async () => {},
      interactive: true, readSecret: reader,
      copy: async (text) => { copied.push(text); return true; },
    });
    expect(copied).toEqual(["https://aile.test/login?code=ABCD-EFGH"]);
  });

  it("reports the browser's failure when BOTH ways are exhausted", async () => {
    // The browser is the path the user was told to expect, so its error is the
    // one that explains what they saw.
    devicePoll = async () => ({ status: "expired" });
    meImpl = async () => { throw new ApiError("unauthorized", 401, {}); };
    const err = await signIn({
      serverUrl: SERVER, log: silent, openBrowser: async () => {}, sleep: async () => {},
      interactive: true, readSecret: scriptedReader(GOOD, GOOD, GOOD),
    }).catch((e) => e);
    expect({ reason: err.reason, hint: /--paste/.test(err.hint || "") })
      .toEqual({ reason: "expired", hint: true });
  });

  it("writes exactly one config, never both winners", async () => {
    // Both paths call saveConfig. If the loser is not stopped cleanly it can
    // land a second write and the stored token stops matching the account the
    // user just saw confirmed.
    devicePoll = async () => ({ status: "approved", token: "ail_browserflow", renter: {} });
    await signIn({
      serverUrl: SERVER, log: silent, openBrowser: async () => {}, sleep: async () => {},
      interactive: true, readSecret: slowReader(GOOD, 10),
    });
    await realSleep(30);
    expect(calls.saved.length).toBe(1);
  });
});

/**
 * The `undefined` bug, from the caller's side.
 *
 * The transport fix (test/transport.test.js) stops a non-JSON reply becoming an
 * empty object. This is the second line of defence: even a server that answers
 * with well-formed JSON of the WRONG SHAPE must not reach the screen. Before, the
 * missing field was interpolated straight into "Browser didn't open? Use the url
 * below" and handed to the browser opener.
 */
describe("deviceLogin — the server's answer is a contract", () => {
  it.each([
    ["an empty object", {}],
    ["no verificationUri", { deviceCode: "dc", userCode: "ABCD-EFGH" }],
    ["no deviceCode", { userCode: "ABCD-EFGH", verificationUri: "https://aile.test/login" }],
    ["a null verificationUri", { deviceCode: "dc", userCode: "A", verificationUri: null }],
  ])("refuses %s rather than printing undefined", async (_name, reply) => {
    deviceStart = async () => reply;
    const err = await deviceLogin({ serverUrl: "https://aile.test", enrol: false }).catch((e) => e);
    expect(err).toBeInstanceOf(LoginError);
    expect(err.reason).toBe("bad-response");
    expect(err.message).not.toContain("undefined");
  });

  it("never opens a browser at an address it rejected", async () => {
    deviceStart = async () => ({});
    const opened = [];
    await deviceLogin({
      serverUrl: "https://aile.test", enrol: false,
      openBrowser: async (u) => { opened.push(u); },
    }).catch(() => {});
    expect(opened).toEqual([]);
  });
});

describe("deviceLogin — an unrecognised poll state is terminal", () => {
  it("stops instead of looping out the full ten minutes", async () => {
    // The old code fell through every `if` and continued, so a state it did not
    // know about was indistinguishable from a user who had not clicked yet.
    devicePoll = async () => ({ status: "something-new" });
    const err = await deviceLogin({
      serverUrl: "https://aile.test", enrol: false, sleep: async () => {},
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LoginError);
    expect(err.reason).toBe("unknown-status");
    expect(calls.poll.length).toBe(1);
  });

  it("treats a missing status the same way", async () => {
    devicePoll = async () => ({});
    const err = await deviceLogin({
      serverUrl: "https://aile.test", enrol: false, sleep: async () => {},
    }).catch((e) => e);
    expect(err.reason).toBe("unknown-status");
    expect(calls.poll.length).toBe(1);
  });

  it("reports an unbound sign-in as its own reason, pointing at an update", async () => {
    devicePoll = async () => ({ status: "unbound" });
    const err = await deviceLogin({
      serverUrl: "https://aile.test", enrol: false, sleep: async () => {},
    }).catch((e) => e);
    expect(err.reason).toBe("unbound");
    expect(err.hint).toContain("aile update");
  });
});

/**
 * The binding. What must be true: the challenge crosses the network, the verifier
 * does too (only on the poll), they correspond, and the verifier NEVER reaches
 * disk — saving it beside the renter token would recreate the exposure it exists
 * to close.
 */
describe("deviceLogin — proof that this client started the sign-in", () => {
  it("sends a challenge on start and the matching verifier on every poll", async () => {
    const { challengeFor } = await import("../src/auth/pkce.js");
    await deviceLogin({ serverUrl: "https://aile.test", enrol: false, sleep: async () => {} });

    const challenge = calls.device[0].codeChallenge;
    const verifier = calls.poll[0].codeVerifier;
    expect(typeof challenge).toBe("string");
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(typeof verifier).toBe("string");
    expect(challengeFor(verifier)).toBe(challenge);
    // The hash is what travels first; the preimage must not be guessable from it.
    expect(challenge).not.toBe(verifier);
  });

  it("never writes the verifier to disk", async () => {
    await deviceLogin({ serverUrl: "https://aile.test", enrol: false, sleep: async () => {} });
    const verifier = calls.poll[0].codeVerifier;
    expect(JSON.stringify(calls.saved)).not.toContain(verifier);
  });

  it("uses a fresh verifier for every sign-in", async () => {
    await deviceLogin({ serverUrl: "https://aile.test", enrol: false, sleep: async () => {} });
    const first = calls.poll[0].codeVerifier;
    calls.poll.length = 0;
    await deviceLogin({ serverUrl: "https://aile.test", enrol: false, sleep: async () => {} });
    expect(calls.poll[0].codeVerifier).not.toBe(first);
  });

  it("withholds the machine label when asked to", async () => {
    const saved = process.env.AILE_NO_MACHINE_LABEL;
    process.env.AILE_NO_MACHINE_LABEL = "1";
    try {
      await deviceLogin({ serverUrl: "https://aile.test", enrol: false, sleep: async () => {} });
      expect(calls.device[0].clientLabel).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.AILE_NO_MACHINE_LABEL;
      else process.env.AILE_NO_MACHINE_LABEL = saved;
    }
  });
});
