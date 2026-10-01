/**
 * The downloader: a file is either complete and verified at `dest`, or it is
 * a resumable `.part` beside it. Never a wrong file at `dest`.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { downloadFile, sha256File, DownloadError } from "../src/local/download.js";
import { assertDownloadUrl, DownloadUrlError } from "../src/local/sources.js";

const BODY = crypto.randomBytes(256 * 1024);
const SHA = crypto.createHash("sha256").update(BODY).digest("hex");
const state = { cutAt: null, ignoreRange: false, etag: '"v1"', hits: [], redirectTo: null };

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    state.hits.push({ path: url.pathname, range: req.headers.get("range"), ifRange: req.headers.get("if-range"), auth: req.headers.get("authorization") });
    if (url.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: state.redirectTo } });
    if (url.pathname === "/missing") return new Response("no", { status: 404 });
    if (url.pathname === "/slow") {
      // Four chunks with a pause between them, so an abort lands mid-body.
      let i = 0;
      const stream = new ReadableStream({
        async pull(ctl) {
          if (i >= 4) return ctl.close();
          await Bun.sleep(i ? 100 : 0);
          ctl.enqueue(BODY.subarray(i * 65536, (i + 1) * 65536));
          i++;
        },
      });
      return new Response(stream, { headers: { "content-length": String(BODY.length) } });
    }
    if (url.pathname !== "/file") return new Response("no", { status: 404 });
    const range = req.headers.get("range");
    const ifRange = req.headers.get("if-range");
    let start = 0;
    if (range && !state.ignoreRange && (!ifRange || ifRange === state.etag)) start = Number(/bytes=(\d+)-/.exec(range)[1]);
    let chunk = BODY.subarray(start);
    if (state.cutAt !== null) {
      // A connection that drops part-way: send some bytes and end.
      chunk = BODY.subarray(start, state.cutAt);
      state.cutAt = null;
    }
    const headers = { etag: state.etag, "content-length": String(BODY.length - start) };
    if (start) headers["content-range"] = `bytes ${start}-${BODY.length - 1}/${BODY.length}`;
    return new Response(chunk, { status: start ? 206 : 200, headers });
  },
});
const BASE = `http://127.0.0.1:${server.port}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-dl-"));
afterAll(() => { server.stop(true); fs.rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { Object.assign(state, { cutAt: null, ignoreRange: false, etag: '"v1"', hits: [], redirectTo: null }); });

let n = 0;
const dest = () => path.join(dir, `f${++n}.bin`);

describe("downloadFile", () => {
  test("downloads, verifies and renames into place", async () => {
    const d = dest();
    const seen = [];
    const r = await downloadFile({ url: `${BASE}/file`, dest: d, size: BODY.length, sha256: SHA, onProgress: (p) => seen.push(p.done) });
    expect(r).toMatchObject({ bytes: BODY.length, sha256: SHA, reused: false });
    expect(fs.readFileSync(d).equals(BODY)).toBe(true);
    expect(fs.existsSync(`${d}.part`)).toBe(false);
    expect(seen.at(-1)).toBe(BODY.length);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });

  test("a dropped connection leaves a .part, and the next call resumes with Range + If-Range", async () => {
    const d = dest();
    state.cutAt = 100_000;
    const err = await downloadFile({ url: `${BASE}/file`, dest: d, size: BODY.length, sha256: SHA }).catch((e) => e);
    expect(err).toBeInstanceOf(DownloadError);
    expect(err.code).toBe("incomplete");
    expect(fs.statSync(`${d}.part`).size).toBe(100_000);
    expect(fs.existsSync(d)).toBe(false);

    state.hits = [];
    const r = await downloadFile({ url: `${BASE}/file`, dest: d, size: BODY.length, sha256: SHA });
    expect(r.sha256).toBe(SHA);
    expect(state.hits[0]).toMatchObject({ range: "bytes=100000-", ifRange: '"v1"' });
    expect(fs.readFileSync(d).equals(BODY)).toBe(true);
  });

  test("a file that changed upstream (new ETag) is fetched whole, not spliced", async () => {
    const d = dest();
    state.cutAt = 50_000;
    await downloadFile({ url: `${BASE}/file`, dest: d, size: BODY.length, sha256: SHA }).catch(() => {});
    state.etag = '"v2"';
    const r = await downloadFile({ url: `${BASE}/file`, dest: d, size: BODY.length, sha256: SHA });
    expect(r.sha256).toBe(SHA);
    expect(fs.readFileSync(d).equals(BODY)).toBe(true);
  });

  test("a server that ignores Range (200) restarts cleanly", async () => {
    const d = dest();
    state.cutAt = 70_000;
    await downloadFile({ url: `${BASE}/file`, dest: d, size: BODY.length, sha256: SHA }).catch(() => {});
    state.ignoreRange = true;
    const r = await downloadFile({ url: `${BASE}/file`, dest: d, size: BODY.length, sha256: SHA });
    expect(r.bytes).toBe(BODY.length);
    expect(fs.readFileSync(d).equals(BODY)).toBe(true);
  });

  test("a checksum mismatch deletes the download and says so", async () => {
    const d = dest();
    const err = await downloadFile({ url: `${BASE}/file`, dest: d, size: BODY.length, sha256: "0".repeat(64) }).catch((e) => e);
    expect(err.code).toBe("checksum");
    expect(fs.existsSync(d)).toBe(false);
    expect(fs.existsSync(`${d}.part`)).toBe(false);
  });

  test("a complete file already in place is reused without a request", async () => {
    const d = dest();
    await downloadFile({ url: `${BASE}/file`, dest: d, size: BODY.length, sha256: SHA });
    state.hits = [];
    const r = await downloadFile({ url: `${BASE}/file`, dest: d, size: BODY.length, sha256: SHA });
    expect(r.reused).toBe(true);
    expect(state.hits).toEqual([]);
  });

  test("follows a redirect, and drops authorization when it leaves the host", async () => {
    const d = dest();
    state.redirectTo = `http://localhost:${server.port}/file`;
    await downloadFile({ url: `${BASE}/redirect`, dest: d, size: BODY.length, sha256: SHA, headers: { authorization: "Bearer hf_x" } });
    expect(state.hits[0]).toMatchObject({ path: "/redirect", auth: "Bearer hf_x" });
    expect(state.hits[1]).toMatchObject({ path: "/file", auth: null });
  });

  test("refuses a redirect to plain http off this machine", async () => {
    state.redirectTo = "http://example.com/file";
    const err = await downloadFile({ url: `${BASE}/redirect`, dest: dest() }).catch((e) => e);
    expect(err).toBeInstanceOf(DownloadUrlError);
  });

  test("an HTTP error is reported with its status", async () => {
    const err = await downloadFile({ url: `${BASE}/missing`, dest: dest() }).catch((e) => e);
    expect(err).toBeInstanceOf(DownloadError);
    expect(err.status).toBe(404);
  });

  test("abort keeps the partial file for a later resume", async () => {
    const d = dest();
    const ctl = new AbortController();
    const err = await downloadFile({
      url: `${BASE}/slow`, dest: d, size: BODY.length, sha256: SHA, signal: ctl.signal,
      onProgress: ({ done }) => { if (done > 0) ctl.abort(); },
    }).catch((e) => e);
    expect(err?.name).toBe("AbortError");
    expect(fs.existsSync(d)).toBe(false);
    expect(fs.statSync(`${d}.part`).size).toBeGreaterThan(0);
    expect(fs.statSync(`${d}.part`).size).toBeLessThan(BODY.length);
  });
});

describe("assertDownloadUrl / sha256File", () => {
  test("https anywhere, http only to loopback", () => {
    expect(() => assertDownloadUrl("https://huggingface.co/x")).not.toThrow();
    expect(() => assertDownloadUrl("http://127.0.0.1:1/x")).not.toThrow();
    expect(() => assertDownloadUrl("http://localhost/x")).not.toThrow();
    expect(() => assertDownloadUrl("http://huggingface.co/x")).toThrow(DownloadUrlError);
    expect(() => assertDownloadUrl("file:///etc/passwd")).toThrow(DownloadUrlError);
    expect(() => assertDownloadUrl("not a url")).toThrow(DownloadUrlError);
  });

  test("sha256File hashes a whole file", async () => {
    const f = path.join(dir, "h.bin");
    fs.writeFileSync(f, BODY);
    expect(await sha256File(f)).toBe(SHA);
  });
});
