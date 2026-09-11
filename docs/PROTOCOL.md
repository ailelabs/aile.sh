# Relay protocol

The wire contract between a node (this package) and aile.sh: every frame the two
sides exchange, what each one is allowed to ask for, and what this client refuses.

Read it to check the claim the rest of the documentation makes. "Your machine
forwards bytes it holds no keys for" is either visible in the frame format or it
is marketing, and §1 and §5 are where you settle that for yourself. §6 is the
egress allowlist: the list of things this client will not do when aile.sh asks.

Reference implementation: `src/relay/framing.js` (codec) and `src/relay/agent.js`
(node behaviour). A working server stub lives in `test/helpers/stub-server.js`.

For using the client rather than auditing it, see
[aile.sh/docs](https://aile.sh/docs).

---

## 1. Trust model — read this first

The node is **not** trusted by the server, and the server is **not** trusted by
the node. Both halves of that are load-bearing.

**The server does not trust the node.** A renter controls their own machine. They
can patch this client, lie in the capability heartbeat, or drop packets. Nothing
the node asserts is proof of anything. See §7.

**The node does not trust the server.** aile.sh chooses the target host in every
`OPEN`, so an unconditional node would be an open proxy into the renter's LAN.
The node refuses any target that is not a known provider host resolving to a
public IP — *including if aile.sh asks*. See §6.

The reason the whole design works is that neither side needs to trust the other
for the security property that matters: **TLS is terminated at aile.sh, so the
node forwards ciphertext it has no keys for.** The renter cannot read buyer
prompts. Not "is contractually forbidden from" — *cannot*.

```
BUYER            aile.sh                  RENTER NODE            PROVIDER
  |                 |                          |                     |
  |-- request ----->|                          |                     |
  |                 |-- TLS handshake ---------+-------------------->|
  |                 |== ciphertext ===========>|== raw TCP =========>|
  |<-- response ----|<= ciphertext ============|<= raw TCP ==========|
                                        sees CIPHERTEXT ONLY
```

The node's value is the **account-bound residential egress IP**, not credential
custody. That is why the client is genuinely required and cannot be optimised
away server-side.

---

## 2. Transport

The node dials **outbound** and holds the connection open:

```
wss://<serverUrl>/agent?token=<renterToken>&nodeId=<nodeId>&nonce=<nonce>&sig=<sig>
```

Outbound-only is deliberate: no inbound ports, no firewall changes, works behind
NAT and CGNAT. Nothing on the renter's machine is exposed to the internet.

| Param | Meaning |
|---|---|
| `token` | renter's bearer token from `aile link` |
| `nodeId` | 16 hex chars, stable per install (`src/relay/identity.js`) |
| `nonce` | `<nodeId>:<unix-ms>` |
| `sig` | `HMAC-SHA256(nodeSecret, nonce)`, hex |

`nodeSecret` is 32 random bytes generated on first run and stored `0600` in the
node's data dir. It crosses the wire exactly once, at enrolment (§2a); after that
only the HMAC does.

**Server-side requirements**, none of which the client can enforce for you:

- Verify `sig` against the secret you registered for that `nodeId` at enrolment.
- Reject a `nonce` whose timestamp is outside a few minutes of now, and reject
  replays within that window. Without this, a captured URL is a valid login.
- Verify `token` maps to an account that owns `nodeId`. A valid signature from
  node A presented with account B's token is an attempted account swap.
- Rate-limit failures per token and per IP.

`http://` is downgraded to `ws://` automatically for local testing. `aile link`
refuses a non-HTTPS `--server` unless it is `localhost`/`127.0.0.1`, or the
renter passes `--insecure` (staging by IP, before a domain is attached).

---

## 2a. Enrolment

The handshake above is unverifiable until the server knows the node's secret.
`aile link` therefore does two things: store the renter token, and enrol.

```
POST /enroll
Authorization: Bearer <renterToken>
{ "nodeId": "<16 hex>", "secret": "<64 hex>", "label": "<hostname>" }
```

This is the one moment the secret is transmitted, which makes `/enroll` the most
sensitive route on the server and the reason a non-HTTPS server URL requires an
explicit opt-in.

**Server-side requirements:**

- Authorise with the renter token; answer `401` without distinguishing *which*
  part was wrong.
- Validate shape before storing — `nodeId` must match `^[a-f0-9]{8,64}$`, and the
  secret must be length-bounded.
- **Re-enrolment must be owner-only.** Renters do reinstall, so overwriting an
  existing node has to be possible; but if any valid renter token may overwrite
  any node's secret, then any renter can hijack another's node. Answer `409` when
  the node belongs to someone else.

Enrolment is idempotent for the owner and rotates the secret, which is also the
revocation path: re-enrol and the old secret stops working immediately.

---

## 3. Two planes on one socket

WebSocket **text** frames are the control plane (JSON). WebSocket **binary**
frames are the data plane (opaque bytes). The node dispatches on frame type, so
the two never collide.

Per-chunk JSON is deliberately avoided on the data plane: DATA frames carry TLS
records at line rate and must stay cheap.

---

## 4. Control plane (JSON, text frames)

### `hello` — node → server, once, immediately after open

```json
{
  "type": "hello",
  "nodeId": "a1b2c3d4e5f60718",
  "capabilities": {
    "nodeId": "a1b2c3d4e5f60718",
    "maxConcurrent": 4,
    "platform": "linux",
    "agentVersion": 2,
    "claimedConnections": [
      { "id": "…", "provider": "codex", "email": "…", "attested": 1, "authType": "oauth" },
      { "id": "…", "provider": "openrouter", "label": "Spare", "attested": 0, "authType": "apikey" }
    ],
    "localModel": null,
    "mcpServers": []
  }
}
```

`claimedConnections` is an **unverified claim** — it is a list the node echoes
back, not proof of anything. The node holds no provider credentials at all
(they are custodied server-side), so a bug here cannot leak one, but neither can
this payload establish that an account exists. The field name says "claimed" on
purpose. See §7 for what actually proves an account.

`authType` says how the account is **paid for**, which is a different question
from whether it is verified. `oauth` is a subscription and stops at a monthly
ceiling; `apikey` bills the lender per token with no ceiling at all, so a runaway
buyer is a real invoice rather than an exhausted plan. Both can be `attested: 0`,
which is why that field cannot carry this — an unverified subscription and a
metered key read identically through it, and they fail very differently under
sustained load. Derived by the node from its own catalog, so it is a claim like
everything else here: a billing hint for an operator, never an input to a trust
decision.

`localModel` is self-hosted capacity and is **null unless the lender enabled
it**. It is advertised under its own key rather than merged into
`claimedConnections` because it is not blind — the lender's machine runs the
model and therefore reads the prompt, so a server must never satisfy a
blind-relay request from it.

`mcpServers` is sandboxed MCP capacity, empty on a node that declares none —
which is the normal state. It is advertised under its own key for the same
reason `localModel` is: the compute happens on the lender's machine, so that
path is not blind either. Its shape, and the two things that empty it even when
servers *are* declared, are in §5 under `MCP_OPEN`.

### `backpressure` — node → server

```json
{ "type": "backpressure", "streamId": 42, "paused": true }
```

Sent when the provider socket's write buffer is full, and again with
`"paused": false` on drain. A server that ignores this will grow the node's
memory until the socket errors.

### `shutdown` — server → node

```json
{ "type": "shutdown" }
```

Node stops cleanly and drains in-flight streams. Use for deploys.

### `pong` — server → node

Optional text-frame liveness reply; the binary `PONG` (§5) is the normal path.

---

## 5. Data plane (binary frames)

```
[op:1][streamId:4 big-endian][payload…]
```

5-byte header. `MAX_PAYLOAD` is 1 MiB — TLS records cap at 16 KiB, so anything
near the limit is malformed or hostile.

| op | Name | Direction | Payload |
|---|---|---|---|
| `0x01` | `OPEN` | server → node | UTF-8 JSON `{"host":"api.openai.com","port":443}` |
| `0x02` | `DATA` | both | opaque bytes |
| `0x03` | `CLOSE` | both | empty |
| `0x04` | `ERR` | node → server | UTF-8 message, truncated to 512 bytes |
| `0x05` | `LOCAL_OPEN` | server → node | empty — deliberately |
| `0x06` | `MCP_OPEN` | server → node | UTF-8 JSON `{"serverId":"claude-code"}` |
| `0x10` | `PING` | both | empty |
| `0x11` | `PONG` | both | empty |

### Stream lifecycle

1. Server sends `OPEN` with a stream id it chooses (unique per connection).
2. Node validates the target (§6). On refusal it replies `ERR` and opens
   **no socket at all** — the refusal costs nothing.
3. On success the node connects to a **resolved IP** and relays `DATA` both ways.
4. Either side may send `CLOSE`. Socket errors produce `ERR` then `CLOSE`.

The node never parses `DATA`. It is TLS ciphertext, and the node has no keys.

### `OPEN` is not acknowledged — `DATA` arrives behind it

There is no `OPEN`-ack in this protocol, and adding one would cost a round trip
on every stream. The server therefore writes the TLS `ClientHello` immediately
after `OPEN`, while the node is still resolving DNS for the allowlist check
(§6) — that check works on *resolved addresses*, so it cannot be skipped or
reordered.

**A node must buffer `DATA` for a stream whose target is still resolving**, and
flush on connect. Dropping those bytes is silent: the socket opens, the provider
waits for a `ClientHello` that never arrives, and the stream dies at the TLS
timeout with bytes-up non-zero and bytes-down zero.

This was a real production failure, and it survived a green test suite because
the tests' allowlist mock resolved in a microtask — closing the window that a
real DNS lookup opens. `test/open-race.test.js` reproduces it with a deliberately
delayed mock; that delay is the test.

Buffering must be bounded (the client caps it at 256 KiB) or a server that opens
streams which never connect can exhaust node memory.

### The node's own capacity: `LOCAL_OPEN` and `MCP_OPEN`

`OPEN` names a host and a port, and the node checks that target against §6
before it opens a socket. The other two openers do not name a target at all,
and that asymmetry is the whole reason they are separate ops rather than flags
on `OPEN`.

**`LOCAL_OPEN (0x05)` carries an empty payload.** The node substitutes the
endpoint its owner configured for self-hosted inference, and there is nowhere in
the frame for the server to say anything else. If the server could name the
target, every node running this op would be an open proxy into its owner's
LAN — which is the precise thing §6 exists to prevent, and a flag on `OPEN`
would have made it one line of server-side code away.

**`MCP_OPEN (0x06)` carries a `serverId`, and that is not a relaxation of the
rule above.** A host:port is an *address* on the lender's network. A `serverId`
is an opaque *key* into a table the lender wrote (`mcp-servers.json`), matched
against `^[a-z0-9][a-z0-9._-]{0,63}$` at both encode and decode. The node
resolves it against its own config and refuses anything absent from it, so the
server can only select among the servers the node already advertised in its own
`hello`. It cannot name anything the lender did not offer. The precedent is
`accountId` on the subscription path: the server says *which* of the lender's
declared things, never an address of its own choosing.

Where the far end of an `OPEN` stream is a TCP socket, the far end of an
`MCP_OPEN` stream is **a child process's stdin/stdout** — an MCP server the
lender declared, started by the node inside a container (read-only root, no host
filesystem, `--network=none` unless the declaration names hosts, no inherited
environment). The node still parses nothing: `DATA` up is written to the child's
stdin, `DATA` down is whatever the child wrote to stdout, and the MCP client
lives on the server side exactly as the TLS client does on the relay path. The
child's **stderr never reaches the wire** — it is where a crashing server prints
its environment.

Two consequences of the far end not being a socket:

- **This path is not blind.** The compute happens on the lender's machine, so
  the lender's hardware sees the renter's prompts, the same way `localModel`
  does. Both are advertised under their own key for that reason, and never
  merged into `claimedConnections`.
- **The pre-start buffering rule above applies unchanged**, for a different
  reason: a container takes far longer to start than a DNS lookup takes to
  resolve. `DATA` that arrives before the child exists is buffered and flushed
  on start, under the same bound.

**Version negotiation is the capability field, not a version number.** An older
node advertises no `mcpServers` in its `hello`, so the server never sends it
`MCP_OPEN`; and the dispatch's `default:` branch warns and ignores an unknown
op, so a node that receives one anyway does nothing. Nothing needed a bump.

### `mcpServers` in `hello`

```json
"mcpServers": [
  {
    "id": "claude-code",
    "name": "Claude Code",
    "tools": ["Read", "Write", "Bash"],
    "egress": ["api.anthropic.com"],
    "egressEnforced": false,
    "blind": false
  }
]
```

**Advertise only what could actually be served.** The server refuses any
`serverId` absent from this list, so an entry is a promise the node has to keep.
Two things drop a declared server from it rather than listing it as healthy and
failing on first rent: **no container runtime** (no sandbox, no capacity — there
is deliberately no unsandboxed fallback), and **disabled by its owner**. A third
thing is deliberately *not* checked: whether the image exists. Pulling or
inspecting an image is a network round trip inside the handshake, on every
reconnect, and a slow registry would then delay the node's provider relaying
too. A missing image surfaces as one failed session instead.

`egress` and `egressEnforced` travel together on purpose. A host list with no
`egressEnforced` beside it reads as a firewall, and it is not one: `[]` with
`egressEnforced: true` means `--network=none`, which the kernel enforces
completely, while a non-empty list means the container has ordinary outbound
network and the list is a **declaration, not a packet filter**.

`tools` is a lender's claim, like `claimedConnections`. The server rediscovers
the real list over an MCP session before selling anything.

### Timers and limits

| Limit | Value | Behaviour |
|---|---|---|
| `PING` interval | 30 s | node → server |
| `PONG` timeout | 90 s | node closes the socket and reconnects |
| Connect timeout | 15 s | `ERR`, stream destroyed |
| Socket idle timeout | 5 min | `ERR`, stream destroyed |
| MCP session idle | 2 min | container killed, `ERR`, stream destroyed |
| MCP session wall clock | per-server `timeoutMs` (default 3 min, max 10) | container killed, `ERR` |
| Max concurrent streams | `maxConcurrent` (default 4) | `ERR "node at capacity"` |

### Backpressure

Both directions, because either can be the fast side.

- **Down** (provider → server): if `ws.bufferedAmount` exceeds 4 MiB the node
  pauses the TCP socket, and resumes below 1 MiB.
- **Up** (server → provider): if `socket.write()` returns `false` the node emits
  the `backpressure` control message above.

### Framing over a non-WebSocket carrier

WebSocket preserves message boundaries, so the agent needs no reassembly. For a
raw-TCP carrier (or a test harness that splits writes), `framing.js` also exports
`FrameReader` and `withLengthPrefix`, which add a 4-byte big-endian length prefix
and re-emit whole frames regardless of chunking.

---

## 6. Egress allowlist — the node's own defence

This is the one place the node does **not** trust aile.sh. Both gates must pass:

1. **Host is a known provider host** (exact match or a subdomain of one), from
   `src/relay/provider-hosts.js` — a generated, baked-in list of 213 hosts. It is
   static data in the published bundle, so a node's egress policy cannot be
   widened at runtime by anything the server says, and nothing outside this
   package can widen it either.
2. **Every resolved address is public.** Blocked: `0.*`, `10.*`, `127.*`,
   `172.16–31.*`, `192.168.*`, `169.254.*` (link-local *and* cloud metadata),
   `100.64–127.*` (CGNAT), `224.*`+ (multicast/reserved), `::1`, `::`, `fe80::/10`,
   `fc00::/7`, and IPv4-mapped IPv6 judged by the embedded IPv4.

Also refused: any port other than 443, and any bare IP target (an IP cannot be
checked against a host list by name).

**DNS rebinding is closed** by connecting to the address returned from the
validating lookup, not by re-resolving the name. There is no window in which the
name can flip to a private address between check and connect.

Covered by 17 tests in `test/allowlist.test.js`.

---

## 7. Attestation — proving an account is real

The heartbeat cannot prove anything: it comes from a machine the renter controls.
Treat `claimedConnections` as a routing hint and nothing more.

**Cryptographic proof — at enrolment, server-side.** The renter completes the
provider OAuth flow with a `nonce` **aile.sh chooses**. aile.sh receives the
provider-signed `id_token` and verifies its signature against the provider's
JWKS, plus `iss`, `aud`, `exp`, and the `nonce`, then binds `sub` to the renter
account. A server-chosen nonce cannot be replayed with a stolen token — which is
exactly the property a client-relayed `id_token` would lack. This is the
unforgeable "actually from Codex" proof.

Never promote anything from the heartbeat to trusted without matching it against
an enrolment record.

**What cannot be attested at all.** A provider linked by pasting an API key signs
nothing — there is no `id_token` in a key exchange, so there is nothing to verify
against a JWKS. Those accounts are stored as unverified claims and reported as
`attested: 0`, permanently, and that is accurate rather than a gap to close
later. Validating the key against the provider before upload (which the client
does) proves the key *works*; it does not prove whose account it bills or that
the lender owns it. Those are different claims and only the first is ever made.

The same limit applies to any OAuth provider absent from the server's JWKS map:
`attestable: false` comes back from `/providers/nonce` so the lender is told
before they authorise, not after. Claude is one of these — its OAuth scopes carry
no `openid`, so no `id_token` is ever issued and there is nothing to verify.

**Liveness proof — at link time, client-observed.** Separately from attestation,
the node asks the provider's own API whether the credential works (a free,
authenticated GET — never a completions endpoint, which would bill the lender to
check their own credential) and uploads the answer as `probe` on `POST
/providers`:

