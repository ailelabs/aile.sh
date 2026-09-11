/**
 * Stable node identity.
 *
 * Derived from a per-install machine id plus our own persisted secret, so the id
 * is stable across restarts but is not guessable from the machine id alone —
 * knowing someone's hardware id must not be enough to impersonate their node.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { AILE_DIR } from "./paths.js";
import { loadNodeSecret, rotateNodeSecret, ensureRelayDir } from "./state.js";

const MACHINE_FILE = path.join(AILE_DIR, "machine-id");

// A per-install random id, generated here rather than read from any hardware
// identifier: it must not be derivable by anything else on the machine.
function loadMachineId() {
  try {
    const v = fs.readFileSync(MACHINE_FILE, "utf8").trim();
    if (v) return v;
  } catch { /* first run */ }
  const generated = crypto.randomBytes(16).toString("hex");
  try {
    ensureRelayDir();
    fs.writeFileSync(MACHINE_FILE, generated, { mode: 0o600 });
  } catch { /* best effort */ }
  return generated;
}

let cachedNodeId = null;

export function getNodeId() {
  if (cachedNodeId) return cachedNodeId;
  cachedNodeId = crypto
    .createHash("sha256")
    .update(loadMachineId() + "aile-node" + loadNodeSecret())
    .digest("hex")
    .substring(0, 16);
  return cachedNodeId;
}

/**
 * Give this machine a new node id.
 *
 * Rotates the secret rather than the machine id: the machine id is the stable
 * "which computer is this" value, and other things may come to rely on it. The
 * secret is what makes the id unguessable, so replacing it yields a different
 * id while leaving the machine recognisably itself.
 *
 * The memo has to be cleared as well, or every caller in this process keeps
 * receiving the id that was just abandoned.
 */
export function rotateNodeIdentity() {
  rotateNodeSecret();
  cachedNodeId = null;
  return getNodeId();
}

export function getNodeInfo() {
  return {
    nodeId: getNodeId(),
    platform: process.platform,
    arch: process.arch,
    hostname: (() => { try { return os.hostname(); } catch { return "unknown"; } })(),
  };
}
