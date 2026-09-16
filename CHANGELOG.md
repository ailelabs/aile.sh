# Changelog

Notable changes to the `aile.sh` client. This file is what `aile update` points
you at when it offers a newer version.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html): a
major bump is a break in the CLI surface, a minor bump adds a command or a flag,
a patch bump fixes something.

## [Unreleased]

### Changed

- The provider catalog and the node egress allowlist are generated from the aile
  relay's own provider registry rather than vendored from a third-party one, so a
  correction made server-side now reaches this client. Nothing changes about what
  you can lend: the same 23 providers link, by the same flows.

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

[Unreleased]: https://github.com/ailelabs/aile.sh/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/ailelabs/aile.sh/releases/tag/v1.0.0
