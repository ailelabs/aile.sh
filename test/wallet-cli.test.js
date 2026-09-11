/**
 * `aile wallet` — the account's wallet, and what it holds.
 *
 * ============================================================================
 * THIS FILE USED TO TEST A PAYOUT ADDRESS. Its four stated risks were a write
 * path reappearing, the custody answer going missing, the WRITE-ONCE property
 * going unsaid, and a donor being told how to get paid. Three of those are about
 * a destination recorded on file, and there is no longer one: a withdrawal names
 * where it is going at the moment it is made.
 *
 * WHAT IS AT RISK NOW, which is not "does it print":
 *
 *  1. A BALANCE THAT CANNOT BE READ BECOMING A ZERO. `null` from an unreachable
 *     RPC and `0` from an empty wallet are the same shape and mean opposite
 *     things, and only one of them is alarming to read about your own earnings.
 *     Printing "$0.00" for an outage is the single worst thing this command can
 *     do, so it is asserted directly.
 *  2. A WRITE PATH REAPPEARING. Still. The reason is different — a wallet is not
 *     a setting, and this client has no code that could receive a private key —
 *     but the absence is the same absence and cannot be checked by exercising it.
 *  3. THE CUSTODY ANSWER GOING MISSING, and going missing now includes going
 *     WRONG. The old answer was "this server has never held your key and cannot
 *     spend from here." That is no longer true: the wallet can be signed for on
 *     your instruction. An out-of-date reassurance is worse than none, so what is
 *     asserted is the honest version — enclave, exportable, session-signed, 2FA.
 *  4. A DONOR BEING TOLD HOW TO GET PAID. Unchanged, and still worth pinning:
 *     nothing accrues to them by their own choice.
 *
 * Run through the real CLI, like the other command tests: `src/cli/index.js`
 * dispatches at import time, so nothing here can be reached by importing it.
 * ============================================================================
 */

import { describe, expect, it, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dirname, "..", "src", "cli", "index.js");
const API = path.join(import.meta.dirname, "..", "src", "api", "client.js");
const scratches = [];

const ADDR = "94AtcatFepB2fueGy4BsGb6MoWL6ek5y5R1X97mSrh2V";

// The whole 200 body, as the server sends it. `exportable: true` rather than a
// key: the key is in the wallet provider's enclave and comes out in a browser,
// encrypted to the tab that asked. Nothing in this client could receive one.
const WALLET = {
  wallet: {
    address: ADDR,
    walletId: "hqx7k2m9p4",
    createdAt: "2026-07-01T10:04:11.000Z",
    exportable: true,
    usdcMicros: 128_400_000,
    usdc: "128.40",
  },
};

/** The same wallet with a balance the chain would not answer for. */
const UNREADABLE = {
  wallet: { ...WALLET.wallet, usdcMicros: null, usdc: null },
};

/**
 * A wallet with requests bought against it and not yet paid out.
 *
 * `owedMicros` is a local sum over this account's own debits; `spendableMicros`
 * is the balance minus it, and `spendable` its display form. The gross is
 * UNCHANGED — the USDC is still on chain until settlement batches it — which is
 * exactly why the two numbers have to be shown together.
 */
const OWING = {
  wallet: {
    ...WALLET.wallet,
    owedMicros: 4_088,
    spendableMicros: 128_395_912,
    spendable: "128.40",
  },
};

/**
 * THE OTHER DIRECTION: A LENDER'S EARNINGS, COUNTED AND NOT YET SENT.
 *
 * `incomingMicros` is net of the network fee — it is what will actually arrive.
 * `settlement` is the WHEN, and it comes from the server for the same reason
 * `owedMicros` does: the threshold, the maximum age and the sweep period are
 * that deployment's settings, so a client counting down from its own constants
 * would print a confident wrong minute and keep printing it after an operator
 * changed one.
 *
 * These figures are a real sub-threshold batch: $0.0049 of a $0.10 batch, so
 * $0.0951 short, and about six minutes left on the clock.
 */
const LENDING = {
  wallet: {
    ...WALLET.wallet,
    incomingMicros: 4_900,
    incoming: "0.0049",
    settlement: {
      dueNow: false,
      thresholdMicros: 100_000,
      shortfallMicros: 95_100,
      etaMs: 6 * 60_000,
      requests: 4,
    },
  },
};

