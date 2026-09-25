/**
 * Is a coding agent running this command — and which one?
 *
 * A different question from detect.js ("what is installed?"): this reads only
 * the environment the calling tool set for its own subprocesses. `aile setup`
 * uses it to pre-select that tool, and to say that a change to its settings
 * reaches its NEXT session, not the one that is running this command.
 *
 * IT NEVER DECIDES WHETHER TO PROMPT. Some of these variables are also set in
 * an editor's integrated terminal, where a person is typing (Claude Code's IDE
 * extension sets CLAUDECODE; every Cursor terminal carries CURSOR_TRACE_ID,
 * which is why that one is not used at all). Whether to ask is decided by
 * whether stdin is a terminal, as everywhere else in this client.
 *
 * ORDER MATTERS, because the tools copy each other's variables: Amp also sets
 * CLAUDECODE, Kilo (an opencode fork) also sets OPENCODE, and Qwen Code (a
 * Gemini CLI fork) may also set GEMINI_CLI. Each more specific tool is checked
 * before the one it imitates.
 *
 * The variable names are facts gathered by is-ai-agent (sdairs; including its
 * recorded environments of real harness runs), Vercel's detect-agent and
 * ai-agent-detect, checked against Claude Code's own env-var documentation.
 * The table and its code are this client's own.
 */

/** `strong`: set only when the tool itself is driving, never in a human's terminal. */
const RULES = [
  { id: "amp", name: "Amp", strong: ["AMP_CURRENT_THREAD_ID"] },
  { id: "claude", name: "Claude Code", strong: ["CLAUDE_CODE_CHILD_SESSION"], weak: ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"] },
  { id: "codex", name: "Codex", strong: ["CODEX_THREAD_ID", "CODEX_CI"], weak: ["CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED"] },
  { id: "kilo", name: "Kilo Code", strong: ["KILO", "KILOCODE_VERSION"] },
  { id: "opencode", name: "opencode", strong: ["OPENCODE_PID"], weak: ["OPENCODE", "OPENCODE_CLIENT"] },
  { id: "qwen", name: "Qwen Code", strong: ["QWEN_CODE"] },
  { id: "gemini", name: "Gemini CLI", weak: ["GEMINI_CLI"] },
  { id: "cursor", name: "Cursor", strong: ["CURSOR_AGENT"], match: { CURSOR_EXTENSION_HOST_ROLE: "agent-exec" } },
  { id: "goose", name: "Goose", weak: ["GOOSE_TERMINAL"], match: { AGENT: "goose" } },
  { id: "crush", name: "Crush", weak: ["CRUSH"], match: { AGENT: "crush" } },
  { id: "openclaw", name: "OpenClaw", weak: ["OPENCLAW_CLI"], match: { OPENCLAW_SHELL: "exec" } },
  { id: "cline", name: "Cline", weak: ["CLINE_ACTIVE", "CLINE_TASK_ID"] },
  { id: "cline", name: "Roo Code", weak: ["ROO_ACTIVE", "ROO_CODE_TASK_ID"] },
  { id: "copilot", name: "GitHub Copilot", strong: ["COPILOT_AGENT_SESSION_ID"], weak: ["COPILOT_CLI"] },
];

const set = (env, k) => env[k] !== undefined && env[k] !== "" && env[k] !== "0" && env[k] !== "false";

/**
 * `AI_AGENT` is the one cross-tool convention, in two spellings:
 * `claude-code_2-1-281_agent` and `name@1.2.3`. Returns the tool's name part.
 */
export function aiAgentName(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return null;
  return v.split("@")[0].split("_")[0] || null;
}

const AI_AGENT_IDS = { "claude-code": "claude", claude: "claude", codex: "codex", crush: "crush", opencode: "opencode", goose: "goose", amp: "amp", gemini: "gemini", "gemini-cli": "gemini", qwen: "qwen", cursor: "cursor", kilo: "kilo" };

/**
 * `{id, name, strong}` for the agent running this process, or null.
 * `id` is a tool id `aile setup` knows where there is one.
 */
export function detectInvoker(env = process.env) {
  for (const r of RULES) {
    const strong = (r.strong || []).some((k) => set(env, k));
    const matched = Object.entries(r.match || {}).some(([k, v]) => String(env[k] || "").toLowerCase() === v);
    const weak = (r.weak || []).some((k) => set(env, k));
    if (strong || matched || weak) return { id: r.id, name: r.name, strong: strong || matched };
  }
  const named = aiAgentName(env.AI_AGENT);
  if (named) {
    return { id: AI_AGENT_IDS[named] || null, name: named, strong: /_agent$/i.test(String(env.AI_AGENT)) };
  }
  // `AGENT=1` (opencode, Kilo) says "an agent" without saying which.
  if (set(env, "AGENT")) return { id: AI_AGENT_IDS[String(env.AGENT).toLowerCase()] || null, name: String(env.AGENT), strong: false };
  return null;
}
