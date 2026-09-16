/**
 * Provider catalog — GENERATED from the aile relay's provider registry. Do not
 * hand-edit: the next regeneration overwrites this file.
 *
 * `flow` is the linking strategy, and it is what src/providers/flows.js
 * branches on. Providers that share a family need no per-provider client code.
 *
 *   authcode  browser redirect to a loopback callback, PKCE where supported
 *   device    device-authorization: show a code, poll for the token
 *   google    Google OAuth with a client secret
 *   apikey    paste a key, verified against `apiKey.verifyUrl` first
 *   paste     no programmatic flow — the user supplies a token
 *
 * `oauth` / `apiKey` is how an account is LINKED. `transport.auth` is only the
 * header the credential travels in, so a probe presents it the way the relay
 * will. Everything else about serving is the server's.
 *
 * 28 providers.
 */

export const PROVIDERS = [
  {
    "id": "antigravity",
    "name": "Antigravity",
    "flow": "google",
    "oauth": {
      "authorizeUrl": "https://accounts.google.com/o/oauth2/v2/auth",
      "tokenUrl": "https://oauth2.googleapis.com/token",
      "scopes": [
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
    }
  },
  {
    "id": "cerebras",
    "name": "Cerebras",
    "flow": "apikey",
    "apiKey": {
      "host": "api.cerebras.ai",
      "verifyUrl": "https://api.cerebras.ai/v1/models",
      "prefix": "csk-",
      "keyUrl": "https://cloud.cerebras.ai/platform/apikeys"
    },
    "transport": {
      "auth": {
        "combined": true,
        "header": "Authorization",
        "scheme": "bearer"
      }
    }
  },
  {
    "id": "claude",
    "name": "Claude Code",
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
      "auth": {
        "apiKey": {
          "header": "x-api-key",
          "scheme": "raw"
        },
        "oauth": {
          "header": "Authorization",
          "scheme": "bearer"
        }
      }
    }
  },
  {
    "id": "cline",
    "name": "Cline",
    "flow": "authcode",
    "oauth": {
      "authorizeUrl": "https://api.cline.bot/api/v1/auth/authorize",
      "tokenExchangeUrl": "https://api.cline.bot/api/v1/auth/token",
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
      "auth": {
        "combined": true,
        "header": "Authorization",
        "scheme": "bearer"
      }
    }
  },
  {
    "id": "clinepass",
    "name": "ClinePass",
    "flow": "authcode",
    "oauth": {
      "authorizeUrl": "https://api.cline.bot/api/v1/auth/authorize",
      "tokenUrl": "https://api.cline.bot/api/v1/auth/token",
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
      "auth": {
        "combined": true,
        "header": "Authorization",
        "scheme": "bearer"
      }
    }
  },
  {
    "id": "codebuddy-cn",
    "name": "CodeBuddy CN",
    "flow": "device",
    "oauth": {
      "tokenUrl": "https://copilot.tencent.com/v2/plugin/auth/token",
      "pollInterval": 5000,
      "userAgent": "CLI/2.108.1 CodeBuddy/2.108.1",
      "deviceHeaders": {
        "X-Requested-With": "=XMLHttpRequest",
        "X-Domain": "=copilot.tencent.com",
        "X-No-Authorization": "=true",
        "X-No-User-Id": "=true",
        "X-Product": "=SaaS"
      },
      "deviceStyle": {
        "initiate": {
          "url": "=https://copilot.tencent.com/v2/plugin/auth/state?platform=CLI",
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
      "auth": {
        "combined": true,
        "header": "Authorization",
        "scheme": "bearer"
      }
    }
  },
  {
    "id": "cursor",
    "name": "Cursor IDE",
    "flow": "paste",
    "oauth": {}
  },
  {
    "id": "deepseek",
    "name": "DeepSeek",
    "flow": "apikey",
    "apiKey": {
      "host": "api.deepseek.com",
      "verifyUrl": "https://api.deepseek.com/models",
      "prefix": "sk-",
      "keyUrl": "https://platform.deepseek.com/api_keys"
    },
    "transport": {
      "auth": {
        "combined": true,
        "header": "Authorization",
        "scheme": "bearer"
      }
    }
  },
  {
    "id": "fireworks",
    "name": "Fireworks AI",
    "flow": "apikey",
    "apiKey": {
      "host": "api.fireworks.ai",
      "verifyUrl": "https://api.fireworks.ai/inference/v1/models",
      "prefix": "fw_",
      "keyUrl": "https://fireworks.ai/account/api-keys"
    },
    "transport": {
      "auth": {
        "combined": true,
        "header": "Authorization",
        "scheme": "bearer"
      }
    }
  },
  {
    "id": "gemini-cli",
    "name": "Gemini CLI",
    "flow": "google",
    "oauth": {
      "authorizeUrl": "https://accounts.google.com/o/oauth2/v2/auth",
      "tokenUrl": "https://oauth2.googleapis.com/token",
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
    }
  },
  {
    "id": "github",
    "name": "GitHub Copilot",
    "flow": "device",
    "oauth": {
      "clientId": "Iv1.b507a08c87ecfe98",
      "tokenUrl": "https://github.com/login/oauth/access_token",
      "deviceCodeUrl": "https://github.com/login/device/code",
      "scope": "read:user",
      "userAgent": "GitHubCopilotChat/0.26.7"
    }
  },
  {
    "id": "gitlab",
    "name": "GitLab Duo",
    "flow": "paste",
    "oauth": {
      "scope": "api read_user",
      "codeChallengeMethod": "S256"
    }
  },
  {
    "id": "grok-cli",
    "name": "Grok CLI (Grok Build)",
    "flow": "device",
    "oauth": {
      "clientId": "b1a00492-073a-47ea-816f-4c329264a828",
      "tokenUrl": "https://auth.x.ai/oauth2/token",
      "deviceCodeUrl": "https://auth.x.ai/oauth2/device/code",
      "scope": "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write",
      "referrer": "grok-build"
    }
  },
  {
    "id": "groq",
    "name": "Groq",
    "flow": "apikey",
    "apiKey": {
      "host": "api.groq.com",
      "verifyUrl": "https://api.groq.com/openai/v1/models",
      "prefix": "gsk_",
      "keyUrl": "https://console.groq.com/keys"
    },
    "transport": {
      "auth": {
        "combined": true,
        "header": "Authorization",
        "scheme": "bearer"
      }
    }
  },
  {
    "id": "iflow",
    "name": "iFlow AI",
    "flow": "authcode",
    "oauth": {
      "clientId": "10009311001",
      "clientSecret": "4Z3YjXycVsQvyGF1etiNlIBB4RsqSDtW",
      "authorizeUrl": "https://iflow.cn/oauth",
      "tokenUrl": "https://iflow.cn/oauth/token",
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
    }
  },
  {
    "id": "kilocode",
    "name": "Kilo Code",
    "flow": "device",
    "oauth": {
      "initiateUrl": "https://api.kilo.ai/api/device-auth/codes",
      "deviceStyle": {
        "initiate": {
          "url": "=https://api.kilo.ai/api/device-auth/codes",
          "method": "POST",
          "encoding": "json",
          "body": {}
        },
        "poll": {
          "url": "=https://api.kilo.ai/api/device-auth/codes/@deviceCode",
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
      "auth": {
        "combined": true,
        "header": "Authorization",
        "scheme": "bearer"
      }
    }
  },
  {
    "id": "kimchi",
    "name": "Kimchi",
    "flow": "paste",
    "oauth": {},
    "transport": {
      "auth": {
        "combined": true,
        "header": "Authorization",
        "scheme": "bearer"
      }
    }
  },
  {
    "id": "kimi",
    "name": "Kimi",
    "flow": "device",
    "oauth": {
      "clientId": "17e5f671-d194-4dfb-9706-5516cb48c098",
      "tokenUrl": "https://auth.kimi.com/api/oauth/token",
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
      "auth": {
        "combined": true,
        "header": "x-api-key",
        "scheme": "raw"
      }
    }
  },
  {
    "id": "kiro",
    "name": "Kiro",
    "flow": "device",
    "oauth": {
      "deviceStyle": {
        "register": {
          "url": "https://oidc.us-east-1.amazonaws.com/client/register",
          "method": "POST",
          "encoding": "json",
          "body": {
            "clientName": "kiro-oauth-client",
            "clientType": "public",
            "scopes": [
              "codewhisperer:completions",
              "codewhisperer:analysis",
              "codewhisperer:conversations"
            ],
            "grantTypes": [
              "urn:ietf:params:oauth:grant-type:device_code",
              "refresh_token"
            ],
            "issuerUrl": "https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6"
          },
          "map": {
            "clientId": "clientId",
            "clientSecret": "clientSecret"
          }
        },
        "initiate": {
          "url": "=https://oidc.us-east-1.amazonaws.com/device_authorization",
          "method": "POST",
          "encoding": "json",
          "body": {
            "clientId": "@clientId",
            "clientSecret": "@clientSecret",
            "startUrl": "https://view.awsapps.com/start"
          }
        },
        "map": {
          "deviceCode": "deviceCode",
          "userCode": "userCode",
          "verificationUri": "verificationUriComplete",
          "expiresIn": "expiresIn"
        },
        "poll": {
          "url": "=https://oidc.us-east-1.amazonaws.com/token",
          "method": "POST",
          "encoding": "json",
          "body": {
            "clientId": "@clientId",
            "clientSecret": "@clientSecret",
            "deviceCode": "@deviceCode",
            "grantType": "urn:ietf:params:oauth:grant-type:device_code"
          }
        },
        "oauthErrors": true,
        "tokenField": "accessToken",
        "refreshField": "refreshToken",
        "expiresField": "expiresIn",
        "region": "us-east-1",
        "intervalMs": 5000
      }
    }
  },
  {
    "id": "mistral",
    "name": "Mistral",
    "flow": "apikey",
    "apiKey": {
      "host": "api.mistral.ai",
      "verifyUrl": "https://api.mistral.ai/v1/models",
      "keyUrl": "https://console.mistral.ai/api-keys"
    },
    "transport": {
      "auth": {
        "combined": true,
        "header": "Authorization",
        "scheme": "bearer"
      }
    }
  },
  {
    "id": "openrouter",
    "name": "OpenRouter",
    "flow": "apikey",
    "apiKey": {
      "host": "openrouter.ai",
      "verifyUrl": "https://openrouter.ai/api/v1/key",
      "prefix": "sk-or-",
      "keyUrl": "https://openrouter.ai/keys",
      "nameFrom": [
        "data",
        "label"
      ]
    },
    "transport": {
      "auth": {
        "combined": true,
        "header": "Authorization",
        "scheme": "bearer"
      }
    }
  },
  {
    "id": "qwen",
    "name": "Qwen Code",
    "flow": "device",
    "oauth": {
      "clientId": "f0304373b74a44d2b584a3fb70ca9e56",
      "tokenUrl": "https://chat.qwen.ai/api/v1/oauth2/token",
      "deviceCodeUrl": "https://chat.qwen.ai/api/v1/oauth2/device/code",
      "scope": "openid profile email model.completion",
      "codeChallengeMethod": "S256"
    }
  },
  {
    "id": "raycast",
    "name": "Raycast",
    "flow": "paste",
    "oauth": {}
  },
  {
    "id": "together",
    "name": "Together AI",
    "flow": "apikey",
    "apiKey": {
      "host": "api.together.xyz",
      "verifyUrl": "https://api.together.xyz/v1/models",
      "keyUrl": "https://api.together.xyz/settings/api-keys"
    },
    "transport": {
      "auth": {
        "combined": true,
        "header": "Authorization",
        "scheme": "bearer"
      }
    }
  },
  {
    "id": "trae",
    "name": "Trae",
    "flow": "paste",
    "oauth": {}
  },
  {
    "id": "windsurf",
    "name": "Windsurf",
    "flow": "paste",
    "oauth": {}
  },
  {
    "id": "xai",
    "name": "xAI (Grok)",
    "flow": "paste",
    "oauth": {}
  },
  {
    "id": "xai-oauth",
    "name": "xAI (Grok) OAuth",
    "flow": "authcode",
    "oauth": {
      "clientId": "b1a00492-073a-47ea-816f-4c329264a828",
      "authorizeUrl": "https://auth.x.ai/oauth2/authorize",
      "tokenUrl": "https://auth.x.ai/oauth2/token",
      "scope": "openid profile email offline_access grok-cli:access api:access",
      "codeChallengeMethod": "S256",
      "fixedPort": 56121,
      "callbackPath": "/callback",
      "extraParams": {
        "plan": "generic",
        "referrer": "cli-proxy-api"
      }
    }
  }
];

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}