/**
 * An account that signed in with its OWN Solana wallet.
 *
 * Earnings settle straight to `payTo` and never enter the wallet named by
 * `address` — so there is nothing here to withdraw for them, and no key of
 * theirs on the server to export. `exportable: false` is the server saying so.
 */
const SELF_CUSTODY = {
  wallet: {
    ...WALLET.wallet,
    exportable: false,
    selfCustody: true,
    payTo: "BGQRmLov6bZKe6tzHQMVJjSVNA5qAhr1HqjugPfX4s1e",
  },
};

const DONOR = {
  wallet: null,
  reason: "this machine is contributing anonymously — nothing accrues, so there is no wallet. Sign in to be paid instead.",
};

const OUTAGE = {
  wallet: null,
  reason: "no wallet yet — this is the wallet service being unreachable rather than anything you need to do. Try again in a moment.",
};

/** A stub server that records every request, so a test can assert on method and query. */
function stubServer({ body = WALLET, status = 200 } = {}) {
  const calls = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      calls.push(`${req.method} ${url.pathname}${url.search}`);
      if (url.pathname === "/wallet" && req.method === "GET") {
        const enveloped = status >= 200 && status < 300
          ? { success: true, data: body, message: "" }
          : { success: false, message: body.reason ?? body.error ?? "", error: body.error };
        return Response.json(enveloped, { status });
      }
      return Response.json({ success: false, message: "not found", error: "not found" }, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    stop: () => { try { server.stop(true); } catch { /* ignore */ } },
  };
}

function signedInData(serverUrl, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-wallet-cli-"));
  scratches.push(dir);
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ serverUrl, renterToken: `ail_${"a".repeat(48)}`, ...extra }),
  );
  return dir;
}

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

afterAll(() => {
  for (const d of scratches) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

// ---------------------------------------------------------------------------

/**
 * The absence tests.
 *
 * A capability that does not exist cannot be checked by calling it, so these check
 * the shape of the client and the traffic it makes. They exist so that a future
 * change reintroducing a write path fails here, next to the comment explaining why
 * it was removed, rather than shipping quietly.
 */
describe("there is no way to create, move, or extract a wallet from here", () => {
  it("exports no create or replace call", async () => {
    const { api } = await import(API);
    for (const name of ["createWallet", "replaceWallet", "newWallet", "setWallet", "generateWallet"]) {
      expect({ name, present: name in api }).toEqual({ name, present: false });
    }
  });

  it("exports no way to fetch a key, which is a browser errand and not a terminal one", async () => {
    // `/wallet/export` returns ciphertext addressed to the tab that generated the
    // recipient key. A terminal cannot decrypt it, and a client method here would
    // be the first half of somebody deciding to try.
    const { api } = await import(API);
    for (const name of ["exportWallet", "walletExport", "privateKey", "exportKey"]) {
      expect({ name, present: name in api }).toEqual({ name, present: false });
    }
  });

  it("only ever GETs, whatever flags it is given", async () => {
    // `--new` and `--replace` are not flags any more, so they land in the
    // positional args and must not become a write. The command still succeeds —
    // it just reads.
    const srv = stubServer({ body: WALLET });
    try {
      for (const extra of [[], ["--new"], ["--replace"], ["--yes"]]) {
        const res = await run(["wallet", ...extra], { data: signedInData(srv.url) });
        expect({ extra, code: res.code }).toEqual({ extra, code: 0 });
      }
      expect([...new Set(srv.calls.map((c) => c.split("?")[0]))]).toEqual(["GET /wallet"]);
    } finally { srv.stop(); }
  });

  it("never prints anything that looks like a private key", async () => {
    const srv = stubServer({ body: WALLET });
    try {
      const res = await run(["wallet"], { data: signedInData(srv.url) });
      expect(res.all).not.toMatch(/secret/i);
      expect(res.all).not.toMatch(/private key/i);
      expect(res.all).not.toMatch(/--new|--replace/);
      // Naming the export PAGE is right and is the point — it is where the key
      // actually comes out. A key in this output would not be.
      expect(res.all).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{80,}/);
    } finally { srv.stop(); }
  });
});

describe("the balance, which is why anybody runs this", () => {
  it("asks the server for it, since the server does not volunteer one", async () => {
    // Reading it costs the server an RPC hop, so it is opt-in on the wire. A
    // client that forgot the parameter would silently print "could not be read"
    // forever, which looks like an outage and is a missing query string.
    const srv = stubServer({ body: WALLET });
    try {
      await run(["wallet"], { data: signedInData(srv.url) });
      expect(srv.calls[0]).toBe("GET /wallet?balance=1");
    } finally { srv.stop(); }
  });

  it("shows the amount and the wallet it is in", async () => {
    const srv = stubServer({ body: WALLET });
    try {
      const res = await run(["wallet"], { data: signedInData(srv.url) });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain(ADDR);
      expect(res.stdout).toContain("$128.40");
      expect(res.stdout).toMatch(/earnings arrive here/i);
    } finally { srv.stop(); }
  });

  /**
   * THE ONE THAT MATTERS MOST IN THIS FILE.
   *
   * `null` and `0` are the same shape on the wire and mean opposite things. An
   * unreachable RPC printed as "$0.00" tells a lender their earnings are gone,
   * which is both false and the most alarming false thing this command could say.
   */
  it("SAYS A BALANCE COULD NOT BE READ RATHER THAN PRINTING ZERO", async () => {
    const srv = stubServer({ body: UNREADABLE });
    try {
      const res = await run(["wallet"], { data: signedInData(srv.url) });
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/could not be read/i);
      expect(res.stdout).not.toContain("$0.00");
      // And the address still shows: the wallet is fine, only the read failed.
      expect(res.stdout).toContain(ADDR);
    } finally { srv.stop(); }
  });

  it("prints a real zero as a real zero", async () => {
    // The inverse of the above, so the fix for it cannot be "never say zero".
    const srv = stubServer({
      body: { wallet: { ...WALLET.wallet, usdcMicros: 0, usdc: "0.00" } },
    });
    try {
      const res = await run(["wallet"], { data: signedInData(srv.url) });
      expect(res.stdout).toContain("$0.00");
      expect(res.stdout).not.toMatch(/could not be read/i);
    } finally { srv.stop(); }
  });

  it("survives a server that sends no balance fields at all", async () => {
    // An older deployment, or one that ignored the query. Undefined must read the
    // same as unreadable, not throw and not print "$undefined".
    const srv = stubServer({ body: { wallet: { address: ADDR, exportable: true } } });
    try {
      const res = await run(["wallet"], { data: signedInData(srv.url) });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain(ADDR);
      expect(res.stdout).not.toContain("undefined");
    } finally { srv.stop(); }
  });
});

