/**
 * Models aile knows how to download AND sell.
 *
 * A self-hosted model is sold only under an id with a published list price,
 * and the relay matches that id exactly (`apps/api/src/modules/v1/service.ts`).
 * Ollama's tags (`llama3.1:8b`) and Hugging Face file names are not such ids,
 * so a model pulled under its own name runs but earns nothing. Each row here
 * pairs a download with the priced id it is the same model as, and aile saves
 * the download under that id.
 *
 * EVERY ROW WAS CHECKED, 2026-10-01: the id against the relay's price snapshot
 * (`apps/api/src/lib/providers/priceSnapshot.fixture.json`), the Ollama tag
 * against registry.ollama.ai, and the Hugging Face repo (ungated) and its file
 * size against the hub API. `aile local models` re-asks the server for the
 * live price; a row whose id stops pricing is shown as not sellable rather
 * than trusted.
 *
 * Tags are pinned explicitly because Ollama's short names move: `qwen3:30b`
 * and `deepseek-r1:8b` have each pointed at a different model than the name
 * suggests. A wrong pairing here would sell one model under another's price.
 *
 * A quantised build is sold under the full-precision id. That residual is
 * accepted by the relay (CLAUDE.md §7) and disclosed wherever a price is shown.
 */

const GB = 1e9;

/**
 * @typedef {{
 *   id: string,          // the priced id; what the model is served and sold as
 *   name: string,        // display name
 *   family: string,
 *   params: string,      // "8B", "30B-A3B"
 *   ctx: number,         // the model's context window
 *   license: string,
 *   ollama: string,      // pinned Ollama tag
 *   ollamaBytes: number, // its download size
 *   hf: { repo: string, quant: string, bytes: number }, // GGUF on Hugging Face
 *   tags?: string[],     // "code", "reasoning", "vision"
 * }} CuratedModel
 */

