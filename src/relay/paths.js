/**
 * Where aile.sh keeps its state.
 *
 * One directory, owned entirely by this app. Everything the app needs lives
 * here, so uninstalling is `npm uninstall -g aile.sh` plus deleting this
 * directory — nothing else on the machine is touched.
 *
 * Note what is NOT here: provider access tokens. Those are held server-side
 * (the relay terminates TLS with the provider, so the server is the party that
 * must hold them). This directory holds the node identity, the node secret, and
 * the account token — nothing that grants access to a provider account.
 */

import path from "node:path";
import os from "node:os";

export function aileDataDir() {
  if (process.env.AILE_DATA_DIR) return process.env.AILE_DATA_DIR;
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "aile"
    );
  }
  return path.join(os.homedir(), ".aile");
}

export const AILE_DIR = aileDataDir();
