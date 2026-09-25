/**
 * Blind relay agent.
 *
 * Holds an outbound WebSocket to the relay server and forwards opaque TCP bytes
 * between that socket and provider endpoints. The server terminates TLS with the
 * provider, so every byte crossing this process is ciphertext: the node cannot
 * read buyer traffic even in principle. Do not add decoding/logging of payloads —
 * that would defeat the entire security model.
 */

import net from "node:net";
import {
  OP, MAX_PAYLOAD, encodeFrame, encodeError, decodeFrame, decodeOpenPayload, decodeMcpOpenPayload,
} from "./framing.js";
import { assertTargetAllowed } from "./allowlist.js";
import { resolveLocalTarget } from "./local.js";
import { findMcpServer } from "../mcp/config.js";
import { McpSession } from "../mcp/stream.js";
import { signNonce } from "./state.js";
import { accessHeaders } from "../api/access.js";

/** The host of a URL, or null. Never throws — a diagnostic must not become the fault. */
const hostOf = (url) => { try { return new URL(String(url)).host; } catch { return null; } };

// Defaults for a directly-constructed agent. The CLI passes the user's settings
// (src/config/settings.js), which is where the documented bounds live; these
// values only apply when a caller — a test, say — constructs one bare.
const PING_INTERVAL_MS = 30000;
const PONG_TIMEOUT_MS = 90000;
const CONNECT_TIMEOUT_MS = 15000;
const SOCKET_IDLE_TIMEOUT_MS = 300000;
// Bytes we will hold for a stream whose DNS lookup is still in flight. A TLS
// ClientHello is well under 1 KB; this is generous while still bounded, so a
// misbehaving server cannot use never-connecting streams to exhaust memory.
const MAX_PENDING_BYTES = 256 * 1024;

// The relay closes a node's older socket with this when the same node id
// connects again. Must match broker.js server-side.
const CLOSE_SUPERSEDED = 4001;

/**
 * A connect failure the caller can branch on.
 *
 * `rejected` means the server refused this machine's credentials — retrying
 * unchanged will fail identically, forever. Everything else is worth a retry.
 * The distinction exists because the supervisor's backoff loop is right for a
 * flaky network and wrong for a permanent refusal, and from a bare Error the
 * two are indistinguishable.
 */
export class RelayConnectError extends Error {
  constructor(message) {
    super(message);
    this.name = "RelayConnectError";
    // Both flags are derived from the message `_diagnose` produced, which is the
    // idiom this file already used for `rejected`. It is a coupling, so the two
    // phrases matched here are the ones written a few hundred lines below and must
    // move together — the tests in test/lockout.test.js pin both ends.
    //
    // `rejected` — the server considered this machine and said no. Retrying is
    // pointless; re-registering might help.
    this.rejected = /rejected this machine/.test(message);
    // `blocked` — something in FRONT of the server answered, so the server never
    // saw the request at all. Neither retrying nor re-registering can change that,
    // and a node that keeps trying just prints the same paragraph every few seconds
    // for ever. This is the difference between "we were refused" and "we never
    // arrived", and only the second one is hopeless.
    this.blocked = /an access proxy answered/.test(message);
  }
}

export class RelayAgent {
  constructor({
    serverUrl, renterToken, nodeId, maxConcurrent = 4, onStatus = null, log = console,
    // Empty unless the owner turned on self-hosted lending. Held here rather
    // than read from config per-stream so one running agent has one target.
    localEndpoint = "",
    // The container runtime `mcp/capabilities.js` found at connect time, or
    // null. Passed in rather than probed per stream because detection shells
    // out synchronously, and doing that inside the frame dispatch would stall
    // every other stream on this socket while Docker answers.
    mcpRuntime = null,
    pingIntervalMs = PING_INTERVAL_MS,
    pongTimeoutMs = PONG_TIMEOUT_MS,
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
    idleTimeoutMs = SOCKET_IDLE_TIMEOUT_MS,
    maxPendingBytes = MAX_PENDING_BYTES,
  }) {
    if (!serverUrl) throw new Error("serverUrl is not configured");
    if (!renterToken) throw new Error("not signed in — run `aile login`");
    this.serverUrl = serverUrl;
    this.renterToken = renterToken;
    this.nodeId = nodeId;
    this.maxConcurrent = maxConcurrent;
    this.onStatus = onStatus;
    this.log = log;
    this.localEndpoint = localEndpoint;
    this.mcpRuntime = mcpRuntime;
    this.pingIntervalMs = pingIntervalMs;
    this.pongTimeoutMs = pongTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.maxPendingBytes = maxPendingBytes;

    this.ws = null;
    this.streams = new Map();
    this.closed = false;
    this.pingTimer = null;
    this.lastPongAt = 0;
    this._abandon = null;
    // localStreamsOpened is counted separately from streamsOpened so a lender
    // can see how much of their traffic took the non-blind path.
    this.stats = {
      streamsOpened: 0, streamsRefused: 0, localStreamsOpened: 0, mcpStreamsOpened: 0,
      bytesUp: 0, bytesDown: 0,
    };
  }