/**
 * THE BALANCE AND THE SPENDABLE BALANCE, WHICH ARE NOT THE SAME NUMBER.
 *
 * A request bought against this wallet is subtracted from what may be spent the
 * instant it is reserved, but the USDC does not leave the wallet until settlement
 * batches it — a Solana fee costs more than a single request is worth, so debts
 * accrue and pay out in one transaction. That gap is real and it is on purpose.
 *
 * The failure this guards is specific: print only the gross, and a buyer refused
 * for insufficient funds is looking at a screen that says they are funded. That is
 * the 402 they already hit, relocated one level up and harder to explain.
 */
describe("what is already spoken for", () => {
  it("prints what is owed and what is left, beside the balance and not instead of it", async () => {
    const srv = stubServer({ body: OWING });
    try {
      const res = await run(["wallet"], { data: signedInData(srv.url) });
      expect(res.code).toBe(0);
      // The gross is still the headline. It is the true on-chain figure and a
      // buyer reconciling against an explorer must find it here unchanged.
      expect(res.stdout).toContain("$128.40");
      expect(res.stdout).toMatch(/Owed:\s+\$0\.004088/);
      expect(res.stdout).toMatch(/not yet paid out/i);
      expect(res.stdout).toMatch(/Spendable:\s*\$128\.40/);
    } finally { srv.stop(); }
  });

  it("SAYS NOTHING AT ALL WHEN NOTHING IS OWED", async () => {
    // A permanent "Owed: $0.000000" would ask every lender to understand batched
    // settlement in order to read their own balance. Absence is the right answer
    // to "nothing is happening".
    const srv = stubServer({ body: WALLET });
    try {
      const res = await run(["wallet"], { data: signedInData(srv.url) });
      expect(res.stdout).not.toMatch(/Owed:/);
      expect(res.stdout).not.toMatch(/Spendable:/);
      expect(res.stdout).not.toContain("$0.000000");
    } finally { srv.stop(); }
  });

  it("STILL REPORTS THE DEBT WHEN THE CHAIN WOULD NOT ANSWER, and does not invent a spendable figure", async () => {
    // The debt is ours and is known without an RPC, so it is reported. The
    // subtraction is not: a balance we could not read minus a real debt is not a
    // number, and printing one would be a guess dressed as an amount.
    const srv = stubServer({
      body: {
        wallet: {
          ...UNREADABLE.wallet,
          owedMicros: 4_088,
          spendableMicros: null,
          spendable: null,
        },
      },
    });
    try {
      const res = await run(["wallet"], { data: signedInData(srv.url) });
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/could not be read/i);
      expect(res.stdout).toMatch(/Owed:\s+\$0\.004088/);
      expect(res.stdout).not.toMatch(/Spendable:/);
      expect(res.stdout).not.toContain("undefined");
    } finally { srv.stop(); }
  });

  it("carries the owed figure through --json as an integer a script can compare", async () => {
    // Same reason as `usdcMicros`: a script deciding "can I afford this" must read
    // the integer, not parse the formatted string back into a float.
    const srv = stubServer({ body: OWING });
    try {
      const res = await run(["wallet", "--json"], { data: signedInData(srv.url) });
      const { wallet } = JSON.parse(res.stdout);
      expect(wallet.owedMicros).toBe(4_088);
      expect(wallet.spendableMicros).toBe(128_395_912);
      // And the gross survives untouched, so both halves of the subtraction are
      // available to whoever wants to do it themselves.
      expect(wallet.usdcMicros).toBe(128_400_000);
    } finally { srv.stop(); }
  });
});

