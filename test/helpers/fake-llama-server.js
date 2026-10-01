/**
 * A pretend `llama-server`, run by the engine tests in place of the real
 * binary (`AILE_LLAMA_SERVER_BIN` / `LlamaServer({bin})` with a `.js` path).
 *
 * Reads `--port` and `--alias` as the real one does and serves `/health`,
 * `/v1/models` and a chat completion. `FAKE_LLAMA_CRASH=1` makes it exit at
 * once, for the crash-loop test; `FAKE_LLAMA_ARGS_FILE` records its argv.
 */

import fs from "node:fs";

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };

if (process.env.FAKE_LLAMA_ARGS_FILE) fs.appendFileSync(process.env.FAKE_LLAMA_ARGS_FILE, `${JSON.stringify(argv)}\n`);
if (process.env.FAKE_LLAMA_CRASH === "1") process.exit(3);

const alias = arg("--alias") || "model";
Bun.serve({
  port: Number(arg("--port")),
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/health") return Response.json({ status: "ok" });
    if (pathname === "/v1/models") return Response.json({ object: "list", data: [{ id: alias }] });
    if (pathname === "/v1/chat/completions") return Response.json({ choices: [{ message: { content: "ready" } }], usage: { completion_tokens: 1 } });
    return new Response("not found", { status: 404 });
  },
});
