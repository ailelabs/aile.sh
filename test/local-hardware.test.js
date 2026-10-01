/**
 * Hardware detection is best-effort and must never throw: a probe that fails
 * leaves a smaller, true menu. And the fit rule is what tells a person a model
 * will run, so its boundaries are pinned.
 */

import { describe, expect, test } from "bun:test";
import { parseNvidiaSmi, detectHardware, fit, estimateNeedBytes, describeHardware, diskFree } from "../src/local/hardware.js";

const GB = 1e9;
const MIB = 1024 * 1024;

describe("parseNvidiaSmi", () => {
  test("one GPU", () => {
    const { gpus, driver } = parseNvidiaSmi("NVIDIA GeForce RTX 4060 Laptop GPU, 8188, 7824, 610.88\n");
    expect(gpus).toEqual([{ vendor: "nvidia", name: "NVIDIA GeForce RTX 4060 Laptop GPU", vramBytes: 8188 * MIB, freeBytes: 7824 * MIB }]);
    expect(driver).toBe("610.88");
  });

  test("several GPUs, CRLF, and [N/A] fields", () => {
    const { gpus } = parseNvidiaSmi("A100, 81920, 80000, 550.54\r\nT4, [N/A], [N/A], 550.54\r\n");
    expect(gpus.map((g) => g.name)).toEqual(["A100", "T4"]);
    expect(gpus[1].vramBytes).toBeNull();
  });

  test("garbage reads as no GPU", () => {
    expect(parseNvidiaSmi("").gpus).toEqual([]);
    expect(parseNvidiaSmi("NVIDIA-SMI has failed").gpus).toEqual([]);
  });
});

describe("detectHardware", () => {
  test("NVIDIA on Windows: CUDA, VRAM from nvidia-smi", () => {
    const hw = detectHardware({ platform: "win32", arch: "x64", ramBytes: 16 * GB, cpus: 8, env: {},
      run: (cmd) => (cmd === "nvidia-smi" ? "RTX 4090, 24564, 24000, 560.10\n" : null) });
    expect(hw.accel).toBe("cuda");
    expect(hw.vramBytes).toBe(24564 * MIB);
    expect(hw.driver).toBe("560.10");
  });

  test("no nvidia-smi on Linux falls back to amdgpu's sysfs, and Vulkan", () => {
    const hw = detectHardware({ platform: "linux", arch: "x64", ramBytes: 32 * GB, env: {}, run: () => null,
      linuxGpus: () => [{ vendor: "amd", name: "AMD GPU (card0)", vramBytes: 16 * GB, freeBytes: null }] });
    expect(hw.accel).toBe("vulkan");
    expect(hw.vramBytes).toBe(16 * GB);
  });

  test("Apple silicon counts unified memory, and never runs nvidia-smi", () => {
    let ran = false;
    const hw = detectHardware({ platform: "darwin", arch: "arm64", ramBytes: 32 * GB, env: {}, run: () => { ran = true; return null; } });
    expect(ran).toBe(false);
    expect(hw.unified).toBe(true);
    expect(hw.accel).toBe("metal");
    expect(hw.vramBytes).toBe(Math.floor(32 * GB * 0.7));
  });

  test("nothing found is a CPU machine, not an error", () => {
    const hw = detectHardware({ platform: "win32", arch: "x64", ramBytes: 8 * GB, env: {}, run: () => null });
    expect(hw).toMatchObject({ accel: "cpu", vramBytes: 0, gpus: [] });
  });

  test("AILE_LOCAL_HW overrides what was detected; a bad value is ignored", () => {
    const hw = detectHardware({ platform: "win32", arch: "x64", ramBytes: 8 * GB, run: () => null, env: { AILE_LOCAL_HW: '{"vramBytes": 48000000000, "accel": "cuda"}' } });
    expect(hw.vramBytes).toBe(48e9);
    const bad = detectHardware({ platform: "win32", arch: "x64", ramBytes: 8 * GB, run: () => null, env: { AILE_LOCAL_HW: "{nope" } });
    expect(bad.accel).toBe("cpu");
  });
});

describe("fit", () => {
  const gpu8 = { ramBytes: 16 * GB, vramBytes: 8.6 * GB, unified: false };
  const cpu16 = { ramBytes: 16 * GB, vramBytes: 0, unified: false };
  const mac = { ramBytes: 32 * GB, vramBytes: 22.4 * GB, unified: true };

  test("an 8B 4-bit build fits an 8 GB card; a 14B spills into RAM; a 70B does not run", () => {
    expect(fit(4.92 * GB, gpu8)).toBe("gpu");
    expect(fit(9.05 * GB, gpu8)).toBe("partial");
    expect(fit(42.5 * GB, gpu8)).toBe("no");
  });

  test("no GPU: small models run on the CPU, big ones do not", () => {
    expect(fit(4.92 * GB, cpu16)).toBe("cpu");
    expect(fit(17.4 * GB, cpu16)).toBe("no");
  });

  test("unified memory has no separate RAM to spill into", () => {
    expect(fit(18.56 * GB, mac)).toBe("gpu");
    expect(fit(42.5 * GB, mac)).toBe("no");
  });

  test("a longer context needs more memory", () => {
    expect(estimateNeedBytes(5 * GB, 32768)).toBeGreaterThan(estimateNeedBytes(5 * GB, 8192));
    expect(fit(6.6 * GB, gpu8, 8192)).not.toBe(fit(6.6 * GB, gpu8, 65536));
  });
});

describe("describeHardware / diskFree", () => {
  test("one readable line", () => {
    expect(describeHardware({ unified: false, gpus: [{ name: "RTX 4060", vramBytes: 8.6 * GB }], vramBytes: 8.6 * GB, ramBytes: 16.3 * GB }))
      .toBe("RTX 4060 · 8.6 GB VRAM · 16.3 GB RAM");
    expect(describeHardware({ unified: false, gpus: [], vramBytes: 0, ramBytes: 8 * GB })).toBe("no supported GPU found · 8 GB RAM");
  });

  test("diskFree walks up to a directory that exists", () => {
    const free = diskFree(`${process.env.AILE_DATA_DIR}/does/not/exist/yet`, {});
    expect(free === null || free > 0).toBe(true);
  });

  test("diskFree takes AILE_LOCAL_HW's diskFreeBytes", () => {
    expect(diskFree("/anywhere", { AILE_LOCAL_HW: '{"diskFreeBytes": 123}' })).toBe(123);
  });
});