```json
{ "provider": "claude", "tokens": {…}, "nonce": "…", "probe": { "ok": true, "reason": "ok" } }
```

`reason` is one of `ok`, `rejected`, `network`, `upstream`, `blocked`,
`no-target`. `probe: null` means no check was run, which is deliberately distinct
from a check that failed.

**This is a claim, not a verification, and the two must not be merged.** It is
observed by the lender's machine — the machine this trust model does not trust —
so a client asserting `ok` proves nothing on its own. It answers "does this
credential work?", never "whose account is it?". Store it in its own column
(`probe_ok`); a client must never be able to write `attested`, or the weak claim
becomes a way to mint the strong one. The server holds the credential anyway, so
it can re-run the identical check itself, and *that* result is worth trusting
because the server observed it — a server-supplied `probe_ok` therefore wins over
the node's.

A failed probe does not fail the link. An OAuth token came from a completed
sign-in, so a negative answer is more often a fussy endpoint or a stale probe URL
than a bad credential; the credential is uploaded either way and the lender is
told only when the provider actively rejected it.

The CLI renders `attested` and `probe_ok` alike as `verified`, because the
question a lender asks of that column — did connecting my account work? — has the
same answer for both. Only `attested` is ever used to display a signed claim such
as a plan tier.

**Behavioural proof — continuous.** Signature checks say the account is real;
they do not say traffic *reached* it. Periodically issue a cheap known-answer
request through the node and fingerprint the upstream response: `x-request-id`
shape, `openai-processing-ms`, org id, TLS/ALPN characteristics. Drift means
demote. This is what catches a renter silently downgrading to a cheaper model,
which no signature check can detect.

