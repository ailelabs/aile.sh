/**
 * Machine registration.
 *
 * The node secret is generated on this machine and never derived from anything
 * the server knows. Enrolment is the one moment it crosses the network, so the
 * server can verify our handshake HMAC afterwards. Everything after this point
 * proves possession of the secret without transmitting it.
 *
 * The renter token authorises the call; re-enrolling an existing node is only
 * permitted for the account that already owns it (enforced server-side).
 */

import { getNodeId, rotateNodeIdentity } from "./identity.js";
import { loadNodeSecret } from "./state.js";
import { accessHeaders } from "../api/access.js";

// These two blocks bypass api/client.js's call() (they need the raw fetch), so
// the {success,data} envelope is unwrapped here by hand. `data` IS the old
// enrolment payload; a non-enveloped body (an un-migrated server) passes through.
const unwrap = (body) => (body && body.success === true && "data" in body) ? body.data : body;
// The string message from a {success:false} error envelope — never an object, so
// an error whose `error` field is {hint}/{status} does not print "[object Object]".
const envelopeError = (body) => (typeof body?.error === "string" && body.error) || body?.message || null;

export async function enrollNode({ serverUrl, renterToken, timeoutMs = 15000 }) {
  const base = String(serverUrl).replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(`${base}/enroll`, {
      method: "POST",
      // `redirect: "manual"` for the reason api/client.js gives at length: a 3xx
      // re-sends these headers to whatever it points at, and both the renter token
      // and any Access service token are in them. No route here redirects.
      redirect: "manual",
      headers: {
        authorization: `Bearer ${renterToken}`,
        "content-type": "application/json",
        ...accessHeaders(),
      },
      body: JSON.stringify({
        nodeId: getNodeId(),
        secret: loadNodeSecret(),
        // NO HOSTNAME. It used to be sent as the node label, and on a personal
        // machine that is usually the owner name — "Hugo", not "build-box-3" — so
        // enrolling quietly uploaded the user identity to a server that has no use
        // for it. The node id identifies the machine; nothing here needs a name.
        label: null,
      }),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`no response from ${base} after ${timeoutMs}ms`);
    throw new Error(`cannot reach ${base}: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Map the two the renter can actually act on; anything else passes through.
    if (res.status === 401) throw new Error("token rejected — check the renter token");
    if (res.status === 409) {
      const e = new Error("this machine is registered to another account");
      e.code = "NODE_OWNED";
      throw e;
    }
    throw new Error(envelopeError(body) || `server returned ${res.status}`);
  }
  return unwrap(body);
}

/**
 * Enrol, and if this machine is already owned by a different account, take a
 * fresh identity and enrol that instead.
 *
 * The lockout this fixes: node identity is derived from files that survive
 * `aile logout`, so signing into a second account leaves the machine still
 * registered to the first. The server correctly refuses to move it — letting
 * any token reclaim any node would be a traffic-hijack primitive — but the
 * client then had no way forward at all. `aile start` connected, was rejected
 * 401, and retried forever.
 *
 * Rotating is safe precisely because the identity is not a claim about
 * anything: it is a random secret this machine generated, and the old node row
 * stays with the account that owns it, untouched. Nothing is taken from the
 * other account, and the two nodes remain distinct.
 *
 * Only 409 rotates. A 401 means the *token* is wrong, and minting a new
 * identity for it would turn one clear error into an unbounded supply of
 * orphaned node rows.
 */
export async function enrollNodeOrRotate({ serverUrl, renterToken, timeoutMs = 15000, log = null }) {
  try {
    return { ...(await enrollNode({ serverUrl, renterToken, timeoutMs })), rotated: false };
  } catch (e) {
    if (e.code !== "NODE_OWNED") throw e;
    log?.("  This machine was registered to a different account — giving it a new identity.");
    rotateNodeIdentity();
    return { ...(await enrollNode({ serverUrl, renterToken, timeoutMs })), rotated: true };
  }
}

/**
 * Enrol with no account at all.
 *
 * The server mints a row nobody can sign into and hands back its token, which is
 * a real bearer credential for that row — so it is written to the same 0600 config
 * as any other token, by the caller. Two differences from the authenticated path,
 * both of them the point:
 *
 *  - There is no token to send, because there is no account. The absence of
 *    authorization IS the request.
 *  - A machine already enrolled is refused rather than re-keyed, so this rotates
 *    identity on 409 exactly as the authenticated path does. Without that, a donor
 *    who reinstalls hits a hard wall on a machine whose old row they can no longer
 *    prove they own — and unlike the signed-in case there is no account to move it
 *    to. Rotating costs nothing here precisely because nothing accrued.
 */
export async function enrollDonor({ serverUrl, timeoutMs = 15000, log = null }) {
  const base = String(serverUrl).replace(/\/+$/, "");

  const attempt = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(`${base}/enroll/anonymous`, {
        method: "POST",
        redirect: "manual", // see the note on the enrolment above
        headers: { "content-type": "application/json", ...accessHeaders() },
        body: JSON.stringify({
          nodeId: getNodeId(),
          secret: loadNodeSecret(),
          // NO HOSTNAME. It used to be sent as the node label, and on a personal
        // machine that is usually the owner name — "Hugo", not "build-box-3" — so
        // enrolling quietly uploaded the user identity to a server that has no use
        // for it. The node id identifies the machine; nothing here needs a name.
        label: null,
        }),
        signal: controller.signal,
      });
    } catch (e) {
      if (e.name === "AbortError") throw new Error(`no response from ${base} after ${timeoutMs}ms`);
      throw new Error(`cannot reach ${base}: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 409) {
        const e = new Error(envelopeError(body) || "this machine is already enrolled");
        e.code = "NODE_TAKEN";
        throw e;
      }
      if (res.status === 429) {
        throw new Error("too many enrolment attempts from this network — wait a few minutes");
      }
      if (res.status === 404) {
        throw new Error("this server does not accept anonymous contributions");
      }
      throw new Error(envelopeError(body) || `server returned ${res.status}`);
    }
    const data = unwrap(body);
    if (!data.renterToken) throw new Error("server did not return a token for this machine");
    return data;
  };

  try {
    return { ...(await attempt()), rotated: false };
  } catch (e) {
    if (e.code !== "NODE_TAKEN") throw e;
    log?.("  This machine is already enrolled — giving it a new identity.");
    rotateNodeIdentity();
    return { ...(await attempt()), rotated: true };
  }
}
