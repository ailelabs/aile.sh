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

/** A GGUF file's build name: its path less the quant label and split suffix (`x/M-noMTP-Q8_0-00001-of-00002.gguf` → `x/M-noMTP`). */
function buildOf(file) {
  const base = path.basename(file);
  const m = base.match(QUANT_RE);
  return file.slice(0, file.length - base.length) + (m ? base.slice(0, m.index) : base);
}

/**
 * Every complete build in a repo, one per (build name, quant): a single file,
 * or every part of a split (`-00001-of-00003`) in order. Two files that only
 * share a quant label (`M-Q8_0.gguf` and `M-noMTP-Q8_0.gguf`) are two builds.
 * @returns {{quant: string, name: string, files: {path,size,sha256}[], bytes: number}[]}
 */
function ggufBuilds(files) {
  const builds = new Map();
  for (const f of files) {
    if (!/\.gguf$/i.test(f.path) || NOT_A_MODEL.test(f.path)) continue;
    const quant = quantOf(f.path);
    if (!quant) continue;
    const name = buildOf(f.path);
    const key = `${quant}\n${name}`;
    const g = builds.get(key) || { quant, name, files: [], bytes: 0 };
    g.files.push(f);
    g.bytes += f.size || 0;
    builds.set(key, g);
  }
  for (const [key, g] of builds) {
    g.files.sort((a, b) => {
      const pa = a.path.match(PART_RE); const pb = b.path.match(PART_RE);
      return (pa ? Number(pa[1]) : 0) - (pb ? Number(pb[1]) : 0) || a.path.localeCompare(b.path);
    });
    // A build split across files must have every part, or llama.cpp cannot load it.
    const parts = g.files[0].path.match(PART_RE);
    if (parts && g.files.length !== Number(parts[2])) builds.delete(key);
  }
  return [...builds.values()];
}

/**
 * One build per quant. Where a repo has several (an MTP and a noMTP file, a
 * base and a variant), the plain one: the shortest build name. The others are
 * named in `alternatives` (first file of each) for `--file`.
 * @returns {Map<string, {quant: string, name: string, files: {path,size,sha256}[], bytes: number, alternatives: string[]}>}
 */
export function ggufGroups(files) {
  const groups = new Map();
  // ponytail: "plain" = shortest name, since `-noMTP`, `-abliterated` and the like add to it; --file overrides.
  const byPlainness = ggufBuilds(files).sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
  for (const g of byPlainness) {
    const kept = groups.get(g.quant);
    if (kept) kept.alternatives.push(g.files[0].path);
    else groups.set(g.quant, { ...g, alternatives: [] });
  }
  return groups;
}

// Best first, when memory allows; the default when nothing is known is Q4_K_M.
const QUALITY_ORDER = ["Q8_0", "Q6_K", "Q5_K_M", "Q4_K_M", "MXFP4", "Q4_K_S", "Q4_0", "IQ4_XS", "Q3_K_M"];

/**
 * Choose the files to download.
 *
 * `file` named → the build that file belongs to (its name or its path in the
 * repo, any part of a split), whose quant must agree with `quant` when both
 * are given. `quant` named → exactly that (case-insensitive), or an error
 * listing what the repo has. Otherwise `preferred` (the curated default) if
 * present, then the best quality whose size fits `budgetBytes`, then Q4_K_M,
 * then the smallest on offer.
 */
export function pickGguf(files, { quant = null, preferred = null, budgetBytes = null, file = null } = {}) {
  if (file) {
    const want = String(file).toLowerCase();
    const builds = ggufBuilds(files);
    const g = builds.find((b) => b.files.some((f) => f.path.toLowerCase() === want || path.basename(f.path).toLowerCase() === want));
    if (!g) {
      const names = builds.map((b) => path.basename(b.files[0].path));
      throw new HfError(`no model file ${file} in this repo${names.length ? `; it has ${names.slice(0, 8).join(", ")}${names.length > 8 ? ", …" : ""}` : ""}`, { code: "no-file" });
    }
    if (quant && String(quant).toUpperCase() !== g.quant) {
      throw new HfError(`${file} is a ${g.quant} build, not ${String(quant).toUpperCase()}`, { code: "no-quant" });
    }
    return { ...g, alternatives: [] };
  }
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
