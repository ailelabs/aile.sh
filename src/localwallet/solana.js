/**
 * Your own wallet's view of Solana: which network, which RPC, what it holds,
 * and plain transfers out of it.
 *
 * ONE NETWORK PER WALLET, CHOSEN BY `walletNetwork`. The USDC mint and the CAIP
 * id both follow from it, and a 402 quoting a different network is refused
 * rather than paid on the wrong chain — see x402.js.
 */

import {
  address,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getTransferCheckedInstruction,
} from "@solana-program/token";
import { getTransferSolInstruction } from "@solana-program/system";
import { loadConfig } from "../relay/config.js";

export const NETWORKS = {
  mainnet: {
    caip: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    publicRpc: "https://api.mainnet-beta.solana.com",
    explorer: (sig) => `https://solscan.io/tx/${sig}`,
  },
  devnet: {
    caip: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    usdc: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    publicRpc: "https://api.devnet.solana.com",
    explorer: (sig) => `https://solscan.io/tx/${sig}?cluster=devnet`,
  },
};

export const USDC_DECIMALS = 6;
const LAMPORTS_PER_SOL = 1_000_000_000n;

/** `{name, caip, usdc, rpcUrl, explorer}` for the configured network. */
export function network(config = loadConfig()) {
  const name = config.walletNetwork === "devnet" ? "devnet" : "mainnet";
  const n = NETWORKS[name];
  return { name, ...n, rpcUrl: config.solanaRpc || n.publicRpc, publicRpc: !config.solanaRpc };
}

/** True when a 402's network string names this wallet's network (v2 CAIP or v1 slug). */
export function sameNetwork(quoted, net = network()) {
  if (quoted === net.caip) return true;
  if (net.name === "mainnet") return quoted === "solana" || quoted === "solana-mainnet";
  return quoted === "solana-devnet";
}

/** SOL and USDC held, as numbers. Either is null when the RPC could not say. */
export async function balances(owner, net = network()) {
  const rpc = createSolanaRpc(net.rpcUrl);
  const [sol, usdc] = await Promise.all([
    rpc.getBalance(address(owner)).send().then((r) => Number(r.value) / 1e9).catch(() => null),
    usdcBalance(rpc, owner, net).catch(() => null),
  ]);
  return { sol, usdc };
}

async function usdcBalance(rpc, owner, net) {
  const [ata] = await findAssociatedTokenPda({
    owner: address(owner), mint: address(net.usdc), tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  try {
    const r = await rpc.getTokenAccountBalance(ata).send();
    return Number(r.value.amount) / 10 ** USDC_DECIMALS;
  } catch (e) {
    // No token account yet is an empty wallet, not an unreadable one.
    if (/could not find account|Invalid param: could not find/i.test(String(e?.message ?? e))) return 0;
    throw e;
  }
}

/** USD value of `amount` USDC in atomic units, e.g. 1.5 → 1500000n. */
export function usdcAtoms(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`amount must be a positive number (got "${amount}")`);
  return BigInt(Math.round(n * 10 ** USDC_DECIMALS));
}

/**
 * Send USDC or SOL from your own wallet. Opens the recipient's USDC account
 * when it has none (idempotent, paid by the sender, ~0.002 SOL) so a transfer
 * to a fresh wallet does not fail on the chain.
 */
export async function send({ signer, token, amount, to, net = network() }) {
  const rpc = createSolanaRpc(net.rpcUrl);
  const recipient = address(to);
  let instructions;
  const t = String(token).toUpperCase();

  if (t === "SOL") {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`amount must be a positive number (got "${amount}")`);
    const lamports = BigInt(Math.round(n * Number(LAMPORTS_PER_SOL)));
    instructions = [getTransferSolInstruction({ source: signer, destination: recipient, amount: lamports })];
  } else if (t === "USDC") {
    const mint = address(net.usdc);
    const [source] = await findAssociatedTokenPda({ owner: signer.address, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const [destination] = await findAssociatedTokenPda({ owner: recipient, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    instructions = [
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: signer, owner: recipient, mint }),
      getTransferCheckedInstruction({
        source, mint, destination, authority: signer, amount: usdcAtoms(amount), decimals: USDC_DECIMALS,
      }),
    ];
  } else {
    throw new Error(`Your own wallet sends USDC or SOL (got "${token}").`);
  }

  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const tx = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(tx);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: "base64", preflightCommitment: "confirmed" }).send();
  await waitForConfirmation(rpc, signature);
  return { signature, explorer: net.explorer(signature) };
}

/** Poll until confirmed. No websocket, so it works behind any proxy that passes HTTPS. */
async function waitForConfirmation(rpc, signature, { timeoutMs = 60_000, intervalMs = 1500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const s = value[0];
    if (s?.err) throw new Error(`The transaction failed on chain: ${JSON.stringify(s.err)}`);
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Sent, but not confirmed within ${timeoutMs / 1000}s — check ${signature} on an explorer before retrying.`);
}
