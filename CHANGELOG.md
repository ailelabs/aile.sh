# Changelog

Notable changes to the `aile.sh` client. This file is what `aile update` points
you at when it offers a newer version.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html): a
major bump is a break in the CLI surface, a minor bump adds a command or a flag,
a patch bump fixes something.

## [Unreleased]

## [1.1.0] - 2026-09-25

### Added

- `aile setup` — use aile from the coding tools on this machine in one step. It
  finds what is installed, gets an API key (on this account if signed in,
  otherwise by approving it in the browser — which neither signs the machine in
  nor logs out your other machines), shows what it will change, and applies it.
  - Claude Code and Codex get shortcuts, `claudeaile` and `codexaile`, and their
    usual commands stay as they were. `--mode default` makes aile their default
    instead (`~/.claude/settings.json`, `~/.codex/config.toml`), and
    `--mode both` does both. Claude Code's `/model` lists every Claude model
    aile serves (`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`).
  - opencode gets aile's plugin. Factory Droid and OpenClaw get aile as an
    extra provider. Qwen Code, Aider and Goose get shortcuts.
  - Cursor, Cline, Roo Code, Kilo Code, Continue, Zed, Windsurf, Crush and the
    Claude Code VS Code extension keep their settings in the app, so setup
    prints the values to paste.
  - Shortcuts work in bash, zsh, fish, cmd, PowerShell and Git Bash.
  - Files that are not plain JSON are never rewritten. Every value replaced is
    recorded, and `aile setup --remove` puts each file back as it was.
- `aile setup status`, `aile setup refresh [--new-key | --key <key>]` (a new
  key for every tool already set up), `aile setup --dry-run`, and
  `aile setup --remove [--revoke]`.
- `aile detect` lists the coding tools installed here, and where:
  - commands on PATH, and at installer locations off it (`~/.local/bin`,
    `~/.opencode/bin`, uv and pipx tool folders, …);
  - apps;
  - extensions in VS Code, VSCodium, Cursor, Devin Desktop, Kiro and Trae;
  - each tool's own directory variables;
  - versions.

  It also names the tools setup cannot use yet: Gemini CLI, GitHub Copilot,
  Amp, Kiro, Warp, Augment and Trae. Run from inside a coding agent, setup
  pre-selects that agent and says its new settings take effect in its next
  session.
- `aile run <tool>` starts Claude Code, Codex, Qwen Code, Aider or Goose
  through aile without editing anything. `aile env <tool>` prints the same
  environment for any other launcher.
- `aile doctor` checks the server, the key and each configured tool.
- Signing in as a different account offers to move the tools' key to it.
  `aile logout` says when the tools still use aile, and `--tools` also removes
  it from them.
- The first run offers the coding-tools setup first.
- `aile status --json`: the overview as one object.

### Changed

- Help is two levels. `aile --help` fits one screen, grouped by what you are
  doing. `aile <command> --help` (or `aile help <command>`) gives that command's
  examples and details. Help never runs the command and never touches the
  network.
- Bare `aile` on a machine that is set up in any way shows an overview in three
  parts: this machine, coding tools, lending. It ends with the next step. In a
  terminal it then offers a menu. A machine that only buys no longer gets the
  first-run welcome again.
- Output looks the same across commands: one set of success, warning and
  failure marks, and a spinner while waiting on the network (stderr, terminal
  only). Tables and menus fit the window. Where the console cannot draw ✓ ❯ ●,
  plain ASCII is used; `AILE_ASCII=1` forces it.
- A failure is one sentence and what to do about it, not a stack trace;
  `AILE_DEBUG=1` shows the trace. An unreachable server is named. An expired
  sign-in says to run `aile login`.
- A mistyped command suggests the one it was close to, and exits 1.
- Esc or `q` leaves a menu. The notes in a menu line up.
- `aile start` says where it is connecting and how to check on it. A server it
  cannot reach is named, not reported as "websocket error".
- Confirmation prompts ask the same way everywhere, and a "no" says
  "Nothing changed."

### Fixed

- `aile update` on Windows: npm is a batch file, which Node refuses to start
  without a shell, so the update never ran. It also waits longer for the
  registry when you asked for the update.
- `aile login` no longer crashes on a Linux machine with no browser opener
  (`xdg-open`), such as a server or a container. It prints the URL, as it
  always meant to.
- On the sign-in screen, `c` copies the URL shown, not a different page.
- `aile wallet` links to the withdraw page on the website, not the API host.
- Contributing from the first-run menu no longer prints the banner twice.
- A menu row wider than the window left torn copies of the menu on each
  keypress.
- `aile status` no longer counts the saved API key as a changed setting.
- `aile logout` on a machine that was not signed in says so.
- `aile connect` ends with `aile start` when nothing is serving yet.

