<!-- Generated from the aile.sh website docs. Do not edit.
     Source: apps/web/src/app/(site)/docs/cli/ in the aile monorepo. -->

# Commands

Every command the `aile` client accepts. Global options (`--server`,
`--insecure`, `--json`) are documented on the [CLI overview](./CLI.md) and are
not repeated per command.

## Coding tools

### setup

Use aile from the coding tools on this machine. With no arguments it shows one
checklist of the tools installed here, each ticked, with what setup will do to
it. For Claude Code and Codex, one more row, **Also make aile the default**,
makes aile their default instead of only adding the shortcuts. Setup then gets
an API key, shows every change, and applies them after you confirm. A tool that
is not installed is not listed: name it (`aile setup droid`) to set it up
anyway, and `aile detect` lists every tool aile knows.

```bash
aile setup                         # pick from what is installed
aile setup claude codex            # just these
aile setup --all --yes             # everything found, no questions
aile setup claude --mode default   # make aile Claude Code's default, no questions
```

| Tool | What setup does |
|---|---|
| Claude Code | A `claudeaile` shortcut. With `--mode default`, it also writes `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` into `~/.claude/settings.json`. |
| Codex | A `codexaile` shortcut. With `--mode default`, it also adds an `aile` provider to `~/.codex/config.toml`. |
| opencode | Adds aile's opencode plugin and its key. |
| Factory Droid, OpenClaw | Adds aile as an extra provider, with the Claude and Codex models. |
| Qwen Code, Aider, Goose | `qwenaile`, `aideraile`, `gooseaile` shortcuts. |
| Cursor, Cline, Roo, Kilo, Continue, Zed, Windsurf (Devin Desktop), JetBrains AI Assistant, Crush, the VS Code extension | Prints the values to paste. These keep their settings inside the app. |

**The key.** If this machine is signed in, setup mints a key on that account. If
not, it opens your browser to approve one. Approving a key does not sign the
machine in, and it does not log out your other machines. A key is saved and
reused by later runs, `aile run` and `aile env`.

If the server cannot approve a key from the browser, setup offers two other ways:
sign in with your browser, after which the key is made on your account, or paste
a key from the dashboard. Signing in works like `aile login`, so it signs out your
other machines, and the option says so.

**Shortcuts** go in the first writable directory already on your PATH:

- macOS and Linux: `~/.local/bin`
- Windows: npm's `%APPDATA%\npm`, or `%LOCALAPPDATA%\Microsoft\WindowsApps`

On Windows, both `.cmd` and a Git Bash script are written. A tool installed off
PATH is started by its full path.

**Safe edits.** A file that is not plain JSON (comments, JSON5) is never
rewritten; you get the snippet instead. Every value replaced is recorded.

| Flag | What it does |
|---|---|
| `--mode <m>` | For Claude Code and Codex: `shortcut` (default), `default` or `both`. |
| `--all` | Every tool found, instead of asking. |
| `--yes` | No questions; replace another gateway's settings (restored by `--remove`). |
| `--key <key>`, `--key -` | Use an existing key, or read it from stdin. |
| `--new-key` | Mint a new key instead of reusing the saved one. |
| `--model <id>` | A default model for the tools that take one. |
| `--models all` | Give Droid and OpenClaw every model, not just Claude and Codex. |
| `--shortcut-name <n>` | Name the shortcut, when setting up one tool. |
| `--dry-run` | Show what would change. Write nothing. |

`aile setup status` shows what is set up and where. `aile setup refresh` gives
every tool already set up the current key: `--new-key` mints a new one (after
revoking a key, or signing in to another account), and `--key` uses one you have.

`aile setup --remove [tool…]` puts every file back as it was and deletes the
shortcuts. Removing every tool also forgets the key on this machine, and
`--revoke` revokes it on your account too.

