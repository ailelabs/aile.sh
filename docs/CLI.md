<!-- Generated from the aile.sh website docs. Do not edit.
     Source: apps/web/src/app/(site)/docs/cli/ in the aile monorepo. -->

# CLI

`aile.sh` signs you in, links provider accounts, sets your prices and runs your machine as a relay node. Callers do not need it, but `aile sharers`, `aile price` and `aile spend` read the same data the marketplace shows.

## Install

```bash
npm install -g aile.sh
```

Bun works too (`bun install -g aile.sh`). Requires **Node 20 or newer**. Details and uninstall: [Install the CLI](https://aile.sh/docs/share/install).

## First run

```bash
aile login      # sign in, and register this machine
aile connect    # link an AI account; a menu if you name no provider
aile capacity   # confirm what this machine now shares
aile start      # run as a relay node
```

Bare `aile` on a fresh machine starts a short first-run prompt. Once set up it shows your balance, coding tools and what you share, then a menu of next steps (Esc or `q` quits). Off a terminal it prints the summary and exits.

## How arguments are parsed

- `--key=value` is always accepted.
- `--key value` is accepted **unless** the flag is boolean. A value after a boolean flag is read as a positional argument. The boolean flags are `--insecure`, `--reset`, `--path`, `--help`, `--json`, `--paste`, `--browser`, `--off`, `--yes`, `--verified`, `--free`, `--free-only`, `--nodeless`, `--no-nodeless`, `--no-route`, `--all`, `--dry-run`, `--new-key`, `--remove`, `--revoke`, `--keep-key`, `--fast`, `--tools`, `--keep-home`, `--debug`, `--anthropic`, `--no-encrypt`, `--qr`, `--no-qr`, `--start`, `--no-start`, `--cpu`, `--force` and `--keep-base`.
- Everything else collects as positionals.

## Global options

| Flag | What it does |
|---|---|
| `--server <url>` | Use a different relay for this command. Overrides `serverUrl`. |
| `--insecure` | Permit plain `http://` for this command. Staging only. `aile start` takes only the saved `allowInsecure`. |
| `--json` | Machine-readable output, on the read commands. |
| `--yes` | Skip confirmations. |
| `--help`, `-h` | The command overview; after a command, its examples. Never runs the command or touches the network. |
| `--version`, `-v` | Print the client version. |

## How output behaves

- Colour only on a terminal (or `FORCE_COLOR`), never with `NO_COLOR`.
- Marks (✓ ✗ ❯ ●) become ASCII (`+ x > *`) where the terminal cannot draw them (`AILE_ASCII=1` forces it).
- Spinners go to stderr on a terminal only (`AILE_NO_SPINNER=1` turns them off).
- A typo gets a suggestion and exit code 1; `AILE_DEBUG=1` prints the full error.

## Where files live

`%APPDATA%\aile\` on Windows, `~/.aile/` elsewhere (override with `AILE_DATA_DIR`). It holds:

- `config.json` (permissions `0600`)
- the machine id
- the node secret

> [!NOTE]
> **Provider credentials are not on your machine**
>
> Linked provider tokens are held server-side. Nothing in this directory grants access to a provider account ([What Aile can see](https://aile.sh/docs/concepts/privacy)).

## Next

- **[Commands](./COMMANDS.md)**: every command, with its flags
- **[Configuration](./CONFIGURATION.md)**: every `aile config` key
- **[Environment](./ENVIRONMENT.md)**: the variables the client reads

---

More: [commands](./COMMANDS.md) · [configuration](./CONFIGURATION.md) · [environment](./ENVIRONMENT.md) · [full documentation](https://aile.sh/docs)