/** @type {CuratedModel[]} */
export const CURATED = [
  { id: "meta-llama/llama-3.2-1b-instruct", name: "Llama 3.2 1B", family: "Llama", params: "1B", ctx: 131072, license: "Llama 3.2 Community",
    ollama: "llama3.2:1b", ollamaBytes: 1.32 * GB, hf: { repo: "bartowski/Llama-3.2-1B-Instruct-GGUF", quant: "Q4_K_M", bytes: 0.81 * GB } },
  { id: "meta-llama/llama-3.2-3b-instruct", name: "Llama 3.2 3B", family: "Llama", params: "3B", ctx: 131072, license: "Llama 3.2 Community",
    ollama: "llama3.2:3b", ollamaBytes: 2.02 * GB, hf: { repo: "bartowski/Llama-3.2-3B-Instruct-GGUF", quant: "Q4_K_M", bytes: 2.02 * GB } },
  { id: "meta-llama/llama-3.1-8b-instruct", name: "Llama 3.1 8B", family: "Llama", params: "8B", ctx: 131072, license: "Llama 3.1 Community",
    ollama: "llama3.1:8b", ollamaBytes: 4.92 * GB, hf: { repo: "bartowski/Meta-Llama-3.1-8B-Instruct-GGUF", quant: "Q4_K_M", bytes: 4.92 * GB } },
  { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B", family: "Llama", params: "70B", ctx: 131072, license: "Llama 3.3 Community",
    ollama: "llama3.3:70b", ollamaBytes: 42.52 * GB, hf: { repo: "bartowski/Llama-3.3-70B-Instruct-GGUF", quant: "Q4_K_M", bytes: 42.52 * GB } },
  { id: "qwen/qwen-2.5-7b-instruct", name: "Qwen 2.5 7B", family: "Qwen", params: "7B", ctx: 32768, license: "Apache 2.0",
    ollama: "qwen2.5:7b", ollamaBytes: 4.68 * GB, hf: { repo: "bartowski/Qwen2.5-7B-Instruct-GGUF", quant: "Q4_K_M", bytes: 4.68 * GB } },
  { id: "qwen/qwen3-8b", name: "Qwen3 8B", family: "Qwen", params: "8B", ctx: 40960, license: "Apache 2.0", tags: ["reasoning"],
    ollama: "qwen3:8b", ollamaBytes: 5.23 * GB, hf: { repo: "Qwen/Qwen3-8B-GGUF", quant: "Q4_K_M", bytes: 5.03 * GB } },
  { id: "qwen/qwen3-14b", name: "Qwen3 14B", family: "Qwen", params: "14B", ctx: 40960, license: "Apache 2.0", tags: ["reasoning"],
    ollama: "qwen3:14b", ollamaBytes: 9.28 * GB, hf: { repo: "Qwen/Qwen3-14B-GGUF", quant: "Q4_K_M", bytes: 9.0 * GB } },
  { id: "qwen/qwen3-32b", name: "Qwen3 32B", family: "Qwen", params: "32B", ctx: 40960, license: "Apache 2.0", tags: ["reasoning"],
    ollama: "qwen3:32b", ollamaBytes: 20.2 * GB, hf: { repo: "Qwen/Qwen3-32B-GGUF", quant: "Q4_K_M", bytes: 19.76 * GB } },
  { id: "qwen/qwen3-30b-a3b-instruct-2507", name: "Qwen3 30B-A3B Instruct", family: "Qwen", params: "30B-A3B", ctx: 262144, license: "Apache 2.0",
    ollama: "qwen3:30b-a3b-instruct-2507-q4_K_M", ollamaBytes: 18.56 * GB, hf: { repo: "unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF", quant: "Q4_K_M", bytes: 18.56 * GB } },
  { id: "qwen/qwen3-coder-30b-a3b-instruct", name: "Qwen3 Coder 30B-A3B", family: "Qwen", params: "30B-A3B", ctx: 262144, license: "Apache 2.0", tags: ["code"],
    ollama: "qwen3-coder:30b", ollamaBytes: 18.56 * GB, hf: { repo: "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF", quant: "Q4_K_M", bytes: 18.56 * GB } },
  { id: "google/gemma-3-4b-it", name: "Gemma 3 4B", family: "Gemma", params: "4B", ctx: 131072, license: "Gemma Terms",
    ollama: "gemma3:4b", ollamaBytes: 3.34 * GB, hf: { repo: "ggml-org/gemma-3-4b-it-GGUF", quant: "Q4_K_M", bytes: 2.49 * GB } },
  { id: "google/gemma-3-12b-it", name: "Gemma 3 12B", family: "Gemma", params: "12B", ctx: 131072, license: "Gemma Terms",
    ollama: "gemma3:12b", ollamaBytes: 8.15 * GB, hf: { repo: "ggml-org/gemma-3-12b-it-GGUF", quant: "Q4_K_M", bytes: 7.3 * GB } },
  { id: "google/gemma-3-27b-it", name: "Gemma 3 27B", family: "Gemma", params: "27B", ctx: 131072, license: "Gemma Terms",
    ollama: "gemma3:27b", ollamaBytes: 17.4 * GB, hf: { repo: "ggml-org/gemma-3-27b-it-GGUF", quant: "Q4_K_M", bytes: 16.55 * GB } },
  { id: "mistralai/mistral-nemo", name: "Mistral Nemo 12B", family: "Mistral", params: "12B", ctx: 131072, license: "Apache 2.0",
    ollama: "mistral-nemo:12b", ollamaBytes: 7.07 * GB, hf: { repo: "bartowski/Mistral-Nemo-Instruct-2407-GGUF", quant: "Q4_K_M", bytes: 7.48 * GB } },
  { id: "mistralai/mistral-small-3.2-24b-instruct", name: "Mistral Small 3.2 24B", family: "Mistral", params: "24B", ctx: 131072, license: "Apache 2.0",
    ollama: "mistral-small3.2:24b", ollamaBytes: 15.18 * GB, hf: { repo: "bartowski/mistralai_Mistral-Small-3.2-24B-Instruct-2506-GGUF", quant: "Q4_K_M", bytes: 14.33 * GB } },
  { id: "microsoft/phi-4", name: "Phi-4 14B", family: "Phi", params: "14B", ctx: 16384, license: "MIT",
    ollama: "phi4:14b", ollamaBytes: 9.05 * GB, hf: { repo: "bartowski/phi-4-GGUF", quant: "Q4_K_M", bytes: 9.05 * GB } },
  { id: "openai/gpt-oss-20b", name: "gpt-oss 20B", family: "gpt-oss", params: "21B-A3.6B", ctx: 131072, license: "Apache 2.0", tags: ["reasoning"],
    ollama: "gpt-oss:20b", ollamaBytes: 13.79 * GB, hf: { repo: "ggml-org/gpt-oss-20b-GGUF", quant: "MXFP4", bytes: 12.11 * GB } },
  { id: "openai/gpt-oss-120b", name: "gpt-oss 120B", family: "gpt-oss", params: "117B-A5.1B", ctx: 131072, license: "Apache 2.0", tags: ["reasoning"],
    ollama: "gpt-oss:120b", ollamaBytes: 65.37 * GB, hf: { repo: "ggml-org/gpt-oss-120b-GGUF", quant: "MXFP4", bytes: 63.39 * GB } },
  { id: "deepseek/deepseek-r1-distill-llama-70b", name: "DeepSeek R1 Distill Llama 70B", family: "DeepSeek", params: "70B", ctx: 131072, license: "MIT + Llama 3.3", tags: ["reasoning"],
    ollama: "deepseek-r1:70b", ollamaBytes: 42.52 * GB, hf: { repo: "bartowski/DeepSeek-R1-Distill-Llama-70B-GGUF", quant: "Q4_K_M", bytes: 42.52 * GB } },
];

