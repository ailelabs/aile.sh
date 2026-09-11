/**
 * Capability advertisement for the relay server.
 *
 * SECURITY — what this payload is and is not:
 *
 * It carries no credentials, and it cannot: provider tokens live server-side, so
 * this process never holds one to leak. What it sends is which accounts the
 * server already has on file for this renter, which the server itself told us.
 *
 * This heartbeat is therefore an *unverified claim* about what the node is ready
 * to egress for. Treat it that way server-side. The unforgeable proof that an
 * account is genuinely a Codex/ChatGPT account comes from linking, where the
 * server chooses the `nonce`, and verifies the provider-signed `id_token`
 * against the provider's JWKS. A nonce the server picked cannot be replayed with
 * a stolen token, which is exactly the property a client-relayed claim lacks.
 * Never promote anything in this payload to trusted without matching it against
 * a stored, attested account.
 */

import { api } from "../api/client.js";
import { loadConfig } from "./config.js";
import { buildLocalCapability } from "./local.js";
import { buildMcpCapability } from "../mcp/capabilities.js";
import { isApiKeyProvider } from "../providers/index.js";

// Fields safe to advertise. Anything not listed is dropped rather than forwarded.
//
// `id` is what lets the server route to ONE of several accounts a lender has
// with the same provider, and `label` is the lender's own name for it — both are
// server-assigned metadata the server already holds, not anything derived from a
// credential. No token material appears here and none may be added.
const SAFE_FIELDS = ["id", "provider", "account_key", "label", "email", "attested"];

/**
 * How this account is paid for, which is not the same question as whether it is
 * verified.
 *
 * An `apikey` account bills the lender per token with no monthly ceiling; a
 * subscription has one. Both can be unattested, so `attested: 0` does not
 * distinguish them — an operator reading a node listing would have no way to
 * tell a metered key from an unverified subscription, and those fail very
 * differently under load.
 *
 * Derived from the local catalog, so like everything else in this payload it is
 * a CLAIM. It is a billing hint, never an input to a trust decision.
 */
const DERIVED_FIELDS = ["authType"];

function toCapability(account) {
  const out = {};
  for (const field of SAFE_FIELDS) {
    if (account[field] !== undefined && account[field] !== null) out[field] = account[field];
  }
  out.authType = isApiKeyProvider(account.provider) ? "apikey" : "oauth";
  return out;
}

export async function buildCapabilities({ nodeId, maxConcurrent, mcp = null }) {
  const config = loadConfig();
  let accounts = [];
  try {
    const res = await api.listProviders({
      serverUrl: config.serverUrl,
      token: config.renterToken,
      // Honour the saved opt-in rather than waiving the check outright. An
      // unconditional waiver here would send the account token in clear on
      // every reconnect, silently, with no command for the user to have
      // approved — the reconnect loop is exactly where that must not happen.
      insecure: config.allowInsecure === true,
    });
    accounts = res.accounts || [];
  } catch {
    // Not signed in, or the server is briefly unreachable — advertise an empty
    // node rather than failing the whole connection.
  }
  // Self-hosted capacity is advertised under its own key, never merged into
  // claimedConnections. A local model is a different product with a different
  // privacy story — it is not blind — and the server must be able to route and
  // label the two separately. See relay/local.js.
  const localModel = await buildLocalCapability(config);

  // Sandboxed MCP servers, advertised under their own key for the same reason
  // localModel is: the compute happens HERE, so the path is not blind, and the
  // server must be able to route and label it separately from a relayed
  // subscription. An empty list is the normal state of a node and is not an
  // error — see mcp/capabilities.js for the two things that empty it.
  // Accepted from the caller when it has one, because building it shells out
  // to the container runtime and the supervisor needs the SAME answer to hand
  // the agent (which runtime to spawn with). Detecting twice per reconnect
  // would be two synchronous probes for one fact.
  const mcpCapability = mcp || buildMcpCapability();

  return {
    nodeId,
    maxConcurrent,
    platform: process.platform,
    agentVersion: 2,
    claimedConnections: accounts.map(toCapability),
    localModel,
    mcpServers: mcpCapability.servers,
  };
}

export { SAFE_FIELDS, DERIVED_FIELDS };
