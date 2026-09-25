/**
 * Which models a tool is told about.
 *
 * Claude Code, Codex and opencode (through its plugin) ask aile for the list
 * themselves. Factory Droid, Crush and OpenClaw cannot: each wants its models
 * written into its config, and a tool offered 150 of them is a picker nobody
 * can use. So those get a short list — the Claude and Codex models, which are
 * what coding agents are tuned for — and `--models all` for anyone who wants
 * the rest.
 *
 * The list is read from the public `GET /v1/models`, so it names only what a
 * lender is serving right now.
 */

import { api } from "../api/client.js";

/** `{id, name, context, maxOut}` for every chat model, or [] when unreachable. */
export async function fetchChatModels({ serverUrl, insecure = false } = {}) {
  let res;
  try {
    res = await api.listModels({ serverUrl, insecure, timeoutMs: 10000 });
  } catch {
    return [];
  }
  const rows = Array.isArray(res?.data) ? res.data : [];
  return rows
    .filter((r) => r && typeof r.id === "string" && (!r.type || r.type === "chat"))
    .map((r) => ({
      id: r.id,
      name: typeof r.display_name === "string" && r.display_name ? r.display_name : r.id,
      context: Number(r.context_length) || null,
      maxOut: Number(r.max_output_tokens) || null,
    }));
}

const CORE = /^(cc|claude|codex)\//;

/** The short list for tools that need one written down. */
export function curatedModels(models, { all = false } = {}) {
  if (all) return models;
  const core = models.filter((m) => CORE.test(m.id));
  return core.length ? core : models.slice(0, 12);
}

/** Aile's pick for a tool with no model of its own (aider, qwen, goose). */
export function defaultModel(models) {
  const ids = models.map((m) => m.id);
  const prefer = ["cc/claude-sonnet-5", "codex/gpt-5.5"];
  for (const p of prefer) if (ids.includes(p)) return p;
  return ids.find((id) => /^cc\/claude-sonnet/.test(id))
    || ids.find((id) => /^codex\//.test(id))
    || ids[0]
    // Nothing reachable: still a sensible id, which fails with a clear message
    // naming the model rather than an empty one that fails confusingly.
    || "cc/claude-sonnet-5";
}

export const isClaudeModel = (id) => /^(cc|claude|anthropic)\/.*claude/i.test(String(id));

/** Output ceiling to write into a tool's config: the model's own, capped sensibly. */
export function outputCap(m, cap = 32000) {
  return Math.min(m.maxOut || 16384, cap);
}
