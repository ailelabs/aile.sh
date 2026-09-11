/**
 * One rented MCP session, against a fake child.
 *
 * The three properties src/mcp/stream.js calls non-incidental are each pinned
 * here, and the first of them is the same shape as test/open-race.test.js: DATA
 * that arrives before the child's stdin exists must be BUFFERED, not dropped.
 * On the provider path that bug shipped once; a spawn re-arms it, so the fix is
 * re-armed too.
 */

import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { McpSession } from "../src/mcp/stream.js";
import { normalizeServer } from "../src/mcp/config.js";

const SERVER = normalizeServer({ id: "srv", image: "alpine:3", timeoutMs: 5000 });

/** A stand-in for a `docker run -i` process: three streams and a close event. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.written = [];
  child.stdin = Object.assign(new EventEmitter(), {
    write: (chunk) => { child.written.push(Buffer.from(chunk)); return true; },
  });
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

function session(overrides = {}, { server = SERVER, spawnDelayed = false } = {}) {
  const events = { data: [], closed: null, errored: null };
  const child = fakeChild();
  const s = new McpSession({
    server,
    streamId: 1,
    runtime: "docker",
    log: { warn() {}, debug() {} },
    spawnImpl: () => child,
    onData: (chunk) => events.data.push(chunk),
    onClose: (reason) => { events.closed = reason; },
    onError: (message) => { events.errored = message; },
    ...overrides,
  });
  if (!spawnDelayed) s.start();
  return { s, child, events };
}

describe("McpSession", () => {
  // PROPERTY 1
  it("buffers writes that arrive before the container exists, in order", () => {
    const { s, child } = session({}, { spawnDelayed: true });
    s.write(Buffer.from("{\"id\":1}\n"));
    s.write(Buffer.from("{\"id\":2}\n"));
    expect(s.pendingBytes).toBeGreaterThan(0);
    s.start();
    expect(Buffer.concat(child.written).toString()).toBe("{\"id\":1}\n{\"id\":2}\n");
    expect(s.pendingBytes).toBe(0);
  });

  it("fails rather than growing without bound when the container never starts", () => {
    const events = { errored: null };
    const s = new McpSession({
      server: SERVER,
      streamId: 1,
      runtime: "docker",
      maxPendingBytes: 64,
      log: { warn() {}, debug() {} },
      spawnImpl: () => fakeChild(),
      onData() {},
      onClose() {},
      onError: (m) => { events.errored = m; },
    });
    s.write(Buffer.alloc(128));
    expect(events.errored).toMatch(/pre-start buffer exceeded/);
    expect(s.closed).toBe(true);
  });

  // PROPERTY 2. stderr is where a crashing child prints its environment, its
  // paths and sometimes its credentials — and anything but JSON-RPC on the
  // stream corrupts the session besides.
  it("NEVER puts the child's stderr on the wire", () => {
    const logged = [];
    const { s, child, events } = session({ log: { warn() {}, debug: (m) => logged.push(m) } });
    child.stderr.emit("data", Buffer.from("ANTHROPIC_API_KEY=sk-ant-leak\n"));
    expect(events.data).toHaveLength(0);
    expect(events.errored).toBeNull();
    expect(logged.join("\n")).toContain("sk-ant-leak");   // the node's own log, and nowhere else
    s.close();
  });

  it("forwards stdout verbatim, without parsing it", () => {
    const { s, child, events } = session();
    child.stdout.emit("data", Buffer.from("not json at all"));
    expect(events.data).toHaveLength(1);
    expect(events.data[0].toString()).toBe("not json at all");
    s.close();
  });

  it("reports a container that exits without ever answering as a fault", () => {
    const { child, events } = session();
    child.emit("close", 127);
    expect(events.errored).toMatch(/exited immediately \(code 127\)/);
    expect(events.closed).toBeNull();
  });

  it("treats an exit after real output as an ordinary close", () => {
    const { child, events } = session();
    child.stdout.emit("data", Buffer.from("{}"));
    child.emit("close", 1);
    expect(events.errored).toBeNull();
    expect(events.closed).toBe("sandbox exited");
  });

  // PROPERTY 3. There is no socket here, so the relay's socket idle timeout
  // governs nothing: a container with a hung child would live until restart.
  it("ends a session that goes idle", async () => {
    const events = { errored: null };
    const child = fakeChild();
    const s = new McpSession({
      server: SERVER,
      streamId: 1,
      runtime: "docker",
      idleTimeoutMs: 20,
      log: { warn() {}, debug() {} },
      spawnImpl: () => child,
      onData() {},
      onClose() {},
      onError: (m) => { events.errored = m; },
    });
    s.start();
    await Bun.sleep(60);
    expect(events.errored).toMatch(/idle for 20ms/);
    expect(child.killed).toBe(true);
  });

  it("bounds one session absolutely, however busy it is", async () => {
    const brief = normalizeServer({ id: "srv", image: "alpine:3", timeoutMs: 5000 });
    brief.timeoutMs = 25;                       // below the schema floor on purpose
    const { s, events } = session({ idleTimeoutMs: 10000 }, { server: brief });
    for (let i = 0; i < 5; i++) {
      s.write(Buffer.from("keepalive"));
      await Bun.sleep(10);
    }
    expect(events.errored).toMatch(/exceeded 25ms/);
  });

  it("kills the container and is idempotent about it", () => {
    const { s, child, events } = session();
    s.close("stream closed");
    s.close("again");
    expect(child.killed).toBe(true);
    expect(events.closed).toBe("stream closed");
    expect(s.closed).toBe(true);
  });

  it("ignores writes after close instead of throwing into the frame dispatch", () => {
    const { s, child } = session();
    s.close();
    const before = child.written.length;
    s.write(Buffer.from("late"));
    expect(child.written.length).toBe(before);
  });

  it("reports a spawn that throws as the reason it threw", () => {
    const events = { errored: null };
    const s = new McpSession({
      server: SERVER,
      streamId: 1,
      runtime: "docker",                        // skip detection; the spawn itself is what fails
      log: { warn() {}, debug() {} },
      spawnImpl: () => { throw new Error("nope"); },
      onData() {},
      onClose() {},
      onError: (m) => { events.errored = m; },
    });
    s.start();
    expect(events.errored).toBe("nope");
    expect(s.closed).toBe(true);
  });

  it("counts bytes both ways", () => {
    const { s, child } = session();
    s.write(Buffer.from("abc"));
    child.stdout.emit("data", Buffer.from("defg"));
    expect(s.stats()).toMatchObject({ streamId: 1, serverId: "srv", bytesIn: 3, bytesOut: 4 });
    s.close();
  });
});
