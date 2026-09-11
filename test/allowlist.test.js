import { describe, expect, it } from "bun:test";
import {
  isPublicIp,
  isAllowedHost,
  getAllowedHosts,
  assertTargetAllowed,
} from "../src/relay/allowlist.js";

describe("relay egress allowlist", () => {
  describe("isPublicIp", () => {
    it("accepts public IPv4", () => {
      for (const ip of ["1.1.1.1", "8.8.8.8", "104.18.32.7", "203.0.100.5"]) {
        expect(isPublicIp(ip)).toBe(true);
      }
    });

    // These are the addresses an open-proxy attack would target.
    it("rejects loopback, private, link-local, CGNAT and metadata addresses", () => {
      for (const ip of [
        "127.0.0.1", "127.1.2.3",
        "10.0.0.1", "10.255.255.255",
        "172.16.0.1", "172.31.255.254",
        "192.168.0.1", "192.168.1.1",
        "169.254.169.254",            // cloud metadata — credential theft
        "100.64.0.1",                 // CGNAT
        "0.0.0.0",
        "224.0.0.1",                  // multicast
      ]) {
        expect(isPublicIp(ip)).toBe(false);
      }
    });

    it("does not treat 172.15/172.32 as private (boundary)", () => {
      expect(isPublicIp("172.15.0.1")).toBe(true);
      expect(isPublicIp("172.32.0.1")).toBe(true);
    });

    it("rejects IPv6 loopback, link-local and unique-local", () => {
      for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1"]) {
        expect(isPublicIp(ip)).toBe(false);
      }
    });

    it("accepts public IPv6", () => {
      expect(isPublicIp("2606:4700:4700::1111")).toBe(true);
    });

    it("judges IPv4-mapped IPv6 by the embedded address", () => {
      expect(isPublicIp("::ffff:127.0.0.1")).toBe(false);
      expect(isPublicIp("::ffff:192.168.1.1")).toBe(false);
      expect(isPublicIp("::ffff:1.1.1.1")).toBe(true);
    });

    it("rejects non-IP input", () => {
      for (const v of ["", "not-an-ip", "999.1.1.1", null, undefined]) {
        expect(isPublicIp(v)).toBe(false);
      }
    });
  });

  describe("isAllowedHost", () => {
    it("carries a non-empty baked host set", () => {
      expect(getAllowedHosts().size).toBeGreaterThan(20);
    });

    it("contains no local endpoints (they must never be relay targets)", () => {
      for (const h of getAllowedHosts()) {
        expect(h).not.toBe("localhost");
        expect(h.endsWith(".local")).toBe(false);
        expect(h.endsWith(".internal")).toBe(false);
        expect(h.includes(".")).toBe(true);
      }
    });

    it("allows known provider hosts", () => {
      expect(isAllowedHost("api.anthropic.com")).toBe(true);
      expect(isAllowedHost("chatgpt.com")).toBe(true);
    });

    it("is case-insensitive and tolerates a trailing dot", () => {
      expect(isAllowedHost("API.ANTHROPIC.COM")).toBe(true);
      expect(isAllowedHost("api.anthropic.com.")).toBe(true);
    });

    it("allows subdomains of a provider host", () => {
      expect(isAllowedHost("eu.api.anthropic.com")).toBe(true);
    });

    it("rejects unknown hosts and lookalike suffixes", () => {
      for (const h of [
        "evil.com",
        "localhost",
        "api.anthropic.com.evil.com",   // suffix-append attack
        "notanthropic.com",
        "",
        null,
      ]) {
        expect(isAllowedHost(h)).toBe(false);
      }
    });
  });

  describe("assertTargetAllowed", () => {
    it("refuses a non-443 port", async () => {
      await expect(assertTargetAllowed("api.anthropic.com", 8080)).rejects.toThrow(/not allowed/);
    });

    it("refuses a raw IP target", async () => {
      await expect(assertTargetAllowed("1.1.1.1", 443)).rejects.toThrow(/not a raw IP/);
      await expect(assertTargetAllowed("127.0.0.1", 443)).rejects.toThrow(/not a raw IP/);
    });

    it("refuses a host outside the provider list", async () => {
      await expect(assertTargetAllowed("evil.com", 443)).rejects.toThrow(/not a known provider/);
    });

    it("refuses localhost by name", async () => {
      await expect(assertTargetAllowed("localhost", 443)).rejects.toThrow(/not a known provider/);
    });
  });
});
