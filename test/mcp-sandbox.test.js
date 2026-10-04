/**
 * The sandbox, asserted without starting a container.
 *
 * Every flag in `buildRunArgs` is a security property, and a test that needs a
 * running Docker to check one is a test that gets skipped on the machine where
 * it matters. So `buildRunArgs` is pure and asserted directly, and
 * `detectRuntime` / `reapOrphans` take an injected `run`.
 */

import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
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

/** Set env vars for one call and put every one back, absent ones included. */
function withEnv(vars, fn) {
  const saved = new Map();
  for (const [k, v] of Object.entries(vars)) { saved.set(k, process.env[k]); process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

/** What the runtime CLI may take from the node. Pinned here, so adding a name is a deliberate edit. */
const RUNTIME_NAMES = [
  "HOME", "USERPROFILE", "SystemRoot", "APPDATA", "LOCALAPPDATA", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS",
  "DOCKER_TLS_VERIFY", "DOCKER_API_VERSION", "CONTAINER_HOST", "CONTAINER_CONNECTION",
  "CONTAINERS_CONF", "CONTAINERS_STORAGE_CONF", "CONTAINERS_REGISTRIES_CONF", "PODMAN_CONNECTIONS_CONF",
  "REGISTRY_AUTH_FILE",
];
const NODE_SECRET = { AILE_TOKEN: "ail_node_secret" };
const fakeChild = () => ({ stdout: {}, stderr: {}, stdin: {}, kill() {} });

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

  it("asks in the same environment a rented session runs in", () => {
    let opts = null;
    withEnv({ DOCKER_HOST: "unix:///run/user/1000/docker.sock", ...NODE_SECRET }, () =>
      detectRuntime({ run: (bin, args, o) => { opts = o; return { status: 0, stdout: "27.1.1" }; } }));
    expect(opts.env.DOCKER_HOST).toBe("unix:///run/user/1000/docker.sock");
    expect("AILE_TOKEN" in opts.env).toBe(false);
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
    withEnv(NODE_SECRET, () => spawnServer(withSecret, {
      streamId: 1,
      runtime: "docker",
      log: { warn() {}, debug() {} },
      spawnImpl: (bin, args, opts) => { seen = { bin, args, opts }; return child; },
    }));
    expect(seen.bin).toBe("docker");
    expect(seen.args.join(" ")).not.toContain("sk-ant-secret");
    expect(seen.opts.env.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
    // Not the node's own environment: that holds this machine's account token.
    expect("AILE_TOKEN" in seen.opts.env).toBe(false);
    for (const k of Object.keys(seen.opts.env)) expect(["ANTHROPIC_API_KEY", "PATH", ...RUNTIME_NAMES]).toContain(k);
  });

  it("gives the runtime CLI what it needs to reach its daemon, and the container none of it", () => {
    // With PATH alone, rootless Podman/Docker and a Docker context
    // could not find their daemon, so every rented session exited at once.
    const conn = {
      DOCKER_HOST: "unix:///run/user/1000/docker.sock", DOCKER_CONTEXT: "colima",
      XDG_RUNTIME_DIR: "/run/user/1000", HOME: "/home/lender", SystemRoot: "C:\\Windows",
      APPDATA: "C:\\Users\\lender\\AppData\\Roaming",
      // Podman's private-registry credentials file: a path, not a secret.
      REGISTRY_AUTH_FILE: "/home/lender/.config/containers/auth.json",
    };
    let seen = null;
    withEnv({ ...conn, ...NODE_SECRET }, () => spawnServer(server, {
      streamId: 1, runtime: "docker", log: { warn() {}, debug() {} },
      spawnImpl: (bin, args, opts) => { seen = { args, opts }; return fakeChild(); },
    }));
    for (const [k, v] of Object.entries(conn)) expect(seen.opts.env[k]).toBe(v);
    expect("AILE_TOKEN" in seen.opts.env).toBe(false);
    // The container gets none of them: only a declared name is passed by --env.
    expect(seen.args).not.toContain("--env");
  });

  it("a declared value beats the node's own for the same name", () => {
    const homed = normalizeServer({ id: "srv", image: "alpine:3", env: { HOME: "/tmp" } });
    let seen = null;
    withEnv({ HOME: "/home/lender" }, () => spawnServer(homed, {
      streamId: 1, runtime: "docker", log: { warn() {}, debug() {} },
      spawnImpl: (bin, args, opts) => { seen = { args, opts }; return fakeChild(); },
    }));
    expect(seen.opts.env.HOME).toBe("/tmp");
    expect(flag(seen.args, "--env")).toBe("HOME");
  });

  it("kills in the same environment it ran in, so it reaches the same daemon", () => {
    // A declared DOCKER_HOST picked the daemon `run` used; a `kill` in the
    // node's own env would ask another one and leave the container running.
    const pinned = normalizeServer({ id: "srv", image: "alpine:3", env: { DOCKER_HOST: "tcp://10.0.0.5:2375" } });
    let spawned = null;
    const kills = [];
    withEnv({ DOCKER_HOST: "unix:///var/run/docker.sock", ...NODE_SECRET }, () => {
      const s = spawnServer(pinned, {
        streamId: 1, runtime: "docker", log: { warn() {}, debug() {} },
        spawnImpl: (bin, args, opts) => { spawned = opts.env; return fakeChild(); },
        killImpl: (bin, args, opts) => { kills.push({ args, env: opts.env }); },
      });
      s.kill();
    });
    expect(kills.length).toBe(1);
    expect(kills[0].args[0]).toBe("kill");
    expect(kills[0].env).toEqual(spawned);
    expect(kills[0].env.DOCKER_HOST).toBe("tcp://10.0.0.5:2375");
    expect("AILE_TOKEN" in kills[0].env).toBe(false);
  });

  it("stops the container without waiting on the runtime CLI", () => {
    // A spawnSync here froze the node's one event loop — every relayed stream —
    // for a whole runtime round trip, up to 10 s, on each session end.
    const k = Object.assign(new EventEmitter(), { unrefd: false, unref() { this.unrefd = true; } });
    const kills = [];
    let cliKilled = false;
    const s = spawnServer(server, {
      streamId: 1, runtime: "docker", log: { warn() {}, debug() {} },
      spawnImpl: () => ({ ...fakeChild(), kill() { cliKilled = true; } }),
      killImpl: (bin, args, opts) => { kills.push({ bin, args, opts }); return k; },
    });
    s.kill();
    expect(kills).toHaveLength(1);
    expect(kills[0].bin).toBe("docker");
    expect(kills[0].args).toEqual(["kill", s.name]);
    // Detached and unreferenced: it outlives a node that exits right after
    // (Windows kills a non-detached child with its parent) and holds nothing open.
    expect(kills[0].opts.detached).toBe(true);
    expect(k.unrefd).toBe(true);
    // A runtime gone by then reports ENOENT as an event; unheard, it would
    // take the whole node down.
    expect(() => k.emit("error", Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }))).not.toThrow();
    expect(cliKilled).toBe(true);
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
    const envs = [];
    const res = withEnv(NODE_SECRET, () => reapOrphans({
      runtime: "docker",
      log: { warn() {} },
      run: (bin, args, o) => {
        calls.push(args);
        envs.push(o?.env);
        if (args[0] === "ps") return { status: 0, stdout: "abc123\ndef456\n" };
        return { status: 0 };
      },
    }));
    expect(calls[0]).toEqual(["ps", "-q", "--filter", `name=^${CONTAINER_PREFIX}`]);
    expect(res.reaped).toEqual(["abc123", "def456"]);
    // One ps and two kills, each in the constructed env, never the node's.
    expect(envs.length).toBe(3);
    for (const e of envs) { expect(e).toBeDefined(); expect("AILE_TOKEN" in e).toBe(false); }
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
