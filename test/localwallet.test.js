/**
 * The opt-in self-custody wallet, piece by piece: key derivation against published
 * vectors, the encrypted file, and every check that must happen BEFORE a key
 * signs anything. The end-to-end paths (a real CLI paying a stub server) are in
 * renter-cli.test.js; this file is the parts that can be wrong silently.
 */

import { describe, expect, it, afterEach } from "bun:test";
import fs from "node:fs";
import { slip10Ed25519, signerFromMnemonic, isValidMnemonic, newMnemonic, normalizeMnemonic } from "../src/localwallet/derive.js";
import { WALLET_FILE, writeWallet, readMnemonic, readWalletInfo, removeWallet, walletExists, WalletLockedError } from "../src/localwallet/store.js";
import { readChallenge, pickRequirement, buildPaymentHeader, readSettlement, PaymentRefused, mppMethods, noChallengeReason } from "../src/localwallet/x402.js";
import { payChallenge } from "../src/localwallet/index.js";
import { NETWORKS, sameNetwork } from "../src/localwallet/solana.js";
import { rpcStub } from "./helpers/solana-rpc-stub.js";

const ABANDON = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
// Phantom's address for the BIP-39 test phrase at m/44'/501'/0'/0'. If this
// changes, a user's restored wallet is a different, empty wallet.
const ABANDON_ADDRESS = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";

const NET = { name: "mainnet", ...NETWORKS.mainnet, rpcUrl: "http://127.0.0.1:1", publicRpc: false };
const hex = (u) => Buffer.from(u).toString("hex");

describe("derivation matches the published vectors", () => {
  // SLIP-0010, ed25519 test vector 1 (seed 000102…0f).
  const seed = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");

  it("master key", () => {
    expect(hex(slip10Ed25519(seed, "m"))).toBe("2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7");
  });

  it("m/0'", () => {
    expect(hex(slip10Ed25519(seed, "m/0'"))).toBe("68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3");
  });

  it("m/0'/1'/2'/2'/1000000000'", () => {
    expect(hex(slip10Ed25519(seed, "m/0'/1'/2'/2'/1000000000'")))
      .toBe("8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793");
  });

  it("refuses a non-hardened segment, which ed25519 cannot derive", () => {
    expect(() => slip10Ed25519(seed, "m/44'/501'/0")).toThrow(/hardened/);
  });

  it("restores the same address Phantom does", async () => {
    expect((await signerFromMnemonic(ABANDON)).address).toBe(ABANDON_ADDRESS);
    // A pasted phrase with stray whitespace and capitals is the same phrase.
    expect((await signerFromMnemonic(`  ${ABANDON.toUpperCase().replace(/ /g, "   ")}\n`)).address).toBe(ABANDON_ADDRESS);
  });

  it("makes 24-word phrases and rejects a bad checksum", () => {
    const m = newMnemonic();
    expect(m.split(" ").length).toBe(24);
    expect(isValidMnemonic(m)).toBe(true);
    expect(isValidMnemonic(ABANDON.replace(/about$/, "abandon"))).toBe(false);
    expect(normalizeMnemonic(" A  b ")).toBe("a b");
  });
});