Not supported yet, because they have no setting that points at another
provider: Gemini CLI (it speaks only Google's own API format), GitHub Copilot,
Amp, Kiro, Warp, Augment and Trae. `aile detect` still lists them.

**Run from inside an agent.** When setup runs inside Claude Code, Codex,
opencode or another agent, it pre-selects that tool. It also tells you that
changing that tool's settings takes effect in its next session. Whether to ask
questions is still decided by whether there is a terminal.

### detect

Which coding tools are installed here, and where. Aliased as `tools`.

```bash
aile detect
aile detect --json
```

A tool is found in any of these places:

- a command on PATH;
- a command at its installer's own location, even off PATH (`~/.local/bin`,
  `~/.opencode/bin`, `~/.claude/local`, uv and pipx tool folders, …);
- an app (Cursor, Devin Desktop, Zed, Kiro, Warp);
- an extension in VS Code, VSCodium, Cursor, Devin Desktop, Kiro or Trae
  (Cline, Roo, Kilo, Continue, Claude Code, Codex, Copilot).

Each tool's own directory variables are honoured, such as `CODEX_HOME`,
`CLAUDE_CONFIG_DIR`, `OPENCODE_INSTALL_DIR`, `VSCODE_EXTENSIONS` and
`UV_TOOL_DIR`. A config directory with nothing else is shown as a hint, not as
installed.

`--fast` skips reading versions. `--json` also reports `invoker`, the coding
agent running the command, if any.

### run

Start a tool through aile without editing anything. Everything after the tool's
name is passed to the tool unchanged.

```bash
aile run claude
aile run codex exec "fix the failing test"
aile run --model cc/claude-opus-5 aider
```

The key travels in the tool's environment, never on its command line.

### env

Print the environment `aile run` would set, for any other way of starting a tool.

```bash
eval "$(aile env claude)"
aile env --shell powershell codex
```

`--shell` takes `sh`, `fish`, `powershell` or `cmd`.

### doctor

Checks that the server answers, the key works, each shortcut is on PATH, and each
tool's config still points at aile. It also warns about shell variables that
would override those settings.

---

## Account

### login

Sign in and register this machine, in one step. Shows a code, opens your browser,
waits for approval, then stores a token with permissions `0600`. Your password
never reaches the terminal.

```bash
aile login
```

Both flows race, so the paste fallback is offered from the second one. You do not
have to wait for the browser path to fail first.

| Flag | What it does |
|---|---|
| `--paste` | Approve on another device and paste the token here. For headless boxes. |
| `--browser` | Force the browser flow. |
| `--token <t>` | Fully non-interactive. Also read from `AILE_TOKEN`. |

A pasted token is normalised (surrounding quotes, a leading `Bearer`, stray
whitespace) and screened before use: a URL, a device code, or anything under 20
or over 512 characters is rejected with a reason. It is then verified against the
server *before* it is written to disk.

### register

Register this machine against a token that was issued out of band. `aile login`
does this for you; this is the separate half, for images and provisioning.

```bash
aile register --token <token>
```

### logout

Sign out. Clears this machine's local token and relay state. **Connected accounts
stay on the server.** This does not unlink anything.

```bash
aile logout
aile logout --tools   # also take aile out of your coding tools, and revoke their key
```

The coding tools `aile setup` configured use a separate API key. It keeps working
after you sign out, so logout says so. On a terminal it asks whether to remove
aile from the tools too. Signing in as a **different** account offers to move the
tools to a key on that account (`--yes` accepts); the manual equivalent is
`aile setup refresh --new-key`.

### donate

Contribute this machine unpaid, with no account. Aliased as `contribute`.

```bash
aile donate
aile donate --yes    # skip the confirmation, for images and provisioning
```

Nothing accrues and nothing can be claimed later. A donor machine's token is the
only copy. There is no identity to prove, so the server cannot reissue it. Lose
it and the machine enrols again as a new donor.

---

## Lending

### connect

Link a provider account. With no argument you get a menu, split into
**Subscriptions** (sign in with the provider) and **API keys** (paste a key,
billed to you).

```bash
aile connect                    # menu
aile connect codex              # a specific subscription
aile connect openrouter         # an API-key provider — prompts, masked
```

