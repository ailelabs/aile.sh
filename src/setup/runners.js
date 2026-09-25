/**
 * How to start a tool so that it talks to aile, without editing any of its files.
 *
 * One table, three consumers: `aile run <tool>` spawns from it, `aile env <tool>`
 * prints it, and a shortcut (`claudeaile`) is it written into a script. Keeping
 * them one table is what makes "the shortcut does exactly what `aile run` does"
 * true by construction.
 *
 * `env` is what the tool reads; `unset` is what must NOT be in its environment
 * (Claude Code sends ANTHROPIC_API_KEY as a second, conflicting credential if a
 * shell exported one); `args` go before anything the user typed.
 *
 * The key travels in the environment, never on the command line: argv is
 * visible to every process on the machine (`ps`, Task Manager), the
 * environment is not.
 */

export const RUNNERS = {
  claude: {
    label: "Claude Code",
    bin: "claude",
    // No model: Claude Code's own default and its `/model` rows are bare
    // `claude-*` ids, which aile routes to the claude provider for this client.
    env: (c) => ({
      ANTHROPIC_BASE_URL: c.anthropicBase,
      ANTHROPIC_AUTH_TOKEN: c.key,
      // Adds every Claude model aile can serve to the `/model` picker.
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      ...(c.model ? { ANTHROPIC_MODEL: c.model } : {}),
    }),
    unset: ["ANTHROPIC_API_KEY"],
    args: () => [],
  },
  codex: {
    label: "Codex",
    bin: "codex",
    // `-c` overrides define an `aile` provider for this run only. Values are
    // written unquoted: Codex parses each as TOML and falls back to the raw
    // string, and an unquoted value survives cmd.exe, PowerShell and sh alike.
    // No model unless asked: Codex's own default is a bare id aile routes to
    // the codex provider for this client.
    env: (c) => ({ AILE_API_KEY: c.key }),
    unset: [],
    args: (c) => [
      "-c", "model_provider=aile",
      "-c", "model_providers.aile.name=aile",
      "-c", `model_providers.aile.base_url=${c.openaiBase}`,
      "-c", "model_providers.aile.wire_api=responses",
      "-c", "model_providers.aile.env_key=AILE_API_KEY",
      ...(c.model ? ["-c", `model=${c.model}`] : []),
    ],
  },
  qwen: {
    label: "Qwen Code",
    bin: "qwen",
    env: (c) => ({ OPENAI_BASE_URL: c.openaiBase, OPENAI_API_KEY: c.key, OPENAI_MODEL: c.model || c.defaultModel }),
    unset: [],
    args: () => [],
  },
  aider: {
    label: "Aider",
    bin: "aider",
    // `openai/<id>` tells aider's model layer to use the OpenAI-compatible
    // route; it strips that one prefix and sends aile the rest verbatim.
    env: (c) => ({ OPENAI_API_BASE: c.openaiBase, OPENAI_API_KEY: c.key }),
    unset: [],
    args: (c) => ["--model", `openai/${c.model || c.defaultModel}`],
  },
  goose: {
    label: "Goose",
    bin: "goose",
    env: (c) => ({
      GOOSE_PROVIDER: "openai",
      OPENAI_HOST: c.serverUrl,
      OPENAI_BASE_PATH: "v1/chat/completions",
      OPENAI_API_KEY: c.key,
      GOOSE_MODEL: c.model || c.defaultModel,
    }),
    unset: [],
    args: () => [],
  },
};

export const RUNNER_IDS = Object.keys(RUNNERS);

/** Tools whose default model aile has to choose (they have no picker of their own). */
export const NEEDS_MODEL = new Set(["qwen", "aider", "goose"]);

/**
 * The full launch recipe for one tool: `{bin, env, unset, args}`.
 * `c` carries `key`, the two bases, `serverUrl`, and optionally `model` and
 * `defaultModel`.
 */
export function recipe(tool, c) {
  const r = RUNNERS[tool];
  if (!r) return null;
  return { bin: r.bin, label: r.label, env: r.env(c), unset: r.unset, args: r.args(c) };
}

/** A child environment: ours laid over the caller's, with conflicts removed. */
export function childEnv(base, rec) {
  const out = { ...base };
  for (const name of rec.unset) {
    for (const k of Object.keys(out)) if (k.toLowerCase() === name.toLowerCase()) delete out[k];
  }
  return { ...out, ...rec.env };
}