/**
 * WHAT IS OWED **TO** THIS ACCOUNT, WHICH IS THE OPPOSITE SIDE OF THE LEDGER.
 *
 * The failure this guards is the one that was reported twice: a lender with four
 * served requests ran this command, read `Balance: $0.00`, and had nothing at all
 * to explain it. Their earnings existed, were counted, and had not been sent —
 * because a Solana fee costs more than one small request is worth, so debts batch.
 * A balance line alone reports that state as "you have earned nothing".
 *
 * Two things therefore have to be true and are asserted separately:
 *
 *  1. THE AMOUNT IS SAID. Otherwise the command is silent about money that exists.
 *  2. THE **WHEN** IS SAID, AND IS READ RATHER THAN COMPUTED. Both halves of
 *     "whichever comes first" — because either can be the one that fires — and
 *     both taken from the server, since the deployment owns those settings.
 */
describe("what is owed to you, which is the reason a lender runs this at all", () => {
  it("NAMES THE AMOUNT AND HOW MANY REQUESTS EARNED IT", async () => {
    const srv = stubServer({ body: LENDING });
    try {
      const res = await run(["wallet"], { data: signedInData(srv.url) });
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/Incoming:\s+\$0\.0049/);
      expect(res.stdout).toMatch(/from 4 requests already served/i);
      expect(res.stdout).toMatch(/not yet paid out/i);
    } finally { srv.stop(); }
  });

  it("SAYS BOTH THE SHORTFALL AND THE CLOCK, because either one can send the batch", async () => {
    // A lender told only the amount waits for traffic that may never come; one
    // told only the clock cannot see that four more requests would send it today.
    const srv = stubServer({ body: LENDING });
    try {
      const res = await run(["wallet"], { data: signedInData(srv.url) });
      expect(res.stdout).toMatch(/\$0\.0951 more/);
      expect(res.stdout).toMatch(/6 minutes/);
      expect(res.stdout).toMatch(/before the batch is sent/i);
    } finally { srv.stop(); }
  });

  it("says it is going out now when the server says it is due", async () => {
    // The opposite state, so the fix for the above cannot be "always print a
    // countdown" — a batch already over the threshold has no shortfall to name.
    const srv = stubServer({
      body: {
        wallet: {
          ...LENDING.wallet,
          incomingMicros: 142_500,
          settlement: { ...LENDING.wallet.settlement, dueNow: true, shortfallMicros: 0, etaMs: 0 },
        },
      },
    });
    try {
      const res = await run(["wallet"], { data: signedInData(srv.url) });
      expect(res.stdout).toMatch(/due now/i);
      expect(res.stdout).toMatch(/next settlement pass/i);
      expect(res.stdout).not.toMatch(/before the batch is sent/i);
    } finally { srv.stop(); }
  });

  /**
   * ========================================================================
   * A FIRST PAYOUT IS AN AMOUNT, NEVER A COUNTDOWN — AND THIS IS CHECKED
   * BEFORE `dueNow`, WHICH IS THE PART THAT IS EASY TO GET WRONG.
   *
   * The first payment to a wallet has to open a USDC token account for it. The
   * network charges the rent-exempt minimum for that — about two hundred times a
   * transfer's fee — and, unlike the batching threshold, waiting does not release
   * it. So a first batch can be well past the batching threshold, report
   * `dueNow`, and still not be sent, and the server returns a null `etaMs` to say
   * so. Printing minutes there is the "usually within a minute" bug arriving in
   * the terminal.
   * ========================================================================
   */
  it("NAMES THE OPENING AMOUNT ON A FIRST PAYOUT, and quotes no minutes", async () => {
    const srv = stubServer({
      body: {
        wallet: {
          ...LENDING.wallet,
          settlement: {
            ...LENDING.wallet.settlement,
            // Due by the batching rule and held anyway, which is the state that
            // makes the ordering of these branches load-bearing.
            dueNow: true,
            etaMs: null,
            firstPayout: true,
            openAtMicros: 500_000,
            openShortfallMicros: 495_100,
          },
        },
      },
    });
    try {
      const res = await run(["wallet"], { data: signedInData(srv.url) });
      expect(res.stdout).toMatch(/\$0\.4951 more, to \$0\.50/);
      expect(res.stdout).toMatch(/before the first one is sent/i);
      expect(res.stdout).toMatch(/opens a USDC account for your wallet/i);
      // Neither of the two sentences that would have been a lie.
      expect(res.stdout).not.toMatch(/due now/i);
      expect(res.stdout).not.toMatch(/a minute/i);
      expect(res.stdout).not.toContain("NaN");
    } finally { srv.stop(); }
  });

  it("SAYS NOTHING AT ALL TO SOMEBODY WHO HAS NEVER LENT", async () => {
    // Same rule as the owed block: a permanent "Incoming: $0.0000" would ask a
    // buyer to understand batched settlement in order to read their own balance.
    const srv = stubServer({ body: WALLET });
    try {
      const res = await run(["wallet"], { data: signedInData(srv.url) });
      expect(res.stdout).not.toMatch(/Incoming:/);
      expect(res.stdout).not.toMatch(/before the batch is sent/i);
      expect(res.stdout).not.toMatch(/settlement pass/i);
    } finally { srv.stop(); }
  });

  /**
   * ========================================================================
   * AND THE ACCOUNT WHERE "EARNINGS ARRIVE HERE" IS SIMPLY NOT TRUE.
   *
   * Somebody who signed in with their own wallet is paid straight to it. The
   * closing paragraphs of this command describe a wallet the SERVER minted — the
   * key in an enclave, the export link, "earnings arrive here" — and every one of
   * those sentences is false for them. Worse than useless: an export link there
   * offers the key to a pass-through account while implying it is the key to
   * their money.
   * ========================================================================
   */
  it("DOES NOT CLAIM EARNINGS ARRIVE HERE when they are settled to their own wallet", async () => {
    const srv = stubServer({ body: SELF_CUSTODY });
    try {
      const res = await run(["wallet"], { data: signedInData(srv.url) });
      expect(res.code).toBe(0);

      expect(res.stdout).toContain(SELF_CUSTODY.wallet.payTo);
      expect(res.stdout).toMatch(/earnings need no withdrawal/i);
      // None of the minted-wallet story, and no export link.
      expect(res.stdout).not.toMatch(/Earnings arrive here/i);
      expect(res.stdout).not.toMatch(/wallet\/export/);
      expect(res.stdout).not.toMatch(/secure enclave/i);
    } finally { srv.stop(); }
  });

  it("keeps the enclave and export paragraphs for a wallet the server minted", async () => {
    // The other side of the branch, so the fix above cannot become "never
    // mention export" — for an account that WAS given a wallet, export is the
    // whole reason giving it was defensible.
    const srv = stubServer({ body: WALLET });
    try {
      const res = await run(["wallet"], { data: signedInData(srv.url) });
      expect(res.stdout).toMatch(/Earnings arrive here/i);
      expect(res.stdout).toMatch(/wallet\/export/);
    } finally { srv.stop(); }
  });

  it("does not fall over when the server sends the amount and no detail", async () => {
    // An older deployment, or a settlement read that failed behind the scenes.
    // The amount is still worth saying; the countdown is not invented.
    const srv = stubServer({
      body: { wallet: { ...WALLET.wallet, incomingMicros: 4_900 } },
    });
    try {
      const res = await run(["wallet"], { data: signedInData(srv.url) });
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/Incoming:\s+\$0\.0049/);
      expect(res.stdout).not.toContain("undefined");
      expect(res.stdout).not.toContain("NaN");
    } finally { srv.stop(); }
  });

  it("carries the integers through --json, settlement included", async () => {
    // A lender scripting "am I close to a payout" must read the integers rather
    // than parse a sentence back into numbers.
    const srv = stubServer({ body: LENDING });
    try {
      const res = await run(["wallet", "--json"], { data: signedInData(srv.url) });
      const { wallet } = JSON.parse(res.stdout);
      expect(wallet.incomingMicros).toBe(4_900);
      expect(wallet.settlement.shortfallMicros).toBe(95_100);
      expect(wallet.settlement.dueNow).toBe(false);
    } finally { srv.stop(); }
  });
});