describe("the wallet file", () => {
  afterEach(() => removeWallet());

  it("encrypts the phrase and keeps only the address in the clear", () => {
    writeWallet({ mnemonic: ABANDON, address: ABANDON_ADDRESS, network: "mainnet", passphrase: "correct horse" });
    const raw = fs.readFileSync(WALLET_FILE, "utf8");
    expect(raw).not.toContain("abandon");
    expect(raw).toContain(ABANDON_ADDRESS);
    expect(readWalletInfo()).toMatchObject({ address: ABANDON_ADDRESS, encrypted: true, network: "mainnet" });
    expect(readMnemonic("correct horse")).toBe(ABANDON);
  });

  it("says a wrong or missing passphrase is exactly that", () => {
    writeWallet({ mnemonic: ABANDON, address: ABANDON_ADDRESS, network: "mainnet", passphrase: "correct horse" });
    expect(() => readMnemonic("battery staple")).toThrow(WalletLockedError);
    expect(() => readMnemonic(null)).toThrow(WalletLockedError);
  });

  it("moves a wallet made under the old file name (local-wallet.json) to the new one, once", () => {
    const legacy = WALLET_FILE.replace(/own-wallet\.json$/, "local-wallet.json");
    fs.writeFileSync(legacy, JSON.stringify({ version: 1, address: ABANDON_ADDRESS, network: "mainnet", mnemonic: ABANDON }));
    expect(walletExists()).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(readWalletInfo().address).toBe(ABANDON_ADDRESS);
    expect(readMnemonic(null)).toBe(ABANDON);
  });

  it("stores an unencrypted wallet only when asked, and removes cleanly", () => {
    writeWallet({ mnemonic: ABANDON, address: ABANDON_ADDRESS, network: "mainnet", passphrase: null });
    expect(readWalletInfo().encrypted).toBe(false);
    expect(readMnemonic(null)).toBe(ABANDON);
    removeWallet();
    expect(walletExists()).toBe(false);
    expect(fs.existsSync(`${WALLET_FILE}.tmp`)).toBe(false);
  });
});

/** An `accepts` entry as aile's 402 sends it. */
const ACCEPT = {
  scheme: "exact",
  network: NETWORKS.mainnet.caip,
  amount: "3015",
  asset: NETWORKS.mainnet.usdc,
  payTo: "Fma6oRHMDqBUJVjg8gbZhpXt7v7WktuDWRUXLU7mvFpa",
  maxTimeoutSeconds: 120,
  extra: { name: "USDC", decimals: 6, feePayer: "DeXterR2kQm8AvRHnNPatWkE46TfAcMeBDjb6FySoAb8" },
};
const doc = (accepts, extra = {}) => ({ x402Version: 2, resource: { url: "https://api.aile.sh/v1/chat/completions" }, accepts, ...extra });

