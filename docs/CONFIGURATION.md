<!-- Generated from the aile.sh website docs. Do not edit.
     Source: apps/web/src/app/(site)/docs/cli/ in the aile monorepo. -->

# Configuration

```bash
aile config                        # every setting, grouped, with * on what you changed
aile config maxConcurrent 8        # change one
aile config maxConcurrent          # show one, with its default and range
aile config --reset                # restore defaults, keeping sign-in and accounts
aile config --reset maxConcurrent  # reset just one
aile config --path                 # print the config file's location
```

The file on disk holds **overrides only**: a value equal to the default is
pruned rather than written. Every read merges your overrides over the current
defaults, which has two useful consequences: a default that changes in a later
release reaches you, and an unknown key written by a newer version survives a
downgrade.

Changes take effect on the next `aile start`.

## Where it lives

`config.json`, permissions `0600`, written write-then-rename:

- **Windows**: `%APPDATA%\aile\config.json`
- **macOS and Linux**: `~/.aile/config.json`
- Override the whole directory with `AILE_DATA_DIR`.

## Account

| Key | Default | What it does |
|---|---|---|
| `renterToken` | — | Your account token. **Read-only here**: written by `aile login`, cleared by `aile logout`, never settable through `aile config`. |

## Connection

| Key | Default | Range | What it does |
|---|---|---|---|
| `serverUrl` | `https://api.aile.sh` | — | Relay this machine connects to. Also `AILE_SERVER_URL`; `--server` beats both. |
| `allowInsecure` | `false` | — | Permit plain `http://` to the server. Staging only. |
| `maxConcurrent` | `4` | 1–64 | Streams this machine carries at once. |
| `autoReconnect` | `true` | — | Reconnect on its own after the link drops. |
| `reconnectMinMs` | `1000` | 250–60000 | Floor of the reconnect backoff. |
| `reconnectMaxMs` | `60000` | 1000–3600000 | Ceiling of the reconnect backoff. |

> [!NOTE]
> **Retired server addresses**
>
> Known-dead hosts are dropped from `serverUrl` on read rather than dialled, so an
> old install does not sit retrying an address that no longer exists. If a stale
> value is the problem, set it explicitly:
> `aile config serverUrl https://api.aile.sh`.

## Self-hosted

Lending a model running on your own machine. Off unless you turn it on; see
[Self-hosted models](https://aile.sh/docs/lend/local).

| Key | Default | What it does |
|---|---|---|
| `localEnabled` | `false` | Also lend a self-hosted model. |
| `localEndpoint` | — | OpenAI-compatible base URL. Loopback or LAN addresses only. |
| `localModels` | — | Comma-separated names to advertise. Blank asks the endpoint. |

> [!WARNING]
> **Names are forwarded verbatim**
>
> Buyers send `local/<name>`; Aile strips `local/` and passes the rest to your
> endpoint unchanged, so the names you advertise must be exactly the names your
> endpoint answers to. Advertise `llama-3` for an endpoint serving `llama3` and
> those requests will not resolve.

## Streams

| Key | Default | Range | What it does |
|---|---|---|---|
| `connectTimeoutMs` | `15000` | 1000–120000 | How long a single upstream dial may take. |
| `idleTimeoutMs` | `300000` | 10000–3600000 | How long a stream may go silent before it is dropped. |
| `maxPendingBytes` | `262144` | 16 KiB–4 MiB | Backpressure ceiling per stream. |

## Liveness

| Key | Default | Range | What it does |
|---|---|---|---|
| `pingIntervalMs` | `30000` | 5000–300000 | How often the node pings the relay. |
| `pongTimeoutMs` | `90000` | 15000–900000 | How long a missing pong is tolerated before reconnecting. |

## Requests

| Key | Default | Range | What it does |
|---|---|---|---|
| `quoteMaxTokens` | `4096` | 1–1000000 | Output ceiling `aile price` assumes. An estimate only; **never sent** with a request. |

## Output

| Key | Default | Values | What it does |
|---|---|---|---|
| `logLevel` | `info` | `silent`, `error`, `warn`, `info`, `debug` | How much `aile start` prints while running. |

> [!NOTE]
> **Nothing here widens egress**
>
> No setting can add a host to the egress allowlist. `localEndpoint` is constrained
> to loopback and LAN precisely so it cannot become one.

---

More: [cli](./CLI.md) · [commands](./COMMANDS.md) · [environment](./ENVIRONMENT.md) · [full documentation](https://aile.sh/docs)
