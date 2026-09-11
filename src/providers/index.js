/**
 * The one provider list the rest of the app reads.
 *
 * Two sources, merged here rather than at either end:
 *
 *  - catalog.js is GENERATED from the upstream registry and gets overwritten by
 *    `bun run scripts/sync-providers.js`. Anything hand-written in it is lost on
 *    the next sync, so the BYOK entries cannot live there.
 *  - byok.js is hand-maintained key-based providers, which have nothing to
 *    generate — no OAuth endpoints to vendor.
 *
 * Merging in the hand-maintained files keeps both properties: the generator owns
 * its output completely, and the hand-maintained lists survive a regeneration
 * untouched. There are two of them — byok.js for KEY-based providers and
 * oauth-extra.js for OAuth providers the generator can't emit (a device flow
 * with a dynamic-client register pre-step, or a split link/serve id absent from
 * the vanilla registry). Both are merged the same way, differing only in how
 * each entry names the host to check against the egress allowlist.
 *
 * ORDER OF PRECEDENCE. A generated entry wins over a hand-written one with the
 * same id. That direction is deliberate: the generated data is derived from the
 * live registry and is the thing that gets updated, so a stale hand-written
 * duplicate must never shadow it. If a provider gains an OAuth flow upstream, it
 * starts being linked by OAuth on the next sync with no edit here — and the
 * leftover hand-written entry becomes inert rather than overriding it.
 */

import { PROVIDERS as GENERATED, getProvider as getGenerated } from "./catalog.js";
import { BYOK_PROVIDERS, BYOK_IDS, isByok } from "./byok.js";
import { OAUTH_EXTRA_PROVIDERS } from "./oauth-extra.js";
import { PROVIDER_HOSTS } from "../relay/provider-hosts.js";

const generatedIds = new Set(GENERATED.map((p) => p.id));

/** The host a hand-written entry will be dialled on, whichever kind it is. */
function hostOf(p) {
  if (p.apiKey?.host) return p.apiKey.host;
  const base = p.transport?.baseUrl;
  if (!base) return null;
  try { return new URL(base).host; } catch { return null; }
}

/**
 * BYOK entries a node could actually serve.
 *
 * A provider whose host is not in the baked egress allowlist is capacity that
 * cannot be relayed: the node refuses to dial it, so every buyer request through
 * it would fail after the lender had already pasted a key and been told it
 * worked. Dropping it here is the honest outcome — the alternative is advertising
 * a provider we know will not work.
 *
 * This file CANNOT widen the allowlist, only intersect with it. That is the
 * point: provider-hosts.js is generated and baked at build time so no
 * hand-maintained list can turn a node into an open proxy, and a check here
 * would be worthless if it could also add.
 */
const servable = (p) => !generatedIds.has(p.id) && PROVIDER_HOSTS.has(hostOf(p));

const SERVABLE_BYOK = BYOK_PROVIDERS.filter(servable);

/**
 * OAuth-extra entries a node could actually serve — same host-allowlist gate as
 * SERVABLE_BYOK, reading the host off `transport.baseUrl` since these have no
 * `apiKey` block. This file cannot widen the allowlist either, only intersect.
 */
const SERVABLE_OAUTH_EXTRA = OAUTH_EXTRA_PROVIDERS.filter(servable);

/** Hand-written entries dropped above, so a test or maintainer can see what and why. */
export const UNSERVABLE_BYOK = BYOK_PROVIDERS.filter((p) => !SERVABLE_BYOK.includes(p));
export const UNSERVABLE_OAUTH_EXTRA = OAUTH_EXTRA_PROVIDERS.filter((p) => !SERVABLE_OAUTH_EXTRA.includes(p));

export const PROVIDERS = [...GENERATED, ...SERVABLE_BYOK, ...SERVABLE_OAUTH_EXTRA]
  .sort((a, b) => a.id.localeCompare(b.id));

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

export function getProvider(id) {
  return getGenerated(id)
    || SERVABLE_BYOK.find((p) => p.id === id)
    || SERVABLE_OAUTH_EXTRA.find((p) => p.id === id)
    || null;
}

/** Providers linked by pasting a key rather than by an OAuth redirect. */
export function isApiKeyProvider(id) {
  return getProvider(id)?.flow === "apikey";
}

export { BYOK_PROVIDERS, BYOK_IDS, isByok };
