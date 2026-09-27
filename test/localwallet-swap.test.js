/**
 * Your own wallet's SOL ⇄ USDC swap, against a stub Jupiter.
 *
 * A swap is the one place the transaction to sign is built by somebody else,
 * so what is pinned here is what gets checked before this wallet signs it, and
 * that what is sent back to be executed carries a signature that actually
 * verifies — over the exact message Jupiter built, by this wallet's key.
 */

import { describe, expect, it } from "bun:test";
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  verifySignature,
} from "@solana/kit";
import { signerFromMnemonic } from "../src/localwallet/derive.js";
import { NETWORKS } from "../src/localwallet/solana.js";
import { quoteSwap, executeSwap, SwapRefused, WSOL_MINT } from "../src/localwallet/swap.js";

const ABANDON = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const OTHER = "11111111111111111111111111111112";
const MAINNET = { name: "mainnet", ...NETWORKS.mainnet, rpcUrl: "http://127.0.0.1:1", publicRpc: false };
const DEVNET = { name: "devnet", ...NETWORKS.devnet, rpcUrl: "http://127.0.0.1:1", publicRpc: false };

/** An unsigned v0 transaction whose fee payer (and only signer) is `payer`. */
function unsignedTx(payer) {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100n }, m),
    (m) => appendTransactionMessageInstructions([{ programAddress: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", accounts: [], data: new Uint8Array([104, 105]) }], m),
  );
  return getBase64EncodedWireTransaction(compileTransaction(msg));
}

/** A fetch that answers as Jupiter would, recording what it was sent. */
function fakeJupiter({ order = {}, execute = { status: "Success", signature: "5swapSig", totalInputAmount: "12000000", totalOutputAmount: "1492529" } } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, params: Object.fromEntries(u.searchParams), body: init.body ? JSON.parse(init.body) : null });
    if (u.pathname.endsWith("/order")) return Response.json(order);
    if (u.pathname.endsWith("/execute")) return Response.json(execute);
    return Response.json({}, { status: 404 });
  };
  return { calls, fetchImpl };
}

const ORDER = (transaction) => ({
  transaction, requestId: "req-1", inAmount: "12000000", outAmount: "1492529", router: "metis",
  priceImpactPct: "0.0001", inUsdValue: 1.49, signatureFeeLamports: 5000, prioritizationFeeLamports: 352, rentFeeLamports: 2976880,
});

describe("quoting a swap", () => {
  it("asks Jupiter for this wallet's order in the right mints and base units", async () => {
    const signer = await signerFromMnemonic(ABANDON);
    const j = fakeJupiter({ order: ORDER(unsignedTx(signer.address)) });
    const q = await quoteSwap({ address: signer.address, net: MAINNET, amount: 0.012, from: "SOL", to: "USDC", holdings: { sol: 0.02, usdc: 0 }, fetchImpl: j.fetchImpl });
    expect(j.calls[0].params).toEqual({ inputMint: WSOL_MINT, outputMint: MAINNET.usdc, amount: "12000000", taker: signer.address });
    expect(q).toMatchObject({ from: "SOL", to: "USDC", inAmount: 0.012, outAmount: 1.492529, route: "metis" });
    expect(q.solCost).toBeCloseTo(0.002982232, 9);
  });

  it("keeps SOL back for fees and rent", async () => {
    const attempt = quoteSwap({ address: OTHER, net: MAINNET, amount: 0.018, from: "SOL", to: "USDC", holdings: { sol: 0.02, usdc: 0 }, fetchImpl: fakeJupiter().fetchImpl });
    await expect(attempt).rejects.toThrow(SwapRefused);
    await expect(attempt).rejects.toThrow(/0\.004 SOL/);
  });

  it("refuses devnet, other tokens, and a route with a large price impact", async () => {
    const f = fakeJupiter({ order: { ...ORDER("x"), priceImpactPct: "0.07" } }).fetchImpl;
    await expect(quoteSwap({ address: OTHER, net: DEVNET, amount: 1, from: "SOL", to: "USDC", fetchImpl: f })).rejects.toThrow(/mainnet only/);
    await expect(quoteSwap({ address: OTHER, net: MAINNET, amount: 1, from: "BONK", to: "USDC", fetchImpl: f })).rejects.toThrow(/SOL and USDC/);
    await expect(quoteSwap({ address: OTHER, net: MAINNET, amount: 1, from: "SOL", to: "USDC", fetchImpl: f })).rejects.toThrow(/7\.00%/);
  });

  it("explains Jupiter's refusals in words", async () => {
    const f = fakeJupiter({ order: { errorCode: 2, errorMessage: "Insufficient funds" } }).fetchImpl;
    await expect(quoteSwap({ address: OTHER, net: MAINNET, amount: 0.001, from: "SOL", to: "USDC", fetchImpl: f })).rejects.toThrow(/not enough SOL for the network fee/);
  });
});

describe("signing and executing it", () => {
  it("sends back Jupiter's own transaction, signed by this wallet, with a signature that verifies", async () => {
    const signer = await signerFromMnemonic(ABANDON);
    const wire = unsignedTx(signer.address);
    const j = fakeJupiter({ order: ORDER(wire) });
    const quote = await quoteSwap({ address: signer.address, net: MAINNET, amount: 0.012, from: "SOL", to: "USDC", fetchImpl: j.fetchImpl });
    const done = await executeSwap({ signer, quote, fetchImpl: j.fetchImpl });
    expect(done).toEqual({ signature: "5swapSig", inAmount: 0.012, outAmount: 1.492529 });

    const exec = j.calls.find((c) => c.path.endsWith("/execute"));
    expect(exec.body.requestId).toBe("req-1");
    const sent = getTransactionDecoder().decode(Buffer.from(exec.body.signedTransaction, "base64"));
    const original = getTransactionDecoder().decode(Buffer.from(wire, "base64"));
    // The message is untouched — only our signature was added.
    expect(Buffer.from(sent.messageBytes).equals(Buffer.from(original.messageBytes))).toBe(true);
    const key = await getPublicKeyFromAddress(signer.address);
    expect(await verifySignature(key, sent.signatures[signer.address], sent.messageBytes)).toBe(true);
  });

  it("refuses to sign a transaction that is not addressed to this wallet", async () => {
    const signer = await signerFromMnemonic(ABANDON);
    const j = fakeJupiter({ order: ORDER(unsignedTx(OTHER)) });
    const quote = await quoteSwap({ address: signer.address, net: MAINNET, amount: 0.012, from: "SOL", to: "USDC", fetchImpl: j.fetchImpl });
    await expect(executeSwap({ signer, quote, fetchImpl: j.fetchImpl })).rejects.toThrow(/not addressed to this wallet/);
    expect(j.calls.some((c) => c.path.endsWith("/execute"))).toBe(false);
  });

  it("reports a failed execution with the signature to check", async () => {
    const signer = await signerFromMnemonic(ABANDON);
    const j = fakeJupiter({ order: ORDER(unsignedTx(signer.address)), execute: { status: "Failed", error: "slippage exceeded", signature: "5reverted" } });
    const quote = await quoteSwap({ address: signer.address, net: MAINNET, amount: 0.012, from: "SOL", to: "USDC", fetchImpl: j.fetchImpl });
    await expect(executeSwap({ signer, quote, fetchImpl: j.fetchImpl })).rejects.toThrow(/slippage exceeded.*5reverted/);
  });
});
