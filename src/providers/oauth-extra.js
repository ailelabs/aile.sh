/**
 * OAuth providers the generator can't emit — HAND-MAINTAINED. Edit directly.
 *
 * catalog.js is generated from the aile relay's provider registry
 * (`apps/api/scripts/build-cli-catalog.ts`) and is overwritten on every
 * regeneration, so nothing hand-written survives there. This is the other file:
 * providers that must be hand-vendored because the relay carries them under a
 * shape the generator drops, or does not carry them at all.
 *
 * WHY EACH ONE IS HERE rather than generated:
 *
 *  - `codex` — the relay links Codex through OpenAI's browser "deviceauth" flow,
 *    which finishes with an `exchange` step flows.js does not implement, so the
 *    generator skips it. That flow exists because the hosted dashboard cannot
 *    bind a loopback listener and auth.openai.com blocks datacenter IPs. Neither
 *    constraint applies to a CLI running on a lender's own machine, so the CLI
 *    keeps the loopback PKCE flow on port 1455 — the same client id, so the
 *    id_token it returns attests against the same JWKS row server-side.
 *  - `gitlab-duo` — the OAuth (authorization_code + PKCE) half of the paste-only
 *    `gitlab` registry entry. Its LINK id must equal the SERVE id (serve does
 *    getProvider(account.provider)), and it is operator-gated: with no client env
 *    configured there is no `authorizeUrl` for the generator to emit.
 *
 * These MIRROR apps/api/src/lib/linkCatalog.ts — the server runs the same link
 * flow, so a drift between the two is a link that works in one place and not the
 * other. Keep them in step.
 *
 * The `transport` block here is read ONLY by probe.js and by the host check in
 * ./index.js (a node relays blind — the server injects the real transport at
 * serve time), so it carries the upstream serve address and format for parity
 * but its `auth` is effectively inert. The `oauth` block drives linking.
 */

/** OpenAI-compatible bearer, shared by reference and frozen so no caller can re-point it. */
const BEARER = Object.freeze({ combined: true, header: "Authorization", scheme: "bearer" });

/**
 * gitlab-duo is operator-gated: with no GITLAB_DUO_OAUTH_CLIENT_ID configured
 * there is no usable client, so `authorizeUrl`/`clientId` stay undefined and the
 * entry links only once an operator sets the env (mirrors the API's gate). The
 * secret is read only for confidential GitLab apps; a public app omits it.
 */
const GITLAB_DUO_BASE = (process.env.GITLAB_DUO_BASE_URL || "https://gitlab.com").replace(/\/+$/, "");
const GITLAB_DUO_CLIENT_ID = process.env.GITLAB_DUO_OAUTH_CLIENT_ID;
const GITLAB_DUO_CLIENT_SECRET = process.env.GITLAB_DUO_OAUTH_CLIENT_SECRET;

export const OAUTH_EXTRA_PROVIDERS = [
  {
    // Loopback PKCE on the port the Codex CLI itself registers (1455), with the
    // public client's own extraParams sent unmodified — auth.openai.com rejects
    // a redirect_uri or an originator it does not recognise. `openid` is in the
    // scope because the id_token is what the server attests the account link
    // with; dropping it downgrades every Codex link to unproven.
    id: "codex",
    name: "OpenAI Codex",
    color: "#3B82F6",
    flow: "authcode",
    oauth: {
      clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
      authorizeUrl: "https://auth.openai.com/oauth/authorize",
      tokenUrl: "https://auth.openai.com/oauth/token",
      scope: "openid profile email offline_access",
      codeChallengeMethod: "S256",
      extraParams: {
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        originator: "codex_cli_rs",
      },
      fixedPort: 1455,
      callbackPath: "/auth/callback",
    },
    transport: {
      baseUrl: "https://chatgpt.com/backend-api/codex/responses",
      format: "openai-responses",
      auth: BEARER,
    },
  },
  {
    // OAuth (authorization_code + PKCE) half of GitLab Duo. Serving id
    // `gitlab-duo` (code-suggestions completions, needs the serve translator).
    // Operator-gated on GITLAB_DUO_OAUTH_CLIENT_ID: absent env leaves clientId /
    // authorizeUrl undefined, so linking stays off until the operator sets it.
    id: "gitlab-duo",
    name: "GitLab Duo (OAuth)",
    color: "#FC6D26",
    flow: "authcode",
    oauth: {
      clientId: GITLAB_DUO_CLIENT_ID,
      clientSecret: GITLAB_DUO_CLIENT_SECRET,
      authorizeUrl: GITLAB_DUO_CLIENT_ID ? `${GITLAB_DUO_BASE}/oauth/authorize` : undefined,
      tokenUrl: `${GITLAB_DUO_BASE}/oauth/token`,
      scope: "ai_features read_user",
      codeChallengeMethod: "S256",
    },
    transport: {
      baseUrl: "https://gitlab.com/api/v4/code_suggestions/completions",
      format: "openai",
      auth: BEARER,
    },
    models: [
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ],
  },
];

/** Ids in this file, for the merge in ./index.js to detect a generated shadow. */
export const OAUTH_EXTRA_IDS = OAUTH_EXTRA_PROVIDERS.map((p) => p.id);
