/**
 * Bring-your-own-key providers — HAND-MAINTAINED. Edit this file directly.
 *
 * The generated catalog (catalog.js) covers providers reached through an OAuth
 * flow, where the lender authorises us and we receive a token. These are the
 * other kind: the lender already has an API key from the provider's dashboard
 * and pastes it in. There is nothing to generate — a key-based provider has no
 * OAuth endpoints to vendor — so this list is written by hand and merged into
 * the catalog view by ./index.js.
 *
 * WHAT A LENDER IS ACTUALLY LENDING HERE, and why it reads differently to a
 * subscription. An API key is billed per token to the lender's own account, with
 * no monthly ceiling to hide behind: a runaway buyer runs up a real invoice
 * rather than exhausting a plan. It also carries no attestation — no provider
 * signs anything, so `aile accounts` shows these as unverified and that is
 * accurate, not a limitation to paper over.
 *
 * TO ADD ONE, you need four things, and the second is the one that matters:
 *
 *  - `verifyUrl` — a cheap authenticated GET. It is fetched with the key BEFORE
 *    the key is uploaded, so a typo fails here, on the lender's own machine,
 *    instead of becoming capacity that 401s on every buyer request. Pick an
 *    endpoint that is free to call; a completions endpoint would bill the lender
 *    to check their own key.
 *  - `host` — must ALREADY be in the generated egress allowlist
 *    (src/relay/provider-hosts.js). A provider a node will not dial is capacity
 *    that cannot be served, and this file cannot widen that allowlist: it is
 *    baked at build time precisely so no hand-edited list can open a node up as
 *    a proxy. index.js tests this rather than trusting it.
 *  - `transport` — where a buyer request is actually SENT, in the same shape the
 *    generated catalog uses, because the relay reads both through one code path
 *    that never learns which file an entry came from. Omitting it produces the
 *    silent version of the `host` failure above: an account that links, verifies,
 *    and advertises capacity the relay then has no address to serve.
 *  - `prefix` — optional, and only ever a hint. It produces a better error
 *    message when validation fails; it never blocks on its own, because a
 *    provider that changes its key format would otherwise lock out every new
 *    lender until someone edited this file.
 */

/**
 * Every provider here is OpenAI-compatible and reads a plain bearer key, so the
 * descriptor is one shared constant rather than seven copies. Frozen because it
 * is shared by reference: a caller that mutated it would re-point the auth of
 * every other provider in the list.
 *
 * `combined` means one header regardless of credential kind — these accounts
 * only ever have a key, so there is no oauth branch to describe.
 */
const BEARER = Object.freeze({ combined: true, header: "Authorization", scheme: "bearer" });

/** Where to read a name for the key out of the verify response, if it says one. */
const OPENROUTER_NAME = ["data", "label"];

export const BYOK_PROVIDERS = [
  {
    id: "openrouter",
    name: "OpenRouter",
    color: "#6467F2",
    flow: "apikey",
    apiKey: {
      host: "openrouter.ai",
      // Returns the key's own label and its spend limit — the cheapest possible
      // check, and the only one in this list that names the key back to us.
      verifyUrl: "https://openrouter.ai/api/v1/key",
      nameFrom: OPENROUTER_NAME,
      prefix: "sk-or-",
      keyUrl: "https://openrouter.ai/keys",
    },
    transport: {
      baseUrl: "https://openrouter.ai/api/v1/chat/completions",
      format: "openai",
      // OpenRouter attributes traffic to whatever client these name, and shows
      // it publicly on its rankings page. They are this app's identity, not a
      // borrowed one.
      headers: { "HTTP-Referer": "https://aile.sh", "X-Title": "aile.sh" },
      auth: BEARER,
    },
    models: [
      "openai/gpt-5",
      "anthropic/claude-sonnet-5",
      "google/gemini-3-pro",
      "meta-llama/llama-4-maverick",
      "deepseek/deepseek-v3",
    ],
  },
  {
    id: "groq",
    name: "Groq",
    color: "#F55036",
    flow: "apikey",
    apiKey: {
      host: "api.groq.com",
      verifyUrl: "https://api.groq.com/openai/v1/models",
      prefix: "gsk_",
      keyUrl: "https://console.groq.com/keys",
    },
    transport: {
      baseUrl: "https://api.groq.com/openai/v1/chat/completions",
      format: "openai",
      auth: BEARER,
    },
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "qwen-2.5-32b"],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    color: "#4D6BFE",
    flow: "apikey",
    apiKey: {
      host: "api.deepseek.com",
      verifyUrl: "https://api.deepseek.com/models",
      prefix: "sk-",
      keyUrl: "https://platform.deepseek.com/api_keys",
    },
    transport: {
      baseUrl: "https://api.deepseek.com/chat/completions",
      format: "openai",
      auth: BEARER,
    },
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "together",
    name: "Together AI",
    color: "#0F6FFF",
    apiKey: {
      host: "api.together.xyz",
      verifyUrl: "https://api.together.xyz/v1/models",
      keyUrl: "https://api.together.xyz/settings/api-keys",
    },
    flow: "apikey",
    transport: {
      baseUrl: "https://api.together.xyz/v1/chat/completions",
      format: "openai",
      auth: BEARER,
    },
    models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Qwen/Qwen2.5-72B-Instruct-Turbo"],
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    color: "#5B2CFF",
    flow: "apikey",
    apiKey: {
      host: "api.fireworks.ai",
      verifyUrl: "https://api.fireworks.ai/inference/v1/models",
      prefix: "fw_",
      keyUrl: "https://fireworks.ai/account/api-keys",
    },
    transport: {
      baseUrl: "https://api.fireworks.ai/inference/v1/chat/completions",
      format: "openai",
      auth: BEARER,
    },
    models: ["accounts/fireworks/models/llama-v3p3-70b-instruct", "accounts/fireworks/models/deepseek-v3"],
  },
  {
    id: "mistral",
    name: "Mistral",
    color: "#FA520F",
    flow: "apikey",
    apiKey: {
      host: "api.mistral.ai",
      verifyUrl: "https://api.mistral.ai/v1/models",
      keyUrl: "https://console.mistral.ai/api-keys",
    },
    transport: {
      baseUrl: "https://api.mistral.ai/v1/chat/completions",
      format: "openai",
      auth: BEARER,
      // Rejects Anthropic's `client_metadata`, which a buyer translating from a
      // Claude-shaped request would otherwise carry through.
      quirks: { dropClientMetadata: true },
    },
    models: ["mistral-large-latest", "mistral-small-latest", "codestral-latest"],
  },
  {
    id: "cerebras",
    name: "Cerebras",
    color: "#F26D5B",
    flow: "apikey",
    apiKey: {
      host: "api.cerebras.ai",
      verifyUrl: "https://api.cerebras.ai/v1/models",
      prefix: "csk-",
      keyUrl: "https://cloud.cerebras.ai/platform/apikeys",
    },
    transport: {
      baseUrl: "https://api.cerebras.ai/v1/chat/completions",
      format: "openai",
      auth: BEARER,
      quirks: { dropClientMetadata: true },
    },
    models: ["llama-3.3-70b", "llama3.1-8b", "qwen-3-32b"],
  },
];

export const BYOK_IDS = BYOK_PROVIDERS.map((p) => p.id);

export function isByok(id) {
  return BYOK_IDS.includes(id);
}
