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

### retest

Ask the server to re-probe a credential. Aliased as `recheck`. With no number it
retests everything.

```bash
aile retest
aile retest 3
```

Each account prints `works`, `rejected` or `no answer` (no healthy egress to test
through), with the server's reason, e.g. `refused-on-serve` for a key a provider
refused on a real request, which a passing check cannot clear.

This updates the **live** half of an account's status (`working` / `failing` /
`unchecked`). It cannot change the identity half. See
[Verification](https://aile.sh/docs/concepts/verification).

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

Lend a model already running on this machine: Ollama, vLLM, LM Studio,
llama.cpp, anything speaking the OpenAI API.

```bash
aile local http://127.0.0.1:11434   # point at an endpoint and turn it on
aile local                          # show current state
aile local --off                    # stop lending it; the endpoint is remembered
```

| Flag | What it does |
|---|---|
| `--off` | Stop lending the local model. |
| `--endpoint <url>` | Set the endpoint without turning it on. |

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
aile wallet --json
```

The client never handles a private key. It lives in the wallet provider's
enclave. A balance that cannot be read shows as unknown, never as `$0`.

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
unset `max_tokens` or a route that sends no cap (codex) can put above `aile price`.
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
