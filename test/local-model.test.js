/**
 * Self-hosted model lending.
 *
 * The security property under test is narrow and important: turning on local
 * lending must not hand the relay server the ability to name a target. The
 * egress allowlist stops the server aiming this node at a LAN address; this
 * feature would undo that if LOCAL_OPEN carried a host, so these tests assert
 * that it does not and that the node-side endpoint is itself constrained.
 */

import { describe, test, expect } from "bun:test";
import {
  parseLocalEndpoint, resolveLocalTarget, discoverLocalModels, buildLocalCapability,
  isLocalAddress,
} from "../src/relay/local.js";
import { OP, encodeLocalOpen, decodeFrame } from "../src/relay/framing.js";
import { validatePatch, merge, SCHEMA } from "../src/config/settings.js";

describe("LOCAL_OPEN names no target", () => {
  test("the frame carries an empty payload", () => {
    const { op, streamId, payload } = decodeFrame(encodeLocalOpen(7));
    expect(op).toBe(OP.LOCAL_OPEN);
    expect(streamId).toBe(7);
    // The whole point: nothing in this frame can express a host or a port, so a
    // hostile server cannot use it to reach into the lender's network.
    expect(payload.length).toBe(0);
  });

  test("its opcode does not collide with the relay ops", () => {
    const codes = Object.values(OP);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("the local endpoint is constrained node-side", () => {
  test("a public address is refused", async () => {
    // Otherwise the node becomes an open proxy to a third party, on the
    // lender's IP — the same failure the egress allowlist exists to prevent.
    await expect(resolveLocalTarget("https://1.1.1.1")).rejects.toThrow(/public address/);
  });

  test("a public hostname is refused", async () => {
    await expect(resolveLocalTarget("http://api.openai.com")).rejects.toThrow(/public address/);
  });

  test("loopback is allowed", async () => {
    const t = await resolveLocalTarget("http://127.0.0.1:11434");
    expect(t.host).toBe("127.0.0.1");
    expect(t.port).toBe(11434);
  });

  test("a private LAN address is allowed", async () => {
    const t = await resolveLocalTarget("http://192.168.1.50:8000");
    expect(t.port).toBe(8000);
  });

  test("a non-http scheme is refused", () => {
    expect(() => parseLocalEndpoint("ftp://127.0.0.1")).toThrow(/http:\/\/ or https:\/\//);
  });

  test("an endpoint with a path is refused rather than silently mangled", () => {
    // The server supplies the request path, so a base path here would produce a
    // wrong URL with no error. Say so at config time instead.
    expect(() => parseLocalEndpoint("http://127.0.0.1:11434/v1")).toThrow(/no path/);
  });

  test("an unset endpoint explains what to do", () => {
    expect(() => parseLocalEndpoint("")).toThrow(/aile config localEndpoint/);
  });

  test("the default port follows the scheme", () => {
    expect(parseLocalEndpoint("http://127.0.0.1").port).toBe(80);
    expect(parseLocalEndpoint("https://127.0.0.1").port).toBe(443);
  });
});

describe("the local-address check is independent of the egress allowlist", () => {
  // Regression: this module first borrowed `isPublicIp` from allowlist.js, which
  // three other test files replace with `() => true` via mock.module. Bun applies
  // those mocks process-wide, so a passing check here silently became a
  // rubber stamp depending on which files ran. Beyond the test artifact, the two
  // modules enforce opposite rules and must not share one predicate.
  test("loopback and private ranges are local", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "192.168.1.50", "::1", "fe80::1", "fd00::1"]) {
      expect(isLocalAddress(ip)).toBe(true);
    }
  });

  test("routable addresses are not local", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "172.32.0.1", "2606:4700::1111"]) {
      expect(isLocalAddress(ip)).toBe(false);
    }
  });

  test("an IPv4-mapped IPv6 loopback is judged by the embedded address", () => {
    expect(isLocalAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLocalAddress("::ffff:1.1.1.1")).toBe(false);
  });

  test("nonsense is not local", () => {
    expect(isLocalAddress("not-an-ip")).toBe(false);
    expect(isLocalAddress("")).toBe(false);
  });
});

describe("settings", () => {
  test("lending is off by default", () => {
    expect(SCHEMA.localEnabled.default).toBe(false);
    expect(SCHEMA.localEndpoint.default).toBe("");
  });

  test("it cannot be enabled without an endpoint", () => {
    const res = validatePatch({ localEnabled: true });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/localEndpoint must be set/);
  });

  test("it can be enabled together with an endpoint", () => {
    const res = validatePatch({ localEndpoint: "http://127.0.0.1:11434", localEnabled: true });
    expect(res.ok).toBe(true);
  });

  test("turning it off is always allowed", () => {
    expect(validatePatch({ localEnabled: false }).ok).toBe(true);
  });

  test("a stored half-configuration reads back as off rather than crashing", () => {
    // Lenient reads: a hand-edited file must not brick the CLI that fixes it.
    expect(merge({ localEnabled: true }).localEnabled).toBe(false);
  });
});

describe("model discovery", () => {
  test("configured names win without any network call", async () => {
    const models = await discoverLocalModels(
      { localModels: "llama3, mistral ,", localEndpoint: "http://127.0.0.1:11434" },
      { fetchImpl: () => { throw new Error("must not be called"); } },
    );
    expect(models).toEqual(["llama3", "mistral"]);
  });

  test("an unreachable endpoint yields no models rather than throwing", async () => {
    // Advertising nothing is correct here; refusing to be a node is not.
    const models = await discoverLocalModels(
      { localModels: "", localEndpoint: "http://127.0.0.1:1" },
      { fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")) },
    );
    expect(models).toEqual([]);
  });

  test("the endpoint is asked when no names are configured", async () => {
    const models = await discoverLocalModels(
      { localModels: "", localEndpoint: "http://127.0.0.1:11434" },
      { fetchImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [{ id: "qwen" }] }) }) },
    );
    expect(models).toEqual(["qwen"]);
  });
});

describe("capability advertisement", () => {
  test("nothing is advertised while lending is off", async () => {
    expect(await buildLocalCapability({ localEnabled: false })).toBeNull();
  });

  test("a misconfigured endpoint advertises nothing instead of failing the node", async () => {
    // Subscription relaying is unaffected by a broken local endpoint and must
    // keep working.
    const cap = await buildLocalCapability({
      localEnabled: true, localEndpoint: "https://1.1.1.1", localModels: "",
    });
    expect(cap).toBeNull();
  });

  test("the advertisement states plainly that this path is not blind", async () => {
    const cap = await buildLocalCapability(
      { localEnabled: true, localEndpoint: "http://127.0.0.1:11434", localModels: "llama3" },
    );
    // A buyer must be able to tell the two kinds of capacity apart, so the flag
    // travels with the capability rather than living only in documentation.
    expect(cap.blind).toBe(false);
    expect(cap.models).toEqual(["llama3"]);
  });
});
