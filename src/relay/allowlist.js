/**
 * Egress allowlist for the blind relay node.
 *
 * The relay server names the target host, so without this the renter's machine
 * would be an open proxy: a compromised or malicious server could reach the
 * renter's LAN (192.168.x, 127.0.0.1) or cloud metadata (169.254.169.254) and
 * exfiltrate credentials. Two independent gates, both must pass:
 *
 *   1. host must be a known provider host (or a subdomain of one)
 *   2. every resolved IP must be public (re-checked after DNS to defeat rebinding)
 *
 * This is the one place where we do NOT trust aile.sh. The node protects its
 * owner even if our own server turns hostile.
 */

import net from "node:net";
import dns from "node:dns/promises";
import { PROVIDER_HOSTS } from "./provider-hosts.js";

export const ALLOWED_PORTS = new Set([443]);

// Defence in depth: provider-hosts.js already filters these at generation time,
// but a bad regeneration must not be able to open a hole.
function isLocalHostname(host) {
  return (
    host === "localhost" ||
    host === "localhost.localdomain" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    !host.includes(".") ||        // bare single-label names are LAN-only
    net.isIP(host) !== 0          // raw IPs are handled by assertTargetAllowed
  );
}

export function getAllowedHosts() {
  return PROVIDER_HOSTS;
}

/**
 * Host matches a provider host exactly, or is a subdomain of one.
 * Subdomains are allowed because providers shard across regional hosts
 * (e.g. eu.api.example.com) while keeping the registered apex.
 */
export function isAllowedHost(host) {
  if (typeof host !== "string" || !host) return false;
  const h = host.toLowerCase().replace(/\.$/, "");
  if (isLocalHostname(h)) return false;
  if (PROVIDER_HOSTS.has(h)) return true;
  for (const candidate of PROVIDER_HOSTS) {
    if (h.endsWith(`.${candidate}`)) return true;
  }
  return false;
}

/** Block loopback, private, link-local, CGNAT, and unique-local ranges. */
export function isPublicIp(ip) {
  const type = net.isIP(ip);
  if (type === 4) {
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b] = p;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;   // link-local + cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a >= 224) return false;                  // multicast + reserved
    return true;
  }
  if (type === 6) {
    const v = ip.toLowerCase().split("%")[0];
    if (v === "::1" || v === "::") return false;
    if (v.startsWith("fe80")) return false;      // link-local
    if (/^f[cd]/.test(v)) return false;          // unique-local
    // IPv4-mapped (::ffff:a.b.c.d) → judge by the embedded IPv4
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicIp(mapped[1]);
    return true;
  }
  return false;
}

/**
 * Full gate. Returns the resolved public IPs so the caller can connect by IP,
 * closing the DNS-rebinding window between this check and connect().
 */
export async function assertTargetAllowed(host, port) {
  if (!ALLOWED_PORTS.has(Number(port))) {
    throw new Error(`Port ${port} not allowed (only ${[...ALLOWED_PORTS].join(", ")})`);
  }
  if (net.isIP(host)) {
    // A bare IP can never be verified against the provider list by name.
    throw new Error("Target must be a provider hostname, not a raw IP");
  }
  if (!isAllowedHost(host)) {
    throw new Error(`Host ${host} is not a known provider endpoint`);
  }

  let resolved;
  try {
    resolved = await dns.lookup(host, { all: true });
  } catch (e) {
    throw new Error(`DNS lookup failed for ${host}: ${e.message}`);
  }
  const addresses = resolved.map((r) => r.address);
  if (addresses.length === 0) throw new Error(`No addresses for ${host}`);

  const bad = addresses.filter((ip) => !isPublicIp(ip));
  if (bad.length > 0) {
    throw new Error(`Host ${host} resolves to non-public address ${bad[0]} — refusing`);
  }
  return addresses;
}
