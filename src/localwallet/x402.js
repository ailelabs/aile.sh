/**
 * x402 from the buyer's side: read a 402, sign exactly what it asks for, and
 * read back what settlement did.
 *
 * THE FACILITATOR BROADCASTS, NOT US. An `exact` payment on Solana is a
 * transaction this wallet signs and does not send: the facilitator named by the
 * 402's `feePayer` co-signs as fee payer, verifies, and settles after the
 * request is served. So paying needs no SOL here — only the USDC being paid —
 * and nothing leaves the wallet if the server never settles.
 *
 * THE CHALLENGE IS READ FROM THE BODY FIRST, THEN `PAYMENT-REQUIRED`. aile sends
 * the same document in both; other x402 servers send one or the other.
 *
 * MPP IS RECOGNISED, NOT PAID. A 402 may also (or only) carry MPP's
 * `WWW-Authenticate: Payment` challenges. aile offers x402 beside every one, so
 * this wallet pays aile over x402 regardless; a server that speaks only MPP is
 * named as such rather than reported as sending "no challenge".
 */

import { ExactSvmScheme } from "@x402/svm/exact/client";
import { sameNetwork } from "./solana.js";

/**
 * The 402's payment document, or null when it carries none. `{x402Version,
 * resource, accepts, error, quote?, balance?}` — `quote` and `balance` are
 * aile's own additions and are passed through for the caller to explain.
 */
export function readChallenge(headers, body) {
  const fromBody = body && typeof body === "object" && Array.isArray(body.accepts) ? body : null;
  if (fromBody) return fromBody;
  const raw = headers.get("payment-required") || headers.get("x-payment-required");
  if (!raw) return null;
  try {
    const doc = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    return doc && Array.isArray(doc.accepts) ? doc : null;
  } catch {
    return null;
  }
}

/**
 * The MPP methods a 402 offers (`WWW-Authenticate: Payment … method="evm"`), in
 * order and without repeats; empty when it offers none. Several challenges may
 * share one header line, comma-joined, so the line is cut at each `Payment`
 * scheme token and each piece's `method=` read.
 */
export function mppMethods(headers) {
  const raw = headers?.get?.("www-authenticate") || "";
  const seen = [];
  for (const piece of raw.split(/(?:^|,)\s*(?=Payment\s)/i)) {
    if (!/^Payment\s/i.test(piece)) continue;
    const method = /\bmethod="([^"]+)"/i.exec(piece)?.[1];
    if (method && !seen.includes(method)) seen.push(method);
  }
  return seen;
}

/** Why a 402 with no x402 document cannot be paid here: MPP-only, or nothing at all. */
export function noChallengeReason(host, headers) {
  const mpp = mppMethods(headers);
  if (mpp.length) {
    return new PaymentRefused(
      `${host} asks to be paid over MPP only (${mpp.join(", ")}), and your own wallet pays x402 on Solana.`,
      "Pay it with an MPP client instead.",
    );
  }
  return new PaymentRefused(`${host} asked for payment but sent no x402 challenge.`);
}

export class PaymentRefused extends Error {
  constructor(message, hint = null) {
    super(message);
    this.name = "PaymentRefused";
    this.hint = hint;
  }
}

/**
 * The one `accepts` entry this wallet will pay, after every check that must
 * happen before signing. Throws PaymentRefused with the reason otherwise.
 *
 *   - `exact` on this wallet's network, in its USDC — nothing else is signed.
 *   - A `feePayer`: without one the transaction cannot be built, and a payment
 *     that verifies nowhere would only be a confusing error later.
 *   - Under `maxMicros`: the cap is checked HERE, before the key is used.
 */
