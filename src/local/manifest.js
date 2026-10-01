/**
 * What aile installed for self-hosting: engines and models.
 *
 * Ollama keeps its own store; this records which of its models aile pulled
 * and under which name, so `aile local list` can say what each one sells as
 * and `aile local rm` knows the tag it came from. llama.cpp has no store at
 * all, so for it this file IS the list of models.
 *
 * Written whole to a temporary file and renamed over the old one: a crash
 * mid-write must leave the previous record, never half of one.
 */

import fs from "node:fs";
import path from "node:path";
import { manifestFile } from "./paths.js";

/**
 * @typedef {{ path: string, size: number|null, sha256: string|null }} ModelFile
 * @typedef {{
 *   id: string,                 // the name it is served under (`localModels` entry)
 *   sellId: string|null,        // the priced catalogue id, when it maps to one
 *   engine: "ollama"|"llamacpp",
 *   source: string,             // `ollama:<tag>` or `hf:<repo>/<file>`
 *   files: ModelFile[],         // llama.cpp only
 *   quant: string|null,
 *   sizeBytes: number|null,
 *   ctx: number|null,
 *   pulledAt: string,
 * }} ModelEntry
 * @typedef {{ tag: string, key: string, dir: string, bin: string }} EngineEntry
 * @typedef {{ v: 1, engines: { llamacpp?: EngineEntry }, models: ModelEntry[], active: string|null }} Manifest
 */

/** @returns {Manifest} */
export function emptyManifest() {
  return { v: 1, engines: {}, models: [], active: null };
}

/** @returns {Manifest} */
export function loadManifest(file = manifestFile()) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object") return emptyManifest();
    return {
      v: 1,
      engines: raw.engines && typeof raw.engines === "object" ? raw.engines : {},
      models: Array.isArray(raw.models) ? raw.models.filter((m) => m && typeof m.id === "string") : [],
      active: typeof raw.active === "string" ? raw.active : null,
    };
  } catch {
    return emptyManifest();
  }
}

export function saveManifest(manifest, file = manifestFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Add or replace a model by `(engine, id)`. Returns the new manifest. */
export function upsertModel(manifest, entry) {
  const models = manifest.models.filter((m) => !(m.id === entry.id && m.engine === entry.engine));
  return { ...manifest, models: [...models, entry] };
}

export function removeModel(manifest, id, engine = null) {
  const models = manifest.models.filter((m) => !(m.id === id && (!engine || m.engine === engine)));
  return { ...manifest, models, active: manifest.active === id ? null : manifest.active };
}

export function findModel(manifest, id, engine = null) {
  const want = String(id || "").toLowerCase();
  return manifest.models.find((m) => m.id.toLowerCase() === want && (!engine || m.engine === engine)) || null;
}
