# Security

This client runs unattended on machines we do not control, holds an account
token, and updates itself. Treat a flaw in it as a flaw that reaches every
lender at once.

## Reporting a vulnerability

Use GitHub's private reporting: **[Report a vulnerability](https://github.com/ailelabs/aile.sh/security/advisories/new)**.
It opens a private thread with the maintainers and stays closed until there is a
fix to publish.

Email `security@aile.sh` if you cannot use GitHub.

Please do not open a public issue, a pull request, or a discussion for a
vulnerability. A public report starts a race between the fix and whoever reads
it first.

**What to expect:** an acknowledgement within 3 working days, an assessment
within 10, and credit in the advisory and changelog unless you ask us to leave
your name out.

## What to include

A report we can reproduce gets fixed faster than one we have to guess at:

- The version (`aile --version`), your OS, and your Node version.
- What an attacker gains, and what they need to start.
- Steps to reproduce, or a proof of concept.
- Any log output, with your token and any API key removed.

## In scope

- Anything that makes the node dial a host outside the egress allowlist, or
  reach a private address (`127.0.0.1`, `192.168.x`, `169.254.169.254`).
- Anything that writes a provider credential to disk, prints one, or sends one
  somewhere other than the configured relay.
- Anything that lets a party other than you read or change your config, account
  token, or node identity.
- A path that lets a malicious relay response run code on the node.
- A flaw in the update mechanism that installs something other than the
  published `aile.sh` package.
- Anything that lets one lender read another's traffic, earnings, or accounts.

## Out of scope

- **Reading prompts on a self-hosted model.** `aile local` runs a model on your
  machine, so your machine reads those prompts. That is how the feature works
  and the client says so at every point it applies.
- **What the aile.sh server can see.** The server terminates TLS with the
  provider, so it reads prompts and responses. See
  [the privacy model](https://aile.sh/docs/concepts/privacy). Report server-side
  findings against the server, not here.
- Vulnerabilities in Node, npm, or a provider's own API.
- Attacks that need root on the machine already, or physical access to it.
- A denial of service against your own node.
- Missing hardening with no path to exploit behind it.

## Scope of this file

`SECURITY.md` covers the `aile.sh` npm package and this repository. For the
relay, the web app, or the API, write to `security@aile.sh` instead.