| Flag | What it does |
|---|---|
| `--key <key>` | Pass the key directly. Visible in `ps`; prefer `--key -`. |
| `--key -` | Read the key from stdin. Keeps it out of the process list and shell history. |
| `--label <name>` | A human name for the account. Cosmetic; the server never routes on it. |
| `--account <key>` | An explicit key distinguishing two accounts the provider reports nothing about. |
| `--replace <n>` | Rotate the credential on an existing account instead of adding a row. |
| `--nodeless` | API-key providers only: opt in to serving with no machine in the path. |
| `--no-nodeless` | Explicitly keep the account node-only. |
| `--account-id <id>` | Cloudflare Workers AI: your account ID. Asked for when omitted at a terminal. |

Reading a key from stdin:

```bash
echo "$KEY" | aile connect groq --key -
```

Without a terminal and without `--key`, the client declines rather than hanging
on a stdin nobody is writing to.

> [!NOTE]
> **Several accounts of one provider**
>
> Personal and work subscriptions have separate quotas, so both can earn. Use
> `--label` to name them. Use `--account` when the provider identifies nothing
> itself. Without it the second link overwrites the first. Use `--replace <n>` to
> rotate a credential in place. A re-pasted API key already rotates onto its own row.

### accounts

Connected accounts, grouped by provider and numbered. The numbers are what every
other command means by `<n>`.

```bash
aile accounts
aile accounts --json
```

A machine lending only a self-hosted model will say "no accounts" here and point
you at `aile capacity`. A local model is capacity, but it is not an account.

### capacity

Everything this machine lends, separated by kind, with the privacy difference
between them spelled out.

```bash
aile capacity
aile capacity --json
```

### label

Name an account. Aliased as `rename`.

```bash
aile label 2 work-laptop
```

### models

What an account lists, and why a model does not: listed, untested, failed, can't
sell or off, each with the server's reason.

```bash
aile models 3
aile models 3 --json
```

### test

Test an account's models so they list. It runs the same test as the dashboard's
*Test* button: one small request per model on the account's own quota.

```bash
aile test 3                      # every untested model
aile test 3 gpt-5.5 gpt-5.4      # just these
aile test 3 <image model> --yes  # renders output and bills the account
aile test 3 --timeout 300        # wait up to 300 s per call (default 120)
```

Image, video and music models are tested only when named, and a lone one asks
first. More than 25 untested models asks first too; `--yes` skips it (needed off
a terminal). A timeout is not a failure: the server may still be testing, so check
`aile models` before running it again.

### check-key

Ask the server to re-probe a credential. Aliased as `retest` and `recheck`. With
no number it checks everything.

```bash
aile check-key
aile check-key 3
```

Each account prints `works`, `rejected` or `no answer` (no healthy egress to test
through), with the server's reason, e.g. `refused-on-serve` for a key a provider
refused on a real request, which a passing check cannot clear.

