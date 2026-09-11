/**
 * Binary frame codec for the blind relay channel.
 *
 * Layout: [op:1][streamId:4 BE][payload…]
 * No per-chunk JSON — DATA frames carry opaque TLS bytes and must stay cheap.
 */

export const OP = {
  OPEN: 0x01,   // server→client: open TCP to host:port for this stream
  DATA: 0x02,   // both: opaque bytes
  CLOSE: 0x03,  // both: half/full close
  ERR: 0x04,    // client→server: connect/socket failure
  // server→client: open a stream to the node's OWN self-hosted model.
  // Carries no host and no port, deliberately: the node substitutes the
  // endpoint its owner configured. If the server could name the target this
  // would be an open proxy into the lender's LAN — the precise thing
  // relay/allowlist.js exists to prevent. See relay/local.js.
  LOCAL_OPEN: 0x05,
  // server→client: open a stream to one of the node's OWN sandboxed MCP
  // servers. Carries a `serverId` where LOCAL_OPEN carries nothing, and that
  // difference is NOT a relaxation of the rule above — read it before adding
  // a field here.
  //
  // A host:port is an ADDRESS on this machine's network; a serverId is an
  // opaque KEY into a table this machine's owner wrote (mcp-servers.json).
  // The node resolves it against that table and refuses anything absent from
  // it, so the server can only select among the servers this node already
  // declared in its own `hello`. It cannot name anything the owner did not
  // offer. See mcp/config.js and mcp/stream.js.
  MCP_OPEN: 0x06,
  PING: 0x10,
  PONG: 0x11,
};

/**
 * Node-local MCP server ids. Deliberately narrow: an id crosses the wire, is
 * matched against this node's config, and ends up in a container name, so it
 * holds no path separators, no whitespace and no shell metacharacters.
 *
 * Byte-identical to apps/api/src/lib/framing.ts. The two tables in this file
 * and that one are maintained by hand and must not drift.
 */
export const MCP_SERVER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const HEADER_SIZE = 5;

// 1 MiB. TLS records cap at 16 KiB, so anything near this is malformed or hostile.
export const MAX_PAYLOAD = 1024 * 1024;

export function encodeFrame(op, streamId, payload = null) {
  const body = payload == null
    ? null
    : Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body && body.length > MAX_PAYLOAD) {
    throw new Error(`Frame payload ${body.length} exceeds max ${MAX_PAYLOAD}`);
  }
  const buf = Buffer.allocUnsafe(HEADER_SIZE + (body ? body.length : 0));
  buf.writeUInt8(op, 0);
  buf.writeUInt32BE(streamId >>> 0, 1);
  if (body) body.copy(buf, HEADER_SIZE);
  return buf;
}

export function encodeOpen(streamId, host, port) {
  return encodeFrame(OP.OPEN, streamId, Buffer.from(JSON.stringify({ host, port }), "utf8"));
}

/**
 * Open a stream to the node's own local model. No host, by design — see OP.
 * The payload is empty; everything about the target comes from node-side config.
 */
export function encodeLocalOpen(streamId) {
  return encodeFrame(OP.LOCAL_OPEN, streamId);
}

/**
 * Open a stream to one of this node's own MCP servers.
 *
 * Encoded here only for tests and for symmetry with the server: in production
 * this frame is always inbound. The charset is enforced on encode AND on
 * decode, because the decoder is what runs against bytes the server sent.
 */
export function encodeMcpOpen(streamId, serverId) {
  if (typeof serverId !== "string" || !MCP_SERVER_ID_RE.test(serverId)) {
    throw new Error("MCP_OPEN serverId must match /^[a-z0-9][a-z0-9._-]{0,63}$/");
  }
  return encodeFrame(OP.MCP_OPEN, streamId, Buffer.from(JSON.stringify({ serverId }), "utf8"));
}

export function encodeError(streamId, message) {
  return encodeFrame(OP.ERR, streamId, Buffer.from(String(message).slice(0, 512), "utf8"));
}

export function decodeFrame(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_SIZE) {
    throw new Error("Frame shorter than header");
  }
  const op = buf.readUInt8(0);
  const streamId = buf.readUInt32BE(1);
  const payload = buf.length > HEADER_SIZE ? buf.subarray(HEADER_SIZE) : Buffer.alloc(0);
  if (payload.length > MAX_PAYLOAD) throw new Error("Frame payload exceeds max");
  return { op, streamId, payload };
}

export function decodeOpenPayload(payload) {
  const { host, port } = JSON.parse(payload.toString("utf8"));
  if (typeof host !== "string" || !host) throw new Error("OPEN missing host");
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    throw new Error("OPEN has invalid port");
  }
  return { host, port: portNum };
}

/**
 * The serverId an MCP_OPEN names.
 *
 * A node must never take a target id on trust from the wire any more than the
 * server takes one from a lender — so this validates the charset itself rather
 * than leaving it to the config lookup, which would otherwise see arbitrary
 * strings as object keys.
 */
export function decodeMcpOpenPayload(payload) {
  let parsed;
  try {
    parsed = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new Error("MCP_OPEN payload is not JSON");
  }
  const serverId = parsed?.serverId;
  if (typeof serverId !== "string" || !MCP_SERVER_ID_RE.test(serverId)) {
    throw new Error("MCP_OPEN has invalid serverId");
  }
  return { serverId };
}

/**
 * Length-prefixed reassembler.
 *
 * WebSocket preserves message boundaries, so the agent does not need this — but a
 * raw-TCP carrier (or a test harness splitting writes) does. Frames are prefixed
 * with a 4-byte BE length and re-emitted whole regardless of how reads are chunked.
 */
export class FrameReader {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = this.buffer.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.buffer, Buffer.from(chunk)]);

    for (;;) {
      if (this.buffer.length < 4) return;
      const len = this.buffer.readUInt32BE(0);
      if (len > MAX_PAYLOAD + HEADER_SIZE) throw new Error("Declared frame length exceeds max");
      if (this.buffer.length < 4 + len) return; // wait for the rest
      const frame = this.buffer.subarray(4, 4 + len);
      this.buffer = this.buffer.subarray(4 + len);
      this.onFrame(decodeFrame(frame));
    }
  }
}

export function withLengthPrefix(frame) {
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(frame.length, 0);
  return Buffer.concat([prefix, frame]);
}
