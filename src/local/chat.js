/**
 * Talking to the local model directly, the way a buyer's request will.
 *
 * `chatOnce` is the check `aile local setup` runs before it calls a model
 * ready — the same shape of request as the relay's own known-answer probe
 * (`POST /v1/chat/completions`, the model named exactly as advertised). A
 * model that loads but cannot answer is caught here, not by the first buyer.
 *
 * `chatStream` is `aile local run`: tokens printed as they arrive.
 */

export class ChatError extends Error {
  constructor(message, { status = null } = {}) { super(message); this.name = "ChatError"; this.status = status; }
}

async function post(base, body, { timeoutMs, signal, fetchImpl = fetch }) {
  const ctl = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  const onAbort = () => ctl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetchImpl(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: body.stream ? "text/event-stream" : "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) {
      let msg = "";
      try { const t = await res.text(); try { const j = JSON.parse(t); msg = j?.error?.message || j?.error || t; } catch { msg = t; } } catch { /* none */ }
      throw new ChatError(`the model answered HTTP ${res.status}${msg ? `: ${String(msg).slice(0, 200)}` : ""}`, { status: res.status });
    }
    return { res, done: () => { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", onAbort); } };
  } catch (e) {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    if (e.name === "AbortError" && !signal?.aborted) throw new ChatError(`no answer within ${Math.round(timeoutMs / 1000)}s`);
    throw e;
  }
}

/**
 * One short completion. Resolves `{text, ms, usage}`.
 * `ms` includes loading the model when it is not loaded yet.
 */
export async function chatOnce({ base, model, prompt, maxTokens = 64, timeoutMs = 180_000, signal, fetchImpl }) {
  const started = Date.now();
  const { res, done } = await post(base, {
    model, stream: false, max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  }, { timeoutMs, signal, fetchImpl });
  try {
    const j = await res.json();
    const text = j?.choices?.[0]?.message?.content ?? "";
    return { text: String(text), ms: Date.now() - started, usage: j?.usage || null };
  } finally {
    done();
  }
}

/** Stream a reply: yields text deltas, then returns `{usage}` when the server sends one. */
export async function* chatStream({ base, model, messages, maxTokens = null, signal, fetchImpl }) {
  const { res, done } = await post(base, {
    model, stream: true, messages, ...(maxTokens ? { max_tokens: maxTokens } : {}),
    stream_options: { include_usage: true },
  }, { timeoutMs: 0, signal, fetchImpl });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let usage = null;
  try {
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return { usage };
        let j;
        try { j = JSON.parse(data); } catch { continue; }
        if (j.usage) usage = j.usage;
        const delta = j?.choices?.[0]?.delta;
        const piece = delta?.content ?? "";
        if (piece) yield piece;
      }
    }
    return { usage };
  } finally {
    done();
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}
