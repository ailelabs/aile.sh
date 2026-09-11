import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AILE_DIR } from "./paths.js";

const STATE_FILE = path.join(AILE_DIR, "state.json");
const NODE_SECRET_FILE = path.join(AILE_DIR, "node-secret");

let cachedNodeSecret = null;

export function ensureRelayDir() {
  if (!fs.existsSync(AILE_DIR)) fs.mkdirSync(AILE_DIR, { recursive: true });
}

export function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch { /* ignore corrupt state */ }
  return null;
}

export function saveState(state) {
  ensureRelayDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function clearState() {
  try {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  } catch { /* ignore */ }
}

// Random secret persisted on first run → the node proves identity to the relay
// server without the machine ID alone being sufficient to impersonate it.
export function loadNodeSecret() {
  if (cachedNodeSecret) return cachedNodeSecret;
  try {
    cachedNodeSecret = fs.readFileSync(NODE_SECRET_FILE, "utf8").trim();
    if (cachedNodeSecret) return cachedNodeSecret;
  } catch { /* not provisioned yet */ }
  cachedNodeSecret = crypto.randomBytes(32).toString("hex");
  try {
    ensureRelayDir();
    fs.writeFileSync(NODE_SECRET_FILE, cachedNodeSecret, { mode: 0o600 });
  } catch { /* best effort — falls back to in-memory secret for this run */ }
  return cachedNodeSecret;
}

/**
 * Throw away this machine's node secret and mint a new one.
 *
 * Used when the server reports the node id belongs to another account, which
 * happens after signing into a second account on a machine that has already
 * enrolled — the identity files deliberately survive `aile logout`.
 *
 * The in-memory cache is cleared too. Without that the process keeps signing
 * with the discarded secret until it restarts, which fails in exactly the way
 * this is supposed to fix, one layer down where it is harder to see.
 */
export function rotateNodeSecret() {
  cachedNodeSecret = crypto.randomBytes(32).toString("hex");
  try {
    ensureRelayDir();
    fs.writeFileSync(NODE_SECRET_FILE, cachedNodeSecret, { mode: 0o600 });
  } catch { /* best effort — in-memory secret still serves this run */ }
  return cachedNodeSecret;
}

// HMAC over a server-supplied nonce → proves secret possession without sending it.
export function signNonce(nonce) {
  return crypto.createHmac("sha256", loadNodeSecret()).update(String(nonce)).digest("hex");
}

export { AILE_DIR, STATE_FILE };
