<!-- Generated from the aile.sh website docs. Do not edit.
     Source: apps/web/src/app/(site)/docs/cli/ in the aile monorepo. -->

# Environment variables

The client reads four variables in normal use; the rest change how it prints, reach a relay behind Cloudflare Access, or matter for one provider.

| Variable | Effect |
|---|---|
| `AILE_SERVER_URL` | Default relay server. Overridden by the `serverUrl` config key if set, and by `--server` always. |
| `AILE_DATA_DIR` | Override the whole state directory (`config.json`, machine id, node secret). |
| `AILE_TOKEN` | Account token for `aile login` and `aile register`. The non-interactive path. |
| `AILE_NO_UPDATE_CHECK` | Set to `1` to silence the "newer version available" notice. `NO_UPDATE_NOTIFIER` and `CI` do the same. |

## Precedence

For the server address, weakest to strongest:


1. The built-in default, `https://api.aile.sh`.
2. `AILE_SERVER_URL`.
3. The `serverUrl` key in `config.json`.
4. `--server <url>` on the command line (per command, writes nothing).


## Non-interactive setup

Enough to bring up a sharer node in an image or provisioning script:

```bash
export AILE_TOKEN="…"
export AILE_NO_UPDATE_CHECK=1

aile register          # enrol this machine against the token
aile connect groq --key -   # feed the provider key on stdin
aile start
```

> [!TIP]
> **Keep the key off the process list**
>
> `--key -` reads stdin, so the key never appears in `ps` or shell history. `--key <value>` is visible to any process that can read the process table.

## Machine label

The client sends this machine's hostname so the approval page can tell you which box is asking. To withhold it:

```bash
AILE_NO_MACHINE_LABEL=1 aile login
```

## Output

| Variable | Effect |
|---|---|
| `NO_COLOR` | No colour, whatever its value (unless empty). Beats `FORCE_COLOR`. |
| `FORCE_COLOR` | Colour even off a terminal, unless it is `0` or empty. |
| `AILE_ASCII` | Set to `1` for plain ASCII marks instead of ✓ ✗ ❯ ●. |
| `AILE_NO_SPINNER` | Set to `1` to turn off spinners. |
| `AILE_DEBUG` | Set to `1` to print the full error behind a one-line failure message. |

## Self-hosted models

Read by `aile local` and, for an engine aile manages, `aile start`.

| Variable | Effect |
|---|---|
| `HF_TOKEN` | Hugging Face token for a gated or private repo. Sent only to huggingface.co, never saved. |
| `OLLAMA_HOST` | Where Ollama listens, as Ollama reads it. `0.0.0.0` is reached on `127.0.0.1`. |
| `OLLAMA_MODELS` | Ollama's model folder, used for the free-disk check. |
| `AILE_LLAMA_SERVER_BIN` | Use your own `llama-server` build instead of the pinned download. |
| `AILE_HF_URL` | A Hugging Face mirror (https). |
| `AILE_LLAMACPP_URL` | A mirror for the pinned llama.cpp downloads. Each is still checked against its sha256. |
| `AILE_LOCAL_NO_INSTALL` | Set to `1` to refuse installing Ollama. llama.cpp is unaffected. |
| `AILE_LOCAL_HW` | JSON that replaces detected hardware, for a GPU the probes miss: `{"vramBytes": 24000000000, "accel": "cuda"}`. |

## Your own wallet

Read only by `aile wallet own`. The first two are the environment form of config keys; a value set with `aile config` wins over them.

| Variable | Effect |
|---|---|
| `AILE_SOLANA_RPC` | Solana RPC URL, for example `https://solana-mainnet.g.alchemy.com/v2/<key>`. Same as `solanaRpc`. |
| `AILE_SOLANA_NETWORK` | `mainnet` or `devnet`. Same as `walletNetwork`. |
| `AILE_WALLET_PASSPHRASE` | Unlocks an encrypted own wallet without a prompt, for scripts. `--passphrase` does the same for one command. |
| `JUPITER_API_KEY` | A Jupiter API key for `aile wallet own swap`, sent only to Jupiter. Optional. |
| `AILE_JUPITER_URL` | Another Jupiter API base URL (default `https://api.jup.ag`). |

The client reads no `.env` file. To keep an RPC key out of your shell profile, run `aile config solanaRpc <url>`; `config.json` is readable by you only and `aile config` prints the value masked.

## Cloudflare Access

For a relay you run behind Cloudflare Access. The client sends both as service-token headers on every call, and neither unless both are set. The public aile.sh relay never asks for them. Environment only, never `config.json`.

| Variable | Effect |
|---|---|
| `CF_ACCESS_CLIENT_ID` | Service token client id. |
| `CF_ACCESS_CLIENT_SECRET` | Service token client secret. |

## GitLab Duo

Consulted only when linking that provider, which needs an OAuth client of your own:

| Variable | Effect |
|---|---|
| `GITLAB_DUO_OAUTH_CLIENT_ID` | OAuth client id. |
| `GITLAB_DUO_OAUTH_CLIENT_SECRET` | OAuth client secret. |
| `GITLAB_DUO_BASE_URL` | Base URL for a self-managed GitLab instance. |

Without a client id configured on the relay, GitLab Duo models are hidden from `GET /v1/models`.

---

More: [cli](./CLI.md) · [commands](./COMMANDS.md) · [configuration](./CONFIGURATION.md) · [full documentation](https://aile.sh/docs)
