/**
 * A minimal MCP client, for `aile mcp test` and nothing else.
 *
 * WHY THIS EXISTS WHEN THE NODE DELIBERATELY DOES NOT SPEAK MCP
 * ------------------------------------------------------------
 * The relay path is a byte pipe: `mcp/stream.js` never parses a message, and
 * that is the design (PROTOCOL.md §1). But a lender configuring a server needs
 * to find out on their own machine whether it starts, whether the sandbox lets
 * it run, and what it exposes — BEFORE a renter pays to discover otherwise.
 * Sending them to the server to find out means a failed rent is the diagnostic.
 *
 * So this is a LOCAL TOOL, imported by the CLI and by nothing on the relay path.
 * It is deliberately small: `initialize`, `notifications/initialized`,
 * `tools/list`. It is not a general MCP implementation and must not grow into
 * one — the authoritative client is the SDK one on the server side, and two
 * implementations that both matter is how they drift.
 */

import { McpSession } from "./stream.js";

const PROTOCOL_VERSION = "2025-06-18";

/**
 * Newline-delimited JSON-RPC reassembly.
 *
 * stdio MCP frames messages by newline, and a pipe read boundary has nothing to
 * do with a message boundary — a `tools/list` answer from a real server arrives
 * in several chunks and two answers can arrive in one. Splitting per chunk
 * rather than across chunks is the bug this class exists to not have.
 */
class LineBuffer {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buf = "";
  }

  push(chunk) {
    this.buf += chunk.toString("utf8");
    let nl;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // A non-JSON line on stdout is a broken server, and saying so beats
        // hanging until the deadline with no explanation.
        this.onMessage({ __parseError: line.slice(0, 200) });
        continue;
      }
      this.onMessage(msg);
    }
  }
}

/**
 * Start the server in its sandbox, handshake, list its tools, stop it.
 *
 * Resolves `{ serverInfo, tools }`. Rejects with the reason a lender can act
 * on — a missing runtime, an image that will not start, a server that answers
 * nothing before the deadline.
 */
export function probeMcpServer(server, { timeoutMs = 60000, log = console } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let nextId = 1;
    const waiting = new Map();

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try { session.close("probe finished"); } catch { /* already gone */ }
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve(value);
    };

    const deadline = setTimeout(() => {
      finish(new Error(`"${server.id}" did not answer within ${timeoutMs}ms`));
    }, timeoutMs);

    const lines = new LineBuffer((msg) => {
      if (msg.__parseError !== undefined) {
        finish(new Error(
          `"${server.id}" wrote non-JSON to stdout: ${JSON.stringify(msg.__parseError)}. ` +
          `An MCP stdio server must log to stderr — anything else corrupts the stream.`,
        ));
        return;
      }
      if (msg.id === undefined) return;   // a notification; nothing waits on one
      const pending = waiting.get(msg.id);
      if (!pending) return;
      waiting.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else pending.resolve(msg.result);
    });

    const session = new McpSession({
      server,
      // Probes are not relay streams and never reach the relay's stream map.
      // A negative id keeps the container name distinguishable in `docker ps`.
      streamId: -1,
      log,
      onData: (chunk) => lines.push(chunk),
      onClose: () => finish(new Error(`"${server.id}" closed before answering`)),
      onError: (message) => finish(new Error(message)),
    });

    const send = (obj) => session.write(Buffer.from(`${JSON.stringify(obj)}\n`, "utf8"));

    const request = (method, params) => new Promise((res, rej) => {
      const id = nextId++;
      waiting.set(id, { resolve: res, reject: rej });
      send({ jsonrpc: "2.0", id, method, params });
    });

    session.start();
    if (session.closed) return;   // start() already failed and reported why

    (async () => {
      const init = await request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "aile.sh", version: "0.1.0" },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const listed = await request("tools/list", {});
      finish(null, {
        serverInfo: init?.serverInfo || null,
        protocolVersion: init?.protocolVersion || null,
        tools: Array.isArray(listed?.tools) ? listed.tools : [],
      });
    })().catch((e) => finish(e));
  });
}
