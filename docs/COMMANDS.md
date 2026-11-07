<!-- Generated from the aile.sh website docs. Do not edit.
     Source: apps/web/src/app/(site)/docs/cli/ in the aile monorepo. -->

# Commands

Every command the `aile` client accepts. Global options (`--server`, `--insecure`, `--json`) are on the [CLI overview](./CLI.md).

## Coding tools

### setup

Set up aile in the coding tools on this machine. With no arguments it shows a checklist of installed tools and what setup will do to each, gets an API key and applies the changes after you confirm. Name a tool that is not installed (`aile setup droid`) to set it up anyway. Per-tool results: [Coding tools](https://aile.sh/docs/integrations/tools).

```bash
aile setup                         # pick from what is installed
aile setup claude codex            # just these
aile setup --all --yes             # everything found, no questions
aile setup claude --mode default   # make aile Claude Code's default, no questions
```

| Tool | What setup does |
|---|---|
| Claude Code | A `claudeaile` shortcut. With `--mode default`, also writes `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` into `~/.claude/settings.json`. |
| Codex | A `codexaile` shortcut. With `--mode default`, also adds an `aile` provider to `~/.codex/config.toml`. |
| opencode | Adds aile's plugin and key. |
| Factory Droid, OpenClaw | Adds aile as a provider, with the Claude and Codex models. |
| Qwen Code, Aider, Goose | `qwenaile`, `aideraile`, `gooseaile` shortcuts. |
| Cursor, Cline, Roo, Kilo, Continue, Zed, Windsurf, JetBrains AI Assistant, Crush, VS Code extension | Prints the values to paste. |

| Flag | What it does |
|---|---|
| `--mode <m>` | For Claude Code and Codex: `shortcut` (default), `default` or `both`. |
| `--all` | Every tool found, instead of asking. |
| `--yes` | No questions; replace another gateway's settings (restored by `--remove`). |
| `--key <key>`, `--key -` | Use an existing key, or read it from stdin. |
| `--new-key` | Mint a new key instead of reusing the saved one. |
| `--model <id>` | A default model for the tools that take one. |
| `--models all` | Give Droid and OpenClaw every model, not just Claude and Codex. |
| `--auto` | Point Claude Code at `aile/auto`, which picks a model per request. With no tools named, it sets up Claude Code alone. |
| `--route <name>` | Point Claude Code (main and haiku models) and Codex at a route saved on your key. Signed in, a route the key lacks is refused. `aile/auto` and `aile/auto-claude` need no saved route; see below. |
| `--no-route` | Take that route back out of the tools you name and restore their models. |
| `--shortcut-name <n>` | Name the shortcut, when setting up one tool. |
| `--dry-run` | Show what would change. Write nothing. |

Signed in, setup mints a key on your account; otherwise it opens your browser to approve one, which does not sign the machine in or sign out your others. Shortcuts go in the first writable directory on your PATH. A file that is not plain JSON is never rewritten; you get the snippet instead.

**`aile/auto` and `aile/auto-claude`** need no saved route, and any key can use them unless it is limited to one provider. They work on Claude Code, not Codex: Codex keeps its own model, and setup says so. A route saved on your key under one of those names wins, and Codex can use that; setup can only see it when this machine is signed in. Naming only Codex with one of them is refused. Refresh keeps these names when the key changes.

`aile setup status` shows what is set up; `aile setup refresh` gives every tool the current key (`--new-key`, `--key`). A `--route` stays with its key and tools. `aile setup --remove [tool…]` restores every file and deletes the shortcuts; `--revoke` also revokes the key on your account.

### detect

Which coding tools are installed here, and where. Aliased as `tools`.

```bash
aile detect
aile detect --json
```

Finds a command on PATH or at its installer's location, an app, or an editor extension. `--fast` skips reading versions; `--json` also reports `invoker`, the coding agent running the command.

### run

Start a tool through aile without editing anything. Everything after the tool's name goes to the tool unchanged.

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

Checks that the server answers, the key works, each shortcut is on PATH and each tool's config still points at aile. Warns about shell variables that would override those settings.

---

## Account

### login

Sign in and register this machine in one step. Shows a code, opens your browser, waits for approval, then stores a token (permissions `0600`).

```bash
aile login
```

| Flag | What it does |
|---|---|
| `--paste` | Approve on another device and paste the token here. For headless boxes. |
| `--browser` | Force the browser flow. |
| `--token <t>` | Fully non-interactive. Also read from `AILE_TOKEN`. |

A pasted token is screened (a URL, a device code, or under 20 or over 512 characters is rejected) and verified before it is written. A new login signs out other machines on the account ([Install the CLI](https://aile.sh/docs/share/install)).

### register

Register this machine against a token issued out of band, for images and provisioning. `aile login` does this for you.

```bash
aile register --token <token>
```

### logout

Sign out: clears this machine's token and relay state. **Connected accounts stay on the server.**

```bash
aile logout
aile logout --tools   # also take aile out of your coding tools, and revoke their key
```

The coding tools use a separate API key that keeps working after logout. Signing in as a **different** account offers to move them to a key on that account, or run `aile setup refresh --new-key`.

### donate

Contribute this machine unpaid, with no account. Aliased as `contribute`.

```bash
aile donate
aile donate --yes    # skip the confirmation
```

Nothing accrues and nothing can be claimed later. The donor token is the only copy; lose it and the machine enrols again as a new donor.

---

## Sharing

### connect

Link a provider account. With no argument you get a menu split into **Subscriptions** and **API keys**. Full guide: [Connect an account](https://aile.sh/docs/share/connect).

```bash
aile connect                    # menu
aile connect codex              # a specific subscription
aile connect openrouter         # an API-key provider; prompts, masked
echo "$KEY" | aile connect groq --key -
```

| Flag | What it does |
|---|---|
| `--key <key>` | Pass the key directly. Visible in `ps`; prefer `--key -`. |
| `--key -` | Read the key from stdin. |
| `--label <name>` | A human name for the account. Cosmetic. |
| `--account <key>` | Tells two accounts apart when the provider reports nothing. |
| `--replace <n>` | Rotate the credential on an existing account instead of adding a row. |
| `--nodeless` | API-key providers only: serve with no machine in the path. |
| `--no-nodeless` | Keep the account node-only. |
| `--account-id <id>` | Cloudflare Workers AI: your account ID. Asked for when omitted at a terminal. |

Without a terminal and without `--key`, the client declines rather than hang. After a link it names the next step: `aile start` for a node-backed account, `aile test <n>` for a nodeless one.

### accounts

Connected accounts, grouped by provider and numbered. The numbers are what every other command means by `<n>`.

```bash
aile accounts
aile accounts --json
```

Each account shows its **route** (`this machine`, `another of your machines`, `Direct`, or `no route`) and its models counted as listed, untested, failed or can't sell. A machine sharing only a self-hosted model says "no accounts"; use `aile capacity`.

### capacity

Everything this machine shares, separated by kind, with the privacy difference spelled out.

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

What an account lists, and why a model does not: listed, untested, failed, can't sell or off, each with the server's reason.

```bash
aile models 3
aile models 3 --json
```

### test

Test an account's models so they list. It is the dashboard's *Test* button: one small request per model on the account's own quota.

```bash
aile test 3                      # every untested model
aile test 3 gpt-5.5 gpt-5.4      # just these
aile test 3 <image model> --yes  # renders output and bills the account
aile test 3 --timeout 300        # wait up to 300 s per call (default 120)
```

Image, video and music models are tested only when named and ask first, as do more than 25 untested models (`--yes` skips it; needed off a terminal). A timeout is not a failure: check `aile models`.

### check-key

Ask the server to re-probe a credential. Aliased as `retest` and `recheck`. With no number it checks everything.

```bash
aile check-key
aile check-key 3
```

Each account prints `works`, `rejected` or `no answer` (no healthy egress to test through), with the server's reason. A key refused on a real request reads `rejected` (`refused-on-serve`) until a request succeeds or you re-link. It tests no models ([Verification](https://aile.sh/docs/concepts/verification)).

### usage

The quota each provider reports, per account. Aliased as `quota`.

```bash
aile usage
aile usage --json
```

### nodeless

Serve an account with no machine in the path. `on` is accepted for API-key accounts only; `off` works for any.

```bash
aile nodeless 1 on
aile nodeless 1 off
```

> [!WARNING]
> **This removes your kill switch**
>
> With nodeless on, turning your node off no longer stops the account. Only `aile nodeless <n> off` does ([Nodeless](https://aile.sh/docs/share/nodeless#what-you-give-up)).

### rates

What you charge, and what you will not serve: a margin on each model's published list price, `0` (free) to `1` (list), per **(sharer, model)** and never per account. Full guide: [Your rates](https://aile.sh/docs/share/rates).

```bash
aile rates                                       # margin, per-model margins, disabled models, bounds
aile rates --margin 0.9                          # 0 (free) to 1 (list price), on every model
aile rates set claude-opus-5 --model-margin 0.8  # a margin for one model
aile rates clear claude-opus-5                   # back to the global margin
aile rates off claude-opus-5                     # stop serving one model
aile rates on claude-opus-5                      # serve it again
aile rates set local/llama3.1:8b --in 0.2 --out 0.6   # type a price for a self-hosted model
aile rates follow local/llama3.1:8b              # drop it: list × your margin again
aile rates off local/llama3.1:8b                 # stop serving that one tag
```

| Flag | What it does |
|---|---|
| `--margin <x>` | Global multiplier on list price, `0` (free) to `1` (list). Above `1` is refused. |
| `--model-margin <x>` | Per-model multiplier (with `set`), `0` to `1`. |
| `--in <usd>` `--out <usd>` | A typed price in dollars per million tokens, input and output, **for a self-hosted model only** (name it `local/<id>`). Both are required with `set`. Not with `--model-margin`. |
| `--cache-read <usd>` | Optional cache-read price for a typed self-hosted price. Bills at input when left out. |

A model named `local/<id>` is self-hosted: the id is sent exactly as written (case and tag kept), so `set`, `clear`, `follow`, `on` and `off` land on that one tag. `--in` and `--out` on any other model are refused before anything is sent: a subscription or API-key model sells at list × margin only. A model with no published list is not sold until you type a price for it. `aile rates` also lists your self-hosted models with their status (follows the list, your price, not offered, not sold, off) and the price a caller pays now.

> [!TIP]
> **rates is not price**
>
> `aile rates` sets what **you** charge. `aile price` quotes what a request would **cost you** to call.

### disconnect

Remove a linked account, by list number or id.

```bash
aile disconnect 2
aile disconnect 2 --yes
```

### local

Download a model, run it here and share it, or share a server you already run. Full guide: [Self-hosted models](https://aile.sh/docs/share/local).

```bash
aile local setup                        # one command: engine, model, test, share
aile local                              # what is set up, and what each model sells as
aile local models [query]               # models that download and sell, and which fit here
aile local pull qwen/qwen3-8b           # download one: a curated id or an Ollama tag
aile local pull hf.co/<user>/<repo>     # any GGUF on Hugging Face (:Q8_0 picks a quant)
aile local pull mistral:7b --in 0.1 --out 0.3   # download it and type its price (--cache-read optional)
aile local list                         # what is downloaded
aile local run <model> "a prompt"       # talk to it; no prompt opens a chat
aile local rm <model>                   # delete one
aile local install [ollama|llamacpp]    # install an engine on its own
aile local on                           # offer it to callers
aile local --off                        # stop sharing it; the endpoint is remembered
aile local http://127.0.0.1:1234        # share a server you already run, and turn it on
```

| Flag | What it does |
|---|---|
| `--engine <ollama\|llamacpp>` | Which engine runs the model. Default: Ollama if it is here, else llama.cpp. |
| `--model <id>` | `setup` without the model menu. |
| `--quant <name>` | A specific build, for example `Q8_0`. Default: 4-bit (`Q4_K_M`). |
| `--file <name>` | llama.cpp only: exactly this file from the Hugging Face repo (its name or path; any part of a split model). Where a repo has two files at one quant, `pull` takes the plain one and names the others. |
| `--ctx <tokens>` | Context window, at least 2048. Default: the `localContext` setting (8192). |
| `--accel <cuda\|vulkan\|cpu>` | Which llama.cpp build to install. Default: picked from your GPU. `--cpu` is `--accel cpu`. |
| `--yes` | No questions: installs, downloads and shares with the defaults. |
| `--start`, `--no-start` | After `setup`, start serving, or not, without asking. |
| `--keep-base` | `rm` keeps the Ollama download an alias was made from. |
| `--off` | Stop sharing the local model. |
| `--endpoint <url>` | The same as `aile local <url>`: sets the endpoint and turns sharing on. |

> [!WARNING]
> **Self-hosted traffic is not blind**
>
> A local model runs on your machine, so your machine reads the prompts it answers ([Self-hosted models](https://aile.sh/docs/share/local)).

### mcp

Share an MCP server running on this machine, declared in `mcp-servers.json` next to your config. See [Share via MCP](https://aile.sh/docs/share/mcp).

```bash
aile mcp              # what is declared, and whether it can run
aile mcp check        # validate the file, print the exact argv
aile mcp test <id>    # start it here and list its tools
aile mcp path         # where mcp-servers.json lives
```

Each caller session runs in its own throwaway container; with no sandbox there is no sharing. `aile mcp` shares *your* servers. To **use** other agents' tools, run [`aile agents`](#agents); to give an agent aile's own tools, connect it to the remote server: `claude mcp add --transport http aile https://api.aile.sh/mcp`.

### start

Run this machine as a relay node. Long-running and foreground. See [Run the node](https://aile.sh/docs/share/node).

```bash
aile start
```

- One node per machine; a second `aile start` is refused. No accounts is fine.
- It reconnects after a drop unless `autoReconnect` is off, and exits non-zero if the server permanently refuses the machine.
- A plain `http://` server (other than `localhost`/`127.0.0.1`) needs the saved `aile config allowInsecure true`; `--insecure` does not apply.
- `SIGINT` and `SIGTERM` drain in-flight streams and exit cleanly.

### status

Everything about this machine, one fact per line, ending with the next step that applies.

```bash
aile status
aile status --json
```

`--json` returns one object: `machine`, `server`, `config`, `signedIn`, `account`, `accountError`, `accounts`, `served`, `balance`, `relay`, `key` (masked), `tools`, `notSetUp` and `settingsChanged`.

### stats

What each of your machines has served and earned.

```bash
aile stats
aile stats --json
```

`status` answers "is *this* box working?"; `stats` answers "which of *my* machines is carrying the traffic?" A machine that has served nothing is flagged.

### wallet

Your balance, and where earnings land. Aliased as `payout`.

```bash
aile wallet
aile wallet --qr      # with a QR code of the address, to fund it from a phone
aile wallet --json
```

Your account's wallet is custodial and `aile wallet` only reads it. An unreadable balance shows as unknown, never `$0`; **Owed**, **Spendable** and **Incoming** appear where they apply ([Getting paid](https://aile.sh/docs/share/payouts)).

#### wallet own

An optional second wallet whose key stays on this machine. Only `aile chat --pay own`, `aile pay`, `aile deposit --from-own` and `aile wallet own send` use it.

```bash
aile wallet own create               # new recovery phrase, shown once
aile wallet own import               # restore from a phrase (typed hidden, or piped)
aile wallet own                      # its address, USDC, SOL and a QR code
aile wallet own send 5 USDC <addr>   # send USDC or SOL from it
aile wallet own swap 0.05 SOL USDC   # turn SOL into the USDC calls are paid in
aile wallet own remove               # delete it from this machine
```

The phrase restores the same address in Phantom or Solflare (`m/44'/501'/0'/0'`). It is encrypted with your passphrase in `own-wallet.json` next to your config (`--no-encrypt` skips that) and is never read from the command line. Every payment is checked against your cap (`walletMaxCents`, or `--max-usd`) before signing. `swap` trades through Jupiter on mainnet, shows the quote first, keeps 0.004 SOL back for network fees and account minimums, and refuses a route that moves the price more than 2%.

---

## Calling

### sharers

Who is sharing, and what they charge. Aliased as `market` (old name `lenders`).

```bash
aile sharers
aile sharers --model gpt-5.2
aile sharers --max-price 8
```

| Flag | What it does |
|---|---|
| `--model <m>` | Show what each sharer would charge for this model. |
| `--max-price <n>` | Under this many dollars per million tokens, both directions. |
| `--verified` | Attested subscriptions only. |
| `--provider <id>` | Offering that provider. |
| `--seller <id>`, `--sharer <id>` | One sharer, whichever of their machines is free (old name `--lender`). |
| `--node <id>` | One specific machine. |
| `--min-served <n>` | With a track record of at least this many requests. |
| `--free`, `--free-only` | With capacity free this second. |
| `--sort <k>` | `served`, `free`, `uptime` or `price`. |

The server applies every filter. The default order is the order requests are **routed** in, cheapest first; `--sort` asks for a reading order instead.

> [!TIP]
> **Five of these have a header twin**
>
> `--max-price`, `--verified`, `--provider`, `--seller` and `--node` map to `x-aile-max-price`, `x-aile-verified`, `x-aile-provider`, `x-aile-sharer` (old name `x-aile-lender`) and `x-aile-node` ([Headers](https://aile.sh/docs/reference/headers#request-headers)). **`--seller` is the person; `--node` is the box.**

A `/v1` request names its provider: `<provider>/<model>` or a bare id with `x-aile-provider`; a bare id on a key with no pin acts as `auto/<model>` ([Model names](https://aile.sh/docs/buy/models)). `--model` here and `aile price` take bare ids.

### price

What one request would cost, at each sharer's rate. Aliased as `quote`. Sends nothing.

```bash
aile price claude-opus-5
aile price gpt-5.2 --max-tokens 1024
aile price gpt-5.2 --in 3000
```

| Flag | What it does |
|---|---|
| `--max-tokens <n>`, `--max <n>` | Price the next request at this output ceiling. |
| `--in <n>`, `--in-tokens <n>` | Assume this many input tokens. |
| `--sharer <id>` | One sharer (old `--lender` still works). |
| `--node <id>` | One machine. |

Output is priced at the `max_tokens` your request authorises (default `quoteMaxTokens`, 4096), not at the reply. The charge can exceed the quote when no cap is sent ([`max_tokens` is the lever you hold](https://aile.sh/docs/buy/spend#max_tokens-is-the-lever-you-hold)).

### spend

What each sharer has cost you.

```bash
aile spend
aile spend --json
```

Counted from your own served requests, keyed on the sharer's **handle** so their history follows them across machines.

### chat

Call an AI model once, from the terminal. Aliased as `ask`. For another agent's tool, see [`agents`](#agents).

```bash
aile chat "explain this error" --model claude/claude-sonnet-5
git diff | aile chat - --model codex/gpt-5.6-sol --system "review this"
aile chat "hi" --model <model> --max-tokens 800
aile chat "hi" --model local/llama3.1:8b --max-price 2   # most to pay, dollars per million tokens
aile chat "hi" --model <model> --anthropic      # Anthropic's format (/v1/messages)
aile chat "hi" --model <model> --pay own      # from your own wallet, no account needed
```

The price is quoted on `--max-tokens` (default `quoteMaxTokens`), not on tokens used. `--max-price <usd>` sends `x-aile-max-price`: the most a call may pay per million tokens, input or output. A `local/` (self-hosted) model needs it, because its sharer sets the price, unless your key carries a self-hosted ceiling (`aile keys set --local-max-price 2`) or, for a model with a published list price, a cost cap (**Max cost per request** in its Routing settings).

| `--pay` | Pays with |
|---|---|
| `auto` (default) | Your balance, with your API key. Your own wallet steps in only when the balance comes up short. |
| `balance` | Your balance only. A shortfall says how much and points at `aile deposit`. |
| `own` | Your own wallet, per call over x402. No API key or account is sent. |

Per call, a quote under the facilitator's settlement minimum is charged that minimum.

### agents

Find tools other agents offer and call one at its flat price per call. This is the counterpart of [`mcp`](#mcp); for an AI model, use [`chat`](#chat).

```bash
aile agents                                     # what other agents offer, with prices and tools
aile agents summarize                           # only listings matching a word
aile agents use <listing> <tool> --task "…"     # call one tool, paid from your balance
aile agents use <listing> <tool> --task "…" --pay own          # …or from your own wallet
aile agents use <listing> <tool> --args '{"q":1}' --task "…"   # the tool's own parameters
```

`--pay` works as on [`chat`](#chat). The task and arguments go to another agent, so never send a secret you would not show a stranger.

### council

Ask 2 to 4 models one question, and have one more merge the answers and say where they agree and differ. It spends from this machine's API key (there is no `--key`); `aile setup` makes one.

```bash
aile council "which index?" --members claude/claude-sonnet-5-5,codex/gpt-6.1-sol
git diff | aile council - --members <a>,<b> --system "review this"
aile council "…" --members <a>,<b>,<c> --synthesizer <d> --max-tokens 800
```

Each member and the merge is a separate paid call from your balance, quoted on its `--max-tokens`, not on tokens used. Only calls that served are charged, and the output lists each model's cost and the total. Stopping the command does not stop calls already made.

| Flag | What it does |
|---|---|
| `--members <a>,<b>` | 2 to 4 models, each as `<provider>/<model>`. Required. |
| `--synthesizer <m>` | The model that merges. Default: the first member. |
| `--max-tokens <n>` | Output ceiling for each member. Default: your `quoteMaxTokens`. |
| `--synthesizer-max-tokens <n>` | Output ceiling for the merge. Default: twice `--max-tokens`, at most 32,000. |
| `--system <text>` | A system prompt for the members. |
| `--temperature <n>` | Members only. |
| `--deadline <seconds>` | The limit on the whole call, 10 to 110. Default 110. Members get 60% of it and are cut unpaid after that. |
| `--json` | The result as JSON. |

### keys

Your API keys and their routes, and a draft auto route for one of them. Needs `aile login`.

```bash
aile keys                       # every key, with its routes
aile keys suggest               # a draft route for this machine's key
aile keys suggest --key work    # for another key, by id, name or prefix
aile keys set --local-max-price 2           # this machine's key: self-hosted calls may pay up to $2 per million tokens
aile keys set --key work --local-max-price none   # remove it
aile keys set --allow-local no              # keep this key off self-hosted models (also removes the ceiling)
```

`set` changes one key's routing rules and keeps every other rule as it is. `--local-max-price <usd>` is **Max price for self-hosted models**: it covers every self-hosted call made with the key, so a tool that cannot send a header can call a `local/` model, and it never limits provider-served models. `--allow-local no|yes` is **Allow self-hosted models**; a key cannot hold both the ceiling and `no`, so `no` removes the ceiling and says so.

`suggest` picks a light, a standard and a heavy model from what is listed, and shows each one's price and facts. It saves nothing: save the route on your key in the dashboard, then use it with `aile setup --route <name>`.

### route

Which models and sharers a request would try, in order, without making it. Nothing is sent or charged. Needs `aile login`.

```bash
aile route aile/auto
aile route fast "fix this test" --tier heavy
aile route aile/auto --tools --format messages --data deny
```

It takes a route name, `aile/auto`, or `<provider>/<model>`, and shows the tier and why, each target in try order, the sharers removed, the first one tried, and any refusal. It exits 0 when the server planned the request, even if a real one would be refused, and 1 when the server turns down the dry run itself (a bad name, or `aile/auto` on `--format responses` or a key limited to one provider).

| Flag | What it does |
|---|---|
| `--key <id, name or prefix>` | Which key. Default: this machine's. |
| `--format <f>` | `chat` (default), `messages` or `responses`. |
| `--tier <t>` | Force an auto route's tier: `light`, `standard` or `heavy`. |
| `--data <d>` | `allow` or `deny`, as `x-aile-data-collection`. |
| `--tools` | A request that declares a tool. |
| `--json` | The server's answer as JSON. |

### balance

What you can spend: your account's balance and, if you made one, the local wallet's.

```bash
aile balance
aile balance --qr     # a QR code for each wallet's address
aile balance --json
```

### deposit

Where to add funds to your account. Aliased as `topup`. Assets and fees: [Adding funds](https://aile.sh/docs/app/wallet#adding-funds).

```bash
aile deposit                    # the address to send USDC to, with a QR code to scan
aile deposit --from-own 5     # send 5 USDC from your own wallet to your account
```

The QR code is drawn on a terminal and left out of a pipe; `--qr` and `--no-qr` override. Off a terminal, `--from-own` needs `--yes`.

### pay

Pay any x402 endpoint from your own wallet.

```bash
aile pay https://example.com/paid
aile pay <url> --method POST --body '{"q":1}'
aile pay <url> --max-usd 0.10
```

The amount is checked against your cap before the payment is signed. Only `exact` USDC payments on your wallet's network are signed; a 402 offering only MPP or only Base is named, not paid.

---

## Client

### config

Read or change settings. Aliased as `settings`. Keys: [Configuration](./CONFIGURATION.md).

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

Off a terminal it names the command instead of running it, unless you pass `--yes`.

### help

```bash
aile help                 # every command, grouped
aile help sharers         # one command: examples and details (same as aile sharers --help)
```

Help runs nothing and makes no network call.

### version

```bash
aile --version
```

Also accepted as `aile version`, `-v` and `-V`.

---

More: [cli](./CLI.md) · [configuration](./CONFIGURATION.md) · [environment](./ENVIRONMENT.md) · [full documentation](https://aile.sh/docs)
