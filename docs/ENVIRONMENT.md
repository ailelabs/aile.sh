<!-- Generated from the aile.sh website docs. Do not edit.
     Source: apps/web/src/app/(site)/docs/cli/ in the aile monorepo. -->

# Environment variables

The client reads four variables in normal use. A few more change only how it
prints, two reach a relay behind Cloudflare Access, and three matter for one
provider.

| Variable | Effect |
|---|---|
| `AILE_SERVER_URL` | Default relay server. Overridden by the `serverUrl` config key only if that key is explicitly set, and by `--server` always. |
| `AILE_DATA_DIR` | Override the whole state directory (`config.json`, machine id, node secret). |
| `AILE_TOKEN` | Account token for `aile login` and `aile register`. The non-interactive path. |
| `AILE_NO_UPDATE_CHECK` | Set to `1` to silence the "newer version available" notice. `NO_UPDATE_NOTIFIER` and `CI` do the same. |

## Precedence

For the server address, from weakest to strongest:


1. The built-in default, `https://api.aile.sh`.
2. `AILE_SERVER_URL`.
3. The `serverUrl` key in `config.json`.
4. `--server <url>` on the command line.


`--server` is per-invocation and writes nothing, so it is the right way to point
one command at a staging relay without disturbing the machine's configuration.

## Non-interactive setup

This is enough to bring up a lender node in an image or a provisioning script with no
terminal interaction:

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
> `--key -` reads from stdin, so the provider key never appears in `ps` output or
> in shell history. `--key <value>` is accepted but visible to any process on the
> box that can read the process table.

## Machine label

By default the client sends this machine's hostname so the approval page can tell
you which box is asking. To withhold it:

```bash
AILE_NO_MACHINE_LABEL=1 aile login
```

The approval page then identifies the request only by its code.

## Output

| Variable | Effect |
|---|---|
| `NO_COLOR` | No colour, whatever its value (unless empty). Beats `FORCE_COLOR`. |
| `FORCE_COLOR` | Colour even off a terminal, unless it is `0` or empty. |
| `AILE_ASCII` | Set to `1` for plain ASCII marks instead of ✓ ✗ ❯ ●. |
| `AILE_NO_SPINNER` | Set to `1` to turn off spinners. |
| `AILE_DEBUG` | Set to `1` to print the full error behind a one-line failure message. |

## Cloudflare Access

For a relay you run behind Cloudflare Access. The client sends both as Access's
service-token headers on every call to the relay, and sends neither unless both
are set. The public aile.sh relay should never ask for them. They are read from the
environment only, never from `config.json`.

| Variable | Effect |
|---|---|
| `CF_ACCESS_CLIENT_ID` | Service token client id. |
| `CF_ACCESS_CLIENT_SECRET` | Service token client secret. |

## GitLab Duo

These are consulted only when linking that one provider, which needs an OAuth client of
your own:

| Variable | Effect |
|---|---|
| `GITLAB_DUO_OAUTH_CLIENT_ID` | OAuth client id. |
| `GITLAB_DUO_OAUTH_CLIENT_SECRET` | OAuth client secret. |
| `GITLAB_DUO_BASE_URL` | Base URL for a self-managed GitLab instance. |

Without a client id configured on the relay, GitLab Duo models are hidden from
`GET /v1/models` rather than advertised and then failing.

---

More: [cli](./CLI.md) · [commands](./COMMANDS.md) · [configuration](./CONFIGURATION.md) · [full documentation](https://aile.sh/docs)
