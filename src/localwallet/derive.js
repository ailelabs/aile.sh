/**
 * Recovery phrase → Solana key, on the same path Phantom and Solflare use, so
 * the phrase `aile wallet own create` prints restores the same address there.
 *
 *   BIP-39 phrase  →  64-byte seed  →  SLIP-10 ed25519, m/44'/501'/0'/0'
 *
 * SLIP-10 IS TWENTY LINES OF HMAC, SO IT IS HERE AND NOT A DEPENDENCY. Every
 * step is hardened (ed25519 has no public derivation), which makes it one
 * HMAC-SHA512 per path segment over the parent key and chain code — exactly
 * what `node:crypto` already does. The phrase itself is `@scure/bip39`: the
 * wordlist and the normalisation rules are where a hand-rolled version would
 * go quietly wrong, and that library is audited.
 */

import { createHmac } from "node:crypto";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";

/** Phantom's default account. */
export const SOLANA_PATH = "m/44'/501'/0'/0'";

const HARDENED = 0x80000000;

/** A fresh 24-word phrase (256 bits of entropy). */
export function newMnemonic() {
  return generateMnemonic(wordlist, 256);
}

/** Collapse the whitespace a paste brings with it, and lowercase. */
export function normalizeMnemonic(phrase) {
  return String(phrase ?? "").trim().toLowerCase().split(/\s+/).join(" ");
}

export function isValidMnemonic(phrase) {
  return validateMnemonic(normalizeMnemonic(phrase), wordlist);
}

/**
 * SLIP-10 ed25519 derivation. Returns the 32-byte private key for `path`.
 * Exported for the test vectors; callers want {@link signerFromMnemonic}.
 */
export function slip10Ed25519(seed, path = SOLANA_PATH) {
  let I = createHmac("sha512", "ed25519 seed").update(seed).digest();
  let key = I.subarray(0, 32);
  let chain = I.subarray(32);

  const segments = path.split("/");
  if (segments[0] !== "m") throw new Error(`derivation path must start with m (got "${path}")`);
  for (const seg of segments.slice(1)) {
    if (!seg.endsWith("'")) throw new Error(`ed25519 derivation is hardened only (got "${seg}")`);
    const index = Number(seg.slice(0, -1));
    if (!Number.isInteger(index) || index < 0 || index >= HARDENED) throw new Error(`bad path segment "${seg}"`);
    const data = Buffer.alloc(37);
    data[0] = 0;
    Buffer.from(key).copy(data, 1);
    data.writeUInt32BE(index + HARDENED, 33);
    I = createHmac("sha512", chain).update(data).digest();
    key = I.subarray(0, 32);
    chain = I.subarray(32);
  }
  return new Uint8Array(key);
}

/** The `@solana/kit` signer for a phrase — what x402 and transfers sign with. */
export async function signerFromMnemonic(phrase) {
  const normalized = normalizeMnemonic(phrase);
  if (!validateMnemonic(normalized, wordlist)) throw new Error("That is not a valid recovery phrase.");
  const seed = mnemonicToSeedSync(normalized);
  return createKeyPairSignerFromPrivateKeyBytes(slip10Ed25519(seed));
}