describe("where the money can go, which is nowhere until you say so", () => {
  it("points at the withdraw page rather than showing a destination", async () => {
    // There is no destination to show. Somebody looking for one has to be told
    // where the answer actually is, or they file a missing feature.
    const srv = stubServer({ body: WALLET });
    try {
      const res = await run(["wallet"], { data: signedInData(srv.url) });
      expect(res.stdout).toContain(`${srv.url}/wallet/withdraw`);
      expect(res.stdout).toMatch(/paste the address to send/i);
    } finally { srv.stop(); }
  });

  it("says nothing is on file, and says why that is the protection", async () => {
    // The old command explained write-once as a protection. This is its
    // replacement and it is a stronger one: there is no stored destination to
    // steal, rather than one that is merely hard to change.
    const srv = stubServer({ body: WALLET });
    try {
      const res = await run(["wallet"], { data: signedInData(srv.url) });
      expect(res.stdout).toMatch(/nothing is on file/i);
      expect(res.stdout).toMatch(/point your earnings anywhere in advance/i);
    } finally { srv.stop(); }
  });

  it("NO LONGER CLAIMS THE ADDRESS IS SET ONCE, because that was about a thing that is gone", async () => {
    // A stale reassurance is worse than no reassurance: it describes a protection
    // the software does not have, and somebody relies on it.
    const srv = stubServer({ body: WALLET });
    try {
      const res = await run(["wallet"], { data: signedInData(srv.url) });
      expect(res.stdout).not.toMatch(/set once/i);
      expect(res.stdout).not.toMatch(/cannot be changed/i);
      expect(res.stdout).not.toMatch(/payout address/i);
    } finally { srv.stop(); }
  });
});

