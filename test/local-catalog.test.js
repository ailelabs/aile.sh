/**
 * The curated table: every row pairs a download with the id it is SOLD under,
 * so a malformed row sells one model under another's price. These pin the
 * shape that pairing depends on, and how a `pull` argument is read.
 */

import { describe, expect, test } from "bun:test";
import { CURATED, resolveModelRef, parseHfRef, searchCurated, sizeFor } from "../src/local/catalog.js";

describe("the curated table", () => {
  test("ids are lower-case `vendor/model`, unique, as the relay's catalogue spells them", () => {
    const ids = CURATED.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+\/[a-z0-9.-]+$/);
  });

  test("Ollama tags are explicit (name:tag) and unique; HF repos are unique", () => {
    const tags = CURATED.map((m) => m.ollama);
    expect(new Set(tags).size).toBe(tags.length);
    for (const t of tags) expect(t).toMatch(/^[a-z0-9.-]+:[\w.-]+$/);
    const repos = CURATED.map((m) => m.hf.repo.toLowerCase());
    expect(new Set(repos).size).toBe(repos.length);
  });

  test("sizes and context windows are plausible (bytes, not GB; tokens, not k)", () => {
    for (const m of CURATED) {
      expect(m.ollamaBytes).toBeGreaterThan(5e8);
      expect(m.ollamaBytes).toBeLessThan(1e11);
      expect(m.hf.bytes).toBeGreaterThan(5e8);
      expect(m.ctx).toBeGreaterThanOrEqual(8192);
      expect(["Q4_K_M", "MXFP4"]).toContain(m.hf.quant);
    }
  });

  test("covers more than Llama: Qwen, Gemma, Mistral, Phi and gpt-oss are all there", () => {
    const families = new Set(CURATED.map((m) => m.family));
    for (const f of ["Llama", "Qwen", "Gemma", "Mistral", "Phi", "gpt-oss"]) expect(families.has(f)).toBe(true);
  });

  test("no row is headed by a provider whose route refuses unlisted ids (closedPrices)", () => {
    // lyceum, meta, muse-code and xkiro answer only their own price rows, so a
    // local id under one of those heads would never price.
    for (const m of CURATED) expect(["lyceum", "meta", "muse-code", "xkiro"]).not.toContain(m.id.split("/")[0]);
  });

  test("sizeFor reads the engine's own download", () => {
    const m = CURATED.find((x) => x.id === "openai/gpt-oss-20b");
    expect(sizeFor(m, "ollama")).toBe(m.ollamaBytes);
    expect(sizeFor(m, "llamacpp")).toBe(m.hf.bytes);
  });
});

describe("resolveModelRef", () => {
  const llama = CURATED.find((m) => m.id === "meta-llama/llama-3.1-8b-instruct");

  test("a curated model by its id, its Ollama tag, its leaf, or its repo", () => {
    for (const ref of ["meta-llama/llama-3.1-8b-instruct", "META-LLAMA/Llama-3.1-8B-Instruct", "llama3.1:8b", "llama-3.1-8b-instruct",
      "local/meta-llama/llama-3.1-8b-instruct", "hf.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF"]) {
      const r = resolveModelRef(ref);
      expect(r.kind).toBe("curated");
      expect(r.entry).toBe(llama);
    }
  });

  test("a curated repo keeps the quant it was named with", () => {
    const r = resolveModelRef("hf.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF:Q8_0");
    expect(r).toEqual({ kind: "curated", entry: llama, quant: "Q8_0" });
  });

  test("any other Hugging Face repo, in each spelling", () => {
    expect(resolveModelRef("hf.co/someone/Thing-GGUF:Q5_K_M")).toEqual({ kind: "hf", repo: "someone/Thing-GGUF", quant: "Q5_K_M" });
    expect(resolveModelRef("https://huggingface.co/someone/Thing-GGUF")).toEqual({ kind: "hf", repo: "someone/Thing-GGUF", quant: null });
    expect(resolveModelRef("someone/Thing-GGUF")).toEqual({ kind: "hf", repo: "someone/Thing-GGUF", quant: null });
  });

  test("anything else is an Ollama tag, and nonsense is refused", () => {
    expect(resolveModelRef("mistral:7b")).toEqual({ kind: "ollama", tag: "mistral:7b" });
    expect(resolveModelRef("library/whatever")).toEqual({ kind: "ollama", tag: "library/whatever" });
    expect(resolveModelRef("").kind).toBe("invalid");
    expect(resolveModelRef("not a model!").kind).toBe("invalid");
  });

  test("a curated Ollama tag with :latest still resolves", () => {
    expect(resolveModelRef("phi4:14b").entry.id).toBe("microsoft/phi-4");
  });
});

describe("parseHfRef / searchCurated", () => {
  test("a bare `a/b` with no GGUF in it is not taken for a Hugging Face repo", () => {
    expect(parseHfRef("library/llama3")).toBeNull();
  });

  test("search matches id, name, family, tag and repo", () => {
    expect(searchCurated("gemma").length).toBe(3);
    expect(searchCurated("reasoning").every((m) => m.tags?.includes("reasoning"))).toBe(true);
    expect(searchCurated("").length).toBe(CURATED.length);
  });
});
