/**
 * A stub provider: a real TLS server that answers like an OpenAI-compatible
 * endpoint, including an SSE stream. Standing in for api.openai.com so the
 * end-to-end test exercises real TLS over the relay without leaving the machine.
 */

import tls from "node:tls";
import crypto from "node:crypto";
import forge from "node-forge";

export function makeCert(commonName = "localhost") {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = privateKey.export({ type: "pkcs8", format: "pem" });
  const pki = forge.pki;
  const cert = pki.createCertificate();
  cert.publicKey = pki.publicKeyFromPem(publicKey.export({ type: "spki", format: "pem" }));
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  const attrs = [{ name: "commonName", value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: "subjectAltName", altNames: [{ type: 2, value: commonName }] }]);
  cert.sign(pki.privateKeyFromPem(key), forge.md.sha256.create());
  return { key, cert: pki.certificateToPem(cert) };
}

/** SSE chunks a streaming completion would send, in order. */
export const SSE_TOKENS = ["Hello", " from", " the", " blind", " relay"];

/**
 * `credentials` lets a caller supply a cert it generated earlier — needed when
 * the cert has to be on disk (as a trusted CA) before the code under test is
 * imported. Defaults to a fresh self-signed pair.
 */
export async function startStubProvider({ secretMarker = "SECRET-PROMPT", credentials } = {}) {
  const { key, cert } = credentials || makeCert("localhost");
  const state = { requests: [], sawSecret: false };

  const server = tls.createServer({ key, cert }, (socket) => {
    let buf = "";
    socket.on("data", async (chunk) => {
      buf += chunk.toString("utf8");
      if (!buf.includes("\r\n\r\n")) return; // headers not complete yet
      const request = buf;
      buf = "";
      state.requests.push(request);
      // The provider legitimately CAN see the plaintext — it terminates TLS.
      // The test asserts the relay node cannot.
      if (request.includes(secretMarker)) state.sawSecret = true;

      if (request.startsWith("POST /v1/chat/completions")) {
        socket.write(
          "HTTP/1.1 200 OK\r\n" +
          "Content-Type: text/event-stream\r\n" +
          "x-request-id: stub-req-1\r\n" +
          "Connection: close\r\n" +
          "Transfer-Encoding: chunked\r\n\r\n"
        );
        // Stream token by token with gaps, so ordering is a real assertion.
        for (const token of SSE_TOKENS) {
          const payload = `data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`;
          socket.write(`${payload.length.toString(16)}\r\n${payload}\r\n`);
          await Bun.sleep(15);
        }
        const done = "data: [DONE]\n\n";
        socket.write(`${done.length.toString(16)}\r\n${done}\r\n`);
        socket.write("0\r\n\r\n");
        socket.end();
        return;
      }

      const body = JSON.stringify({ ok: true, path: request.split(" ")[1] });
      socket.write(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" +
        `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`
      );
      socket.end();
    });
    socket.on("error", () => { /* client vanished */ });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    state,
    cert,                                     // so a caller can trust this CA specifically
    stop: () => new Promise((r) => server.close(r)),
  };
}