  async connect(capabilities = null) {
    const url = this._buildUrl();

    return new Promise((resolve, reject) => {
      let settled = false;
      // Whether this socket ever OPENED. A connect that failed prints its own
      // "cannot reach" line; announcing a "disconnect" of a connection that never
      // existed made one refusal read as two problems.
      let opened = false;
      let ws;
      try {
        // The Access service token has to ride the UPGRADE itself. Cloudflare
        // Access answers an unauthenticated upgrade with a 200 sign-in page, which
        // the WebSocket sees only as "expected 101" — so a relay behind Access
        // reconnects for ever with nothing in the log that names the cause. Both
        // runtimes accept a `headers` option here (verified on Bun and on Node's
        // undici WebSocket); on a relay with no Access in front it is an empty
        // object and changes nothing.
        const headers = accessHeaders();
        ws = Object.keys(headers).length ? new WebSocket(url, { headers }) : new WebSocket(url);
      } catch (e) {
        reject(e);
        return;
      }
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      ws.onopen = () => {
        opened = true;
        this.lastPongAt = Date.now();
        this._startPing();
        // Capability advertisement is JSON (control plane); byte frames are binary.
        if (capabilities) this._sendJson({ type: "hello", nodeId: this.nodeId, capabilities });
        settled = true;
        this._emitStatus("connected");
        resolve(this);
      };

      ws.onmessage = (event) => {
        try {
          this._onMessage(event.data);
        } catch (e) {
          this.log?.warn?.(`[Relay] frame error: ${e.message}`);
        }
      };

      ws.onerror = (err) => {
        if (!settled) {
          settled = true;
          // A browser-shaped WebSocket reports every failed upgrade as a bare
          // "websocket error" — the HTTP status and body that say WHY are not
          // exposed to it at all. That turned an actionable 401 ("this machine
          // belongs to another account") into an opaque reconnect loop with
          // nothing to act on. So ask the server in plain HTTP and report what
          // it actually said. Diagnosis only: the answer never authorises
          // anything, it just replaces a dead end with a sentence.
          this._diagnose()
            .then((detail) => reject(new RelayConnectError(detail || err?.message || "websocket error")))
            .catch(() => reject(new RelayConnectError(err?.message || "websocket error")));
        }
      };

      // ONE REPORT PER SOCKET, however it ends: its close event, or the ping
      // timer giving up on a link that went silent. A dead TCP connection may
      // not deliver a close event for minutes, so waiting for one left the node
      // "connected" to nothing; and reporting both would print the drop twice.
      let ended = false;
      const end = (code, reason, stale = false) => {
        if (ended) return;
        ended = true;
        if (this._abandon === abandon) this._abandon = null;
        // Report WHY. A close code discarded here is a reconnect loop with no
        // stated cause, which reads as a flaky network no matter what actually
        // happened — 4001 ("superseded") in particular is self-inflicted and
        // instantly diagnosable, but only if it is printed.
        if (code === CLOSE_SUPERSEDED) {
          this.log?.warn?.(
            "another agent on this machine took over the connection — " +
            "only one can run at a time",
          );
        }
        // Every other close is reported by the supervisor, which is the one
        // that knows whether the link came back in two seconds or never: a
        // line per drop, printed here, turned every server deploy into a pair
        // of alarming lines about a code (1006) nobody can act on.
        this._teardown();
        this._emitStatus("disconnected", { code: code ?? null, reason, opened, stale });
        if (!settled) {
          settled = true;
          reject(new Error(`websocket closed before open (${code || "no code"}${reason ? `: ${reason}` : ""})`));
        }
      };
      const abandon = () => {
        // Detached first, so a close event that does arrive late from this dead
        // socket cannot report the same drop again.
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try { ws.close(); } catch { /* already gone */ }
        if (this.ws === ws) this.ws = null;
        end(null, "", true);
      };
      this._abandon = abandon;
      ws.onclose = (event) => end(event?.code ?? null, String(event?.reason || "").trim());
    });
  }