const lower = (s) => String(s || "").trim().toLowerCase();

/** The download size of a curated model on `engine`. */
export function sizeFor(entry, engine) {
  return engine === "llamacpp" ? entry.hf.bytes : entry.ollamaBytes;
}

/** `hf.co/a/b:Q4_K_M`, `https://huggingface.co/a/b`, `a/b-GGUF` → `{repo, quant}`. */
export function parseHfRef(ref) {
  let s = String(ref || "").trim();
  const quantSplit = (r) => {
    const i = r.lastIndexOf(":");
    return i > 0 ? { repo: r.slice(0, i), quant: r.slice(i + 1) || null } : { repo: r, quant: null };
  };
  const url = /^https?:\/\/(?:www\.)?huggingface\.co\/([^/?#\s]+\/[^/?#\s:]+)(?:[/?#].*)?$/i.exec(s);
  if (url) return { repo: url[1], quant: null };
  const short = /^(?:hf\.co|huggingface\.co)\/(.+)$/i.exec(s);
  if (short) s = short[1];
  else if (!/gguf/i.test(s)) return null;
  const { repo, quant } = quantSplit(s);
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? { repo, quant } : null;
}

/**
 * What a `pull` argument names.
 *
 *   curated  — a row above, by its id, its Ollama tag, the last part of its id
 *              (`llama-3.1-8b-instruct`) or its Hugging Face repo
 *   hf       — any other Hugging Face GGUF repo (`hf.co/user/repo[:quant]`)
 *   ollama   — anything else, taken as an Ollama tag
 *
 * @returns {{kind: "curated", entry: CuratedModel, quant: string|null}
 *   | {kind: "hf", repo: string, quant: string|null}
 *   | {kind: "ollama", tag: string}
 *   | {kind: "invalid", reason: string}}
 */
export function resolveModelRef(ref) {
  const raw = String(ref || "").trim().replace(/^local\//i, "");
  if (!raw) return { kind: "invalid", reason: "name a model" };
  const l = lower(raw);
  const noLatest = l.replace(/:latest$/, "");

  const byId = CURATED.find((m) => m.id === noLatest);
  if (byId) return { kind: "curated", entry: byId, quant: null };
  const byTag = CURATED.find((m) => m.ollama.toLowerCase() === noLatest);
  if (byTag) return { kind: "curated", entry: byTag, quant: null };
  const byLeaf = CURATED.find((m) => m.id.split("/").pop() === noLatest);
  if (byLeaf) return { kind: "curated", entry: byLeaf, quant: null };

  const hf = parseHfRef(raw);
  if (hf) {
    const entry = CURATED.find((m) => m.hf.repo.toLowerCase() === hf.repo.toLowerCase());
    if (entry) return { kind: "curated", entry, quant: hf.quant };
    return { kind: "hf", repo: hf.repo, quant: hf.quant };
  }

  // Ollama names: [namespace/]model[:tag], letters, digits, `.`, `_`, `-`.
  if (/^[a-z0-9][\w.-]*(\/[a-z0-9][\w.-]*)?(:[\w.-]+)?$/i.test(raw)) return { kind: "ollama", tag: raw };
  return { kind: "invalid", reason: `"${raw}" is not a model name, an Ollama tag, or hf.co/<user>/<repo>` };
}

/** Rows matching a free-text query against id, name, family, tag and repo. */
export function searchCurated(query = "") {
  const q = lower(query);
  if (!q) return [...CURATED];
  return CURATED.filter((m) => [m.id, m.name, m.family, m.ollama, m.hf.repo, ...(m.tags || [])]
    .some((s) => lower(s).includes(q)));
}
