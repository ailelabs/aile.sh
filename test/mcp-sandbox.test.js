/**
 * The sandbox, asserted without starting a container.
 *
 * Every flag in `buildRunArgs` is a security property, and a test that needs a
 * running Docker to check one is a test that gets skipped on the machine where
 * it matters. So `buildRunArgs` is pure and asserted directly, and
 * `detectRuntime` / `reapOrphans` take an injected `run`.
 */

import { describe, expect, it } from "bun:test";
import {
  CONTAINER_PREFIX,
  detectRuntime,
  containerName,
  buildRunArgs,
  describeEgress,
  spawnServer,
  reapOrphans,
} from "../src/mcp/sandbox.js";
import { normalizeServer } from "../src/mcp/config.js";

const server = normalizeServer({ id: "srv", image: "alpine:3", command: ["sh", "-c", "cat"] });

/** Read a `--flag value` pair out of an argv array. */
function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
}

describe("buildRunArgs", () => {
  const args = buildRunArgs(server, { name: "aile-mcp-srv-1-abcd" });

  it("keeps stdin open and gives the container no TTY", () => {
    expect(args).toContain("--interactive");
    // A TTY would line-edit and echo the JSON-RPC stream into itself.
    expect(args).not.toContain("--tty");
    expect(args).not.toContain("-t");
  });

  it("removes the container when it exits", () => {
    expect(args).toContain("--rm");
    expect(flag(args, "--name")).toBe("aile-mcp-srv-1-abcd");
  });

  it("gives the child no writable filesystem but /tmp", () => {
    expect(args).toContain("--read-only");
    expect(flag(args, "--tmpfs")).toBe("/tmp:rw,noexec,nosuid,size=64m");
  });

  it("drops every capability and forbids regaining any", () => {
    expect(flag(args, "--cap-drop")).toBe("ALL");
    expect(flag(args, "--security-opt")).toBe("no-new-privileges");
  });

  it("caps cpu, memory, swap and pids", () => {
    expect(flag(args, "--cpus")).toBe("1");
    expect(flag(args, "--memory")).toBe("1024m");
    // Without this a memory cap is advisory: the kernel swaps past it.
    expect(flag(args, "--memory-swap")).toBe("1024m");
    expect(flag(args, "--pids-limit")).toBe("256");
  });

  it("gives a server with no declared hosts no network stack at all", () => {
    expect(flag(args, "--network")).toBe("none");
  });

  it("puts the image and its command last, in order", () => {
    expect(args.slice(-4)).toEqual(["alpine:3", "sh", "-c", "cat"]);
  });

  // The single most important assertion in this file. `-e NAME=value` puts a
  // lender's API key in the process table, readable by every other user on the
  // machine. The name-only form makes the runtime copy it from its own env.
  it("NEVER puts an env VALUE in argv", () => {
    const withSecret = normalizeServer({
      id: "srv",
      image: "alpine:3",
      env: { ANTHROPIC_API_KEY: "sk-ant-super-secret-value" },
    });
    const a = buildRunArgs(withSecret, { name: "n" });
    expect(a).toContain("--env");
    expect(flag(a, "--env")).toBe("ANTHROPIC_API_KEY");
    expect(a.join(" ")).not.toContain("sk-ant-super-secret-value");
    // No `KEY=value` pair anywhere: the only `=` in this argv is inside the
    // tmpfs mount options, and a name-only --env is the whole point.
    expect(a.some((x) => x.startsWith("ANTHROPIC_API_KEY="))).toBe(false);
  });

  it("drops --network=none once hosts are declared", () => {
    const open = normalizeServer({ id: "srv", image: "alpine:3", network: ["api.anthropic.com"] });
    expect(buildRunArgs(open, { name: "n" })).not.toContain("none");
  });
});

describe("describeEgress", () => {
  // Honesty, not decoration: --network=none is kernel-enforced and complete;
  // a declared host list is advertised and NOT packet-filtered, and every
  // surface that carries the list carries that fact beside it.
  it("marks no-network as enforced and a host list as not", () => {
    expect(describeEgress(server)).toEqual({ hosts: [], enforced: true, mode: "none" });
    const open = normalizeServer({ id: "srv", image: "alpine:3", network: ["api.anthropic.com"] });
    expect(describeEgress(open)).toEqual({
      hosts: ["api.anthropic.com"],
      enforced: false,
      mode: "open",
    });
  });
});

