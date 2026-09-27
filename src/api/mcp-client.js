/**
 * A minimal client for aile's own MCP server (`<server>/mcp`), for the one thing
 * the CLI needs from it: calling other agents' tools (`aile agents`).
 *
 * WHY MCP AND NOT A REST CALL. Finding and calling another agent's tool is an MCP
 * surface on the server (`find_agent_tools`, `use_agent_tool`), with its own
 * payment handling — the price comes back as a tool RESULT, not an HTTP 402,
 * because one JSON-RPC response is 200 whatever happened. Speaking the protocol
 * the server already serves keeps one implementation of that on the server.
 *
 * NO DEPENDENCIES, ON PURPOSE (see test/branding.test.js). Streamable HTTP is a
 * POST of one JSON-RPC message, answered with either JSON or a short SSE stream;
 * that is all this needs to read. Same transport rules as `api/client.js`:
 * https unless waived, redirects not followed, Cloudflare Access headers passed.
 *
 * RETIRED TOOL NAMES. The server renamed `find_mcp_capacity` → `find_agent_tools`
 * and `rent_capability` → `use_agent_tool`, keeping the old names callable.
 * `callTool` falls back to the old name only when the server answers
 * `unknown_tool`, so this client works against a server from either side of that
 * rename.
 */

import { loadConfig } from "../relay/config.js";
import { accessHeaders } from "./access.js";
import { assertTransportOk } from "./client.js";

const PROTOCOL = "2025-06-18";

/** Current name → the name a server deployed before the rename answers to. */
const RETIRED = {
  find_agent_tools: "find_mcp_capacity",
  use_agent_tool: "rent_capability",
};

export class McpCallError extends Error {
  constructor(message, code = null) {
    super(message);
    this.name = "McpCallError";
    this.code = code;
  }
}

/**
 * Open a session. `key` is a buyer key (`sk-aile-…`) or null for a keyless
 * session, which pays each call from the caller's own wallet (x402).
 */
export async function connectMcp({ serverUrl, key = null, insecure = false, timeoutMs = 120_000 } = {}) {
  const base = String(serverUrl || loadConfig().serverUrl).replace(/\/+$/, "");
  assertTransportOk(base, { insecure });
  const url = `${base}/mcp`;
  let session = null;
  let seq = 0;

  async function post(message, extraHeaders = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": PROTOCOL,
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          ...(session ? { "mcp-session-id": session } : {}),
          ...accessHeaders(),
          ...extraHeaders,
        },
        body: JSON.stringify(message),
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (e) {
      if (e.name === "AbortError") throw new Error(`no response from ${base} after ${timeoutMs}ms`);
      throw new Error(`cannot reach ${base}: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
    session = res.headers.get("mcp-session-id") || session;
    const text = await res.text();
    if (res.status === 401) throw new McpCallError("The server refused the credential for its MCP endpoint.", "unauthorized");
    if (res.status === 404) throw new McpCallError("This server has no MCP endpoint turned on.", "not_found");
    if (message.id === undefined) return null;
    const reply = parseReply(text, res.headers.get("content-type") || "");
    if (!reply) throw new McpCallError(`The MCP endpoint answered ${res.status} with nothing readable.`);
    if (reply.error) throw new McpCallError(reply.error.message || "MCP error", reply.error.code ?? null);
    return reply.result;
  }

  await post({
    jsonrpc: "2.0", id: ++seq, method: "initialize",
    params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "aile-cli", version: "1" } },
  });
  await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  /**
   * Call a tool. Resolves `{isError, data, structured, raw}`: `data` is the
   * result's text parsed as JSON when it is JSON, `structured` its
   * `structuredContent`. `headers` rides on this one request — a payment.
   */
  async function callTool(name, args = {}, { headers = {} } = {}) {
    const once = async (n) => readResult(await post({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name: n, arguments: args } }, headers));
    const first = await once(name);
    if (first.isError && first.data?.error === "unknown_tool" && RETIRED[name]) return once(RETIRED[name]);
    return first;
  }

  return { callTool, url };
}

/** One JSON-RPC message from a JSON body, or the first one carrying an id from an SSE stream. */
function parseReply(text, contentType) {
  if (!text) return null;
  if (contentType.includes("text/event-stream")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (!data) continue;
      try {
        const msg = JSON.parse(data);
        if (msg && msg.id !== undefined) return msg;
      } catch { /* not a message */ }
    }
    return null;
  }
  try { return JSON.parse(text); } catch { return null; }
}

function readResult(result) {
  const text = (result?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("");
  let data = null;
  try { data = JSON.parse(text); } catch { /* plain text */ }
  return { isError: Boolean(result?.isError), data, text, structured: result?.structuredContent ?? null, raw: result };
}
