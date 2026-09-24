/**
 * Live blindness probe.
 *
 * The unit tests prove the node cannot read buyer traffic against a stub. This
 * proves it against the deployed server and a real provider, on the real
 * network: it runs a genuine relay node, taps every byte the node hands to (and
 * receives from) the WebSocket, then asserts a canary prompt and the buyer's API
 * key appear nowhere in that capture.
 *
 * The tap is at the socket, not in the agent's own logging — the agent is the
 * component whose honesty is in question, so its self-reporting proves nothing.
 *
 * Usage: bun scripts/live-blindness-probe.js
 */

import { RelayAgent } from "../src/relay/agent.js";
import { loadConfig } from "../src/relay/config.js";
import { getNodeId } from "../src/relay/identity.js";

const CANARY_PROMPT = "CANARY-LIVE-PROBE-7d3f91ab";
const CANARY_KEY = "sk-canary-live-probe-4e8c22f0";

const config = loadConfig();
if (!config.renterToken) {
  console.error("not linked — run `aile link` first");
  process.exit(1);
}

const captured = [];
let framesOut = 0, framesIn = 0;

const agent = new RelayAgent({
  serverUrl: config.serverUrl,
  renterToken: config.renterToken,
  nodeId: getNodeId(),
  maxConcurrent: 4,
  log: { warn: (m) => console.log(m), log: () => {} },
});

await agent.connect({
  nodeId: getNodeId(),
  maxConcurrent: 4,
  platform: process.platform,
  claimedConnections: [{ provider: "openai", authType: "oauth", email: "probe@example.com" }],
});

// Tap AFTER connect so the live socket exists. Both directions: what the node
// sends up and what it receives down are equally "what the renter could read".
const ws = agent.ws;
const originalSend = ws.send.bind(ws);
ws.send = (data) => {
  if (typeof data !== "string") { captured.push(Buffer.from(data)); framesOut++; }
  return originalSend(data);
};
const originalOnMessage = ws.onmessage;
ws.onmessage = (ev) => {
  if (typeof ev.data !== "string") { captured.push(Buffer.from(ev.data)); framesIn++; }
  return originalOnMessage.call(ws, ev);
};

console.log(`node ${getNodeId()} connected to ${config.serverUrl}`);
console.log("issuing a buyer request carrying a canary prompt…");

const res = await fetch(`${config.serverUrl}/v1/chat/completions`, {
  method: "POST",
  headers: { authorization: `Bearer ${CANARY_KEY}`, "content-type": "application/json" },
  body: JSON.stringify({
    // Every /v1 request names its provider; a bare id is a 400 that never
    // reaches a node, and the capture would prove nothing.
    model: "openai/gpt-4o",
    messages: [{ role: "user", content: CANARY_PROMPT }],
  }),
});
const bodyText = await res.text();
await Bun.sleep(500);

const forwarded = Buffer.concat(captured);
const asLatin1 = forwarded.toString("latin1");

// The provider must genuinely have answered, or the capture proves nothing:
// an empty exchange trivially contains no canary.
const reachedProvider = /invalid_api_key|Incorrect API key|"choices"/.test(bodyText);

const checks = [
  ["provider actually answered (capture is meaningful)", reachedProvider],
  ["bytes actually crossed the node", forwarded.length > 0],
  ["canary prompt absent from relayed bytes", !forwarded.includes(Buffer.from(CANARY_PROMPT)) && !asLatin1.includes(CANARY_PROMPT)],
  ["buyer API key absent from relayed bytes", !asLatin1.includes(CANARY_KEY)],
  ["'Authorization' header absent from relayed bytes", !/authorization:/i.test(asLatin1)],
  ["no cleartext HTTP request line", !/POST \/v1\/chat\/completions HTTP/.test(asLatin1)],
];

console.log(`\ncaptured ${forwarded.length} bytes (${framesOut} frames out, ${framesIn} in)`);
console.log(`upstream said: ${bodyText.slice(0, 90).replace(/\s+/g, " ")}\n`);

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
}

agent.stop("probe done");
console.log(failed === 0
  ? "\nBLINDNESS HOLDS on live traffic — the node relayed ciphertext only."
  : `\n${failed} CHECK(S) FAILED — the node saw something it must not.`);
process.exit(failed === 0 ? 0 : 1);