describe("containerName", () => {
  it("is prefixed, scoped to the stream, and never collides", () => {
    const a = containerName("srv", 7);
    const b = containerName("srv", 7);
    expect(a.startsWith(`${CONTAINER_PREFIX}srv-7-`)).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("detectRuntime", () => {
  // Three states, not two. "Start Docker Desktop" and "install Docker" are
  // different fixes, and one "unavailable" would tell a lender neither.
  it("reports running when a daemon answers", () => {
    const r = detectRuntime({ run: () => ({ status: 0, stdout: "27.1.1\n" }) });
    expect(r).toMatchObject({ ok: true, runtime: "docker", state: "running" });
    expect(r.message).toContain("27.1.1");
  });

  it("reports stopped when the CLI exists but nothing answers", () => {
    const r = detectRuntime({
      run: () => ({ status: 1, stderr: "cannot connect to the Docker daemon\n" }),
    });
    expect(r.ok).toBe(false);
    expect(r.state).toBe("stopped");
    expect(r.message).toMatch(/installed but not running/);
    expect(r.message).toMatch(/cannot connect to the Docker daemon/);
  });

  it("reports absent when no runtime is on PATH", () => {
    const r = detectRuntime({ run: () => ({ error: { code: "ENOENT" } }) });
    expect(r.ok).toBe(false);
    expect(r.state).toBe("absent");
    expect(r.message).toMatch(/install Docker/);
  });

  it("falls through to podman when docker is absent", () => {
    const r = detectRuntime({
      run: (bin) => (bin === "docker" ? { error: { code: "ENOENT" } } : { status: 0, stdout: "5.1.0" }),
    });
    expect(r).toMatchObject({ ok: true, runtime: "podman", state: "running" });
  });
});

describe("spawnServer", () => {
  it("refuses to start anything when no runtime is usable", () => {
    // §5.2: no sandbox means no capacity. There is deliberately no bare-child
    // fallback — a silent downgrade is worse than an unavailable lender.
    const noRuntime = normalizeServer({ id: "srv", image: "alpine:3" });
    let spawned = false;
    expect(() => spawnServer(noRuntime, {
      streamId: 1,
      runtime: null,
      detect: () => detectRuntime({ run: () => ({ error: { code: "ENOENT" } }) }),
      spawnImpl: () => { spawned = true; },
      log: { warn() {}, debug() {} },
    })).toThrow(/install Docker/);
    expect(spawned).toBe(false);
  });

  it("passes env values through the spawned process's environment, not argv", () => {
    const withSecret = normalizeServer({
      id: "srv",
      image: "alpine:3",
      env: { ANTHROPIC_API_KEY: "sk-ant-secret" },
    });
    let seen = null;
    const child = { stdout: {}, stderr: {}, stdin: {}, kill() {} };
    spawnServer(withSecret, {
      streamId: 1,
      runtime: "docker",
      log: { warn() {}, debug() {} },
      spawnImpl: (bin, args, opts) => { seen = { bin, args, opts }; return child; },
    });
    expect(seen.bin).toBe("docker");
    expect(seen.args.join(" ")).not.toContain("sk-ant-secret");
    expect(seen.opts.env.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
    // Not the node's own environment: that holds this machine's account token.
    expect(Object.keys(seen.opts.env).sort()).toEqual(["ANTHROPIC_API_KEY", "PATH"]);
  });

  it("warns out loud when a declared host list is not enforced", () => {
    const open = normalizeServer({ id: "srv", image: "alpine:3", network: ["api.anthropic.com"] });
    const warned = [];
    spawnServer(open, {
      streamId: 1,
      runtime: "docker",
      log: { warn: (m) => warned.push(m), debug() {} },
      spawnImpl: () => ({ stdout: {}, stderr: {}, stdin: {}, kill() {} }),
    });
    expect(warned.join("\n")).toMatch(/advertised, not packet-enforced/);
  });
});

describe("reapOrphans", () => {
  it("kills only containers carrying this node's own prefix", () => {
    const calls = [];
    const res = reapOrphans({
      runtime: "docker",
      log: { warn() {} },
      run: (bin, args) => {
        calls.push(args);
        if (args[0] === "ps") return { status: 0, stdout: "abc123\ndef456\n" };
        return { status: 0 };
      },
    });
    expect(calls[0]).toEqual(["ps", "-q", "--filter", `name=^${CONTAINER_PREFIX}`]);
    expect(res.reaped).toEqual(["abc123", "def456"]);
  });

  it("does nothing at all when there is no runtime", () => {
    let ran = false;
    const res = reapOrphans({
      run: (bin, args) => {
        if (args[0] === "version") return { error: { code: "ENOENT" } };
        ran = true;
        return { status: 0 };
      },
    });
    expect(ran).toBe(false);
    expect(res).toEqual({ reaped: [], skipped: "absent" });
  });
});
