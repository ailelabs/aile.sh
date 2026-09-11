/**
 * One rented MCP session: a sandboxed child's stdio, pumped onto the relay.
 *
 * The node does not parse MCP. It moves bytes between the WebSocket and the
 * container's stdin/stdout exactly as it moves TLS records for a provider
 * stream — PROTOCOL.md §1's "the node never parses DATA" is unchanged here. The
 * MCP client lives server-side; this file is the pipe.
 *
 * THREE THINGS HERE ARE NOT INCIDENTAL
 * ------------------------------------
 *
 *  1. **DATA that arrives before stdin exists is BUFFERED, not dropped.** The
 *     server pipelines the MCP `initialize` request immediately behind
 *     MCP_OPEN, and a container takes a moment to start, so the first request
 *     routinely arrives first. `test/open-race.test.js` exists because exactly
 *     this bug shipped once on the provider path; the same shape is re-armed by
 *     a spawn, so the same fix is applied. Bounded, so a server that floods a
 *     stream whose container never starts cannot exhaust memory.
 *
 *  2. **stderr NEVER reaches the wire.** An MCP stdio server logs to stderr by
 *     convention, and `claude mcp serve --debug` writes there too. Anything but
 *     JSON-RPC on the stream corrupts the session, and worse, stderr is where a
 *     crashing child prints its environment, its paths and sometimes its
 *     credentials. It goes to this node's own debug log and nowhere else.
 *
 *  3. **Two timers, both owned here.** The relay's socket idle timeout governs
 *     TCP sockets and there is no socket here. A wall clock bounds one session
 *     absolutely; an idle timer ends a session whose renter walked away. Without
 *     them a container with a hung child lives until the node restarts.
 */

import { spawnServer } from "./sandbox.js";

/** Bytes held for a stream whose container has not started yet. */
export const MAX_PENDING_BYTES = 256 * 1024;

/** No traffic either way for this long ends the session. */
export const IDLE_TIMEOUT_MS = 120000;

/**
 * A live MCP session.
 *
 * Constructed by `relay/agent.js` on MCP_OPEN. Everything it emits goes through
 * the three callbacks, so the agent owns framing and this file owns the child.
 */
export class McpSession {
  constructor({
    server,
    streamId,
    runtime = null,
    onData,
    onClose,
    onError,
    log = console,
    spawnImpl = undefined,
    maxPendingBytes = MAX_PENDING_BYTES,
    idleTimeoutMs = IDLE_TIMEOUT_MS,
  }) {
    this.server = server;
    this.streamId = streamId;
    this.runtime = runtime;
    this.onData = onData;
    this.onClose = onClose;
    this.onError = onError;
    this.log = log;
    this.spawnImpl = spawnImpl;
    this.maxPendingBytes = maxPendingBytes;
    this.idleTimeoutMs = idleTimeoutMs;

    this.child = null;
    this.name = null;
    this.kill = null;
    this.closed = false;
    this.pending = [];
    this.pendingBytes = 0;
    this.wallTimer = null;
    this.idleTimer = null;
    this.bytesIn = 0;
    this.bytesOut = 0;
  }

  /**
   * Start the container.
   *
   * Synchronous by design: `write` may be called on the very next line, and an
   * async start would put an await between the caller's registration and the
   * child's existence — the exact window rule 1 is about. `spawn` does not wait
   * for the process either way, so the buffering below still carries the race;
   * this only keeps it to ONE mechanism rather than two.
   */
  start() {
    if (this.child || this.closed) return;
    let handle;
    try {
      handle = spawnServer(this.server, {
        streamId: this.streamId,
        runtime: this.runtime,
        spawnImpl: this.spawnImpl,
        log: this.log,
      });
    } catch (e) {
      this._fail(e.message);
      return;
    }
    this.child = handle.child;
    this.name = handle.name;
    this.kill = handle.kill;

    this.child.stdout.on("data", (chunk) => {
      this.bytesOut += chunk.length;
      this._touch();
      this.onData?.(chunk);
    });

    // See rule 2. Never `onData`, never a frame, not at any log level.
    this.child.stderr.on("data", (chunk) => {
      const text = String(chunk).trimEnd();
      if (text) this.log?.debug?.(`[MCP ${this.server.id}] ${text.slice(0, 2000)}`);
    });

    // A broken pipe here is the container having exited; `close` reports it
    // with an exit code, which is the more useful of the two messages.
    this.child.stdin.on("error", () => {});
    this.child.on("error", (e) => this._fail(`sandbox failed to start: ${e.message}`));

    this.child.on("close", (code) => {
      if (this.closed) return;
      if (code !== 0 && code !== null && this.bytesOut === 0) {
        // Exited without ever answering: the image is wrong, the command is
        // wrong, or the runtime refused it. That is a lender-side fault and the
        // renter should be told it was, not left waiting for a timeout.
        this._fail(`MCP server "${this.server.id}" exited immediately (code ${code})`);
        return;
      }
      this.close("sandbox exited");
    });

    // Flush whatever arrived while the container was starting, in order.
    for (const chunk of this.pending) this._writeNow(chunk);
    this.pending.length = 0;
    this.pendingBytes = 0;

    this.wallTimer = setTimeout(() => {
      this._fail(`MCP session exceeded ${this.server.timeoutMs}ms`);
    }, this.server.timeoutMs);
    if (this.wallTimer.unref) this.wallTimer.unref();
    this._touch();
  }

  /** Bytes from the server, bound for the child's stdin. */
  write(chunk) {
    if (this.closed) return;
    this.bytesIn += chunk.length;
    this._touch();

    if (!this.child) {
      this.pendingBytes += chunk.length;
      if (this.pendingBytes > this.maxPendingBytes) {
        this._fail("pre-start buffer exceeded");
        return;
      }
      this.pending.push(chunk);
      return;
    }
    this._writeNow(chunk);
  }

  _writeNow(chunk) {
    try {
      this.child.stdin.write(chunk);
    } catch (e) {
      this._fail(`sandbox stdin closed: ${e.message}`);
    }
  }

  _touch() {
    if (this.closed) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this._fail(`MCP session idle for ${this.idleTimeoutMs}ms`);
    }, this.idleTimeoutMs);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  _fail(message) {
    if (this.closed) return;
    this._stop();
    this.onError?.(message);
  }

  /** End the session cleanly. Idempotent — every path here may run twice. */
  close(reason = "closed") {
    if (this.closed) return;
    this._stop();
    this.onClose?.(reason);
  }

  _stop() {
    this.closed = true;
    if (this.wallTimer) clearTimeout(this.wallTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.wallTimer = null;
    this.idleTimer = null;
    this.pending.length = 0;
    this.pendingBytes = 0;
    try { this.kill?.("session ended"); } catch { /* already gone */ }
    this.child = null;
  }

  stats() {
    return { streamId: this.streamId, serverId: this.server.id, bytesIn: this.bytesIn, bytesOut: this.bytesOut };
  }
}
