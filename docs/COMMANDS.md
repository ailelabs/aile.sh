<!-- Generated from the aile.sh website docs. Do not edit.
     Source: apps/web/src/app/(site)/docs/cli/ in the aile monorepo. -->

# Commands

Every command the `aile` client accepts. Global options (`--server`,
`--insecure`, `--json`) are documented on the [CLI overview](./CLI.md) and are
not repeated per command.

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
```

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

This updates the **live** half of an account's status (`works` / `failing` /
`unchecked`). It cannot change the identity half. See
[Verification](https://aile.sh/docs/concepts/verification).

### usage

The quota each provider reports, per account. Aliased as `quota`.

```bash
aile usage
aile usage --json
```

### nodeless

Serve an API-key account with no machine in the path.

```bash
aile nodeless 1 on
aile nodeless 1 off
```

> [!WARNING]
> **This removes your kill switch**
>
> With nodeless on, turning your node off no longer stops the account. Only
> `aile nodeless <n> off` does. Refused for subscriptions by design. The client
> declines rather than storing a setting the server would ignore.

### rates

What you charge, and what you will not serve. Prices are per **(lender, model)**,
never per account. Two keys for one provider share one price sheet, which is why
no `rates` command takes an account number.

```bash
aile rates                                       # margin, overrides, disabled models, bounds
aile rates --margin 1.2                          # multiplier on every provider's list price
aile rates set claude-opus-5 --in 3 --out 15     # dollars per million tokens
aile rates set claude-opus-5 --model-margin 1.5  # a multiplier for one model instead
aile rates clear claude-opus-5                   # back to the global margin
aile rates off claude-opus-5                     # stop serving one model
aile rates on claude-opus-5                      # serve it again
```

| Flag | What it does |
|---|---|
| `--margin <x>` | Global multiplier on list price. `0` means **unset**, not free. |
| `--in <usd>` | Input price, dollars per million tokens (with `set`). |
| `--out <usd>` | Output price, dollars per million tokens (with `set`). |
| `--model-margin <x>` | Per-model multiplier instead of an absolute price (with `set`). |

`disabled` is kept separate from price, so clearing a price never re-enables a
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

> [!WARNING]
> **Self-hosted traffic is not blind**
>
> A local model runs on your machine, so your machine reads the prompts it answers.
> Subscription and API-key traffic are unaffected and stay blind. The client repeats
> this at `aile local`, `aile capacity`, `aile status` and `aile start`.

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

What this machine is: its id, its server, whether it is signed in, its connected
accounts, and whether the relay is running.

```bash
aile status
aile status --json
```

Reads the lock file, so it can report a relay running in another process.

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
ceiling is `quoteMaxTokens` (4096).

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
aile help
aile --help
aile -h
```

### version

```bash
aile --version
```

Also accepted as `aile version`, `-v` and `-V`.

---

More: [cli](./CLI.md) · [configuration](./CONFIGURATION.md) · [environment](./ENVIRONMENT.md) · [full documentation](https://aile.sh/docs)