This updates the **live** half of an account's status (`working` / `failing` /
`unchecked`). It does not test models; `aile test` does. It cannot change the
identity half. See [Verification](https://aile.sh/docs/concepts/verification).

An API key the provider refused on a real request reads `rejected`
(`refused-on-serve`) even when the key check passes. It clears once a request on
that key succeeds, or when you re-link it.

### usage

The quota each provider reports, per account. Aliased as `quota`.

```bash
aile usage
aile usage --json
```

### nodeless

Serve an account with no machine in the path. `on` is accepted for API-key
accounts only; `off` works for any account.

```bash
aile nodeless 1 on
aile nodeless 1 off
```

> [!WARNING]
> **This removes your kill switch**
>
> With nodeless on, turning your node off no longer stops the account. Only
> `aile nodeless <n> off` does. `on` is refused for a subscription by the CLI, not
> the relay; the web dashboard can turn it on. See [Nodeless](https://aile.sh/docs/lend/nodeless).

### rates

What you charge, and what you will not serve. You set only a margin: a multiplier
on each model's published list price, `0` (free) to `1` (list). Margins are per
**(lender, model)**, never per account. Two keys for one provider share one price
sheet, which is why no `rates` command takes an account number.

```bash
aile rates                                       # margin, per-model margins, disabled models, bounds
aile rates --margin 0.9                          # 0 (free) to 1 (list price), on every model
aile rates set claude-opus-5 --model-margin 0.8  # a margin for one model
aile rates clear claude-opus-5                   # back to the global margin
aile rates off claude-opus-5                     # stop serving one model
aile rates on claude-opus-5                      # serve it again
```

| Flag | What it does |
|---|---|
| `--margin <x>` | Global multiplier on list price, `0` (free) to `1` (list). Above `1` is refused. |
| `--model-margin <x>` | Per-model multiplier on list price (with `set`), `0` to `1`. |

Dollar prices are retired, and `--in`/`--out` are refused (aile.sh 1.1.6 and later).
A per-unit model (images, audio, video, …) with a published list sells at
list × margin by default; `aile rates off <model>` stops one. A model with no
list price is not sold.

`disabled` is kept separate from price, so clearing a margin never re-enables a
model you turned off.

> [!TIP]
> **rates is not price**
>
> `aile rates` sets what **you** charge. `aile price` quotes what a request would
> **cost you** to buy. The names are deliberately different.

### disconnect

Remove a linked account, by list number or id.

```bash
aile disconnect 2
aile disconnect 2 --yes
```

### local

Download a model, run it on this machine, and lend it. Or lend a model server you
already run (vLLM, LM Studio, anything speaking the OpenAI API). See
[Self-hosted models](https://aile.sh/docs/lend/local).

```bash
aile local setup                        # one command: engine, model, test, lend
aile local                              # what is set up, and what each model sells as
aile local models [query]               # models that download and sell, and which fit here
aile local pull qwen/qwen3-8b           # download one: a curated id or an Ollama tag
aile local pull hf.co/<user>/<repo>     # any GGUF on Hugging Face (:Q8_0 picks a quant)
aile local list                         # what is downloaded
aile local run <model> "a prompt"       # talk to it; no prompt opens a chat
aile local rm <model>                   # delete one
aile local install [ollama|llamacpp]    # install an engine on its own
aile local on                           # offer it to buyers
aile local --off                        # stop lending it; the endpoint is remembered
aile local http://127.0.0.1:1234        # lend a server you already run, and turn it on
```

| Flag | What it does |
|---|---|
| `--engine <ollama\|llamacpp>` | Which engine runs the model. Default: Ollama if it is here, else llama.cpp. |
| `--model <id>` | `setup` without the model menu. |
| `--quant <name>` | A specific build, for example `Q8_0`. Default: 4-bit (`Q4_K_M`). |
| `--ctx <tokens>` | Context window. Default: the `localContext` setting (8192). |
| `--accel <cuda\|vulkan\|cpu>` | Which llama.cpp build to install. Default: picked from your GPU. |
| `--yes` | No questions: installs, downloads and lends with the defaults. |
| `--start`, `--no-start` | After `setup`, start serving, or not, without asking. |
| `--keep-base` | `rm` keeps the Ollama download an alias was made from. |
| `--off` | Stop lending the local model. |
| `--endpoint <url>` | The same as `aile local <url>`: sets the endpoint and turns lending on. |

A model sells only under an id with a published list price. The curated models
are saved under that id (Ollama's `llama3.1:8b` becomes
`meta-llama/llama-3.1-8b-instruct`), and every screen says whether a model sells,
from the server's own price check. Any other model runs here but may not sell.

The endpoint is validated before it is saved and constrained to **loopback or LAN
addresses**. A public value would turn the node into an open proxy.

Buyers send `local/<model>`. The relay strips `local/`, so your endpoint sees the
id it advertised.

> [!WARNING]
> **Self-hosted traffic is not blind**
>
> A local model runs on your machine, so your machine reads the prompts it answers.
> Subscription and API-key traffic are unaffected and stay blind. The client repeats
> this at `aile local`, `aile capacity`, `aile status` and `aile start`.

### mcp

Lend an MCP server running on this machine, declared in `mcp-servers.json` next
to your config. See [Lend via MCP](https://aile.sh/docs/lend/mcp).

```bash
aile mcp              # what is declared, and whether it can run
aile mcp check        # validate the file, print the exact argv
aile mcp test <id>    # start it here and list its tools
aile mcp path         # where mcp-servers.json lives
```

Each rented session runs in its own throwaway container. With no sandbox there is
no lending: there is no unsandboxed fallback.

> [!NOTE]
> **Using other agents' tools, or giving an agent aile's, is something else**
>
> `aile mcp` lends *your* MCP servers to the network. To **use** tools other agents
> offer, run [`aile agents`](#agents). To let an agent use models, other agents' tools
> and your balance itself, connect it to aile's remote MCP server:
>
> ```bash
> claude mcp add --transport http aile https://api.aile.sh/mcp
> ```

### start

Run this machine as a relay node. Long-running and foreground.

```bash
aile start
```

- **One node per machine.** The node id derives from the machine, so a second
  `aile start` is refused and names the running pid.
- Starting with no accounts is fine. It serves the moment one is added.
- It reconnects on its own after a drop unless `autoReconnect` is off. If the
  server permanently refuses this machine it exits non-zero, so a service manager
  sees a failure rather than a node that looks alive.
- `SIGINT` / `SIGTERM` drain in-flight streams and exit cleanly.

### status

Everything about this machine, one fact per line: its id and server, changed
settings, the API key and coding tools, the account and its balance, each
connected account and where it is served (this node, another node, nodeless or
no node), requests served, local AI and MCP, and the relay. It ends with the
next step that applies. `aile start` is suggested only for an account a node
must serve: a nodeless account is served without any machine.

```bash
aile status
aile status --json
```

Reads the lock file, so it can report a relay running in another process.
`--json` returns one object: `machine`, `server`, `config`, `signedIn`,
`account`, `accountError`, `accounts`, `served`, `balance`, `relay`, `key` (masked), `tools`,
`notSetUp` and `settingsChanged`.

### stats

What each of your machines has served and earned.

```bash
aile stats
aile stats --json
```

`status` answers "is *this* box working?"; `stats` answers "which of *my* machines
is carrying the traffic?" A machine that has served nothing is flagged, because
that is the one to look at.

### wallet

Your balance, and where earnings land. Aliased as `payout`.

```bash
aile wallet
aile wallet --qr      # with a QR code of the address, to fund it from a phone
aile wallet --json
```

Your account's wallet is custodial: its private key lives in the wallet
provider's enclave, and `aile wallet` only ever reads it. A balance that cannot be
read shows as unknown, never as `$0`.

#### wallet own

An optional second wallet whose key stays on this machine. Nothing creates it but
you, and nothing but `aile chat --pay own`, `aile pay`, `aile deposit
--from-own` and `aile wallet own send` uses it.

```bash
aile wallet own create               # new recovery phrase, shown once
aile wallet own import               # restore from a phrase (typed hidden, or piped)
aile wallet own                      # its address, USDC, SOL and a QR code
aile wallet own send 5 USDC <addr>   # send USDC or SOL from it
aile wallet own swap 0.05 SOL USDC   # turn SOL into the USDC calls are paid in
aile wallet own remove               # delete it from this machine
```

The phrase restores the same address in Phantom or Solflare
(`m/44'/501'/0'/0'`). It is encrypted with your passphrase in
`own-wallet.json` next to your config; `--no-encrypt` skips that for a
throwaway wallet. The phrase is never read from the command line, where it would
land in your shell history.

Every payment and send is checked against your cap (`walletMaxCents`, or
`--max-usd` for one command) before anything is signed.

Calls are paid in USDC, so a wallet funded with SOL needs `swap` first. It
trades through Jupiter, on mainnet, and shows the quote before signing. It keeps
0.004 SOL back for fees and rent, and refuses a route that moves the price more
than 2%.

---

## Buying

### lenders

Who is lending, and what they charge. Aliased as `market`.

```bash
aile lenders
aile lenders --model gpt-5.2
aile lenders --max-price 8
```

| Flag | What it does |
|---|---|
| `--model <m>` | Show what each lender would charge for this model. |
| `--max-price <n>` | Under this many dollars per million tokens, both directions. |
| `--verified` | Attested subscriptions only. |
| `--provider <id>` | Offering that provider. |
| `--seller <id>` | One seller, whichever of their machines is free. |
| `--node <id>` | One specific machine. |
| `--min-served <n>` | With a track record of at least this many requests. |
| `--free`, `--free-only` | With capacity free this second. |
| `--sort <k>` | `served`, `free`, `uptime` or `price`. |

Every filter is applied **by the server** and echoed back. Nothing is filtered
locally, so the CLI, the API and the web page never disagree about who is
available.

The default order is the order requests are **routed** in: cheapest
first, ties to the least-busy machine. The top row is the machine your next
request goes to. `--sort` asks for a reading order instead, and the footer then
says so.

> [!TIP]
> **Five of these have a header twin**
>
> `--max-price`, `--verified`, `--provider`, `--seller` and `--node` map to
> `x-aile-max-price`, `x-aile-verified`, `x-aile-provider`, `x-aile-lender` and
> `x-aile-node`, so a choice you make here is one you can act on in a request. See
> [Headers](https://aile.sh/docs/reference/headers). **`--seller` is the person; `--node` is the box.**

A `/v1` request's `model` must be `<provider>/<model>` (`cc/claude-sonnet-5`,
`local/llama3`), or a bare id with `x-aile-provider`, which names the provider and
sends the id upstream as written. A bare id alone is a 400, except on a key pinned
to one provider, or from Claude Code or the Codex CLI, which route it to `claude`
and `codex`. `--model` here and `aile price` still take bare ids.

### price

What one request would cost, at each lender's rate. Aliased as `quote`. Sends
nothing.

```bash
aile price claude-opus-5
aile price gpt-5.2 --max-tokens 1024
aile price gpt-5.2 --in 3000
```

| Flag | What it does |
|---|---|
| `--max-tokens <n>`, `--max <n>` | Price the next request at this output ceiling. |
| `--in <n>`, `--in-tokens <n>` | Assume this many input tokens. |
| `--lender <id>` | One seller. |
| `--node <id>` | One machine. |

Output is priced at the `max_tokens` your request **authorises**, not at the reply
that comes back. That field is the one lever you hold over your bill. The default
ceiling is `quoteMaxTokens` (4096). A key's balance is billed up to the cap sent
upstream (the model's context window when none is sent), which tools, thinking, an
unset `max_tokens` or a route that sends no cap (codex) can put above `aile price`;
so can cache writes the provider reports, which bill at up to 2x input.
An x402 payment is the quote itself: a request naming no cap is sent the one it was
priced at, and a route that sends no cap (codex) is refused.

### spend

What each lender has cost you.

```bash
aile spend
aile spend --json
```

Counted from your own served requests, so a lender who was cheap but timed out a
third of the time looks worse here than any listing can show. Keyed on the
lender's **handle**, not their machine, so their history follows them across boxes
and cannot be shed by re-enrolling a node.

### chat

Call an AI model once, from the terminal. Aliased as `ask`. To call a tool
another agent offers instead, see [`agents`](#agents).

```bash
aile chat "explain this error" --model claude/claude-sonnet-5
git diff | aile chat - --model codex/gpt-5.5 --system "review this"
aile chat "hi" --model <model> --max-tokens 800
aile chat "hi" --model <model> --anthropic      # Anthropic's format (/v1/messages)
aile chat "hi" --model <model> --pay own      # from your own wallet, no account needed
```

The price is quoted on `--max-tokens`, not on tokens used. Without the flag the
request carries your `quoteMaxTokens` setting, the same ceiling `aile price`
quotes.

`--pay` chooses who pays:

| `--pay` | Pays with |
|---|---|
| `auto` (default) | Your balance, with your API key. Your own wallet steps in only when the balance comes up short. |
| `balance` | Your balance only. A shortfall says how much and points at `aile deposit`. |
| `own` | Your own wallet, per call over x402. No API key or account is sent. |

A call quoted under the facilitator's minimum settlement ($0.0008) cannot be paid
per call and needs the balance.

### agents

Find tools other agents offer, and call one at its flat price per call. This is
the counterpart of [`mcp`](#mcp), which lends *your* tools; for an AI model, use
[`chat`](#chat).

```bash
aile agents                                     # what other agents offer, with prices and tools
aile agents summarize                           # only listings matching a word
aile agents use <listing> <tool> --task "…"     # call one tool, paid from your balance
aile agents use <listing> <tool> --task "…" --pay own          # …or from your own wallet
aile agents use <listing> <tool> --args '{"q":1}' --task "…"   # the tool's own parameters
```

`--pay` works as on [`chat`](#chat): `auto` (default), `balance` or `own`. The price
is set by the agent that lists the tool and checked against your cap before your
own wallet signs anything. The task text and arguments go to another agent, so
never send a secret you would not show a stranger.

### balance

What you can spend: your account's balance and, if you made one, the local
wallet's.

```bash
aile balance
aile balance --qr     # a QR code for each wallet's address
aile balance --json
```

### deposit

Where to add funds to your account. Aliased as `topup`.

```bash
aile deposit                    # the address to send USDC to, with a QR code to scan
aile deposit --from-own 5     # send 5 USDC from your own wallet to your account
```

`aile deposit` and `aile wallet own` draw the QR code on a terminal and leave it
out of a pipe; `--qr` and `--no-qr` decide either way. It encodes the bare
address, which every Solana wallet app scans.

USDC sent to the address counts as soon as it lands; SOL, USDT and $AILE are
converted to USDC. Off a terminal, `--from-own` needs `--yes`.

### pay

Pay any x402 endpoint from your own wallet.

```bash
aile pay https://example.com/paid
aile pay <url> --method POST --body '{"q":1}'
aile pay <url> --max-usd 0.10
```

The 402 is read, the amount checked against your cap, the payment signed, and the
request sent again. Only `exact` payments in USDC on your own wallet's network
are signed. A 402 that offers only MPP (`WWW-Authenticate: Payment`), or only
another chain such as Base, is named rather than paid; aile's own 402s always
include a Solana entry.

---

## Client

### config

Read or change settings. Aliased as `settings`. Full key reference:
[Configuration](./CONFIGURATION.md).

```bash
aile config                        # every setting, grouped, with * on what you changed
aile config maxConcurrent 8        # change one
aile config maxConcurrent          # show one, with its default and range
aile config --reset                # restore defaults, keeping sign-in and accounts
aile config --reset maxConcurrent  # reset just one
aile config --path                 # print the config file's location
```

### update

Check for and install a newer client. Aliased as `upgrade`.

```bash
aile update
aile update --yes
```

Forces a fresh registry read rather than the once-a-day cache, so "up to date" is
honest the instant you ask. On a terminal it confirms before touching a global
install; off a terminal it names the command instead of running an unattended
`npm i -g`, unless you pass `--yes`.

### help

```bash
aile help                 # every command, grouped
aile help lenders         # one command: examples and details
aile lenders --help       # the same
aile -h
```

Help runs nothing: `aile start --help` does not start a node, and
`aile lenders --help` makes no network call.

### version

```bash
aile --version
```

Also accepted as `aile version`, `-v` and `-V`.

---

More: [cli](./CLI.md) · [configuration](./CONFIGURATION.md) · [environment](./ENVIRONMENT.md) · [full documentation](https://aile.sh/docs)