export function pickRequirement(doc, { net, maxMicros }) {
  const accepts = doc?.accepts || [];
  if (!accepts.length) {
    const price = doc?.quote?.usd ? ` (quoted ${doc.quote.usd})` : "";
    throw new PaymentRefused(
      `This request can't be paid per call${price}: it is under the facilitator's minimum settlement.`,
      "Raise --max-tokens, or pay from your account balance (`aile deposit`).",
    );
  }
  const req = accepts.find((a) => a.scheme === "exact" && sameNetwork(a.network, net));
  if (!req) {
    const offered = accepts.map((a) => `${a.scheme} on ${a.network}`).join(", ");
    // NOT A WRONG-CLUSTER PROBLEM WHEN NOTHING IS ON SOLANA: a Base-only offer
    // (`eip155:…`, v1 `base`) cannot be fixed by switching devnet/mainnet.
    if (!accepts.some((a) => String(a.network ?? "").toLowerCase().startsWith("solana"))) {
      throw new PaymentRefused(
        `The server asks for ${offered}, and your own wallet pays on Solana only.`,
        "Pay from a wallet on that chain, or from your aile balance with --pay balance.",
      );
    }
    throw new PaymentRefused(
      `The server asks for ${offered}, and this wallet pays exact on Solana ${net.name}.`,
      net.name === "mainnet" ? "If this is a devnet server: `aile config walletNetwork devnet`." : "If this is a mainnet server: `aile config walletNetwork mainnet`.",
    );
  }
  if (req.asset !== net.usdc) {
    throw new PaymentRefused(`The server asks to be paid in ${req.asset}, not USDC — refusing to sign.`);
  }
  if (!req.extra?.feePayer) {
    throw new PaymentRefused("The server's 402 names no fee payer, so the payment cannot be built.");
  }
  const amount = BigInt(req.amount ?? req.maxAmountRequired ?? "0");
  // A ZERO QUOTE IS A FREE MODEL, AND x402 CANNOT CARRY IT: there is no transfer
  // of nothing to sign. aile serves free models to callers with an account, so
  // say that instead of "no amount", which leaves an agent nowhere to go.
  if (amount <= 0n) {
    throw new PaymentRefused(
      "This call is free, but free models can't be paid for per call — there is nothing to transfer.",
      "Use it with your aile account instead: --pay balance (needs an API key from `aile setup`).",
    );
  }
  if (amount > BigInt(maxMicros)) {
    throw new PaymentRefused(
      `The server asks $${formatMicros(amount)}, over your cap of $${formatMicros(BigInt(maxMicros))}.`,
      "Raise it for this call with --max-usd, or for good with `aile config walletMaxCents <cents>`.",
    );
  }
  return { ...req, amount: amount.toString() };
}

/**
 * The payment header value: base64 of the x402 v2 envelope. `accepted` is the
 * entry being paid — v2 facilitators match it against their own copy of the
 * requirements, and a payment without it is refused as not matching.
 */
export async function buildPaymentHeader({ signer, requirement, resource, rpcUrl }) {
  const requirements = {
    scheme: "exact",
    network: requirement.network,
    amount: requirement.amount,
    asset: requirement.asset,
    payTo: requirement.payTo,
    maxTimeoutSeconds: requirement.maxTimeoutSeconds ?? 120,
    extra: requirement.extra,
  };
  const scheme = new ExactSvmScheme(signer, { rpcUrl });
  const partial = await scheme.createPaymentPayload(2, requirements);
  const envelope = {
    x402Version: partial.x402Version ?? 2,
    ...(resource ? { resource } : {}),
    accepted: requirements,
    payload: partial.payload,
  };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

/** Both header names: v2 servers read the first, v1 the second, and aile answers v2 when both arrive. */
export function paymentHeaders(value) {
  return { "payment-signature": value, "x-payment": value };
}

/** What settlement did, from `PAYMENT-RESPONSE`: `{transaction, network, payer, success}` or null. */
export function readSettlement(headers) {
  const raw = headers.get("payment-response") || headers.get("x-payment-response");
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export function formatMicros(micros) {
  const n = Number(micros) / 1_000_000;
  return n >= 0.01 ? n.toFixed(4) : n.toFixed(6);
}