describe("nothing is signed that should not be", () => {
  const pick = (d, maxMicros = 500_000n) => pickRequirement(d, { net: NET, maxMicros });

  it("pays the entry it was asked for", () => {
    expect(pick(doc([ACCEPT]))).toMatchObject({ amount: "3015", payTo: ACCEPT.payTo });
  });

  it("explains an empty accepts as the facilitator minimum, with the quote", () => {
    const d = doc([], { quote: { usd: "$0.000615" } });
    expect(() => pick(d)).toThrow(PaymentRefused);
    expect(() => pick(d)).toThrow(/\$0\.000615.*minimum/);
  });

  it("refuses another network, another asset, or no fee payer", () => {
    expect(() => pick(doc([{ ...ACCEPT, network: NETWORKS.devnet.caip }]))).toThrow(/devnet|Solana mainnet/);
    expect(() => pick(doc([{ ...ACCEPT, asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" }]))).toThrow(/not USDC/);
    expect(() => pick(doc([{ ...ACCEPT, extra: { name: "USDC" } }]))).toThrow(/fee payer/);
    expect(() => pick(doc([{ ...ACCEPT, scheme: "tab" }]))).toThrow(PaymentRefused);
  });

  it("names a Base-only offer as another chain, not as a devnet/mainnet mix-up", () => {
    const base = { ...ACCEPT, network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", extra: { name: "USD Coin", version: "2" } };
    expect(() => pick(doc([base]))).toThrow(/eip155:8453.*Solana only/);
    try { pick(doc([base])); } catch (e) { expect(e.hint).not.toMatch(/walletNetwork/); }
    // Solana listed beside Base: the Solana entry is the one paid.
    expect(pick(doc([ACCEPT, base])).network).toBe(ACCEPT.network);
  });

  it("refuses anything over the cap, before signing", () => {
    expect(() => pick(doc([ACCEPT]), 3014n)).toThrow(/over your cap/);
    expect(pick(doc([ACCEPT]), 3015n).amount).toBe("3015");
  });

  it("accepts v1's network slug for the same chain", () => {
    expect(sameNetwork("solana", NET)).toBe(true);
    expect(sameNetwork("solana-devnet", NET)).toBe(false);
  });

  it("reads the challenge from the header when the body has none", () => {
    const h = new Headers({ "payment-required": Buffer.from(JSON.stringify(doc([ACCEPT]))).toString("base64") });
    expect(readChallenge(h, "not json")?.accepts[0].payTo).toBe(ACCEPT.payTo);
    expect(readChallenge(new Headers(), null)).toBeNull();
  });

  it("reads the MPP methods a 402 offers, several challenges on one line", () => {
    const h = new Headers({ "www-authenticate": 'Payment id="a", realm="api.aile.sh", method="evm", intent="charge", request="e30", Payment id="b", realm="api.aile.sh", method="solana", intent="charge", request="e30"' });
    expect(mppMethods(h)).toEqual(["evm", "solana"]);
    expect(mppMethods(new Headers({ "www-authenticate": 'Bearer realm="x", method="nope"' }))).toEqual([]);
    expect(mppMethods(new Headers())).toEqual([]);
  });

  it("names an MPP-only 402 as MPP, not as sending no challenge", () => {
    const mpp = new Headers({ "www-authenticate": 'Payment id="a", realm="x.dev", method="tempo", intent="charge"' });
    expect(noChallengeReason("x.dev", mpp).message).toMatch(/MPP only \(tempo\).*x402 on Solana/);
    expect(noChallengeReason("x.dev", new Headers()).message).toMatch(/no x402 challenge/);
  });

  it("reads settlement back from PAYMENT-RESPONSE", () => {
    const h = new Headers({ "payment-response": Buffer.from(JSON.stringify({ success: true, transaction: "5xyz" })).toString("base64") });
    expect(readSettlement(h)).toEqual({ success: true, transaction: "5xyz" });
  });

  it("stops at an unfunded wallet with the address to fund, before signing", async () => {
    const wallet = { address: ABANDON_ADDRESS, signer: await signerFromMnemonic(ABANDON), net: NET };
    let retried = false;
    const attempt = payChallenge({
      challenge: doc([ACCEPT]),
      wallet,
      maxMicros: 500_000n,
      readBalance: async () => ({ usdc: 0.001, sol: 0 }),
      retry: async () => { retried = true; },
    });
    await expect(attempt).rejects.toThrow(/holds \$0\.001 USDC.*costs \$0\.003015/);
    expect(retried).toBe(false);
  });
});

describe("the payment it builds", () => {
  it("is an x402 v2 envelope naming the entry it pays, signed by this wallet", async () => {
    const rpc = rpcStub();
    try {
      const signer = await signerFromMnemonic(ABANDON);
      // A blockhash in the 402 is used as given, so the only RPC read is the mint.
      const requirement = { ...ACCEPT, extra: { ...ACCEPT.extra, recentBlockhash: "11111111111111111111111111111111" } };
      const header = await buildPaymentHeader({ signer, requirement, resource: { url: "https://api.aile.sh/v1/chat/completions" }, rpcUrl: rpc.url });
      const env = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
      expect(env.x402Version).toBe(2);
      expect(env.resource.url).toContain("/v1/chat/completions");
      expect(env.accepted).toMatchObject({ scheme: "exact", amount: "3015", payTo: ACCEPT.payTo, network: ACCEPT.network });
      expect(env.accepted.extra.feePayer).toBe(ACCEPT.extra.feePayer);
      expect(typeof env.payload.transaction).toBe("string");
      expect(env.payload.transaction.length).toBeGreaterThan(200);
      expect(rpc.methods).toEqual(["getAccountInfo"]);
    } finally { rpc.stop(); }
  });
});

describe("a free model", () => {
  it("is explained as free-with-an-account, not as a broken 402", () => {
    const d = { x402Version: 2, accepts: [{ ...ACCEPT, amount: "0" }] };
    expect(() => pickRequirement(d, { net: NET, maxMicros: 500_000n })).toThrow(/free/);
    try { pickRequirement(d, { net: NET, maxMicros: 500_000n }); } catch (e) { expect(e.hint).toContain("--pay balance"); }
  });
});
