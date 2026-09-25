# aile.sh

Lend spare AI capacity from a machine you own and get paid per request. The same
client also lets you pick which lender serves your own requests.

**Full documentation: [aile.sh/docs](https://aile.sh/docs)**

## Install

```bash
npm install -g aile.sh     # or: bun install -g aile.sh
```

Requires Node 20 or newer. Nothing else to install.

## Use aile from your coding tools

```bash
npx aile.sh setup      # finds Claude Code, Codex, opencode, … and sets each up
claudeaile             # Claude Code through aile; plain `claude` is unchanged
codexaile              # the same for Codex
```

`aile setup` opens your browser to approve an API key. That machine is not
signed in to your account, and your other machines stay signed in. Tools that
keep their settings in an app (Cursor, Cline, Continue, Zed) get the three
values to paste.

```bash
aile detect                     # which coding tools are installed, and where
aile setup claude --mode default   # make aile Claude Code's default instead
aile setup refresh --new-key    # a new key for every tool already set up
aile setup --remove             # put every file back exactly as it was
aile doctor                     # check the key, the server and each tool
```

## Start lending

```bash
aile login       # sign in through your browser
aile connect     # connect an AI account
aile start       # start earning
```

`aile login` shows a code, opens a browser, and waits for you to approve it. Your
password stays out of the terminal. Signing in registers this machine too, so
`aile start` works straight afterwards.

No browser on this box? A headless server or an SSH session is the common case.
Approve on whatever device you are reading this on and carry the token across:

```bash
aile login --paste            # approve elsewhere, paste the token here
aile login --token <token>    # for scripts, images, systemd units
```

A pasted token is checked against the server before anything reaches disk, so a
truncated copy fails in front of you. See
[Install the CLI](https://aile.sh/docs/lend/install) for the headless path in
full.

## Three kinds of capacity

```bash
aile connect codex                      # a subscription
aile connect openrouter                 # an API key, prompted and never echoed
echo $KEY | aile connect groq --key -   # the same key, from a pipe
aile local http://127.0.0.1:11434       # a model running on this machine
aile capacity                           # all three, grouped by kind
```

A **subscription** stops at its monthly ceiling. An **API key** has no ceiling:
it bills your own account per token, so a busy week arrives as an invoice. A
**local model** runs on your hardware, which means your machine reads those
prompts; buyers ask for it by name (`local/<model>`) and never receive it in
place of the other two.

Keys are checked with the provider before upload, so a bad paste fails here
rather than becoming capacity that fails on every request. Nothing signs a key,
so those accounts read `unverified` for as long as they exist. `aile accounts`
says so on the line beneath.

[Connect an account →](https://aile.sh/docs/lend/connect)

## Getting paid

```bash
aile wallet    # balance, and where earnings land
aile stats     # what each of your machines has served and earned
```

One account, one wallet, created for you at sign-in. Earnings arrive as USDC on
Solana. The private key lives in the wallet provider's secure enclave, outside
this program and off this machine.

You name a withdrawal's destination at the moment you make it, on the withdraw
page, and it is stored nowhere. No payout address sits on file, so nobody who
reaches your account can re-point your earnings in advance.

[Getting paid →](https://aile.sh/docs/lend/payouts)

## Buying

```bash
aile lenders                  # who is lending now, cheapest first
aile lenders --max-price 8    # nobody above $8 per million tokens
aile lenders --verified       # provider-attested accounts only
aile price gpt-5.2            # what one request would cost, at each rate
aile spend                    # what each lender has charged you
```

Filters combine, and each one narrows: `--verified --max-price 8` is both. An
unpinned request goes to the cheapest lender who meets your filters, with ties
broken by whoever is least busy. That is also the listing's default order, so
the top row is where your next request lands.

Five filters have a header twin on `/v1/*`, which turns a choice you make here
into one you can make per request.

A `/v1` request's `model` must be `<provider>/<model>` (`cc/claude-sonnet-5`,
`local/llama3`), or a bare id with `x-aile-provider`. A bare id alone is a 400.
`aile lenders --model` and `aile price` still take bare ids.

[Choosing a lender →](https://aile.sh/docs/buy/routing)

## What your machine can see

```
BUYER            aile.sh                  YOUR MACHINE            PROVIDER
  |                 |                          |                     |
  |-- request ----->|                          |                     |
  |                 |-- opens TLS to provider --+-------------------->|
  |                 |== opaque bytes =========>|== raw TCP =========>|
  |<-- response ----|<= opaque bytes ==========|<= raw TCP ==========|
                                        sees CIPHERTEXT ONLY
```

aile.sh terminates TLS with the provider, so your machine forwards bytes it
holds no keys for. Cryptography enforces that, not a policy you have to take on
trust. What your machine contributes is an account-bound residential egress IP.

The client dials outbound and holds the connection open. No inbound ports, no
firewall changes, and it works behind NAT and CGNAT.

A self-hosted model is the exception, and the client says so wherever that
matters: the model runs on your machine, so your machine reads those prompts.

[The privacy model →](https://aile.sh/docs/concepts/privacy) ·
[Wire protocol](docs/PROTOCOL.md)

## What the client refuses to do

- **Dial anything but a provider.** The egress allowlist is static data compiled
  into the bundle. Requests for `127.0.0.1`, `192.168.x`, `169.254.169.254` or
  any other non-provider host are refused, including when aile.sh asks.
- **Trust a hostname twice.** Targets are re-checked after DNS resolution and
  connected to by IP, so a name cannot flip to a private address between the
  check and the connect.
- **Write a provider credential to disk.** Provider tokens stay server-side,
  because the server terminates TLS with the provider and is the party that can
  use them. This machine holds its account token and node identity. A pasted API
  key is checked, uploaded, and never written here.
- **Take a setting that names a host.** No config value from you, from us, or
  from the server can point this machine at a target the allowlist does not
  already contain.

## Settings

```bash
aile config                    # every setting, and what you changed
aile config maxConcurrent 8    # change one
aile config --reset            # back to defaults, keeping your sign-in
```

The file records what you changed and nothing more, which lets a later version
improve a default for anyone who never expressed an opinion about it. Values are
checked on write, so a typo or an out-of-range number fails at the moment you
make it.

[Every setting →](https://aile.sh/docs/cli/config)

## Documentation

In this repository, so a clone carries the documentation rather than a link to it:

| | |
|---|---|
| [docs/CLI.md](docs/CLI.md) | Install, first run, how arguments are parsed |
| [docs/COMMANDS.md](docs/COMMANDS.md) | Every command, alias and flag |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every setting, default and allowed range |
| [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) | Environment variables, and how they beat config keys |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | Wire protocol, trust model, allowlist, attestation |

Those four are generated from [aile.sh/docs](https://aile.sh/docs) and rewritten
on each change, so they cannot fall behind the site. `PROTOCOL.md` is written by
hand and lives only here. Edit any of the four on the website, not in this repo.

The rest of the documentation stays online, because it describes the service
rather than this client:

| | |
|---|---|
| [Quickstart](https://aile.sh/docs/quickstart) | Sign up, install, first request |
| [Lending](https://aile.sh/docs/lend) | Connect accounts, set rates, run the node |
| [Buying](https://aile.sh/docs/buy) | Keys, models, routing, streaming, errors |
| [Pricing](https://aile.sh/docs/pricing) | Fees, discounts, who pays what |
| [Troubleshooting](https://aile.sh/docs/troubleshooting) | When something is wrong |

## Development

```bash
bun install
bun test                                    # unit + integration
bun run dev -- status                       # run from source
bun run build                               # → dist/cli.js
```

`src/providers/catalog.js` and `src/relay/provider-hosts.js` are GENERATED from
the aile relay's own provider registry and committed here — regenerate them from
that repo with `bun run scripts/build-cli-catalog.ts` (in `apps/api`), not by
hand. Both ship as static data, so neither the set of connectable accounts nor a
machine's egress policy can widen at runtime.

`src/providers/oauth-extra.js` carries the few providers the generator cannot
emit, and `src/providers/index.js` merges them with the generated catalog. That
merge can only intersect with the egress allowlist: a hand-written entry naming a
host the allowlist lacks is dropped rather than added, and a generated entry
always wins over a hand-written one with the same id.

Tests run against a sandboxed data dir (`test/setup.js`, preloaded via
`bunfig.toml`) and never touch a real `~/.aile`.

## Security

Report a vulnerability through [SECURITY.md](SECURITY.md). Please do not open a
public issue for one.

## License

MIT. See [LICENSE](LICENSE).
