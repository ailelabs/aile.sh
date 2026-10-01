/**
 * llama.cpp: the right build for the machine, the server bound to loopback
 * under the name it sells as, and an install that refuses an archive whose
 * sha256 is not the pinned one.
 */

import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pickAsset, serverArgs, versionAtLeast, findServerBin, endpointPort, assetBytes } from "../src/local/llamacpp.js";
import { LLAMACPP_PINS } from "../src/local/llamacpp-pins.js";
import { installLlamaCpp, extractArchive, ollamaInstallPlan, runOllamaInstall, InstallError } from "../src/local/install.js";

const nvidia = (driver) => ({ gpus: [{ vendor: "nvidia", name: "RTX", vramBytes: 8e9 }], driver });

describe("the pinned build", () => {
  test("every key carries a file, a size and a 64-hex sha256", () => {
    expect(LLAMACPP_PINS.tag).toMatch(/^b\d+$/);
    for (const a of Object.values(LLAMACPP_PINS.assets)) {
      expect(a.file).toContain(LLAMACPP_PINS.tag.startsWith("b") ? "llama-" : "");
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.size).toBeGreaterThan(1e6);
      if (a.extra) expect(a.extra.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("pickAsset", () => {
  test("NVIDIA with a new enough driver gets CUDA, an old one Vulkan", () => {
    expect(pickAsset({ platform: "win32", arch: "x64", ...nvidia("610.88") }).key).toBe("win-x64-cuda");
    expect(pickAsset({ platform: "win32", arch: "x64", ...nvidia("470.10") }).key).toBe("win-x64-vulkan");
    expect(pickAsset({ platform: "linux", arch: "x64", ...nvidia("575.1") }).key).toBe("linux-x64-cuda");
    expect(pickAsset({ platform: "linux", arch: "x64", ...nvidia("560.1") }).key).toBe("linux-x64-vulkan");
  });

  test("AMD gets Vulkan; no GPU gets the CPU build; Apple silicon gets Metal", () => {
    expect(pickAsset({ platform: "linux", arch: "x64", gpus: [{ vendor: "amd", name: "AMD" }] }).key).toBe("linux-x64-vulkan");
    expect(pickAsset({ platform: "win32", arch: "x64", gpus: [] }).key).toBe("win-x64-cpu");
    expect(pickAsset({ platform: "darwin", arch: "arm64", gpus: [] })).toMatchObject({ key: "macos-arm64", accel: "metal" });
    expect(pickAsset({ platform: "linux", arch: "arm64", gpus: [] }).key).toBe("linux-arm64-cpu");
  });

  test("--accel picks a build when it exists for the platform, and nothing when it does not", () => {
    expect(pickAsset({ platform: "win32", arch: "x64", ...nvidia("610") }, { accel: "cpu" }).key).toBe("win-x64-cpu");
    expect(pickAsset({ platform: "win32", arch: "arm64", gpus: [] }, { accel: "cuda" })).toBeNull();
    expect(pickAsset({ platform: "freebsd", arch: "x64", gpus: [] })).toBeNull();
  });

  test("CUDA's size includes its runtime", () => {
    const a = LLAMACPP_PINS.assets["win-x64-cuda"];
    expect(assetBytes(a)).toBe(a.size + a.extra.size);
  });
});

describe("versionAtLeast / endpointPort", () => {
  test("numeric per component", () => {
    expect(versionAtLeast("610.88", "551.61")).toBe(true);
    expect(versionAtLeast("551.6", "551.61")).toBe(false);
    expect(versionAtLeast(null, "1")).toBe(false);
  });

  test("the port a loopback endpoint names", () => {
    expect(endpointPort("http://127.0.0.1:8091")).toBe(8091);
    expect(endpointPort("http://localhost")).toBe(80);
    expect(endpointPort("nonsense", 7)).toBe(7);
  });
});

describe("serverArgs", () => {
  test("loopback, one slot, the alias it sells as", () => {
    const a = serverArgs({ gguf: "/m/x.gguf", port: 8091, alias: "qwen/qwen3-8b", ctx: 16384, gpu: true });
    expect(a).toEqual(["-m", "/m/x.gguf", "--host", "127.0.0.1", "--port", "8091", "--alias", "qwen/qwen3-8b", "-c", "16384", "-np", "1", "-ngl", "999", "--jinja"]);
    expect(serverArgs({ gguf: "/m/x.gguf", port: 1, gpu: false })).toContain("0");
  });

  test("refuses a bad port or no model", () => {
    expect(() => serverArgs({ gguf: "/m", port: 0 })).toThrow();
    expect(() => serverArgs({ port: 80 })).toThrow();
  });
});

describe("findServerBin", () => {
  test("finds llama-server wherever the archive nested it", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "aile-bin-"));
    fs.mkdirSync(path.join(d, "llama-b1", "bin"), { recursive: true });
    fs.writeFileSync(path.join(d, "llama-b1", "bin", "llama-server"), "");
    expect(findServerBin(d, "linux")).toBe(path.join(d, "llama-b1", "bin", "llama-server"));
    expect(findServerBin(d, "win32")).toBeNull();
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe("extractArchive", () => {
  test("Windows uses System32's tar by absolute path, then Expand-Archive for a zip", () => {
    const calls = [];
    const run = (cmd, args) => { calls.push([cmd, args]); return { status: calls.length === 1 ? 1 : 0, stderr: "nope" }; };
    const used = extractArchive("C:\\x\\a'b.zip", os.tmpdir(), { platform: "win32", run, env: { SystemRoot: "C:\\Windows" } });
    expect(calls[0][0]).toBe(path.join("C:\\Windows", "System32", "tar.exe"));
    expect(used).toBe("powershell.exe");
    expect(calls[1][1].at(-1)).toContain("'C:\\x\\a''b.zip'");
  });

  test("a .tar.gz elsewhere is tar -xzf; nothing working is an InstallError naming each attempt", () => {
    const calls = [];
    expect(extractArchive("/t/a.tar.gz", os.tmpdir(), { platform: "linux", run: (c, a) => { calls.push([c, a]); return { status: 0 }; } })).toBe("tar");
    expect(calls[0][1][0]).toBe("-xzf");
    expect(() => extractArchive("/t/a.zip", os.tmpdir(), { platform: "linux", run: () => ({ status: 2, stderr: "bad" }) })).toThrow(/unzip: bad; tar: bad/);
  });
});

describe("installLlamaCpp", () => {
  const body = Buffer.from("pretend archive");
  const good = crypto.createHash("sha256").update(body).digest("hex");
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(body) });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aile-llama-"));
  afterAll(() => { server.stop(true); fs.rmSync(root, { recursive: true, force: true }); delete process.env.AILE_LLAMACPP_URL; });
  const hw = { platform: "linux", arch: "x64", gpus: [] };
  const pins = (sha) => ({ tag: "b1", assets: { "linux-x64-cpu": { file: "llama-b1-bin-ubuntu-x64.tar.gz", size: body.length, sha256: sha } } });
  const fakeExtract = (file, dir) => { fs.mkdirSync(path.join(dir, "bin"), { recursive: true }); fs.writeFileSync(path.join(dir, "bin", "llama-server"), "#!"); };

  test("downloads, verifies, unpacks, and is reused next time", async () => {
    process.env.AILE_LLAMACPP_URL = `http://127.0.0.1:${server.port}`;
    const got = await installLlamaCpp({ hw, config: { localModelDir: root }, pins: pins(good), extract: fakeExtract });
    expect(got).toMatchObject({ tag: "b1", key: "linux-x64-cpu", reused: false, accel: "cpu" });
    expect(fs.existsSync(got.bin)).toBe(true);
    const again = await installLlamaCpp({ hw, config: { localModelDir: root }, pins: pins(good), extract: () => { throw new Error("must not unpack again"); } });
    expect(again.reused).toBe(true);
  });

  test("an archive that does not match the pin is refused", async () => {
    process.env.AILE_LLAMACPP_URL = `http://127.0.0.1:${server.port}`;
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "aile-llama-"));
    await expect(installLlamaCpp({ hw, config: { localModelDir: other }, pins: pins("0".repeat(64)), extract: fakeExtract })).rejects.toThrow(/checksum/);
    fs.rmSync(other, { recursive: true, force: true });
  });
});

describe("Ollama install plan", () => {
  test("winget, Homebrew, the official script — or a page to visit", () => {
    expect(ollamaInstallPlan({ platform: "win32", has: (c) => c === "winget" }).display).toMatch(/^winget install -e --id Ollama\.Ollama/);
    expect(ollamaInstallPlan({ platform: "win32", has: () => false }).manual).toMatch(/ollama\.com\/download/);
    expect(ollamaInstallPlan({ platform: "darwin", has: (c) => c === "brew" }).display).toBe("brew install ollama");
    expect(ollamaInstallPlan({ platform: "linux", has: () => true }).display).toBe("curl -fsSL https://ollama.com/install.sh | sh");
  });

  test("never runs while AILE_LOCAL_NO_INSTALL is set (the test preload sets it)", () => {
    expect(process.env.AILE_LOCAL_NO_INSTALL).toBe("1");
    let ran = false;
    expect(() => runOllamaInstall({ cmd: "x", args: [] }, { run: () => { ran = true; return { status: 0 }; } })).toThrow(InstallError);
    expect(ran).toBe(false);
  });
});
