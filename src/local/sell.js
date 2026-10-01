/**
 * Will this model earn anything, and is it being offered?
 *
 * PRICES come from the server (`GET /catalog/self-hosted`), which answers with
 * the very check the relay applies to a buyer's `local/<id>` request. The
 * client never guesses: an unreachable or older server reads as "unknown",
 * never as "priced".
 *
 * `localModels` decides what the node advertises. Blank means "everything the
 * endpoint lists" — which, for Ollama, is every tag with `:latest` glued on,
 * so a model saved as `meta-llama/llama-3.1-8b-instruct` would reach buyers as
 * `local/meta-llama/llama-3.1-8b-instruct:latest`. A managed pull therefore
 * names its model in the list explicitly. When the list was blank and already
 * advertising this endpoint's models, it is seeded with them first, so taking
 * control of the list never quietly withdraws something that was on offer.
 */

import { api } from "../api/client.js";

/** `"a, b,,c"` → `["a","b","c"]`. */
export function parseList(value) {
  return String(value || "").split(",").map((s) => s.trim()).filter(Boolean);
}

const uniq = (xs) => [...new Set(xs)];

/**
 * Live list prices for `ids`.
 * @returns {Promise<{ available: boolean, prices: Map<string, {priced: boolean, inPerMtok: number|null, outPerMtok: number|null, source: string|null}>, reason?: string }>}
 */
export async function livePrices(ids, config, { call = api.selfHostedPrices } = {}) {
  const want = uniq(ids.filter(Boolean));
  const prices = new Map();
  if (!want.length) return { available: true, prices };
  try {
    for (let i = 0; i < want.length; i += 50) {
      const res = await call({ ids: want.slice(i, i + 50), serverUrl: config.serverUrl, insecure: config.allowInsecure === true });
      for (const row of res?.models || []) prices.set(row.id, row);
    }
    return { available: true, prices };
  } catch (e) {
    const reason = e?.status === 404 ? "this server does not answer price checks yet" : "the price list could not be read";
    return { available: false, prices, reason };
  }
}

/** "priced" | "unpriced" | "unknown" for one id. */
export function sellState(id, live) {
  const row = live?.prices?.get(id);
  if (!row) return "unknown";
  return row.priced ? "priced" : "unpriced";
}

/** `$0.05 / $0.08` per million tokens, at list. */
export function priceText(row) {
  if (!row?.priced) return null;
  const f = (n) => (n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(3).replace(/0$/, "") : n.toPrecision(2));
  return `$${f(row.inPerMtok)} / $${f(row.outPerMtok)}`;
}

/**
 * What lending looked like before this command changed anything. Taken first,
 * because the seed below must be what WAS advertised, not what is now.
 */
export async function snapshotAdvertising(config, discover) {
  const declared = parseList(config.localModels);
  return {
    enabled: Boolean(config.localEnabled),
    endpoint: config.localEndpoint || "",
    declared,
    discovered: declared.length || !config.localEnabled ? null : await discover(config).catch(() => []),
  };
}

/**
 * The `localModels` value after adding `id`.
 * @returns {{ value: string, seeded: string[] }}
 */
export function addAdvertised(id, pre, endpoint) {
  if (pre.declared.length) return { value: uniq([...pre.declared, id]).join(","), seeded: [] };
  const sameEndpoint = pre.enabled && pre.endpoint && pre.endpoint === endpoint;
  const base = sameEndpoint ? (pre.discovered || []).filter((m) => m !== id && m !== `${id}:latest`) : [];
  return { value: uniq([...base, id]).join(","), seeded: base };
}

/** The `localModels` value after removing `id` (and its `:latest` spelling). */
export function removeAdvertised(id, config) {
  const list = parseList(config.localModels);
  const next = list.filter((m) => m !== id && m !== `${id}:latest`);
  return { value: next.join(","), changed: next.length !== list.length };
}