describe("the custody answer, which changed and had to", () => {
  it("says where the key is and that it can be taken out", async () => {
    const srv = stubServer({ body: WALLET });
    try {
      const res = await run(["wallet"], { data: signedInData(srv.url) });
      expect(res.stdout).toMatch(/enclave/i);
      expect(res.stdout).toContain(`${srv.url}/wallet/export`);
      expect(res.stdout).toMatch(/ciphertext it cannot read/i);
    } finally { srv.stop(); }
  });

  /**
   * THE HONEST VERSION OF A SENTENCE THAT USED TO BE TRUE.
   *
   * "This server has never held your key and cannot spend from here" was correct
   * about a wallet the lender held themselves. It is false about this one, which
   * is signed for on the renter's instruction — so the claim is asserted ABSENT,
   * and what replaces it names the protection that actually exists.
   */
  it("DOES NOT CLAIM THE SERVER CANNOT SPEND, and names what stops it instead", async () => {
    const srv = stubServer({ body: WALLET });
    try {
      const res = await run(["wallet"], { data: signedInData(srv.url) });
      expect(res.stdout).not.toMatch(/cannot spend/i);
      expect(res.stdout).not.toMatch(/never held/i);
      expect(res.stdout).toMatch(/your browser session/i);
      expect(res.stdout).toMatch(/two-step verification/i);
    } finally { srv.stop(); }
  });
});