  _buildUrl() {
    const base = this.serverUrl.replace(/\/+$/, "").replace(/^http/, "ws");
    const nonce = `${this.nodeId}:${Date.now()}`;
    const params = new URLSearchParams({
      token: this.renterToken,
      nodeId: this.nodeId,
      nonce,
      sig: signNonce(nonce),
    });
    return `${base}/agent?${params.toString()}`;
  }

  /**
   * Ask why the upgrade was refused, over plain HTTP where the status and body
   * are readable.
   *
   * A fresh nonce is used rather than replaying the one the WebSocket just
   * sent: the server burns a nonce on success, so reusing it would report
   * "nonce replay" — a true statement about this probe and a lie about the
   * connection that failed. A distinct nonce reproduces the real refusal.
   *
   * Anything unexpected returns null, and the caller falls back to the
   * transport's own message. A diagnostic that throws would replace a poor
   * error with no error at all.
   */
  async _diagnose() {
    const nonce = `${this.nodeId}:${Date.now()}`;
    const params = new URLSearchParams({
      token: this.renterToken, nodeId: this.nodeId, nonce, sig: signNonce(nonce),
    });
    const base = this.serverUrl.replace(/\/+$/, "");

    let res;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 10000);
      try {
        res = await fetch(`${base}/agent?${params.toString()}`, {
          signal: ac.signal,
          headers: accessHeaders(),
          // Not followed, for the reason api/client.js sets out: a 3xx re-sends
          // these headers to wherever it points, and they hold both the renter
          // token's query URL and any Access service token.
          redirect: "manual",
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return null;   // unreachable: the transport's own message is the better one
    }

    // 400/426 mean the handshake passed and the server wanted a real upgrade —
    // the refusal was about the transport, not the credentials.
    if (res.status === 400 || res.status === 426) return null;

    // AN ACCESS PROXY ANSWERED, NOT THE RELAY. This is its own case because the
    // generic path below would print two hundred characters of somebody else's
    // sign-in page into the log, once per reconnect — which is how the same class
    // of bug read as "undefined" in `aile login`. A portal cannot be satisfied by a
    // node, so say what it is and how an operator gets through it.
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    const body = (await res.text().catch(() => "")).trim();
    const isRedirect = res.status >= 300 && res.status < 400;
    const isHtml = ctype.includes("html") || /^<(!doctype|html)/i.test(body);
    if (isRedirect || isHtml) {
      const where = isRedirect ? hostOf(res.headers.get("location")) : null;
      return (
        `an access proxy answered instead of the relay${where ? ` (redirect to ${where})` : ""} — ` +
        `this node cannot sign in to it. Ask whoever runs ${base} to allow the /agent ` +
        `endpoint, or set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET if you hold a ` +
        `service token for it.`
      );
    }

    const snippet = body.slice(0, 200);
    if (res.status === 401 || res.status === 403) {
      return `server rejected this machine (${res.status}${snippet ? `: ${snippet}` : ""})`;
    }
    return snippet ? `server returned ${res.status}: ${snippet}` : `server returned ${res.status}`;
  }

  /**
   * Re-advertise on the LIVE socket, without reconnecting.
   *
   * A lender who edits mcp-servers.json while the node runs would otherwise
   * see nothing change until a restart, and "aile says it is connected but my
   * server is not listed" is indistinguishable from a bug. The server's hello
   * handler replaces `entry.capabilities` outright, so a second hello is an
   * update rather than a duplicate registration.
   *
   * DELIBERATELY NOT A RECONNECT. Dropping the socket to re-advertise would
   * fail every in-flight stream — someone else's paid request — for a config
   * change that has nothing to do with them.
   *
   * The CALLER rate-limits this (supervisor.js). Each hello fires
   * `probeNodeAccounts` server-side, so a file changing in a loop would
   * otherwise become a probe storm against the lender's own providers.
   *
   * Returns false when there is no live socket: the next connect advertises
   * fresh capabilities anyway, so there is nothing to do and nothing to say.
   */
  readvertise(capabilities) {
    if (this.ws?.readyState !== 1 || !capabilities) return false;
    this._sendJson({ type: "hello", nodeId: this.nodeId, capabilities });
    return true;
  }
  _sendJson(obj) {
    if (this.ws?.readyState !== 1) return;
    this.ws.send(JSON.stringify(obj));
  }

  _sendFrame(frame) {
    if (this.ws?.readyState !== 1) return;
    this.ws.send(frame);
  }

  _onMessage(data) {
    // Control-plane messages arrive as text, data-plane as binary.
    if (typeof data === "string") {
      this._onControl(JSON.parse(data));
      return;
    }
    const buf = Buffer.from(data);
    const { op, streamId, payload } = decodeFrame(buf);

    switch (op) {
      case OP.OPEN:
        this._handleOpen(streamId, payload);
        break;
      case OP.LOCAL_OPEN:
        this._handleLocalOpen(streamId);
        break;
      case OP.MCP_OPEN:
        this._handleMcpOpen(streamId, payload);
        break;
      case OP.DATA:
        this._handleData(streamId, payload);
        break;
      case OP.CLOSE:
        this._handleClose(streamId);
        break;
      case OP.PING:
        this._sendFrame(encodeFrame(OP.PONG, streamId));
        break;
      case OP.PONG:
        this.lastPongAt = Date.now();
        break;
      default:
        this.log?.warn?.(`[Relay] unknown op 0x${op.toString(16)}`);
    }
  }

  _onControl(msg) {
    if (msg?.type === "pong") this.lastPongAt = Date.now();
    if (msg?.type === "shutdown") this.stop("server requested shutdown");
  }

  /**
   * Reserve a stream slot and register it SYNCHRONOUSLY, before any await.
   *
   * The server pipelines the TLS ClientHello immediately behind OPEN, so DATA
   * for this stream routinely arrives while the target check is still resolving
   * DNS. Without a placeholder here that DATA finds no entry and is dropped, and
   * the handshake then stalls until the provider gives up.
   */
  _reserveStream(streamId) {
    if (this.streams.size >= this.maxConcurrent) {
      this.stats.streamsRefused++;
      this._sendFrame(encodeError(streamId, "node at capacity"));
      return null;
    }
    const entry = {
      streamId, socket: null, session: null, host: null, port: null,
      wsPaused: false, pending: [], pendingBytes: 0, closed: false,
    };
    this.streams.set(streamId, entry);
    return entry;
  }

  _refuseStream(streamId, message, label = "OPEN") {
    this.streams.delete(streamId);
    this.stats.streamsRefused++;
    this.log?.warn?.(`[Relay] refused ${label}: ${message}`);
    this._sendFrame(encodeError(streamId, message));
  }

  async _handleOpen(streamId, payload) {
    const entry = this._reserveStream(streamId);
    if (!entry) return;

    let host, port, addresses;
    try {
      ({ host, port } = decodeOpenPayload(payload));
      // Both gates: registry membership + public-IP check on every resolved address.
      addresses = await assertTargetAllowed(host, port);
    } catch (e) {
      this._refuseStream(streamId, e.message);
      return;
    }

    // Connect by resolved IP, not name — the name could re-resolve to a private
    // address between the check above and the connect (DNS rebinding).
    this._attachSocket(entry, { address: addresses[0], host, port });
  }

  /**
   * Open a stream to this node's OWN self-hosted model.
   *
   * The frame names no host: the target comes from the owner's `localEndpoint`,
   * never from the server. That asymmetry is the whole security argument — see
   * relay/local.js. A server can ask for the local model; it cannot pick which
   * machine, address, or port that means.
   *
   * Unlike the relay path, this traffic is NOT ciphertext to this process: the
   * model runs here, so this machine necessarily sees the prompt. That is
   * disclosed to the lender at config time and to the buyer at routing time.
   */
  async _handleLocalOpen(streamId) {
    if (!this.localEndpoint) {
      // Not an error worth a warn: a server that routes local work to a node
      // that stopped offering it is a race, not a misconfiguration.
      this.streams.delete(streamId);
      this.stats.streamsRefused++;
      this._sendFrame(encodeError(streamId, "node is not lending a local model"));
      return;
    }

    const entry = this._reserveStream(streamId);
    if (!entry) return;

    let target;
    try {
      target = await resolveLocalTarget(this.localEndpoint);
    } catch (e) {
      this._refuseStream(streamId, e.message, "LOCAL_OPEN");
      return;
    }

    this.stats.localStreamsOpened++;
    this._attachSocket(entry, { address: target.host, host: target.hostname, port: target.port });
  }

  /**
   * Open a stream to one of this node's OWN sandboxed MCP servers.
   *
   * The frame names a `serverId`, where LOCAL_OPEN names nothing, and that is
   * not the asymmetry above being relaxed — see the note on OP.MCP_OPEN in
   * relay/framing.js. A serverId is a key into the table this machine's owner
   * wrote; the lookup below is what makes it one. A server this node does not
   * currently serve is refused here, before a container starts, so the id can
   * only ever select among what the owner already declared.
   *
   * Like the local-model path and unlike the relay path, this traffic is NOT
   * ciphertext to this process — the MCP server runs here. It is sandboxed
   * (mcp/sandbox.js) and the node still does not parse a byte of it, but the
   * capability is advertised `blind: false` and must stay that way.
   */
  _handleMcpOpen(streamId, payload) {
    let serverId;
    try {
      ({ serverId } = decodeMcpOpenPayload(payload));
    } catch (e) {
      this._refuseUnreserved(streamId, e.message);
      return;
    }

    const server = findMcpServer(serverId);
    if (!server) {
      // A server that routes MCP work to a node which just stopped offering it
      // is a race, not a misconfiguration — same reasoning as _handleLocalOpen.
      // The message names the id back because the server chose it and can act
      // on it; it enumerates nothing else this node has.
      this._refuseUnreserved(streamId, `this node does not serve an MCP server named "${serverId}"`);
      return;
    }

    const entry = this._reserveStream(streamId);
    if (!entry) return;

    entry.session = new McpSession({
      server,
      streamId,
      runtime: this.mcpRuntime,
      log: this.log,
      onData: (chunk) => {
        this.stats.bytesDown += chunk.length;
        // A pipe read is far under MAX_PAYLOAD, but encodeFrame throws rather
        // than truncating and a throw inside a stdout handler would take the
        // whole agent down. Splitting costs nothing and cannot be wrong.
        for (let off = 0; off < chunk.length; off += MAX_PAYLOAD) {
          this._sendFrame(encodeFrame(OP.DATA, streamId, chunk.subarray(off, off + MAX_PAYLOAD)));
        }
      },
      onClose: () => {
        if (!this.streams.has(streamId)) return;
        this._sendFrame(encodeFrame(OP.CLOSE, streamId));
        this._closeStream(streamId);
      },
      onError: (message) => {
        this._sendFrame(encodeError(streamId, message));
        this._closeStream(streamId);
      },
    });
    this.stats.mcpStreamsOpened++;
    entry.session.start();
  }

  /**
   * Refuse a stream that was never reserved.
   *
   * `_refuseStream` deletes the map entry it assumes exists; both MCP refusals
   * above happen BEFORE reservation, deliberately, so that a bad serverId costs
   * no capacity slot. Kept separate rather than made lenient because a refusal
   * path that quietly tolerates a missing entry is how a leaked slot goes
   * unnoticed.
   */
  _refuseUnreserved(streamId, message) {
    this.stats.streamsRefused++;
    this.log?.warn?.(`[Relay] refused MCP_OPEN: ${message}`);
    this._sendFrame(encodeError(streamId, message));
  }

  /** Shared socket plumbing for both open paths: flush, timers, backpressure. */
  _attachSocket(entry, { address, host, port }) {
    const streamId = entry.streamId;

    // CLOSE (or a refusal) may have landed while the lookup was in flight.
    if (entry.closed || this.streams.get(streamId) !== entry) {
      this.streams.delete(streamId);
      return;
    }

    const socket = net.connect({ host: address, port });
    socket.setNoDelay(true);
    socket.setTimeout(this.idleTimeoutMs);

    entry.socket = socket;
    entry.host = host;
    entry.port = port;
    this.stats.streamsOpened++;

    // Flush whatever arrived during the lookup, in order. node:net buffers
    // writes made before the socket connects, so this needs no connect wait.
    for (const chunk of entry.pending) socket.write(chunk);
    entry.pending.length = 0;
    entry.pendingBytes = 0;

    const connectTimer = setTimeout(() => {
      socket.destroy(new Error(`connect timeout to ${host}:${port}`));
    }, this.connectTimeoutMs);

    socket.once("connect", () => clearTimeout(connectTimer));

    socket.on("data", (chunk) => {
      this.stats.bytesDown += chunk.length;
      this._sendFrame(encodeFrame(OP.DATA, streamId, chunk));
      // Backpressure: if the WebSocket is buffering, stop reading the socket so a
      // fast provider stream cannot balloon memory here.
      const buffered = this.ws?.bufferedAmount ?? 0;
      if (buffered > 4 * 1024 * 1024 && !entry.wsPaused) {
        entry.wsPaused = true;
        socket.pause();
        this._drainThenResume(entry);
      }
    });

    socket.on("timeout", () => socket.destroy(new Error("socket idle timeout")));

    socket.on("error", (err) => {
      clearTimeout(connectTimer);
      this._sendFrame(encodeError(streamId, err.message));
      this._closeStream(streamId);
    });

    socket.on("close", () => {
      clearTimeout(connectTimer);
      if (this.streams.has(streamId)) {
        this._sendFrame(encodeFrame(OP.CLOSE, streamId));
        this._closeStream(streamId);
      }
    });
  }

  _drainThenResume(entry) {
    const check = () => {
      if (this.streams.get(entry.streamId) !== entry) return; // stream closed while waiting
      if ((this.ws?.bufferedAmount ?? 0) < 1024 * 1024) {
        entry.wsPaused = false;
        entry.socket.resume();
        return;
      }
      setTimeout(check, 50);
    };
    setTimeout(check, 50);
  }

  _handleData(streamId, payload) {
    const entry = this.streams.get(streamId);
    if (!entry) return;
    this.stats.bytesUp += payload.length;

    // An MCP stream has no socket and never will — its far end is a child
    // process's stdin. McpSession owns the same pre-start buffering the
    // socket path does below, for the same reason (see mcp/stream.js rule 1).
    if (entry.session) {
      entry.session.write(payload);
      return;
    }

    // Still resolving DNS — hold the bytes rather than drop them. Bounded, so a
    // server that floods a stream that never connects cannot exhaust memory.
    if (!entry.socket) {
      entry.pendingBytes += payload.length;
      if (entry.pendingBytes > this.maxPendingBytes) {
        this.log?.warn?.(`[Relay] stream ${streamId} exceeded pre-connect buffer`);
        this._sendFrame(encodeError(streamId, "pre-connect buffer exceeded"));
        entry.closed = true;
        this.streams.delete(streamId);
        return;
      }
      entry.pending.push(payload);
      return;
    }

    const ok = entry.socket.write(payload);
    if (!ok) {
      // Socket buffer full — tell the server to slow down for this stream.
      this._sendJson({ type: "backpressure", streamId, paused: true });
      entry.socket.once("drain", () => {
        this._sendJson({ type: "backpressure", streamId, paused: false });
      });
    }
  }

  _handleClose(streamId) {
    const entry = this.streams.get(streamId);
    if (!entry) return;
    // Mark first: if the socket does not exist yet, _handleOpen checks this flag
    // after its await and abandons the connect instead of leaking a socket.
    entry.closed = true;
    entry.socket?.end();
    entry.session?.close("server closed the stream");
    this._closeStream(streamId);
  }

  _closeStream(streamId) {
    const entry = this.streams.get(streamId);
    if (!entry) return;
    entry.closed = true;
    this.streams.delete(streamId);
    try { entry.socket?.destroy(); } catch { /* already gone */ }
    try { entry.session?.close("stream closed"); } catch { /* already gone */ }
  }

  _startPing() {
    this._stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState !== 1) return;
      if (Date.now() - this.lastPongAt > this.pongTimeoutMs) {
        // Said by the supervisor, once, as a lost link — not here as well.
        this.log?.debug?.(`no pong for ${Math.round(this.pongTimeoutMs / 1000)}s — dropping the link`);
        if (this._abandon) this._abandon();
        else try { this.ws.close(); } catch { /* ignore */ }
        return;
      }
      this._sendFrame(encodeFrame(OP.PING, 0));
    }, this.pingIntervalMs);
    if (this.pingTimer.unref) this.pingTimer.unref();
  }

  _stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  _teardown() {
    this._stopPing();
    for (const streamId of [...this.streams.keys()]) this._closeStream(streamId);
  }

  _emitStatus(state, info = null) {
    try { this.onStatus?.(state, this.getStats(), info); } catch { /* observer must not break the agent */ }
  }

  getStats() {
    return { ...this.stats, activeStreams: this.streams.size, connected: this.ws?.readyState === 1 };
  }

  stop(reason = "stopped") {
    this.closed = true;
    this._teardown();
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    this.log?.debug?.(`agent stopped: ${reason}`);
  }
}
