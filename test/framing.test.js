import { describe, expect, it } from "bun:test";
import {
  OP,
  HEADER_SIZE,
  MAX_PAYLOAD,
  encodeFrame,
  encodeOpen,
  encodeError,
  encodeMcpOpen,
  decodeFrame,
  decodeOpenPayload,
  decodeMcpOpenPayload,
  MCP_SERVER_ID_RE,
  FrameReader,
  withLengthPrefix,
} from "../src/relay/framing.js";

describe("relay framing", () => {
  it("round-trips a DATA frame", () => {
    const payload = Buffer.from("opaque tls bytes");
    const decoded = decodeFrame(encodeFrame(OP.DATA, 42, payload));
    expect(decoded.op).toBe(OP.DATA);
    expect(decoded.streamId).toBe(42);
    expect(decoded.payload.equals(payload)).toBe(true);
  });

  it("encodes a header-only frame with an empty payload", () => {
    const frame = encodeFrame(OP.CLOSE, 7);
    expect(frame.length).toBe(HEADER_SIZE);
    const decoded = decodeFrame(frame);
    expect(decoded.op).toBe(OP.CLOSE);
    expect(decoded.streamId).toBe(7);
    expect(decoded.payload.length).toBe(0);
  });

  it("preserves large stream ids (32-bit unsigned)", () => {
    expect(decodeFrame(encodeFrame(OP.DATA, 4294967295, Buffer.from("x"))).streamId).toBe(4294967295);
  });

  it("round-trips an OPEN target", () => {
    const { op, payload } = decodeFrame(encodeOpen(1, "api.openai.com", 443));
    expect(op).toBe(OP.OPEN);
    expect(decodeOpenPayload(payload)).toEqual({ host: "api.openai.com", port: 443 });
  });

  it("rejects an OPEN with an invalid port", () => {
    const bad = encodeFrame(OP.OPEN, 1, Buffer.from(JSON.stringify({ host: "a.com", port: 99999 })));
    expect(() => decodeOpenPayload(decodeFrame(bad).payload)).toThrow(/invalid port/);
  });

  it("rejects an OPEN with no host", () => {
    const bad = encodeFrame(OP.OPEN, 1, Buffer.from(JSON.stringify({ port: 443 })));
    expect(() => decodeOpenPayload(decodeFrame(bad).payload)).toThrow(/missing host/);
  });

  it("rejects a buffer shorter than the header", () => {
    expect(() => decodeFrame(Buffer.alloc(3))).toThrow(/shorter than header/);
  });

  it("rejects an oversized payload at encode time", () => {
    expect(() => encodeFrame(OP.DATA, 1, Buffer.alloc(MAX_PAYLOAD + 1))).toThrow(/exceeds max/);
  });

  it("truncates long error messages", () => {
    expect(decodeFrame(encodeError(1, "e".repeat(5000))).payload.length).toBe(512);
  });

  it("reassembles frames split across arbitrary chunk boundaries", () => {
    const got = [];
    const reader = new FrameReader((f) => got.push(f));
    const wire = Buffer.concat([
      withLengthPrefix(encodeFrame(OP.DATA, 1, Buffer.from("hello"))),
      withLengthPrefix(encodeFrame(OP.DATA, 2, Buffer.from("world"))),
      withLengthPrefix(encodeFrame(OP.CLOSE, 1)),
    ]);

    // Feed one byte at a time — the worst case for a length-prefixed reader.
    for (const byte of wire) reader.push(Buffer.from([byte]));

    expect(got).toHaveLength(3);
    expect(got[0].payload.toString()).toBe("hello");
    expect(got[1].streamId).toBe(2);
    expect(got[2].op).toBe(OP.CLOSE);
  });

  it("emits nothing until a frame is complete", () => {
    const got = [];
    const reader = new FrameReader((f) => got.push(f));
    const full = withLengthPrefix(encodeFrame(OP.DATA, 1, Buffer.from("partial")));
    reader.push(full.subarray(0, full.length - 2));
    expect(got).toHaveLength(0);
    reader.push(full.subarray(full.length - 2));
    expect(got).toHaveLength(1);
  });

  it("rejects a declared length beyond the maximum", () => {
    const reader = new FrameReader(() => {});
    const evil = Buffer.alloc(4);
    evil.writeUInt32BE(MAX_PAYLOAD * 4, 0);
    expect(() => reader.push(evil)).toThrow(/exceeds max/);
  });
});

/**
 * MCP_OPEN, mirroring apps/api/src/lib/framing.test.ts.
 *
 * The two OP tables are maintained by hand in two languages and must not drift,
 * so both sides test the same charset against the same shapes.
 */
describe("MCP_OPEN", () => {
  it("round-trips a serverId", () => {
    const decoded = decodeFrame(encodeMcpOpen(7, "claude-code"));
    expect(decoded.op).toBe(OP.MCP_OPEN);
    expect(decoded.streamId).toBe(7);
    expect(decodeMcpOpenPayload(decoded.payload).serverId).toBe("claude-code");
  });

  it("refuses a bad serverId at BOTH ends, not just at encode", () => {
    // The decoder is what THIS side runs against bytes the server sent. A node
    // must never take an id on trust from the wire — it ends up in a container
    // name — any more than the server takes one on trust from a lender.
    const bad = ["", "../etc/passwd", "has space", "UPPER", "a/b", "x".repeat(65), "-leading", "semi;colon"];
    for (const id of bad) {
      expect(MCP_SERVER_ID_RE.test(id)).toBe(false);
      expect(() => encodeMcpOpen(1, id)).toThrow(/serverId/);
      const forged = encodeFrame(OP.MCP_OPEN, 1, Buffer.from(JSON.stringify({ serverId: id }), "utf8"));
      expect(() => decodeMcpOpenPayload(decodeFrame(forged).payload)).toThrow(/serverId/);
    }
  });

  it("refuses a payload that is not JSON, and one with no serverId at all", () => {
    expect(() => decodeMcpOpenPayload(Buffer.from("not json", "utf8"))).toThrow(/not JSON/);
    expect(() => decodeMcpOpenPayload(Buffer.from("{}", "utf8"))).toThrow(/serverId/);
    expect(() => decodeMcpOpenPayload(Buffer.from('{"serverId":42}', "utf8"))).toThrow(/serverId/);
    expect(() => decodeMcpOpenPayload(Buffer.alloc(0))).toThrow(/not JSON/);
  });

  it("accepts the shapes a real server id takes", () => {
    for (const id of ["a", "claude-code", "my.server_1", "x".repeat(64)]) {
      expect(decodeMcpOpenPayload(decodeFrame(encodeMcpOpen(1, id)).payload).serverId).toBe(id);
    }
  });

  it("keeps every op code distinct", () => {
    const codes = Object.values(OP);
    expect(new Set(codes).size).toBe(codes.length);
    expect(OP.MCP_OPEN).toBe(0x06);
  });
});
