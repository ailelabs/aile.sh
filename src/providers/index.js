/**
 * The one provider list the rest of the app reads.
 *
 * Two sources, merged here rather than at either end:
 *
 *  - catalog.js is GENERATED from the aile relay's own provider registry
 *    (`apps/api/scripts/build-cli-catalog.ts`) and is overwritten on every
 *    regeneration, so nothing hand-written survives there.
 *  - oauth-extra.js is hand-maintained: the providers the generator cannot emit,
 *    because the CLI runs a different link flow to the hosted dashboard or
 *    because the entry only exists once an operator sets an env var.
 *
 * Merging here keeps both properties: the generator owns its output completely,
 * and the hand-maintained file survives a regeneration untouched.
 *
 * ORDER OF PRECEDENCE. A generated entry wins over a hand-written one with the
 * same id. That direction is deliberate: the generated data is derived from the
 * relay's registry and is the thing that gets updated, so a stale hand-written
 * duplicate must never shadow it. When the relay learns to emit a provider this
 * file carries, it starts being linked the relay's way on the next regeneration
 * with no edit here — and the leftover hand-written entry becomes inert rather
 * than overriding it.
 */

import { PROVIDERS as GENERATED, getProvider as getGenerated } from "./catalog.js";
import { OAUTH_EXTRA_PROVIDERS } from "./oauth-extra.js";
import { PROVIDER_HOSTS } from "../relay/provider-hosts.js";

const generatedIds = new Set(GENERATED.map((p) => p.id));

/** The host a hand-written entry will be dialled on. */
function hostOf(p) {
  if (p.apiKey?.host) return p.apiKey.host;
  const base = p.transport?.baseUrl;
  if (!base) return null;
  try { return new URL(base).host; } catch { return null; }
}

/**
 * Hand-written entries a node could actually serve.
 *
 * A provider whose host is not in the baked egress allowlist is capacity that
 * cannot be relayed: the node refuses to dial it, so every buyer request through
 * it would fail after the lender had already linked and been told it worked.
 * Dropping it here is the honest outcome — the alternative is advertising a
 * provider we know will not work.
 *
 * This file CANNOT widen the allowlist, only intersect with it. That is the
 * point: provider-hosts.js is generated and baked at build time so no
 * hand-maintained list can turn a node into an open proxy, and a check here
 * would be worthless if it could also add.
 */
const servable = (p) => !generatedIds.has(p.id) && PROVIDER_HOSTS.has(hostOf(p));

const SERVABLE_OAUTH_EXTRA = OAUTH_EXTRA_PROVIDERS.filter(servable);

/** Hand-written entries dropped above, so a test or maintainer can see what and why. */
export const UNSERVABLE_OAUTH_EXTRA = OAUTH_EXTRA_PROVIDERS.filter((p) => !SERVABLE_OAUTH_EXTRA.includes(p));

export const PROVIDERS = [...GENERATED, ...SERVABLE_OAUTH_EXTRA]
  .sort((a, b) => a.id.localeCompare(b.id));

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

export function getProvider(id) {
  return getGenerated(id) || SERVABLE_OAUTH_EXTRA.find((p) => p.id === id) || null;
}

/** Providers linked by pasting a key rather than by an OAuth redirect. */
export function isApiKeyProvider(id) {
  return getProvider(id)?.flow === "apikey";
}
