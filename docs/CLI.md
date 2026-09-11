<!-- Generated from the aile.sh website docs. Do not edit.
     Source: apps/web/src/app/(site)/docs/cli/ in the aile monorepo. -->

# CLI

`aile.sh` is the client a lender installs. It signs you in, links provider
accounts, sets your prices, and runs your machine as a relay node.

Buyers do not need it. A buyer key and a base URL are enough. It is still useful
on the buying side for discovery and accounting: `aile lenders`, `aile price` and
`aile spend` read the same server-side data the marketplace page does.

## Install

```bash
npm install -g aile.sh
```

Bun works too (`bun install -g aile.sh`). Requires **Node 20 or newer**, and
nothing else.

Uninstalling is `npm uninstall -g aile.sh` plus deleting the data directory.
Nothing else on the machine is touched.

## First run

```bash
aile login      # sign in, and register this machine
aile connect    # link an AI account — a menu if you name no provider
aile capacity   # confirm what this machine now lends
aile start      # run as a relay node
```

Bare `aile` on a machine that has never signed in starts a short first-run
prompt. On a signed-in machine it is the same as `aile status`.

## How arguments are parsed

The parser is deliberately small, and has one rule that
surprises people.

- `--key=value` is always accepted.
- `--key value` is accepted **unless** the flag is boolean. The boolean flags are
  `--insecure`, `--reset`, `--path`, `--help`, `--json`, `--paste`, `--browser`,
  `--off`, `--yes`, `--verified`, `--free`, `--free-only`, `--nodeless` and
  `--no-nodeless`. A value after one of those is read as a positional argument,
  not as the flag's value.
- Everything else collects as positionals.

## Global options

These work on any command.

| Flag | What it does |
|---|---|
| `--server <url>` | Point at a different relay for this one command. Overrides `serverUrl`. |
| `--insecure` | Permit a plain `http://` server. Staging only; refused otherwise. |
| `--json` | Machine-readable output. Supported on the read commands. |
| `--help`, `-h` | Full usage text. |
| `--version`, `-v` | Print the client version. |

## Where files live

One directory, owned entirely by the client:

- **Windows**: `%APPDATA%\aile\`
- **macOS and Linux**: `~/.aile/`
- Override with `AILE_DATA_DIR`.

It holds `config.json` (permissions `0600`), the machine id, and the node secret.

> [!NOTE]
> **Provider credentials are not on your machine**
>
> Linked provider tokens are held server-side, because the relay is what terminates
> TLS with the provider. Nothing in this directory grants access to a provider
> account. See [What Aile can see](https://aile.sh/docs/concepts/privacy).

## Next

- **[Commands](./COMMANDS.md)**: every command, with its flags
- **[Configuration](./CONFIGURATION.md)**: every `aile config` key, its default and range
- **[Environment](./ENVIRONMENT.md)**: the four environment variables the client reads

---

More: [commands](./COMMANDS.md) · [configuration](./CONFIGURATION.md) · [environment](./ENVIRONMENT.md) · [full documentation](https://aile.sh/docs)
