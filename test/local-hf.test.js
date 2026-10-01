/**
 * Choosing and fetching a GGUF from Hugging Face: the right quant, every part
 * of a split model in order, each file checked against the hub's own sha256,
 * and a gated repo explained rather than reported as a 401.
 */

import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { listRepoFiles, pickGguf, ggufGroups, quantOf, pullFromHf, HfError, resolveUrl } from "../src/local/hf.js";

const A = Buffer.from("part one of the model");
const B = Buffer.from("part two");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const FILES = {
  "M-Q4_K_M.gguf": Buffer.from("small model bytes"),
  "Q8_0/M-Q8_0-00001-of-00002.gguf": A,
  "Q8_0/M-Q8_0-00002-of-00002.gguf": B,
};
const tree = [
  ...Object.entries(FILES).map(([p, b]) => ({ type: "file", path: p, size: 1, lfs: { oid: sha(b), size: b.length } })),
  { type: "file", path: "README.md", size: 10 },
  { type: "file", path: "mmproj-M-f16.gguf", size: 5, lfs: { oid: "x", size: 5 } },
  { type: "directory", path: "Q8_0" },
];

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/models/me/M-GGUF/tree/main") return Response.json(tree);
    if (url.pathname === "/api/models/me/Gated/tree/main") return new Response("{}", { status: 401 });
    if (url.pathname === "/api/models/me/Nope/tree/main") return new Response("{}", { status: 404 });
    const m = /^\/me\/M-GGUF\/resolve\/main\/(.+)$/.exec(url.pathname);
    if (m) {
      const body = FILES[decodeURIComponent(m[1])];
      return body ? new Response(body) : new Response("no", { status: 404 });
    }
    return new Response("no", { status: 404 });
  },
});
process.env.AILE_HF_URL = `http://127.0.0.1:${server.port}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-hf-"));
afterAll(() => { server.stop(true); fs.rmSync(dir, { recursive: true, force: true }); delete process.env.AILE_HF_URL; });

describe("quantOf / ggufGroups", () => {
  test("reads the quant from the file name", () => {
    expect(quantOf("Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf")).toBe("Q4_K_M");
    expect(quantOf("gpt-oss-20b-MXFP4.gguf")).toBe("MXFP4");
    expect(quantOf("x/Llama-3.3-70B-Instruct-Q8_0-00001-of-00002.gguf")).toBe("Q8_0");
    expect(quantOf("model-IQ4_XS.gguf")).toBe("IQ4_XS");
    expect(quantOf("Qwen3-8B.gguf")).toBeNull();
  });

  test("groups split files in part order, and skips projectors", () => {
    const files = await_files();
    const g = ggufGroups(files);
    expect([...g.keys()].sort()).toEqual(["Q4_K_M", "Q8_0"]);
    expect(g.get("Q8_0").files.map((f) => f.path)).toEqual(["Q8_0/M-Q8_0-00001-of-00002.gguf", "Q8_0/M-Q8_0-00002-of-00002.gguf"]);
  });

  test("a split quant with a part missing is not offered", () => {
    const g = ggufGroups([{ path: "M-Q8_0-00001-of-00003.gguf", size: 1 }, { path: "M-Q8_0-00002-of-00003.gguf", size: 1 }]);
    expect(g.has("Q8_0")).toBe(false);
  });
});

function await_files() {
  return tree.filter((r) => r.type === "file").map((r) => ({ path: r.path, size: r.lfs?.size ?? r.size, sha256: r.lfs?.oid ?? null }));
}

describe("pickGguf", () => {
  const files = await_files();
  test("named quant, case-insensitive; an absent one lists what exists", () => {
    expect(pickGguf(files, { quant: "q8_0" }).quant).toBe("Q8_0");
    expect(() => pickGguf(files, { quant: "Q2_K" })).toThrow(/Q4_K_M, Q8_0|Q8_0, Q4_K_M/);
  });

  test("the curated default, then Q4_K_M", () => {
    expect(pickGguf(files, { preferred: "Q8_0" }).quant).toBe("Q8_0");
    expect(pickGguf(files).quant).toBe("Q4_K_M");
  });

  test("with a memory budget, the best quality that fits", () => {
    expect(pickGguf(files, { budgetBytes: 1000 }).quant).toBe("Q8_0");
    expect(pickGguf(files, { budgetBytes: 20 }).quant).toBe("Q4_K_M");
  });

  test("a repo with no loadable GGUF is refused", () => {
    expect(() => pickGguf([{ path: "README.md" }])).toThrow(HfError);
  });
});

describe("listRepoFiles / pullFromHf", () => {
  test("lists files with their LFS sha256", async () => {
    const files = await listRepoFiles("me/M-GGUF");
    expect(files.find((f) => f.path === "M-Q4_K_M.gguf").sha256).toBe(sha(FILES["M-Q4_K_M.gguf"]));
  });

  test("gated and missing repos are explained", async () => {
    await expect(listRepoFiles("me/Gated")).rejects.toThrow(/HF_TOKEN/);
    await expect(listRepoFiles("me/Nope")).rejects.toThrow(/no Hugging Face repo/);
  });

  test("downloads every part, verified, with one running total", async () => {
    const files = await listRepoFiles("me/M-GGUF");
    const group = pickGguf(files, { quant: "Q8_0" });
    const totals = [];
    const got = await pullFromHf({ repo: "me/M-GGUF", group, config: { localModelDir: dir }, onProgress: ({ done }) => totals.push(done) });
    expect(got.files.map((f) => path.basename(f.path))).toEqual(["M-Q8_0-00001-of-00002.gguf", "M-Q8_0-00002-of-00002.gguf"]);
    expect(fs.readFileSync(got.main).equals(A)).toBe(true);
    expect(totals.at(-1)).toBe(A.length + B.length);
    expect(got.main.startsWith(path.join(dir, "models", "me__M-GGUF"))).toBe(true);
  });

  test("resolveUrl keeps the folder and encodes each segment", () => {
    expect(resolveUrl("me/M-GGUF", "Q8_0/a b.gguf")).toBe(`${process.env.AILE_HF_URL}/me/M-GGUF/resolve/main/Q8_0/a%20b.gguf`);
  });
});
