/**
 * Ollama over its HTTP API: progress summed across layers, an `{error}` line
 * surfaced, and the alias that makes a pull sellable — falling back through
 * both create shapes to a plain copy on older servers.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as ollama from "../src/local/ollama.js";
import { startStubOllama } from "./helpers/stub-ollama.js";

const stub = startStubOllama({ models: ["already:latest"] });
afterAll(() => stub.stop());
beforeEach(() => { stub.state.calls = []; stub.state.createShape = "from"; stub.state.pullError = null; });

describe("ollamaBase", () => {
  test("the configured endpoint when Ollama is the engine", () => {
    expect(ollama.ollamaBase({ localEngine: "ollama", localEndpoint: "http://127.0.0.1:9999/" }, {})).toBe("http://127.0.0.1:9999");
  });

  test("else OLLAMA_HOST as Ollama reads it, 0.0.0.0 reached on loopback", () => {
    expect(ollama.ollamaBase({}, { OLLAMA_HOST: "0.0.0.0:11500" })).toBe("http://127.0.0.1:11500");
    expect(ollama.ollamaBase({}, { OLLAMA_HOST: "http://192.168.1.5" })).toBe("http://192.168.1.5:11434");
    expect(ollama.ollamaBase({ localEngine: "external", localEndpoint: "http://127.0.0.1:1234" }, {})).toBe(ollama.OLLAMA_DEFAULT);
  });
});

describe("version / tags / hasModel", () => {
  test("answers when Ollama answers, null otherwise", async () => {
    expect(await ollama.version(stub.url)).toBe("0.12.3");
    expect(await ollama.version("http://127.0.0.1:1")).toBeNull();
  });

  test("hasModel matches with or without :latest", async () => {
    const list = await ollama.tags(stub.url);
    expect(ollama.hasModel(list, "already")).toBe(true);
    expect(ollama.hasModel(list, "already:latest")).toBe(true);
    expect(ollama.hasModel(list, "other")).toBe(false);
  });
});

describe("pull", () => {
  test("sums progress across layers and finishes on success", async () => {
    const seen = [];
    await ollama.pull(stub.url, "llama3.1:8b", { onProgress: (p) => seen.push(p) });
    const last = seen.filter((p) => p.total).at(-1);
    expect(last).toMatchObject({ done: 1200, total: 1200 });
    expect(stub.state.calls[0].body).toMatchObject({ model: "llama3.1:8b", stream: true });
  });

  test("an error line mid-pull is thrown with Ollama's words", async () => {
    stub.state.pullError = "pull model manifest: file does not exist";
    await expect(ollama.pull(stub.url, "nope:1b")).rejects.toThrow(/file does not exist/);
  });
});

describe("alias", () => {
  test("the new create body, with the context window", async () => {
    expect(await ollama.alias(stub.url, "llama3.1:8b", "meta-llama/llama-3.1-8b-instruct", { ctx: 16384 })).toBe("create");
    expect(stub.state.params.get("meta-llama/llama-3.1-8b-instruct")).toEqual({ num_ctx: 16384 });
  });

  test("falls back to the Modelfile body on an older server", async () => {
    stub.state.createShape = "modelfile";
    expect(await ollama.alias(stub.url, "a:1", "x/a", { ctx: 8192 })).toBe("modelfile");
    expect(stub.state.params.get("x/a")).toBe("FROM a:1\nPARAMETER num_ctx 8192");
  });

  test("and to a plain copy when neither create shape works", async () => {
    stub.state.createShape = "none";
    expect(await ollama.alias(stub.url, "a:1", "x/b", { ctx: 8192 })).toBe("copy");
    expect(stub.state.calls.at(-1)).toMatchObject({ path: "/api/copy", body: { source: "a:1", destination: "x/b" } });
  });
});

describe("remove / findOllamaBin", () => {
  test("deletes, and reports a model that was not there", async () => {
    stub.state.models.add("gone:latest");
    expect(await ollama.remove(stub.url, "gone")).toBe(true);
    expect(await ollama.remove(stub.url, "gone")).toBe(false);
  });

  test("finds the binary on PATH, then in the installers' own folders", () => {
    const seen = new Set(["/opt/x/ollama", "/Applications/Ollama.app/Contents/Resources/ollama"]);
    expect(ollama.findOllamaBin({ platform: "linux", env: { PATH: "/opt/x" }, exists: (p) => seen.has(p.replace(/\\/g, "/")) })).toMatch(/opt.x.ollama$/);
    expect(ollama.findOllamaBin({ platform: "darwin", env: { PATH: "" }, exists: (p) => seen.has(p.replace(/\\/g, "/")) })).toMatch(/Ollama\.app/);
    expect(ollama.findOllamaBin({ platform: "linux", env: { PATH: "" }, exists: () => false })).toBeNull();
  });
});
