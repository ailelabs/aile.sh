/**
 * Provider catalog — GENERATED, do not hand-edit.
 *
 * Regenerate with:  bun run scripts/sync-providers.js /path/to/registry
 *
 * `flow` is the linking strategy, and it is what src/providers/flows.js
 * branches on. Providers that share a family need no per-provider client code.
 *
 *   authcode  browser redirect to a loopback callback, PKCE where supported
 *   device    device-authorization: show a code, poll for the token
 *   google    Google OAuth with a client secret
 *   paste     no programmatic flow — the user supplies a token
 *
 * `oauth` is how an account is LINKED; `transport` and `refresh` are how it is
 * SERVED and RENEWED once linked. They are separate because the same provider
 * presents a different client identity to its authorization server than to its
 * inference endpoint, and collapsing them makes one of the two wrong.
 *
 * 17 providers.
 */

export const PROVIDERS = [
  {
    "id": "antigravity",
    "name": "Antigravity",
    "color": "#F59E0B",
    "flow": "google",
    "oauth": {
      "authorizeUrl": "https://accounts.google.com/o/oauth2/v2/auth",
      "tokenUrl": "https://oauth2.googleapis.com/token",
      "userInfoUrl": "https://www.googleapis.com/oauth2/v1/userinfo",
      "scopes": [
        "openid",
        "email",
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/cclog",
        "https://www.googleapis.com/auth/experimentsandconfigs"
      ],
      "extraParams": {
        "access_type": "offline",
        "prompt": "consent"
      },
      "clientId": "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
      "clientSecret": "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"
    },
    "transport": {
      "baseUrls": [
        "https://cloudcode-pa.googleapis.com"
      ],
      "format": "antigravity",
      "headers": {
        "User-Agent": "antigravity/ide/2.1.1 darwin/arm64"
      }
    },
    "refresh": {
      "refreshLeadMs": 300000
    },
    "models": [
      "gemini-3-flash-agent",
      "gemini-3.5-flash-low",
      "gemini-3.5-flash-extra-low",
      "gemini-pro-agent",
      "gemini-3.1-pro-low",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
      "gemini-3-flash",
      "gemini-3.1-flash-image"
    ]
  },
  {
    "id": "claude",
    "name": "Claude Code",
    "color": "#D97757",
    "flow": "authcode",
    "oauth": {
      "clientId": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      "authorizeUrl": "https://claude.ai/oauth/authorize",
      "tokenUrl": "https://api.anthropic.com/v1/oauth/token",
      "scopes": [
        "org:create_api_key",
        "user:profile",
        "user:inference"
      ],
      "codeChallengeMethod": "S256",
      "extraParams": {
        "code": "true"
      },
      "tokenStyle": {
        "encoding": "json",
        "sendState": true
      }
    },
    "transport": {
      "baseUrl": "https://api.anthropic.com/v1/messages",
      "format": "claude",
      "urlSuffix": "?beta=true",
      "headers": {
        "Anthropic-Version": "2023-06-01",
        "Anthropic-Beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24,structured-outputs-2025-12-15,fast-mode-2026-02-01,redact-thinking-2026-02-12,token-efficient-tools-2026-03-28",
        "Anthropic-Dangerous-Direct-Browser-Access": "true",
        "User-Agent": "claude-cli/2.1.92 (external, sdk-cli)",
        "X-App": "cli",
        "X-Stainless-Helper-Method": "stream",
        "X-Stainless-Retry-Count": "0",
        "X-Stainless-Runtime-Version": "v24.14.0",
        "X-Stainless-Package-Version": "0.80.0",
        "X-Stainless-Runtime": "node",
        "X-Stainless-Lang": "js",
        "X-Stainless-Arch": "arm64",
        "X-Stainless-Os": "MacOS",
        "X-Stainless-Timeout": "600"
      },
      "auth": {
        "apiKey": {
          "header": "x-api-key",
          "scheme": "raw"
        },
        "oauth": {
          "header": "Authorization",
          "scheme": "bearer"
        }
      },
      "quirks": {
        "cloakToolsOnOAuth": true
      }
    },
    "refresh": {
      "refreshLeadMs": 14400000,
      "refresh": {
        "encoding": "json"
      }
    },
    "models": [
      "claude-fable-5",
      "claude-sonnet-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-haiku-4-5-20251001"
    ]
  },
  {
    "id": "cline",
    "name": "Cline",
    "color": "#5B9BD5",
    "flow": "authcode",
    "oauth": {
      "authorizeUrl": "https://api.cline.bot/api/v1/auth/authorize",
      "tokenExchangeUrl": "https://api.cline.bot/api/v1/auth/token",
      "refreshUrl": "https://api.cline.bot/api/v1/auth/refresh",
      "apiBaseUrl": "https://api.cline.bot",
      "appBaseUrl": "https://app.cline.bot",
      "extraParams": {
        "client_type": "extension"
      },
      "authShape": {
        "callback_url": "@redirect",
        "redirect_uri": "@redirect"
      },
      "tokenStyle": {
        "encoding": "json",
        "codeFormat": "base64json"
      }
    },
    "transport": {
      "baseUrl": "https://api.cline.bot/api/v1/chat/completions",
      "headers": {
        "X-PLATFORM": "@platform",
        "X-PLATFORM-VERSION": "@platformVersion",
        "X-CLIENT-TYPE": "=aile",
        "X-CLIENT-VERSION": "@appVersion",
        "X-CORE-VERSION": "@appVersion",
        "X-IS-MULTIROOT": "=false",
        "HTTP-Referer": "https://cline.bot",
        "X-Title": "Cline"
      },
      "auth": {
        "combined": true,
        "header": "Authorization",
        "scheme": "bearer"
      },
      "tokenPrefix": "workos:"
    },
    "models": [
      "anthropic/claude-opus-4.7",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-opus-4.6",
      "openai/gpt-5.3-codex",
      "openai/gpt-5.4",
      "google/gemini-3.1-pro-preview",
      "google/gemini-3.1-flash-lite-preview",
      "kwaipilot/kat-coder-pro"
    ]
  },
  {
    "id": "clinepass",
    "name": "ClinePass",
    "color": "#5B9BD5",
    "flow": "authcode",
    "oauth": {
      "authorizeUrl": "https://api.cline.bot/api/v1/auth/authorize",
      "tokenUrl": "https://api.cline.bot/api/v1/auth/token",
      "refreshUrl": "https://api.cline.bot/api/v1/auth/refresh",
      "apiBaseUrl": "https://api.cline.bot",
      "appBaseUrl": "https://app.cline.bot",
      "extraParams": {
        "client_type": "extension"
      },
      "authShape": {
        "callback_url": "@redirect",
        "redirect_uri": "@redirect"
      },
      "tokenStyle": {
        "encoding": "json",
        "codeFormat": "base64json"
      }
    },
    "transport": {
      "baseUrl": "https://api.cline.bot/api/v1/chat/completions",
      "headers": {
        "X-PLATFORM": "@platform",
        "X-PLATFORM-VERSION": "@platformVersion",
        "X-CLIENT-TYPE": "=aile",
        "X-CLIENT-VERSION": "@appVersion",
        "X-CORE-VERSION": "@appVersion",
        "X-IS-MULTIROOT": "=false",
        "HTTP-Referer": "https://cline.bot",
        "X-Title": "Cline"
      },
      "auth": {
        "combined": true,
        "header": "Authorization",
        "scheme": "bearer"
      },
      "tokenPrefix": "workos:"
    },
    "models": [
      "cline-pass/glm-5.2",
      "cline-pass/kimi-k2.7-code",
      "cline-pass/kimi-k2.6",
      "cline-pass/deepseek-v4-pro",
      "cline-pass/deepseek-v4-flash",
      "cline-pass/mimo-v2.5",
      "cline-pass/mimo-v2.5-pro",
      "cline-pass/minimax-m3",
      "cline-pass/qwen3.7-max",
      "cline-pass/qwen3.7-plus"
    ]
  },
  {
    "id": "codebuddy-cn",
    "name": "CodeBuddy CN",
    "color": "#006EFF",
    "flow": "device",
    "oauth": {
      "tokenUrl": "https://copilot.tencent.com/v2/plugin/auth/token",
      "refreshUrl": "https://copilot.tencent.com/v2/plugin/auth/token/refresh",
      "stateUrl": "https://copilot.tencent.com/v2/plugin/auth/state",
      "pollInterval": 5000,
      "userAgent": "CLI/2.63.2 CodeBuddy/2.63.2",
      "platform": "CLI",
      "deviceHeaders": {
        "X-Requested-With": "=XMLHttpRequest",
        "X-Domain": "=copilot.tencent.com",
        "X-No-Authorization": "=true",
        "X-No-User-Id": "=true",
        "X-Product": "=SaaS"
      },
      "deviceStyle": {
        "initiate": {
          "url": "@stateUrl?platform=@platform",
          "method": "POST",
          "encoding": "json",
          "body": {}
        },
        "poll": {
          "url": "@tokenUrl?state=@deviceCode",
          "method": "GET"
        },
        "envelope": "data",
        "map": {
          "deviceCode": "state",
          "verificationUri": "authUrl"
        },
        "codeField": "code",
        "codePending": 11217,
        "codeOk": 0,
        "tokenField": "accessToken",
        "refreshField": "refreshToken",
        "expiresField": "expiresIn"
      }
    },
    "transport": {
      "baseUrl": "https://copilot.tencent.com/v2/chat/completions",
      "headers": {
        "User-Agent": "CLI/2.108.1 CodeBuddy/2.108.1",
        "X-Product": "SaaS",
        "X-IDE-Type": "CLI",
        "X-IDE-Name": "CLI",
        "x-requested-with": "XMLHttpRequest",
        "x-codebuddy-request": "1"
      },
      "auth": {
        "combined": true,
        "header": "Authorization",
        "scheme": "bearer"
      },
      "forceStream": true,
      "thinkingFormat": "openai"
    },
    "models": [
      "glm-5.2",
      "glm-5.1",
      "glm-5.0",
      "glm-5.0-turbo",
      "glm-5v-turbo",
      "glm-4.7",
      "minimax-m3",
      "minimax-m2.7",
      "kimi-k2.7",
      "kimi-k2.6",
      "kimi-k2.5",
      "hy3-preview"
    ]
  },
  {
    "id": "codex",
    "name": "OpenAI Codex",
    "color": "#3B82F6",
    "flow": "authcode",
    "oauth": {
      "clientId": "app_EMoamEEZ73f0CkXaXp7hrann",
      "authorizeUrl": "https://auth.openai.com/oauth/authorize",
      "tokenUrl": "https://auth.openai.com/oauth/token",
      "scope": "openid profile email offline_access",
      "codeChallengeMethod": "S256",
      "extraParams": {
        "id_token_add_organizations": "true",
        "codex_cli_simplified_flow": "true",
        "originator": "codex_cli_rs"
      },
      "fixedPort": 1455,
      "callbackPath": "/auth/callback"
    },
    "transport": {
      "baseUrl": "https://chatgpt.com/backend-api/codex/responses",
      "format": "openai-responses",
      "headers": {
        "ChatGPT-Account-ID": "@chatgptAccountId",
        "session_id": "@sessionId",
        "originator": "codex_cli_rs",
        "User-Agent": "codex_cli_rs/0.136.0"
      },
      "forceStream": true
    },
    "refresh": {
      "refreshLeadMs": 432000000,
      "maxRefreshAgeMs": 691200000,
      "trackRefreshAt": true,
      "refresh": {
        "encoding": "form",
        "scope": "openid profile email offline_access"
      }
    },
    "models": [
      "gpt-5.6-sol",
      "gpt-5.6-sol-review",
      "gpt-5.6-terra",
      "gpt-5.6-terra-review",
      "gpt-5.6-luna",
      "gpt-5.6-luna-review",
      "gpt-5.5",
      "gpt-5.5-review",
      "gpt-5.4",
      "gpt-5.4-review",
      "gpt-5.4-mini",
      "gpt-5.4-mini-review"
    ]
  },
  {
    "id": "cursor",
    "name": "Cursor IDE",
    "color": "#00D4AA",
    "flow": "paste",
    "oauth": {},
    "transport": {
      "baseUrl": "https://api2.cursor.sh",
      "format": "cursor",
      "headers": {
        "connect-accept-encoding": "gzip",
        "connect-protocol-version": "1",
        "Content-Type": "application/connect+proto",
        "User-Agent": "connect-es/1.6.1"
      },
      "chatPath": "/aiserver.v1.ChatService/StreamUnifiedChatWithTools"
    },
    "models": [
      "default",
      "claude-4.5-opus-high-thinking",
      "claude-4.5-opus-high",
      "claude-4.5-sonnet-thinking",
      "claude-4.5-sonnet",
      "claude-4.5-haiku",
      "claude-4.5-opus",
      "gpt-5.2-codex",
      "claude-4.6-opus-max",
      "claude-4.6-sonnet-medium-thinking",
      "kimi-k2.5",
      "gemini-3-flash-preview"
    ]
  },
  {
    "id": "gemini-cli",
    "name": "Gemini CLI",
    "color": "#4285F4",
    "flow": "google",
    "oauth": {
      "authorizeUrl": "https://accounts.google.com/o/oauth2/v2/auth",
      "tokenUrl": "https://oauth2.googleapis.com/token",
      "userInfoUrl": "https://www.googleapis.com/oauth2/v1/userinfo",
      "scopes": [
        "openid",
        "email",
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile"
      ],
      "extraParams": {
        "access_type": "offline",
        "prompt": "consent"
      },
      "clientId": "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
      "clientSecret": "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"
    },
    "transport": {
      "baseUrl": "https://cloudcode-pa.googleapis.com/v1internal",
      "format": "gemini-cli"
    },
    "refresh": {
      "refresh": {
        "encoding": "form"
      }
    },
    "models": [
      "gemini-3.1-pro-preview",
      "gemini-3-pro-preview",
      "gemini-3-flash-preview",
      "gemini-3.1-flash-lite-preview",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite"
    ]
  },
  {
    "id": "github",
    "name": "GitHub Copilot",
    "color": "#333333",
    "flow": "device",
    "oauth": {
      "clientId": "Iv1.b507a08c87ecfe98",
      "authorizeUrl": "https://github.com/login/oauth/authorize",
      "tokenUrl": "https://github.com/login/oauth/access_token",
      "deviceCodeUrl": "https://github.com/login/device/code",
      "userInfoUrl": "https://api.github.com/user",
      "scopes": "read:user",
      "userAgent": "GitHubCopilotChat/0.26.7"
    },
    "transport": {
      "baseUrl": "https://api.githubcopilot.com/chat/completions",
      "headers": {
        "copilot-integration-id": "vscode-chat",
        "editor-version": "vscode/1.110.0",
        "editor-plugin-version": "copilot-chat/0.38.0",
        "user-agent": "GitHubCopilotChat/0.38.0",
        "openai-intent": "conversation-panel",
        "x-github-api-version": "2025-04-01",
        "x-vscode-user-agent-library-version": "electron-fetch",
        "X-Initiator": "user",
        "Accept": "application/json",
        "Content-Type": "application/json"
      },
      "responsesUrl": "https://api.githubcopilot.com/responses",
      "messagesUrl": "https://api.githubcopilot.com/v1/messages"
    },
    "models": [
      "gpt-5.2",
      "gpt-5.2-codex",
      "gpt-5.3-codex",
      "gpt-5.4",
      "gpt-5.4-mini",
      "claude-haiku-4.5",
      "claude-opus-4.5",
      "claude-sonnet-4.5",
      "claude-sonnet-4.6",
      "claude-opus-4.6",
      "claude-opus-4.7",
      "gemini-2.5-pro"
    ]
  },
  {
    "id": "gitlab",
    "name": "GitLab Duo",
    "color": "#FC6D26",
    "flow": "paste",
    "oauth": {
      "scope": "api read_user",
      "codeChallengeMethod": "S256",
      "defaultBaseUrl": "https://gitlab.com",
      "authorizeUrlPath": "/oauth/authorize",
      "tokenUrlPath": "/oauth/token"
    },
    "transport": {
      "baseUrl": "https://gitlab.com/api/v4/chat/completions",
      "auth": {
        "combined": true,
        "header": "Authorization",
        "scheme": "bearer"
      }
    },
    "models": []
  },
  {
    "id": "grok-cli",
    "name": "Grok CLI (Grok Build)",
    "color": "#1DA1F2",
    "flow": "device",
    "oauth": {
      "clientId": "b1a00492-073a-47ea-816f-4c329264a828",
      "tokenUrl": "https://auth.x.ai/oauth2/token",
      "refreshUrl": "https://auth.x.ai/oauth2/token",
      "deviceCodeUrl": "https://auth.x.ai/oauth2/device/code",
      "scope": "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write",
      "referrer": "grok-build"
    },
    "transport": {
      "baseUrl": "https://cli-chat-proxy.grok.com/v1/responses",
      "format": "openai-responses",
      "headers": {
        "User-Agent": "grok-shell/0.2.99 (linux; x86_64)",
        "x-grok-client-identifier": "grok-shell",
        "x-grok-client-version": "0.2.99"
      },
      "forceStream": true
    },
    "refresh": {
      "refreshLeadMs": 300000
    },
    "models": [
      "grok-build",
      "grok-4.5",
      "grok-4.5-high",
      "grok-4.5-medium",
      "grok-4.5-low"
    ]
  },
  {
    "id": "iflow",
    "name": "iFlow AI",
    "color": "#6366F1",
    "flow": "authcode",
    "oauth": {
      "clientId": "10009311001",
      "clientSecret": "4Z3YjXycVsQvyGF1etiNlIBB4RsqSDtW",
      "authorizeUrl": "https://iflow.cn/oauth",
      "tokenUrl": "https://iflow.cn/oauth/token",
      "userInfoUrl": "https://iflow.cn/api/oauth/getUserInfo",
      "extraParams": {
        "loginMethod": "phone",
        "type": "phone"
      },
      "authShape": {
        "redirect": "@redirect",
        "state": "@state",
        "client_id": "@clientId"
      },
      "tokenStyle": {
        "auth": "basic"
      }
    },
    "transport": {
      "baseUrl": "https://apis.iflow.cn/v1/chat/completions",
      "headers": {
        "User-Agent": "iFlow-Cli"
      },
      "thinkingFormat": "openai"
    },
    "refresh": {
      "refreshLeadMs": 86400000
    },
    "models": [
      "qwen3-coder-plus",
      "qwen3-max",
      "qwen3-vl-plus",
      "qwen3-max-preview",
      "qwen3-235b",
      "qwen3-235b-a22b-instruct",
      "qwen3-235b-a22b-thinking-2507",
      "qwen3-32b",
      "kimi-k2",
      "deepseek-v3.2",
      "deepseek-v3.1",
      "deepseek-v3"
    ]
  },
  {
    "id": "kilocode",
    "name": "Kilo Code",
    "color": "#FF6B35",
    "flow": "device",
    "oauth": {
      "initiateUrl": "https://api.kilo.ai/api/device-auth/codes",
      "pollUrlBase": "https://api.kilo.ai/api/device-auth/codes",
      "apiBaseUrl": "https://api.kilo.ai",
      "deviceStyle": {
        "initiate": {
          "url": "@initiateUrl",
          "method": "POST",
          "encoding": "json",
          "body": {}
        },
        "poll": {
          "url": "@pollUrlBase/@deviceCode",
          "method": "GET"
        },
        "map": {
          "deviceCode": "code",
          "userCode": "code",
          "verificationUri": "verificationUrl",
          "expiresIn": "expiresIn"
        },
        "pollStatus": {
          "202": "pending",
          "403": "denied",
          "410": "expired"
        },
        "approvedWhen": {
          "field": "status",
          "equals": "approved"
        },
        "tokenField": "token",
        "emailField": "userEmail",
        "intervalMs": 3000
      }
    },
    "transport": {
      "baseUrl": "https://api.kilo.ai/api/openrouter/chat/completions",
      "headers": {
        "X-Kilocode-OrganizationID": "@orgId"
      },
      "auth": {
        "combined": true,
        "header": "Authorization",
        "scheme": "bearer"
      }
    },
    "models": [
      "anthropic/claude-sonnet-4-20250514",
      "anthropic/claude-opus-4-20250514",
      "google/gemini-2.5-pro",
      "google/gemini-2.5-flash",
      "openai/gpt-4.1",
      "openai/o3",
      "deepseek/deepseek-chat",
      "deepseek/deepseek-reasoner"
    ]
  },
  {
    "id": "kimchi",
    "name": "Kimchi",
    "color": "#FF521D",
    "flow": "paste",
    "oauth": {
      "userInfoUrl": "https://app.kimchi.dev/api/v1/me",
      "webAppUrl": "https://app.kimchi.dev",
      "validationUrl": "https://api.cast.ai/v1/llm/openai/supported-providers"
    },
    "transport": {
      "baseUrl": "https://llm.kimchi.dev/openai/v1/chat/completions",
      "format": "openai",
      "headers": {
        "User-Agent": "kimchi/0.1.50"
      },
      "auth": {
        "combined": true,
        "header": "Authorization",
        "scheme": "bearer"
      }
    },
    "models": [
      "minimax-m3",
      "kimi-k2.7",
      "kimi-k2.6",
      "kimi-k2.5",
      "nemotron-3-ultra-fp4",
      "minimax-m2.7",
      "claude-opus-4-6",
      "claude-sonnet-4-6"
    ]
  },
  {
    "id": "kimi",
    "name": "Kimi",
    "color": "#1E3A8A",
    "flow": "device",
    "oauth": {
      "clientId": "17e5f671-d194-4dfb-9706-5516cb48c098",
      "tokenUrl": "https://auth.kimi.com/api/oauth/token",
      "refreshUrl": "https://auth.kimi.com/api/oauth/token",
      "deviceCodeUrl": "https://auth.kimi.com/api/oauth/device_authorization",
      "authorizeDeviceUrl": "https://www.kimi.com/code/authorize_device",
      "deviceHeaders": {
        "X-Msh-Platform": "=aile",
        "X-Msh-Version": "@appVersion",
        "X-Msh-Device-Name": "@hostname",
        "X-Msh-Device-Model": "@deviceModel",
        "X-Msh-Device-Id": "@deviceId"
      }
    },
    "transport": {
      "baseUrl": "https://api.kimi.com/coding/v1/messages",
      "format": "claude",
      "urlSuffix": "?beta=true",
      "headers": {
        "X-Msh-Platform": "=aile",
        "X-Msh-Version": "@appVersion",
        "X-Msh-Device-Name": "@hostname",
        "X-Msh-Device-Model": "@deviceModel",
        "X-Msh-Device-Id": "@deviceId",
        "Anthropic-Version": "2023-06-01",
        "Anthropic-Beta": "claude-code-20250219,interleaved-thinking-2025-05-14"
      },
      "auth": {
        "combined": true,
        "header": "x-api-key",
        "scheme": "raw"
      }
    },
    "refresh": {
      "refreshLeadMs": 300000
    },
    "models": [
      "kimi-k3",
      "k3",
      "kimi-for-coding",
      "kimi-for-coding-highspeed",
      "kimi-k2.7-code",
      "kimi-k2.7-code-highspeed",
      "kimi-k2.6",
      "kimi-k2.5",
      "kimi-k2.5-thinking",
      "kimi-latest"
    ]
  },
  {
    "id": "qwen",
    "name": "Qwen Code",
    "color": "#10B981",
    "flow": "device",
    "oauth": {
      "clientId": "f0304373b74a44d2b584a3fb70ca9e56",
      "tokenUrl": "https://chat.qwen.ai/api/v1/oauth2/token",
      "deviceCodeUrl": "https://chat.qwen.ai/api/v1/oauth2/device/code",
      "scope": "openid profile email model.completion",
      "codeChallengeMethod": "S256"
    },
    "transport": {
      "baseUrl": "https://portal.qwen.ai/v1/chat/completions"
    },
    "refresh": {
      "refreshLeadMs": 1200000
    },
    "models": [
      "qwen3-coder-plus",
      "qwen3-coder-flash",
      "vision-model",
      "coder-model"
    ]
  },
  {
    "id": "xai",
    "name": "xAI (Grok)",
    "color": "#1DA1F2",
    "flow": "paste",
    "oauth": {},
    "transport": {
      "baseUrl": "https://api.x.ai/v1/chat/completions",
      "responsesUrl": "https://api.x.ai/v1/responses"
    },
    "models": [
      "grok-4",
      "grok-4-fast-reasoning",
      "grok-code-fast-1",
      "grok-3",
      "grok-2-image-1212",
      "grok-imagine-video"
    ]
  }
];

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}
