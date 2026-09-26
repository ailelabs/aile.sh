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
function declaredModels(config) {
  return String(config.localModels || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function discoverLocalModels(config, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const declared = declaredModels(config);
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
 * Does anything accept a connection at host:port? Resolves `{ ok, reason }`,
 * never throws.
 *
 * A TCP accept and nothing more, because that is exactly what a LOCAL_OPEN
 * needs: the node opens a socket there and the server's request rides it. An
 * HTTP check would add opinions this does not want — a self-signed https
 * endpoint, or a runtime with no `/v1/models`, would read as down while serving
 * fine. Whether what answers is any good is the server's known-answer probe's
 * question, not this one's.
 */
export function tcpAnswers(host, port, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok, reason = null) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* already gone */ }
      resolve({ ok, reason });
    };
    const sock = net.connect({ host, port });
    sock.setTimeout(timeoutMs, () => finish(false, `no answer in ${Math.round(timeoutMs / 1000)}s`));
    sock.once("connect", () => finish(true));
    sock.once("error", (e) => finish(false,
      e?.code === "ECONNREFUSED" ? "nothing is listening" : (e?.code || e?.message || "unreachable")));
  });
}

/**
 * Where self-hosted lending stands right now, for the capability AND for what
 * the node says about it:
 *
 *   { state: "off" }                                  lending is switched off
 *   { state: "misconfigured", reason }                the endpoint is refused
 *   { state: "down", reason, port, models }           nothing answers there
 *   { state: "up", port, models }                     advertise it
 *
 * THE NODE ADVERTISES A MODEL ONLY WHILE SOMETHING ANSWERS FOR IT. Named models
 * (`localModels`) used to be advertised on the lender's word alone, so a node
 * whose model server was stopped — or never installed — listed a model it
 * could not serve, the server's hourly probe failed against it for as long as
 * the node was up, and the lender saw nothing wrong. `models` on a "down"
 * status is what WOULD be listed, for the sentence that says so.
 */
export async function localStatus(config, { connect = tcpAnswers, fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  if (!config.localEnabled) return { state: "off" };
  let target;
  try {
    target = await resolveLocalTarget(config.localEndpoint);
  } catch (e) {
    return { state: "misconfigured", reason: e.message };
  }
  const reach = await connect(target.host, target.port, { timeoutMs });
  if (!reach.ok) {
    return { state: "down", reason: reach.reason || "unreachable", port: target.port, models: declaredModels(config) };
  }
  const models = await discoverLocalModels(config, { fetchImpl, timeoutMs });
  return { state: "up", port: target.port, models };
}

/** The hello block for a status from `localStatus`, or null unless it is up. */
export function localCapabilityFrom(status) {
  if (status?.state !== "up") return null;
  return {
    // Named so a reader cannot mistake it for a verified claim, and so the
    // server has an unambiguous flag to route and label with.
    blind: false,
    models: status.models,
    endpointPort: status.port,
  };
}

/**
 * Capability block for the hello payload, or null when not lending locally —
 * or when the endpoint is misconfigured or not answering, which must never
 * stop the node relaying subscription traffic. Shape is deliberately distinct
 * from `claimedConnections` so the server cannot confuse self-hosted capacity
 * with an attested subscription.
 */
export async function buildLocalCapability(config, opts = {}) {
  return localCapabilityFrom(await localStatus(config, opts));
}
