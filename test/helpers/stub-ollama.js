/**
 * A stand-in for Ollama's HTTP API, for the `aile local` tests.
 *
 * Plays the parts aile uses — version, tags, a streamed pull with per-layer
 * progress, create (in both of its body shapes), copy, delete — plus the
 * OpenAI-compatible chat endpoint a buyer's request reaches. Every call is
 * recorded so a test can assert what aile actually sent.
 *
 * Knobs on the returned `state`: `createShape` ("from" accepts the new body,
 * "modelfile" only the old one, "none" neither, forcing the copy fallback),
 * `pullError` (an `{error}` line mid-pull), `models` (installed names).
 */

export function startStubOllama({ version = "0.12.3", models = [] } = {}) {
  const state = {
    calls: [],
    models: new Set(models),
    createShape: "from",
    pullError: null,
    params: new Map(),
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" ? null : await req.json().catch(() => null);
      state.calls.push({ method: req.method, path: url.pathname, body });

      if (url.pathname === "/api/version") return Response.json({ version });
      if (url.pathname === "/api/tags") {
        return Response.json({ models: [...state.models].map((name) => ({ name: name.includes(":") ? name : `${name}:latest`, size: 4_920_000_000, details: { quantization_level: "Q4_K_M" } })) });
      }
      if (url.pathname === "/api/pull") {
        const tag = body?.model || body?.name;
        const lines = [
          { status: "pulling manifest" },
          { status: "pulling aaa", digest: "sha256:aaa", total: 1000, completed: 0 },
          { status: "pulling aaa", digest: "sha256:aaa", total: 1000, completed: 600 },
          { status: "pulling bbb", digest: "sha256:bbb", total: 200, completed: 200 },
          ...(state.pullError ? [{ error: state.pullError }] : []),
          { status: "pulling aaa", digest: "sha256:aaa", total: 1000, completed: 1000 },
          { status: "verifying sha256 digest" },
          { status: "writing manifest" },
          { status: "success" },
        ];
        if (!state.pullError) state.models.add(tag);
        return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } });
      }
      if (url.pathname === "/api/create") {
        const ok = (state.createShape === "from" && body?.from && body?.model)
          || (state.createShape === "modelfile" && body?.modelfile && body?.name);
        if (!ok) return Response.json({ error: "neither 'from' or 'files' was specified" }, { status: 400 });
        const name = body.model || body.name;
        state.models.add(name);
        state.params.set(name, body.parameters || body.modelfile);
        return Response.json({ status: "success" });
      }
      if (url.pathname === "/api/copy") {
        state.models.add(body.destination);
        return new Response(null, { status: 200 });
      }
      if (url.pathname === "/api/delete") {
        const name = body?.model || body?.name;
        const hit = [...state.models].find((m) => m === name || m === `${name}:latest` || `${m}:latest` === name);
        if (!hit) return Response.json({ error: `model '${name}' not found` }, { status: 404 });
        state.models.delete(hit);
        return new Response(null, { status: 200 });
      }
      if (url.pathname === "/v1/models") {
        return Response.json({ object: "list", data: [...state.models].map((m) => ({ id: m.includes(":") ? m : `${m}:latest` })) });
      }
      if (url.pathname === "/v1/chat/completions") {
        if (body?.stream) {
          const frames = ["Hel", "lo", "!"].map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
          frames.push(`data: ${JSON.stringify({ choices: [], usage: { completion_tokens: 3 } })}\n\n`, "data: [DONE]\n\n");
          return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
        }
        return Response.json({ choices: [{ message: { role: "assistant", content: "ready" } }], usage: { completion_tokens: 1 } });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    state,
    stop: () => { try { server.stop(true); } catch { /* ignore */ } },
  };
}
