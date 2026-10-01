/**
 * One file from the internet to disk: resumable, verified, and honest about
 * progress.
 *
 * Models are gigabytes and home connections drop, so a download that has to
 * start over is the difference between "it worked" and "I gave up". Bytes go
 * to `<dest>.part` with a small sidecar recording what they are part of; a
 * later attempt re-hashes what is there and asks for the rest with `Range`
 * (and `If-Range`, so a file that changed upstream is fetched whole rather
 * than spliced). Only a complete file whose sha256 matches is renamed into
 * place, so `<dest>` existing means `<dest>` is right.
 *
 * Redirects are followed by hand: every hop must pass `assertDownloadUrl`,
 * and an `authorization` header is dropped the moment a hop leaves the host it
 * was meant for (Hugging Face redirects to a CDN that needs no token).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { once } from "node:events";
import { assertDownloadUrl } from "./sources.js";

export class DownloadError extends Error {
  constructor(message, { code = "download", status = null } = {}) {
    super(message);
    this.name = "DownloadError";
    this.code = code;
    this.status = status;
  }
}

const cleanSha = (s) => (s ? String(s).toLowerCase().replace(/^sha256:/, "") : null);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function unlinkQuiet(file) {
  try { fs.unlinkSync(file); } catch { /* not there */ }
}

/** Fetch `url`, following redirects one checked hop at a time. */
export async function openUrl(url, { headers = {}, fetchImpl = fetch, signal, maxRedirects = 8 } = {}) {
  let current = assertDownloadUrl(url);
  let hdrs = { ...headers };
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await fetchImpl(current.href, { headers: hdrs, redirect: "manual", signal });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!loc) return res;
    try { await res.body?.cancel(); } catch { /* nothing to drain */ }
    const nextUrl = assertDownloadUrl(new URL(loc, current).href);
    if (nextUrl.host !== current.host) {
      hdrs = Object.fromEntries(Object.entries(hdrs).filter(([k]) => k.toLowerCase() !== "authorization"));
    }
    current = nextUrl;
  }
  throw new DownloadError(`too many redirects from ${new URL(url).host}`);
}

/** Feed the first `upTo` bytes of `file` into `hash`. */
async function hashInto(file, hash, upTo, onProgress) {
  let done = 0;
  for await (const chunk of fs.createReadStream(file, { end: upTo - 1, highWaterMark: 1 << 20 })) {
    hash.update(chunk);
    done += chunk.length;
    onProgress?.(done);
  }
  return done;
}

/** sha256 of a whole file, hex. */
export async function sha256File(file, onProgress) {
  const hash = crypto.createHash("sha256");
  const size = fs.statSync(file).size;
  if (size) await hashInto(file, hash, size, onProgress);
  return hash.digest("hex");
}

/**
 * Download `url` to `dest`.
 *
 * `size` and `sha256` are what the publisher says the file is; both are
 * checked when given. `onProgress({phase, done, total})` is called with
 * `phase` "verify" while an existing partial file is re-hashed and "download"
 * while bytes arrive. Aborting through `signal` keeps the partial file, so the
 * same call later resumes.
 *
 * @returns {Promise<{path: string, bytes: number, sha256: string|null, reused: boolean}>}
 */
export async function downloadFile({
  url, dest, size = null, sha256 = null, headers = {},
  onProgress = () => {}, signal, fetchImpl = fetch,
}) {
  const want = cleanSha(sha256);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  if (fs.existsSync(dest)) {
    const have = fs.statSync(dest).size;
    if (size === null || have === size) return { path: dest, bytes: have, sha256: null, reused: true };
    unlinkQuiet(dest);
  }

  const part = `${dest}.part`;
  const metaFile = `${part}.json`;
  let meta = readJson(metaFile);
  let hash = crypto.createHash("sha256");
  let have = 0;

  const sameTarget = meta && meta.url === url && (meta.size ?? null) === size && (meta.sha256 ?? null) === want;
  if (sameTarget && fs.existsSync(part)) {
    have = fs.statSync(part).size;
    if (size !== null && have > size) have = 0;
    if (have > 0) {
      await hashInto(part, hash, have, (d) => onProgress({ phase: "verify", done: d, total: have }));
    }
  }
  const restart = () => {
    have = 0;
    hash = crypto.createHash("sha256");
    fs.writeFileSync(part, "");
  };
  if (!have) {
    meta = { url, size, sha256: want, etag: null };
    restart();
  }

  const reqHeaders = { ...headers };
  if (have) {
    reqHeaders.range = `bytes=${have}-`;
    if (meta.etag) reqHeaders["if-range"] = meta.etag;
  }

  const res = await openUrl(url, { headers: reqHeaders, fetchImpl, signal });
  const host = new URL(url).host;

  if (res.status === 416 && have && size !== null && have === size) {
    try { await res.body?.cancel(); } catch { /* nothing to drain */ }
  } else {
    if (res.status === 200 && have) restart();
    else if (res.status === 206) {
      const m = /bytes\s+(\d+)-/i.exec(res.headers.get("content-range") || "");
      if (!m || Number(m[1]) !== have) {
        try { await res.body?.cancel(); } catch { /* nothing to drain */ }
        unlinkQuiet(part);
        unlinkQuiet(metaFile);
        throw new DownloadError(`${host} resumed at the wrong offset; run it again to start over`);
      }
    } else if (!res.ok) {
      try { await res.body?.cancel(); } catch { /* nothing to drain */ }
      throw new DownloadError(`${host} answered HTTP ${res.status}`, { status: res.status });
    }

    const length = Number(res.headers.get("content-length"));
    const total = size ?? (Number.isFinite(length) && length > 0 ? have + length : null);
    meta.etag = res.headers.get("etag") || meta.etag || null;
    fs.writeFileSync(metaFile, JSON.stringify(meta));

    const out = fs.createWriteStream(part, { flags: "a" });
    let writeError = null;
    out.on("error", (e) => { writeError = e; });
    let done = have;
    onProgress({ phase: "download", done, total });
    try {
      if (!res.body) throw new DownloadError(`${host} sent no body`);
      const reader = res.body.getReader();
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        if (writeError) throw writeError;
        hash.update(value);
        if (!out.write(value)) await once(out, "drain");
        done += value.length;
        onProgress({ phase: "download", done, total });
      }
    } finally {
      await new Promise((resolve) => out.end(resolve));
    }
    if (writeError) throw writeError;
    have = done;
    if (size !== null && have < size) {
      throw new DownloadError(`the connection closed at ${have} of ${size} bytes; run it again to resume`, { code: "incomplete" });
    }
  }

  const digest = hash.digest("hex");
  if (want && digest !== want) {
    unlinkQuiet(part);
    unlinkQuiet(metaFile);
    throw new DownloadError(`${path.basename(dest)} failed its checksum (expected ${want.slice(0, 12)}…, got ${digest.slice(0, 12)}…); deleted`, { code: "checksum" });
  }
  fs.renameSync(part, dest);
  unlinkQuiet(metaFile);
  return { path: dest, bytes: have, sha256: digest, reused: false };
}
