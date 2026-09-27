/**
 * Your own wallet file: `<AILE_DIR>/own-wallet.json` (`aile wallet own`).
 *
 * It was `local-wallet.json` before the command was renamed from `wallet local`
 * — "local" already meant lending a self-hosted model. A file under the old name
 * is moved to the new one the first time anything looks for the wallet, so a
 * funded wallet made before the rename is simply still there.
 *
 * ITS OWN FILE, NOT A KEY IN config.json. config.json is read by every command,
 * printed by `aile config`, and rewritten by `aile config --reset`; a recovery
 * phrase belongs in none of those paths. Separate for the same reason
 * mcp-servers.json is separate: one file per kind of trust.
 *
 * ENCRYPTED UNLESS ASKED OTHERWISE. scrypt → AES-256-GCM over the phrase, all
 * `node:crypto`. GCM is authenticated, so a wrong passphrase is an error rather
 * than a garbage phrase that derives somebody else's empty wallet. The address
 * is stored in the clear so `aile balance` can show it without unlocking.
 *
 * 0600 AND WRITE-THEN-RENAME, the same rule relay/config.js follows for the
 * account token: a crash mid-write must not leave half a wallet.
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { AILE_DIR } from "../relay/paths.js";

export const WALLET_FILE = path.join(AILE_DIR, "own-wallet.json");
const LEGACY_WALLET_FILE = path.join(AILE_DIR, "local-wallet.json");

const SCRYPT = { N: 1 << 15, r: 8, p: 1 };
const KEY_LEN = 32;
const MAXMEM = 64 * 1024 * 1024;

export class WalletLockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "WalletLockedError";
  }
}

export function walletExists() {
  // One-time move from the pre-rename file name. A rename, never a copy: two
  // files holding one key is one more place for a phrase to be left behind.
  if (!fs.existsSync(WALLET_FILE) && fs.existsSync(LEGACY_WALLET_FILE)) {
    try { fs.renameSync(LEGACY_WALLET_FILE, WALLET_FILE); } catch { /* left in place; reported as absent below */ }
  }
  return fs.existsSync(WALLET_FILE);
}

/** The file without unlocking it: `{version, address, network, createdAt, encrypted}`, or null. */
export function readWalletInfo() {
  if (!walletExists()) return null;
  const w = JSON.parse(fs.readFileSync(WALLET_FILE, "utf8"));
  return { version: w.version, address: w.address, network: w.network, createdAt: w.createdAt, encrypted: Boolean(w.encrypted) };
}

/** Persist a phrase. `passphrase` null writes it unencrypted (the caller asked for that explicitly). */
export function writeWallet({ mnemonic, address, network, passphrase }) {
  const body = {
    version: 1,
    address,
    network,
    createdAt: new Date().toISOString(),
    ...(passphrase ? { encrypted: encrypt(mnemonic, passphrase) } : { mnemonic }),
  };
  fs.mkdirSync(AILE_DIR, { recursive: true });
  const tmp = `${WALLET_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, WALLET_FILE);
}

/** The phrase. Throws WalletLockedError when a passphrase is needed and missing or wrong. */
export function readMnemonic(passphrase) {
  if (!walletExists()) throw new Error("Your own wallet isn't set up on this machine.");
  const w = JSON.parse(fs.readFileSync(WALLET_FILE, "utf8"));
  if (!w.encrypted) return w.mnemonic;
  if (!passphrase) throw new WalletLockedError("Your own wallet is encrypted and no passphrase was given.");
  return decrypt(w.encrypted, passphrase);
}

export function removeWallet() {
  if (walletExists()) fs.rmSync(WALLET_FILE);
}

function encrypt(plain, passphrase) {
  const salt = randomBytes(16);
  const key = scryptSync(passphrase, salt, KEY_LEN, { ...SCRYPT, maxmem: MAXMEM });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return {
    cipher: "aes-256-gcm",
    kdf: { name: "scrypt", salt: salt.toString("hex"), ...SCRYPT },
    iv: iv.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
    authTag: cipher.getAuthTag().toString("hex"),
  };
}

function decrypt(payload, passphrase) {
  const key = scryptSync(passphrase, Buffer.from(payload.kdf.salt, "hex"), KEY_LEN, {
    N: payload.kdf.N, r: payload.kdf.r, p: payload.kdf.p, maxmem: MAXMEM,
  });
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "hex"));
  decipher.setAuthTag(Buffer.from(payload.authTag, "hex"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, "hex")), decipher.final()]).toString("utf8");
  } catch {
    throw new WalletLockedError("Wrong passphrase for your own wallet.");
  }
}