## [1.0.1]

Never published on its own; these changes ship in 1.1.0.

### Changed

- The provider catalog and the node egress allowlist are generated from the aile
  relay's own provider registry rather than vendored from a third-party one, so a
  correction made server-side now reaches this client. Nothing changes about what
  you can lend: the same 23 providers link, by the same flows.
- `aile rates --margin` and `--model-margin` take 0 (free) to 1 (list price).
  Anything else is refused before it reaches the server, which no longer sells
  above retail. A per-model `--in`/`--out` above list is refused by the server.
- `aile rates` tells a margin you set to 0 (free) from one you never set.
- `aile lenders` and `aile --help` say a `/v1` model must name its provider:
  `<provider>/<model>`, or a bare id with `x-aile-provider`. A bare id is a 400.
  `x-aile-provider` now names the provider rather than only filtering lenders.
- `aile local` shows self-hosted models as buyers address them, `local/<model>`,
  and so does `aile capacity` when nothing is lent yet. The node still
  advertises the raw id.
- `scripts/live-blindness-probe.js` sends `openai/gpt-4o`, not a bare id.

### Added

- `raycast`, `trae` and `windsurf` appear in `aile connect` under "not yet
  supported". They need a manual token, like `cursor` and `gitlab` already did.

### Fixed

- `aile connect antigravity` no longer requests Google's `openid` scope, which
  was routing consent into a first-party screen that hangs. The account links;
  the trade is that it is no longer attested.

### Removed

- The credential probe for GitHub Copilot, Gemini CLI and iFlow. Google's
  answered 200 for any live token, so it could not fail; iFlow's only
  authenticates with the token in the query string and was never sent that way.
  A probe that cannot say no was telling you nothing.

## [1.0.0]

First published release. The CLI surface below is now stable, and a break in it
means a 2.0.0.

### Lending

- `aile login` signs in through a browser and registers the machine in one step.
  `--paste` and `--token` sign in where there is no browser, and plain
  `aile login` falls back to `--paste` on its own when the browser flow fails.
- `aile donate` contributes a machine with no account and no sign-up. Buyers pay
  the usual rate; you donate the earnings rather than the price.
- `aile connect` links a provider account: an OAuth subscription, an API key
  (prompted and masked, or piped with `--key -`), or a model already running on
  your machine through `aile local`.
- `aile connect --nodeless` lets an API key serve while the machine is off. This
  removes the node-side kill switch, so only `aile nodeless <n> off` stops it.
- `aile accounts`, `aile label`, `aile retest`, `aile usage` and `aile disconnect`
  manage what is connected. Several accounts of one provider are supported
  through `--label` and `--account`.
- `aile capacity` groups by what you lend rather than by provider, because a plan
  ceiling, a metered invoice and a machine that reads prompts stop for different
  reasons.
- `aile rates` sets a margin or a per-model price, and takes a model off sale.
- `aile mcp` lends an MCP server declared in `mcp-servers.json`. Each rented
  session runs in a throwaway container with a read-only root, no host
  filesystem, and no network beyond the hosts you name. There is no unsandboxed
  fallback.
- `aile start` runs the node, `aile status` reports what it is doing, and
  `aile stats` shows what each of your machines has served and earned.

### Buying

- `aile lenders` lists who is lending, cheapest first, with nine filters. Five
  have a header twin on `/v1/*`.
- `aile price <model>` prices a request before you send it, at every lender's
  rate. It sends nothing.
- `aile spend` reports what each lender has charged you.

### Wallet

- `aile wallet` shows the balance and where earnings land. Withdrawals name
  their destination on the withdraw page, and no payout address is stored.

### Client

- `aile config` reads and writes settings, validating on write and recording
  only what you changed.
- `aile update` checks the registry and installs a newer version after a
  confirmation. A one-line notice appears above other commands when one is out;
  `AILE_NO_UPDATE_CHECK=1` silences it.

### Security

- The egress allowlist ships as static data compiled into the bundle. The node
  refuses any host outside it and any private address, including when the relay
  asks for one.
- Targets are re-checked after DNS resolution and connected to by IP, which
  closes DNS rebinding.
- No provider credential is written to this machine. A pasted API key is
  checked, uploaded, and never stored locally.
- No configuration value can name an egress target.
- Published from CI with [npm provenance](https://docs.npmjs.com/generating-provenance-statements),
  so the tarball is bound to this repository and commit. Verify with
  `npm audit signatures`.

[Unreleased]: https://github.com/ailelabs/aile.sh/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/ailelabs/aile.sh/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/ailelabs/aile.sh/releases/tag/v1.0.0
