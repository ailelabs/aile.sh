/**
 * The proof that this machine is the one that asked to sign in.
 *
 * WHY A CLIENT WITH NO SECRET NEEDS THIS. aile.sh is open source and installed
 * from a public registry, so it cannot hold a client secret — anyone can read one
 * out of the source. What it CAN do is invent a random value moments before it
 * asks, tell the server only a hash of it, and produce the original when it comes
 * back to collect. Nothing about the exchange is secret in advance, and the server
 * still ends up able to tell this process apart from anyone else on earth.
 *
 * This is PKCE's construction (RFC 7636), applied to the device flow, which has no
 * equivalent of its own. It closes a real gap: the device code travels in a poll
 * request, gets written to terminal scrollback, and lands in CI logs and screen
 * recordings. Without the binding, anyone who reads one out of any of those places
 * can collect the token it is waiting for.
 *
 * WHAT IT DOES NOT DEFEND, said plainly: anyone who can read this process's memory
 * has the verifier too. The binding raises the bar from "saw a code on a screen" to
 * "already has code execution on the lender's machine", and that is all it claims.
 *
 * S256 ONLY. RFC 7636 also allows sending the verifier unhashed, which would make
 * the stored challenge itself the credential and defeat the entire point.
 */

import crypto from "node:crypto";

/**
 * A fresh verifier. 32 random bytes → 43 base64url characters, which is the length
 * RFC 7636 specifies as the minimum and comfortably beyond guessing.
 *
 * NEVER PERSISTED. It lives in the memory of the process that made it and dies with
 * it — writing it beside the renter token in config.json would recreate exactly the
 * "read it off the disk" exposure the binding exists to close.
 */
export function makeVerifier() {
  return crypto.randomBytes(32).toString("base64url");
}

/** base64url(sha256(verifier)) — the only thing that ever crosses the network. */
export function challengeFor(verifier) {
  return crypto.createHash("sha256").update(String(verifier), "utf8").digest("base64url");
}
