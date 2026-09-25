/**
 * A stub of the aile.sh relay server, for local end-to-end testing.
 *
 * It plays the server half of the protocol honestly: accepts the agent's
 * outbound WebSocket, reads the `hello` capability advertisement, opens streams
 * with OPEN frames, and — crucially — **terminates TLS itself** by running a
 * real TLS client over the frame channel. That is what makes this a genuine
 * end-to-end test rather than a mock: the ciphertext the node forwards is
 * produced by a real TLS session the node has no keys for.
 *
 * Not a production server. It does not verify the node signature against a
 * registered secret (it has no database); it only checks the parameters are
 * present and well-formed.
 */

import { Duplex } from "node:stream";
import tls from "node:tls";
import { OP, encodeFrame, encodeOpen, decodeFrame } from "../../src/relay/framing.js";

export async function startStubServer({ onHello = null } = {}) {
  const state = {
    sockets: new Set(),
    hellos: [],
    /** every DATA payload the node sent up to us — ciphertext, by design */
    bytesFromNode: [],
    errors: [],
    connectCount: 0,
    /** Stop answering PING, imitating a link that went silent without closing. */
    mute: false,
    streams: new Map(), // streamId → Duplex
    /** Set to refuse every /agent upgrade, imitating a node the server has
     *  decided about (wrong owner, unknown node). Cleared by `accept()`. */
    reject: null,
    /** node ids seen at /enroll, so a test can prove a rotation happened */
    enrolled: [],
    /** Set to make /enroll answer 409, imitating a node owned by someone else. */
    enrollConflict: false,
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === "/enroll") {
        const body = await req.json().catch(() => ({}));
        if (state.enrollConflict) {
          return Response.json({ success: false, message: "node belongs to another account" }, { status: 409 });
        }
        state.enrolled.push(body.nodeId);
        return Response.json({ success: true, data: { ok: true, nodeId: body.nodeId }, message: "" });
      }

      if (url.pathname !== "/agent") return new Response("not found", { status: 404 });

      const q = url.searchParams;
      // The real server verifies sig against the node's registered secret.
      for (const p of ["token", "nodeId", "nonce", "sig"]) {
        if (!q.get(p)) return new Response(`missing ${p}`, { status: 401 });
      }
      // The real server answers a refused node with a coarse status and a short
      // body — deliberately, so the endpoint cannot be used to enumerate nodes.
      // The client's job is to report that sentence rather than "websocket error".
      if (state.reject) {
        return new Response(state.reject.body, {
          status: state.reject.status,
          headers: state.reject.headers || {},
        });
      }
      if (srv.upgrade(req, { data: { nodeId: q.get("nodeId"), token: q.get("token") } })) return;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      open(ws) {
        state.connectCount++;
        state.sockets.add(ws);
      },
      message(ws, message) {
        if (typeof message === "string") {
          const msg = JSON.parse(message);
          if (msg.type === "hello") {
            state.hellos.push(msg);
            onHello?.(msg, ws);
          }
          return;
        }
        const { op, streamId, payload } = decodeFrame(Buffer.from(message));
        if (op === OP.DATA) {
          state.bytesFromNode.push(Buffer.from(payload));
          state.streams.get(streamId)?.push(Buffer.from(payload));
        } else if (op === OP.CLOSE) {
          state.streams.get(streamId)?.push(null);
          state.streams.delete(streamId);
        } else if (op === OP.ERR) {
          state.errors.push({ streamId, message: payload.toString("utf8") });
          const d = state.streams.get(streamId);
          if (d) { d.destroy(new Error(payload.toString("utf8"))); state.streams.delete(streamId); }
        } else if (op === OP.PING) {
          if (!state.mute) ws.send(encodeFrame(OP.PONG, streamId));
        }
      },
      close(ws) {
        state.sockets.delete(ws);
        for (const [id, d] of state.streams) { d.push(null); state.streams.delete(id); }
      },
    },
  });

  /** Frame channel → a Duplex that TLS can run over. */
  function openStream(ws, streamId, { host, port }) {
    const duplex = new Duplex({
      read() {},
      write(chunk, _enc, cb) {
        ws.send(encodeFrame(OP.DATA, streamId, chunk));
        cb();
      },
      final(cb) {
        try { ws.send(encodeFrame(OP.CLOSE, streamId)); } catch { /* already closed */ }
        cb();
      },
    });
    // A stream the node refuses is destroyed with an error below. Without a
    // listener that becomes an unhandled 'error' and takes down the test run;
    // callers that care (requestThroughNode) observe it via the TLS socket.
    duplex.on("error", () => {});
    state.streams.set(streamId, duplex);
    ws.send(encodeOpen(streamId, host, port));
    return duplex;
  }

  /**
   * The server-side half of the blind relay: open a stream through the node and
   * speak TLS over it. The node forwards bytes it cannot read.
   */
  async function requestThroughNode(ws, streamId, { host, port, servername, httpRequest }) {
    const duplex = openStream(ws, streamId, { host, port });
    return new Promise((resolve, reject) => {
      const chunks = [];
      const timer = setTimeout(() => reject(new Error("timed out through node")), 15000);
      const sock = tls.connect(
        { socket: duplex, servername, rejectUnauthorized: false },
        () => sock.write(httpRequest)
      );
      sock.on("data", (c) => chunks.push(Buffer.from(c)));
      sock.on("error", (e) => { clearTimeout(timer); reject(e); });
      sock.on("close", () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString("utf8")); });
    });
  }

  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port,
    state,
    firstSocket: () => [...state.sockets][0],
    waitForConnection: async (n = 1, timeoutMs = 10000) => {
      const start = Date.now();
      while (state.connectCount < n || state.sockets.size === 0) {
        if (Date.now() - start > timeoutMs) throw new Error(`no connection #${n} within ${timeoutMs}ms`);
        await Bun.sleep(25);
      }
      return [...state.sockets][0];
    },
    openStream,
    requestThroughNode,
    dropAllConnections: () => {
      for (const ws of state.sockets) { try { ws.close(); } catch { /* ignore */ } }
    },
    /** Refuse every /agent upgrade from now on. `headers` lets a caller imitate
     *  something OTHER than the relay answering — an access portal's redirect. */
    refuse: (status = 403, body = "node does not belong to this renter", headers = {}) => {
      state.reject = { status, body, headers };
    },
    /** Accept again. */
    accept: () => { state.reject = null; },
    /** Keep every socket open but stop answering pings (`false` to resume). */
    mute: (on = true) => { state.mute = on; },
    stop: () => server.stop(true),
  };
}
