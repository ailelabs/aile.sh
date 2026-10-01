/**
 * GGUF models from Hugging Face, for the llama.cpp engine.
 *
 * The repo's file list comes from the hub API, which also gives each LFS
 * file's size and sha256 — so every file is verified against the hub's own
 * digest, not trusted because it arrived.
 *
 * `HF_TOKEN` is read from the environment for gated or private repos and sent
 * to huggingface.co only (the downloader drops it on the redirect to the CDN).
 * It is never written to disk.
 */

import path from "node:path";
import { hfBase } from "./sources.js";
import { downloadFile, DownloadError } from "./download.js";
import { modelsDir, repoDirName } from "./paths.js";

export class HfError extends Error {
  constructor(message, { code = "hf" } = {}) { super(message); this.name = "HfError"; this.code = code; }
}

const authHeaders = () => (process.env.HF_TOKEN ? { authorization: `Bearer ${process.env.HF_TOKEN}` } : {});

/** Every file in the repo: `{path, size, sha256}` (sha256 null for non-LFS files). */
export async function listRepoFiles(repo, { fetchImpl = fetch, signal } = {}) {
  const url = `${hfBase()}/api/models/${repo}/tree/main?recursive=true`;
  let res;
  try {
    res = await fetchImpl(url, { headers: { accept: "application/json", ...authHeaders() }, signal });
  } catch (e) {
    throw new HfError(`cannot reach Hugging Face: ${e.message}`, { code: "network" });
  }
  if (res.status === 401 || res.status === 403) {
    throw new HfError(`${repo} is gated or private. Accept its terms on huggingface.co, then set HF_TOKEN and run this again.`, { code: "gated" });
  }
  if (res.status === 404) throw new HfError(`no Hugging Face repo named ${repo}`, { code: "missing" });
  if (!res.ok) throw new HfError(`Hugging Face answered HTTP ${res.status} for ${repo}`, { code: "http" });
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new HfError(`unexpected file list for ${repo}`);
  return rows
    .filter((r) => r && r.type === "file" && typeof r.path === "string")
    .map((r) => ({ path: r.path, size: Number(r.lfs?.size ?? r.size) || null, sha256: r.lfs?.oid || null }));
}

const QUANT_RE = /(?:^|[-_.])(i?q\d(?:_[a-z0-9]+)*|f16|bf16|f32|mxfp4)(?:-\d{5}-of-\d{5})?\.gguf$/i;
const PART_RE = /-(\d{5})-of-(\d{5})\.gguf$/i;
// Not models: vision projectors, speculative-decoding drafts, imatrix data.
const NOT_A_MODEL = /mmproj|eagle|draft|imatrix/i;

/** The quant label in a GGUF file name, upper-cased (`Q4_K_M`), or null. */
export function quantOf(file) {
  const m = QUANT_RE.exec(path.basename(file));
  return m ? m[1].toUpperCase() : null;
}

/**
 * Group a repo's GGUF files by quant, with split files (`-00001-of-00003`)
 * kept together and in order.
 * @returns {Map<string, {quant: string, files: {path,size,sha256}[], bytes: number}>}
 */
export function ggufGroups(files) {
  const groups = new Map();
  for (const f of files) {
    if (!/\.gguf$/i.test(f.path) || NOT_A_MODEL.test(f.path)) continue;
    const quant = quantOf(f.path);
    if (!quant) continue;
    const g = groups.get(quant) || { quant, files: [], bytes: 0 };
    g.files.push(f);
    g.bytes += f.size || 0;
    groups.set(quant, g);
  }
  for (const g of groups.values()) {
    g.files.sort((a, b) => {
      const pa = PART_RE.exec(a.path); const pb = PART_RE.exec(b.path);
      return (pa ? Number(pa[1]) : 0) - (pb ? Number(pb[1]) : 0) || a.path.localeCompare(b.path);
    });
    // A quant split across files must have every part, or llama.cpp cannot load it.
    const parts = PART_RE.exec(g.files[0].path);
    if (parts && g.files.length !== Number(parts[2])) groups.delete(g.quant);
  }
  return groups;
}

// Best first, when memory allows; the default when nothing is known is Q4_K_M.
const QUALITY_ORDER = ["Q8_0", "Q6_K", "Q5_K_M", "Q4_K_M", "MXFP4", "Q4_K_S", "Q4_0", "IQ4_XS", "Q3_K_M"];

/**
 * Choose the files to download.
 *
 * `quant` named → exactly that (case-insensitive), or an error listing what
 * the repo has. Otherwise `preferred` (the curated default) if present, then
 * the best quality whose size fits `budgetBytes`, then Q4_K_M, then the
 * smallest on offer.
 */
export function pickGguf(files, { quant = null, preferred = null, budgetBytes = null } = {}) {
  const groups = ggufGroups(files);
  if (!groups.size) throw new HfError("that repo has no GGUF model files llama.cpp can load", { code: "no-gguf" });
  const available = [...groups.keys()];
  if (quant) {
    const g = groups.get(String(quant).toUpperCase());
    if (!g) throw new HfError(`no ${quant} build; this repo has ${available.join(", ")}`, { code: "no-quant" });
    return g;
  }
  if (budgetBytes) {
    for (const q of QUALITY_ORDER) {
      const g = groups.get(q);
      if (g && g.bytes && g.bytes <= budgetBytes) return g;
    }
  }
  if (preferred && groups.get(String(preferred).toUpperCase())) return groups.get(String(preferred).toUpperCase());
  if (groups.get("Q4_K_M")) return groups.get("Q4_K_M");
  return [...groups.values()].sort((a, b) => (a.bytes || Infinity) - (b.bytes || Infinity))[0];
}

/** The download URL for one file of a repo. */
export function resolveUrl(repo, file) {
  return `${hfBase()}/${repo}/resolve/main/${file.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Download a quant of `repo` into the models directory.
 * @returns {Promise<{repo, quant, files: {path,size,sha256}[], bytes: number, main: string}>}
 */
export async function pullFromHf({ repo, group, config = {}, onProgress = () => {}, signal, fetchImpl = fetch }) {
  const dir = path.join(modelsDir(config), repoDirName(repo));
  const total = group.bytes || null;
  let before = 0;
  let reused = true;
  const out = [];
  for (const f of group.files) {
    const dest = path.join(dir, path.basename(f.path));
    try {
      const got = await downloadFile({
        url: resolveUrl(repo, f.path), dest, size: f.size, sha256: f.sha256, headers: authHeaders(), signal, fetchImpl,
        onProgress: ({ phase, done }) => onProgress({ phase, done: before + done, total, file: path.basename(f.path) }),
      });
      reused = reused && got.reused;
    } catch (e) {
      if (e instanceof DownloadError && (e.status === 401 || e.status === 403)) {
        throw new HfError(`${repo} is gated or private. Accept its terms on huggingface.co, then set HF_TOKEN and run this again.`, { code: "gated" });
      }
      throw e;
    }
    before += f.size || 0;
    out.push({ path: dest, size: f.size, sha256: f.sha256 });
  }
  return { repo, quant: group.quant, files: out, bytes: group.bytes, main: out[0].path, reused };
}
