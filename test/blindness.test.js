/**
 * Blindness proof.
 *
 * The design's central claim is that the renter's node cannot read buyer traffic,
 * because TLS is terminated at the relay server and the node only forwards bytes.
 * This verifies it at the socket level: a real TLS session is established *through*
 * a byte-forwarder, and we assert the plaintext never appears in the bytes the
 * forwarder actually handled.
 *
 * The tap sits on the forwarder's own sockets — we do not trust the agent's logging.
 *
 * The negative control is the important half: the same forwarder and the same tap
 * over a *plaintext* origin MUST see the secret. Without it, "secret not found"
 * could just mean the tap captured nothing.
 */

import { describe, expect, it, afterAll } from "bun:test";
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";
import forge from "node-forge";

function makeCert() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = privateKey.export({ type: "pkcs8", format: "pem" });
  const pki = forge.pki;
  const cert = pki.createCertificate();
  cert.publicKey = pki.publicKeyFromPem(publicKey.export({ type: "spki", format: "pem" }));
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  const attrs = [{ name: "commonName", value: "localhost" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] }]);
  cert.sign(pki.privateKeyFromPem(key), forge.md.sha256.create());
  return { key, cert: pki.certificateToPem(cert) };
}

const SECRET = "SUPER-SECRET-BUYER-PROMPT-9f3a2c1b";
const servers = [];

afterAll(() => {
  for (const s of servers) { try { s.close(); } catch { /* ignore */ } }
});

function listen(server) {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

// The renter node: pure byte forwarding, exactly what agent.js does per stream.
async function makeForwarder(originPort) {
  const seen = [];
  const forwarder = net.createServer((clientSock) => {
    const upstream = net.connect({ host: "127.0.0.1", port: originPort });
    clientSock.on("data", (c) => { seen.push(Buffer.from(c)); upstream.write(c); });
    upstream.on("data", (c) => { seen.push(Buffer.from(c)); clientSock.write(c); });
    const close = () => { clientSock.destroy(); upstream.destroy(); };
    clientSock.on("error", close);
    upstream.on("error", close);
    clientSock.on("close", close);
    upstream.on("close", close);
  });
  return { seen, port: await listen(forwarder) };
}

describe("blind relay", () => {
  it("never observes plaintext crossing the forwarder", async () => {
    const { key, cert } = makeCert();

    // Origin: a TLS echo server standing in for the provider.
    const origin = tls.createServer({ key, cert }, (socket) => {
      socket.on("data", (chunk) => socket.write(chunk));
    });
    const originPort = await listen(origin);
    const { seen, port: forwarderPort } = await makeForwarder(originPort);

    // The buyer/server side terminates TLS — the forwarder holds no session keys.
    const echoed = await new Promise((resolve, reject) => {
      const sock = tls.connect(
        { host: "127.0.0.1", port: forwarderPort, servername: "localhost", rejectUnauthorized: false },
        () => sock.write(SECRET)
      );
      sock.once("data", (d) => { resolve(d.toString()); sock.end(); });
      sock.on("error", reject);
      setTimeout(() => reject(new Error("TLS echo timed out")), 10000);
    });

    // The tunnel works end to end...
    expect(echoed).toBe(SECRET);

    // ...and the forwarder saw real traffic...
    expect(seen.length).toBeGreaterThan(0);
    const observed = Buffer.concat(seen);
    expect(observed.length).toBeGreaterThan(0);

    // ...but never the plaintext, in any encoding.
    expect(observed.includes(Buffer.from(SECRET, "utf8"))).toBe(false);
    expect(observed.toString("latin1")).not.toContain(SECRET);
    expect(observed.toString("utf8")).not.toContain(SECRET);
    expect(observed.toString("base64")).not.toContain(Buffer.from(SECRET).toString("base64"));
  }, 30000);

  // Proves the tap above is live. If this ever fails, the blindness assertion is
  // vacuous and the test above means nothing.
  it("NEGATIVE CONTROL: the same tap does see plaintext without TLS", async () => {
    const origin = net.createServer((s) => s.on("data", (c) => s.write(c)));
    const originPort = await listen(origin);
    const { seen, port: forwarderPort } = await makeForwarder(originPort);

    await new Promise((resolve, reject) => {
      const sock = net.connect({ host: "127.0.0.1", port: forwarderPort }, () => sock.write(SECRET));
      sock.once("data", () => { resolve(); sock.end(); });
      sock.on("error", reject);
      setTimeout(() => reject(new Error("echo timed out")), 10000);
    });

    const observed = Buffer.concat(seen);
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.includes(Buffer.from(SECRET, "utf8"))).toBe(true);
  }, 30000);
});
