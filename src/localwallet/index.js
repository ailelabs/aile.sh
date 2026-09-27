/**
 * The opt-in self-custody wallet, as the rest of the CLI sees it.
 *
 * ==========================================================================
 * THIS DIRECTORY IS THE ONLY PLACE IN aile THAT HOLDS A PRIVATE KEY, and only
 * when somebody ran `aile wallet own create` (or `import`). Everything else
 * — `aile wallet`, `status`, `balance`, `setup`, the relay — stays key-free,
 * and none of it imports this module statically: callers `await import()` it
 * from the one command that needs it, so a machine that never opted in never
 * loads a line of it. `test/branding.test.js` holds that line (the wallet
 * libraries are allowed only under `src/localwallet/`).
 *
 * The account's own wallet is still custodial and still never touched here.
 * The two meet only by address: `aile deposit --from-own` sends USDC from
 * this wallet to that one, the same as sending from any other wallet.
 * ==========================================================================
 */

import { loadConfig } from "../relay/config.js";
import { signerFromMnemonic } from "./derive.js";
import { readMnemonic, readWalletInfo, walletExists, WalletLockedError } from "./store.js";
import { network, balances, send } from "./solana.js";
import { readChallenge, pickRequirement, buildPaymentHeader, paymentHeaders, readSettlement, PaymentRefused, formatMicros, noChallengeReason } from "./x402.js";

export { walletExists, readWalletInfo, WalletLockedError, PaymentRefused, readChallenge, noChallengeReason, formatMicros, network, balances };

/**
 * The passphrase, from (in order) `--passphrase`, AILE_WALLET_PASSPHRASE, or a
 * prompt when a person is there to answer it. Unencrypted wallets need none.
 */
export async function resolvePassphrase(args, { prompt, interactive }) {
  const info = readWalletInfo();
  if (!info?.encrypted) return null;
  if (typeof args.passphrase === "string" && args.passphrase) return args.passphrase;
  if (process.env.AILE_WALLET_PASSPHRASE) return process.env.AILE_WALLET_PASSPHRASE;
  if (!interactive) {
    throw new WalletLockedError("Your own wallet is encrypted. Pass --passphrase, or set AILE_WALLET_PASSPHRASE.");
  }
  const got = await prompt("  Own wallet passphrase > ");
  if (!got) throw new WalletLockedError("No passphrase entered.");
  return got;
}

/** Unlock: `{address, signer, net}`. Throws WalletLockedError on a missing or wrong passphrase. */
export async function unlock(passphrase, config = loadConfig()) {
  const signer = await signerFromMnemonic(readMnemonic(passphrase));
  const info = readWalletInfo();
  if (info?.address && info.address !== signer.address) {
    throw new Error("Your own wallet file is inconsistent: its phrase derives a different address than it records.");
  }
  return { address: signer.address, signer, net: network(config) };
}

/** The cap, in micro-USDC: `--max-usd` for this call, else `walletMaxCents`. */
export function capMicros(args, config = loadConfig()) {
  const flag = args["max-usd"];
  if (flag !== undefined && flag !== true) {
    const n = Number(flag);
    if (!Number.isFinite(n) || n <= 0) throw new PaymentRefused(`--max-usd must be a positive number (got "${flag}")`);
    return BigInt(Math.round(n * 1_000_000));
  }
  return BigInt(Number(config.walletMaxCents) || 50) * 10_000n;
}

/**
 * Pay a 402 and send the request again. `retry(headers)` re-sends the original
 * request with the payment headers and resolves `{status, headers, body}`.
 * `confirm(requirement)` resolves false to stop before signing.
 *
 * Resolves `{response, requirement, settlement}`.
 */
export async function payChallenge({ challenge, wallet, maxMicros, retry, confirm = async () => true, readBalance = balances }) {
  const requirement = pickRequirement(challenge, { net: wallet.net, maxMicros });

  // CHECKED HERE, NOT LEFT TO THE FACILITATOR. An unfunded wallet otherwise
  // signs, the server verifies, and what comes back is a transaction-simulation
  // log about "InvalidAccountData" — true, and useless to somebody who only
  // needs to hear "add USDC". An unreadable balance is not a verdict: the
  // payment goes ahead and the facilitator remains the judge.
  const { usdc } = await readBalance(wallet.address, wallet.net).catch(() => ({ usdc: null }));
  if (usdc !== null && BigInt(Math.round(usdc * 1_000_000)) < BigInt(requirement.amount)) {
    throw new PaymentRefused(
      `Your own wallet holds $${usdc} USDC and this call costs $${formatMicros(requirement.amount)}.`,
      `Send USDC on Solana ${wallet.net.name} to ${wallet.address}, or pay from your balance with --pay balance.`,
    );
  }

  if (!(await confirm(requirement))) throw new PaymentRefused("Cancelled — nothing was signed.");
  const value = await buildPaymentHeader({
    signer: wallet.signer, requirement, resource: challenge.resource, rpcUrl: wallet.net.rpcUrl,
  });
  const response = await retry(paymentHeaders(value));
  return { response, requirement, settlement: readSettlement(response.headers) };
}

/** Plain transfer out of your own wallet. */
export async function sendFromLocal({ wallet, token, amount, to }) {
  return send({ signer: wallet.signer, token, amount, to, net: wallet.net });
}
