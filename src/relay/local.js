/**
 * Self-hosted model lending.
 *
 * The other way to lend capacity: instead of a provider subscription reached
 * over the blind relay, the lender runs a model on their own machine (Ollama,
 * vLLM, LM Studio, llama.cpp) and sells inference from it.
 *
 * READ THIS BEFORE CHANGING ANYTHING HERE
 * ---------------------------------------
 * **This path is NOT blind, and cannot be made blind.** The model runs on the
 * lender's hardware, so the lender's machine must read the prompt in order to
 * answer it. There is no arrangement of keys that avoids that — it is a property
 * of where the computation happens, not of the transport.
 *
 * So the two kinds of capacity are deliberately kept distinguishable end to end:
 * the node advertises them separately, the server routes them separately, and a
 * buyer is told which one answered. Blurring that line would let a renter
 * believe the blind-relay guarantee covers traffic it does not cover, which is
 * worse than not offering this at all.
 *
 * THE HOST IS NEVER NAMED BY THE SERVER
 * -------------------------------------
 * `relay/allowlist.js` exists to stop a hostile server aiming this node at
 * 127.0.0.1 or the owner's LAN. A "just let the server say localhost" shortcut
 * would hand back exactly that capability and undo the allowlist.
 *
 * Instead LOCAL_OPEN carries no host at all. The node substitutes the endpoint
 * its *owner* configured, and validates that endpoint is loopback or private —
 * the inverse of the allowlist's public-IP rule. A server can ask this node to
 * talk to its local model; it can never choose which machine that is.
 */

import net from "node:net";
import dns from "node:dns/promises";

/**
 * Is this address on this machine or this network?
 *
 * Deliberately implemented here rather than imported as `!isPublicIp` from
 * allowlist.js. The two modules enforce *opposite* rules — the allowlist demands
 * a public address, this demands a private one — and sharing one predicate
 * between them means a future change made for one silently rewrites the other.
 * They are independent safety checks and are kept independent.
 */
export function isLocalAddress(ip) {
  const type = net.isIP(ip);
  if (type === 4) {
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b] = p;
    if (a === 127) return true;                          // loopback
    if (a === 10) return true;                           // private
    if (a === 172 && b >= 16 && b <= 31) return true;    // private
    if (a === 192 && b === 168) return true;             // private
    if (a === 169 && b === 254) return true;             // link-local
    if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT
    return false;
  }
  if (type === 6) {
    const v = ip.toLowerCase().split("%")[0];
    if (v === "::1") return true;
    if (v.startsWith("fe80")) return true;               // link-local
    if (/^f[cd]/.test(v)) return true;                   // unique-local
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isLocalAddress(mapped[1]);
    return false;
  }
  return false;
}

/** Parse and validate a lender-configured local endpoint. */
export function parseLocalEndpoint(raw) {
  if (!raw) throw new Error("localEndpoint is not set — run `aile config localEndpoint http://127.0.0.1:11434`");

  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error(`localEndpoint is not a URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`localEndpoint must be http:// or https:// (got ${url.protocol})`);
  }
  // The server supplies the request path, so a base path here would silently
  // produce the wrong URL rather than an error. Refuse it up front and say so.
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(
      `localEndpoint must be an origin with no path (got "${url.pathname}") — ` +
      `use http://127.0.0.1:11434, not http://127.0.0.1:11434/v1`
    );
  }

  const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
  return { hostname: url.hostname, port, protocol: url.protocol };
}

/**
 * Resolve the endpoint and refuse anything reachable off this network.
 *
 * A public address here would make the node an open proxy to a third party, on
 * the lender's IP and the lender's liability. That is the same failure the
 * egress allowlist prevents in the other direction, so it is refused with the
 * same firmness.
 */
export async function resolveLocalTarget(raw) {
  const { hostname, port } = parseLocalEndpoint(raw);

  let addresses;
  if (net.isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      const resolved = await dns.lookup(hostname, { all: true });
      addresses = resolved.map((r) => r.address);
    } catch (e) {
      throw new Error(`cannot resolve localEndpoint host ${hostname}: ${e.message}`);
    }
  }
  if (addresses.length === 0) throw new Error(`no addresses for localEndpoint host ${hostname}`);

  // Every address must be local. Requiring all of them (rather than any) means
  // a name resolving to both a LAN and a public address is refused.
  const offNetwork = addresses.filter((ip) => !isLocalAddress(ip));
  if (offNetwork.length > 0) {
    throw new Error(
      `localEndpoint resolves to public address ${offNetwork[0]} — refusing. ` +
      `A self-hosted endpoint must be on this machine or this network.`
    );
  }
  return { host: addresses[0], port, hostname };
}

/**
 * Models this node will advertise.
 *
 * Configured names win. Otherwise ask the endpoint — but never let that failure
 * take down the connection: an unreachable model server means "advertise
 * nothing", not "refuse to be a node".
 */
export async function discoverLocalModels(config, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const declared = String(config.localModels || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (declared.length) return declared;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const base = String(config.localEndpoint).replace(/\/+$/, "");
    const res = await fetchImpl(`${base}/v1/models`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const body = await res.json();
    return (body?.data || []).map((m) => m?.id).filter((id) => typeof id === "string");
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Capability block for the hello payload, or null when not lending locally.
 * Shape is deliberately distinct from `claimedConnections` so the server cannot
 * confuse self-hosted capacity with an attested subscription.
 */
export async function buildLocalCapability(config, opts = {}) {
  if (!config.localEnabled) return null;
  try {
    const target = await resolveLocalTarget(config.localEndpoint);
    const models = await discoverLocalModels(config, opts);
    return {
      // Named so a reader cannot mistake it for a verified claim, and so the
      // server has an unambiguous flag to route and label with.
      blind: false,
      models,
      endpointPort: target.port,
    };
  } catch {
    // Misconfigured local endpoint must not stop the node relaying
    // subscription traffic, which is unaffected by it.
    return null;
  }
}
