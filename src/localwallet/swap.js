/**
 * SOL ⇄ USDC inside your own wallet, through Jupiter.
 *
 * WHY IT EXISTS: aile is paid in USDC, and a wallet is often funded with SOL.
 * Without this the SOL sits there unable to pay for anything.
 *
 * THE FLOW IS JUPITER'S OWN: `GET /swap/v2/order` builds an unsigned v0
 * transaction for this wallet, it is signed HERE, and `POST /swap/v2/execute`
 * lands it. No RPC broadcast of ours, and the key never leaves this process.
 *
 * WHAT IS CHECKED BEFORE SIGNING, because a swap is the one operation where the
 * transaction to sign is built by somebody else:
 *
 *   - Only SOL and USDC, only on mainnet (Jupiter routes nothing on devnet).
 *   - The transaction really asks THIS wallet to sign, and nothing else of
 *     ours: the order names the taker, and signing refuses a transaction that
 *     does not list this address as a signer.
 *   - The price impact Jupiter reports is under a ceiling — a thin route
 *     would otherwise quietly sell the wallet's SOL for far less than it is worth.
 *   - A SOL sale leaves SOL behind for fees and the USDC account's rent, so the
 *     wallet is never swapped into a state where it can no longer move anything.
 */

import {
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
} from "@solana/kit";
import { usdcAtoms, USDC_DECIMALS } from "./solana.js";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
/** Kept back from a SOL sale: fees, plus rent for the USDC account the first swap opens. */
export const SOL_KEEP = 0.004;
/** Refuse a route that moves the price more than this. */
export const MAX_PRICE_IMPACT = 0.02;

export class SwapRefused extends Error {
  constructor(message, hint = null) {
    super(message);
    this.name = "SwapRefused";
    this.hint = hint;
  }
}

const jupiterBase = () => (process.env.AILE_JUPITER_URL || "https://api.jup.ag").replace(/\/+$/, "");

/** `{mint, decimals, symbol}` for the two tokens a swap may name. */
function token(sym, net) {
  const s = String(sym).toUpperCase();
  if (s === "SOL") return { mint: WSOL_MINT, decimals: 9, symbol: "SOL" };
  if (s === "USDC") return { mint: net.usdc, decimals: USDC_DECIMALS, symbol: "USDC" };
  throw new SwapRefused(`Your own wallet swaps SOL and USDC (got "${sym}").`);
}

/**
 * Ask Jupiter for an order. Nothing is signed. Resolves the quote a person
 * confirms — amounts, USD value, impact, route, the SOL it costs in fees and
 * rent — plus the order itself for {@link executeSwap}.
 */
export async function quoteSwap({ address, net, amount, from, to, holdings, fetchImpl = fetch }) {
  if (net.name !== "mainnet") throw new SwapRefused("Swaps run on mainnet only — Jupiter has no devnet routes.");
  const a = token(from, net);
  const b = token(to, net);
  if (a.mint === b.mint) throw new SwapRefused(`Both sides are ${a.symbol}.`);

  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new SwapRefused(`amount must be a positive number (got "${amount}")`);
  const inAtoms = a.symbol === "USDC" ? usdcAtoms(n) : BigInt(Math.round(n * 1e9));

  if (holdings) {
    const have = a.symbol === "SOL" ? holdings.sol : holdings.usdc;
    if (have !== null && have !== undefined) {
      const keep = a.symbol === "SOL" ? SOL_KEEP : 0;
      if (n > have - keep + 1e-12) {
        throw new SwapRefused(
          a.symbol === "SOL"
            ? `The wallet holds ${have} SOL; swapping ${n} would leave less than the ${SOL_KEEP} SOL it needs for fees and rent.`
            : `The wallet holds ${have} USDC.`,
          a.symbol === "SOL" ? `Swap at most ${Math.max(0, +(have - SOL_KEEP).toFixed(6))} SOL.` : null,
        );
      }
    }
    if (a.symbol === "USDC" && holdings.sol !== null && holdings.sol !== undefined && holdings.sol < 0.001) {
      throw new SwapRefused("The wallet has no SOL to pay the swap's network fee.", "Send it about 0.005 SOL first.");
    }
  }

  const url = new URL(`${jupiterBase()}/swap/v2/order`);
  url.searchParams.set("inputMint", a.mint);
  url.searchParams.set("outputMint", b.mint);
  url.searchParams.set("amount", inAtoms.toString());
  url.searchParams.set("taker", address);
  const headers = { accept: "application/json", ...(process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : {}) };
  const res = await fetchImpl(url, { headers });
  const order = await res.json().catch(() => ({}));
  if (!res.ok || !order.transaction) {
    const reason = order.errorCode === 1 ? `not enough ${a.symbol} in the wallet`
      : order.errorCode === 2 ? "not enough SOL for the network fee and rent"
        : order.errorMessage || order.error || `Jupiter answered ${res.status}`;
    throw new SwapRefused(`Jupiter could not build the swap: ${reason}.`);
  }

  const impact = Math.abs(Number(order.priceImpactPct ?? 0));
  if (impact > MAX_PRICE_IMPACT) {
    throw new SwapRefused(`That route moves the price ${(impact * 100).toFixed(2)}% — refusing above ${MAX_PRICE_IMPACT * 100}%.`, "Try a smaller amount.");
  }

  const feeLamports = Number(order.signatureFeeLamports || 0) + Number(order.prioritizationFeeLamports || 0) + Number(order.rentFeeLamports || 0);
  return {
    from: a.symbol,
    to: b.symbol,
    inAmount: Number(order.inAmount) / 10 ** a.decimals,
    outAmount: Number(order.outAmount) / 10 ** b.decimals,
    usd: typeof order.inUsdValue === "number" ? order.inUsdValue : null,
    impact,
    route: order.router || "jupiter",
    solCost: feeLamports / 1e9,
    order,
  };
}

/**
 * Sign the order's transaction with this wallet and have Jupiter land it.
 * Resolves `{signature, inAmount, outAmount}`; throws with Jupiter's reason.
 */
export async function executeSwap({ signer, quote, fetchImpl = fetch }) {
  const tx = getTransactionDecoder().decode(Buffer.from(quote.order.transaction, "base64"));
  if (!(signer.address in tx.signatures)) {
    throw new SwapRefused("The swap transaction Jupiter returned is not addressed to this wallet — refusing to sign it.");
  }
  const signed = await partiallySignTransaction([signer.keyPair], tx);
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    ...(process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : {}),
  };
  const res = await fetchImpl(`${jupiterBase()}/swap/v2/execute`, {
    method: "POST",
    headers,
    body: JSON.stringify({ signedTransaction: getBase64EncodedWireTransaction(signed), requestId: quote.order.requestId }),
  });
  const out = await res.json().catch(() => ({}));
  if (out.status !== "Success") {
    const landed = out.signature ? ` It may have landed and reverted — check ${out.signature} on an explorer.` : "";
    throw new Error(`The swap failed: ${out.error || `Jupiter answered ${res.status}`}.${landed}`);
  }
  const dec = (sym) => (sym === "SOL" ? 9 : USDC_DECIMALS);
  return {
    signature: out.signature,
    inAmount: out.totalInputAmount ? Number(out.totalInputAmount) / 10 ** dec(quote.from) : quote.inAmount,
    outAmount: out.totalOutputAmount ? Number(out.totalOutputAmount) / 10 ** dec(quote.to) : quote.outAmount,
  };
}