---

## 8. Reconnection

The node owns reconnection; the server should simply accept that nodes come and
go. Exponential backoff from 1 s to 60 s with jitter (`base/2 + random(base/2)`,
so a fleet does not reconnect in lockstep after a deploy), gated on a DNS
reachability check so a sleeping laptop does not burn attempts. The attempt
counter resets to 0 on success.

On disconnect all in-flight streams are destroyed and their sockets closed — a
dropped WebSocket must not leak provider sockets. Verified in
`test/e2e.test.js` ("drains in-flight streams when the connection drops
mid-stream") and `test/supervisor.test.js`.

---

## 9. Testing against a stub

`test/helpers/stub-server.js` implements the server half honestly: it validates
the handshake params, reads `hello`, opens streams, and **terminates TLS itself**
by running a real TLS client over the frame channel. That is what makes the e2e
test genuine rather than a mock — the ciphertext the node forwards comes from a
real TLS session the node has no keys for.

```bash
bun test test/e2e.test.js
```

Covers: outbound handshake, capability advertisement, a real streaming SSE
completion arriving in order, the blindness assertion, allowlist refusal,
`maxConcurrent` enforcement, and mid-stream disconnect recovery.

The stub does **not** verify the node signature (it has no database). Do not
model your server's auth on it — implement §2 properly. The real server lives in
the `aile-server` repo and its `test/integration.test.js` runs this same client
against it, signatures and all.

### Against the deployed server

A stub cannot prove the design holds on a real network. `scripts/live-blindness-probe.js`
runs a genuine node against the live server, taps every byte crossing its
WebSocket in both directions, issues a buyer request carrying a canary prompt,
and asserts the canary and the buyer's API key appear nowhere in the capture:

```bash
aile link --server <url> --token <token>   # once
bun scripts/live-blindness-probe.js
```

It also asserts the provider genuinely answered — an exchange that never happened
trivially contains no canary, and would otherwise "pass".
