/**
 * What the hello says about a self-hosted model: engine, quantization and context from aile's own
 * manifest, and the country opt-in. Nothing else crosses (no paths, hashes or sizes), and a node with
 * no manifest entry keeps the bare `{ blind, models, endpointPort }` block.
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import net from "node:net";
import { buildLocalCapability, localStatus } from "../src/relay/local.js";

let model;
let port;
beforeAll(async () => {
  model = net.createServer((c) => c.end());
  await new Promise((r) => model.listen(0, "127.0.0.1", r));
  port = model.address().port;
});
afterAll(() => new Promise((r) => model.close(r)));

const cfg = (over = {}) => ({ localEnabled: true, localEndpoint: `http://127.0.0.1:${port}`, localModels: "llama3", localEngine: "external", localContext: 8192, ...over });
const entry = (over = {}) => ({
  id: "llama3", sellId: null, engine: "llamacpp", source: "hf:x/y", quant: "Q4_K_M", ctx: 16384,
  files: [{ path: "/secret/dir/m.gguf", size: 123, sha256: "abc" }], sizeBytes: 123, pulledAt: "2026-10-10", ...over,
});
const manifest = (...models) => ({ v: 1, engines: {}, models, active: null });

describe("buildLocalCapability details", () => {
  it("carries engine, quant and ctx for a model in the manifest, and nothing more", async () => {
    const cap = await buildLocalCapability(cfg(), { manifest: manifest(entry()) });
    expect(cap).toEqual({ blind: false, models: ["llama3"], endpointPort: port, details: { llama3: { engine: "llamacpp", quant: "Q4_K_M", ctx: 16384 } } });
    expect(JSON.stringify(cap)).not.toMatch(/secret|sha256|gguf|sizeBytes/);
  });

  it("finds an entry by its sell id", async () => {
    const cap = await buildLocalCapability(cfg(), { manifest: manifest(entry({ id: "llama3.1:8b", sellId: "llama3" })) });
    expect(cap.details.llama3.quant).toBe("Q4_K_M");
  });

  it("falls back to the configured engine and context, and null for a missing quant", async () => {
    const cap = await buildLocalCapability(cfg({ localEngine: "ollama", localContext: 4096 }), { manifest: manifest(entry({ engine: undefined, quant: null, ctx: null, sellId: "llama3" })) });
    expect(cap.details.llama3).toEqual({ engine: "ollama", quant: null, ctx: 4096 });
    const ext = await buildLocalCapability(cfg(), { manifest: manifest(entry({ engine: undefined })) });
    expect(ext.details.llama3.engine).toBeNull();
  });

  it("claims no context for an Ollama model with no alias, where no num_ctx was applied", async () => {
    const cap = await buildLocalCapability(cfg(), { manifest: manifest(entry({ engine: "ollama", ctx: 16384 })) });
    expect(cap.details.llama3.ctx).toBeNull();
  });

  it("an empty manifest, or one without this model, gives exactly the bare block", async () => {
    const bare = { blind: false, models: ["llama3"], endpointPort: port };
    expect(await buildLocalCapability(cfg(), { manifest: manifest() })).toEqual(bare);
    expect(await buildLocalCapability(cfg(), { manifest: manifest(entry({ id: "other" })) })).toEqual(bare);
  });
});

describe("shareCountry", () => {
  it("rides the hello only when set to true", async () => {
    const bare = { blind: false, models: ["llama3"], endpointPort: port };
    expect(await buildLocalCapability(cfg({ shareCountry: true }), { manifest: manifest() })).toEqual({ ...bare, shareCountry: true });
    expect(await buildLocalCapability(cfg({ shareCountry: false }), { manifest: manifest() })).toEqual(bare);
    expect(await buildLocalCapability(cfg({ shareCountry: "yes" }), { manifest: manifest() })).toEqual(bare);
  });

  it("is carried beside details", async () => {
    const s = await localStatus(cfg({ shareCountry: true }), { manifest: manifest(entry()) });
    expect(s).toMatchObject({ state: "up", shareCountry: true, details: { llama3: { engine: "llamacpp" } } });
  });
});