describe("having no wallet", () => {
  it("is reported as an ordinary state, not an error", async () => {
    // A donated machine can lend perfectly well with no wallet. A non-zero exit
    // would make a script treat that as a failure.
    const srv = stubServer({ body: DONOR, status: 404 });
    try {
      const res = await run(["wallet"], { data: signedInData(srv.url) });
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/no wallet/i);
    } finally { srv.stop(); }
  });

  it("says nothing about getting paid to a donor, who chose not to be", async () => {
    // Nothing accrues to them by their own choice. Instructions would be noise,
    // and the server's own reason already says the one useful thing.
    const srv = stubServer({ body: DONOR, status: 404 });
    try {
      const res = await run(["wallet"], { data: signedInData(srv.url) });
      expect(res.stdout).toMatch(/contributing anonymously/i);
      expect(res.stdout).not.toMatch(/wallet\/withdraw/);
      expect(res.stdout).not.toMatch(/enclave/i);
    } finally { srv.stop(); }
  });

  it("passes through the OTHER 404, which is an outage and not a choice", async () => {
    // The two reasons want opposite responses — one is "this is how you set it
    // up", the other is "try again shortly" — so the server's own wording is
    // printed rather than one guessed here.
    const srv = stubServer({ body: OUTAGE, status: 404 });
    try {
      const res = await run(["wallet"], { data: signedInData(srv.url) });
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/try again in a moment/i);
      expect(res.stdout).not.toMatch(/contributing anonymously/i);
    } finally { srv.stop(); }
  });
});

describe("--json", () => {
  it("emits the server's answer and nothing else on stdout", async () => {
    const srv = stubServer({ body: WALLET });
    try {
      const res = await run(["wallet", "--json"], { data: signedInData(srv.url) });
      expect(JSON.parse(res.stdout)).toEqual(WALLET);
    } finally { srv.stop(); }
  });

  it("emits the 404 body too, since an absent wallet is data and not an error", async () => {
    const srv = stubServer({ body: DONOR, status: 404 });
    try {
      const res = await run(["wallet", "--json"], { data: signedInData(srv.url) });
      expect(JSON.parse(res.stdout)).toEqual(DONOR);
    } finally { srv.stop(); }
  });

  it("carries the balance through as a number a script can compare", async () => {
    // `usdc` is a display string. `usdcMicros` is the integer, and it is what a
    // script checking "do I have enough to withdraw" should read — parsing the
    // formatted one back into a float is how rounding bugs start.
    const srv = stubServer({ body: WALLET });
    try {
      const res = await run(["wallet", "--json"], { data: signedInData(srv.url) });
      expect(JSON.parse(res.stdout).wallet.usdcMicros).toBe(128_400_000);
    } finally { srv.stop(); }
  });
});

describe("before there is an account", () => {
  it("says how to set the machine up, naming both ways", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-wallet-cli-"));
    scratches.push(dir);
    const res = await run(["wallet"], { data: dir });
    expect(res.code).toBe(1);
    expect(res.all).toMatch(/not set up yet/i);
    expect(res.all).toMatch(/aile login/);
    expect(res.all).toMatch(/aile donate/);
  });
});

describe("an unreachable server", () => {
  it("fails with the reason rather than pretending there is no wallet", async () => {
    // Conflating "we cannot ask" with "you have none" would tell a lender their
    // wallet had vanished — the same failure as printing a zero balance, one
    // level up.
    const srv = stubServer();
    const url = srv.url;
    srv.stop();
    const res = await run(["wallet"], { data: signedInData(url) });
    expect(res.code).toBe(1);
    expect(res.all).toMatch(/could not reach/i);
    expect(res.all).not.toMatch(/no wallet/i);
  });
});

describe("help", () => {
  it("lists the command and states the model in one place", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-wallet-cli-"));
    scratches.push(dir);
    const res = await run(["--help"], { data: dir });
    expect(res.stdout).toContain("aile wallet");
    expect(res.stdout).toMatch(/one account, one wallet/i);
    expect(res.stdout).toMatch(/nothing is kept on file/i);
    // And no command that does not exist.
    expect(res.stdout).not.toMatch(/wallet --new|wallet --replace/);
  });

  it("no longer advertises a payout address anywhere in help", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-wallet-cli-"));
    scratches.push(dir);
    const res = await run(["--help"], { data: dir });
    expect(res.stdout).not.toMatch(/payout address/i);
    expect(res.stdout).not.toMatch(/wallet you already own/i);
  });
});
