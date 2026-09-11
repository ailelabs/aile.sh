/**
 * How `aile accounts` renders WHERE each account is served right now.
 *
 * The user complaint this pins: an account carried by the very node you are
 * looking at read as "Needs a node", and one served through Aile with no machine
 * read the same — the CLI answered "is a machine involved?" from the raw
 * `allow_nodeless` flag and never looked at live presence. The fix moved the
 * verdict onto the server (`lib/serving.ts`, one rule for every surface) and made
 * the CLI RENDER `account.serving` instead of re-deriving it.
 *
 * So these tests feed a `serving` verdict through the stubbed `/providers` and
 * assert the one distinction a lender at a terminal actually wants: is THIS box
 * doing the work, is another of theirs, is Aile, or is nothing. The node id is
 * made deterministic by seeding the two files `getNodeId()` derives from, so the
 * "THIS machine" branch is a real assertion rather than a coin flip.
 *
 * Run: cd apps/aile.sh && bun test --isolate test/serving-cli.test.js
 */

import { describe, expect, it, beforeEach, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const CLI = path.join(import.meta.dirname, "..", "src", "cli", "index.js");
const scratches = [];

// `getNodeId()` = sha256(machineId + "aile-node" + secret).slice(0,16), reading
// machineId from AILE_DIR/machine-id and secret from AILE_DIR/node-secret. Seed
// both so the id this machine reports is a value the test knows in advance.
const MACHINE_ID = "1111111111111111aaaaaaaaaaaaaaaa";
const NODE_SECRET = "2222222222222222bbbbbbbbbbbbbbbb2222222222222222cccccccccccccccc";
const HERE = crypto
  .createHash("sha256")
  .update(MACHINE_ID + "aile-node" + NODE_SECRET)
  .digest("hex")
  .substring(0, 16);
const OTHER = "ffffffffffffffff"; // a different node of the same renter's

/** A signed-in data dir whose node id is deterministic (== HERE). */
function signedInData(serverUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aile-serving-"));
  scratches.push(dir);
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ serverUrl, renterToken: "ail_" + "a".repeat(48) }),
  );
  fs.writeFileSync(path.join(dir, "machine-id"), MACHINE_ID, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "node-secret"), NODE_SECRET, { mode: 0o600 });
  return dir;
}

function stubServer(accounts) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/providers" && req.method === "GET") {
        return Response.json({ success: true, data: { accounts }, message: "" });
      }
      return Response.json({ success: false, message: "not found", error: "x" }, { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => { try { server.stop(true); } catch { /* ignore */ } } };
}

async function run(args, data) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, AILE_DATA_DIR: data, NO_COLOR: "1" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 15_000);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const strip = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  return { stdout: strip(stdout), stderr: strip(stderr) };
}

let stub;
let data;
function serve(accounts) {
  stub?.stop();
  stub = stubServer(accounts);
  data = signedInData(stub.url);
}

beforeEach(() => { stub = null; data = null; });
afterAll(() => {
  stub?.stop();
  for (const dir of scratches) fs.rmSync(dir, { recursive: true, force: true });
});

describe("aile accounts — the serving line reads live presence, not the flag", () => {
  it("names THIS machine when the serving node is this box", async () => {
    serve([{
      id: "aaaa0001", provider: "openrouter", account_key: "default", label: "Spare", attested: 0,
      serving: { via: "node", nodeId: HERE, online: true, nodeless: true, nodelessCapable: true },
    }]);
    const { stdout } = await run(["accounts"], data);
    expect(stdout).toMatch(/serving through THIS machine/);
    // nodeless true beside a live node → the honest "also reachable" aside.
    expect(stdout).toMatch(/also reachable via Aile/);
  });

  it("names ANOTHER machine when a different node of yours carries it", async () => {
    serve([{
      id: "aaaa0002", provider: "codex", account_key: "default", label: "Work", attested: 1,
      serving: { via: "node", nodeId: OTHER, online: true, nodeless: false, nodelessCapable: false },
    }]);
    const { stdout } = await run(["accounts"], data);
    expect(stdout).toMatch(/serving through another of your machines/);
    expect(stdout).not.toMatch(/THIS machine/);
  });

  it("says nodeless when Aile serves it with no machine in the path", async () => {
    serve([{
      id: "aaaa0003", provider: "openrouter", account_key: "default", label: "Direct", attested: 0,
      serving: { via: "nodeless", nodeId: null, online: false, nodeless: true, nodelessCapable: true },
    }]);
    const { stdout } = await run(["accounts"], data);
    expect(stdout).toMatch(/serving nodeless/);
    expect(stdout).toMatch(/no machine in the path/);
  });

  it("says NOT serving when no node is up and nodeless is off", async () => {
    serve([{
      id: "aaaa0004", provider: "codex", account_key: "default", label: "Idle", attested: 1,
      serving: { via: "none", nodeId: null, online: false, nodeless: false, nodelessCapable: false },
    }]);
    const { stdout } = await run(["accounts"], data);
    expect(stdout).toMatch(/not serving/);
    // The way out is named, so the line is actionable rather than just a verdict.
    expect(stdout).toMatch(/aile start/);
  });
});

describe("the nodeless switch is offered only where it can be honoured", () => {
  it("points an API-key account that is nodeless back to the machine", async () => {
    serve([{
      id: "bbbb0001", provider: "openrouter", account_key: "default", label: "Key", attested: 0,
      serving: { via: "nodeless", nodeId: null, online: false, nodeless: true, nodelessCapable: true },
    }]);
    const { stdout } = await run(["accounts"], data);
    expect(stdout).toMatch(/serve only through this machine/);
    expect(stdout).toMatch(/aile nodeless 1 off/);
  });

  it("offers to arm an API-key account that has no machine and is not nodeless", async () => {
    serve([{
      id: "bbbb0002", provider: "openrouter", account_key: "default", label: "Key", attested: 0,
      serving: { via: "none", nodeId: null, online: false, nodeless: false, nodelessCapable: true },
    }]);
    const { stdout } = await run(["accounts"], data);
    expect(stdout).toMatch(/also serve without this machine/);
    expect(stdout).toMatch(/aile nodeless 1 on/);
  });

  it("never offers the switch for a subscription — the serve path would ignore it", async () => {
    serve([{
      id: "bbbb0003", provider: "codex", account_key: "default", label: "Sub", attested: 1,
      serving: { via: "none", nodeId: null, online: false, nodeless: false, nodelessCapable: false },
    }]);
    const { stdout } = await run(["accounts"], data);
    expect(stdout).not.toMatch(/aile nodeless/);
  });
});

describe("back-compat — a relay too old to send a verdict", () => {
  it("falls back to the raw flag: allow_nodeless true reads as nodeless", async () => {
    serve([{
      id: "cccc0001", provider: "openrouter", account_key: "default", label: "Legacy", attested: 0,
      allow_nodeless: true, // no `serving` — the un-upgraded server
    }]);
    const { stdout } = await run(["accounts"], data);
    expect(stdout).toMatch(/serving nodeless/);
  });

  it("falls back to NOT serving when the old flag is unset", async () => {
    serve([{
      id: "cccc0002", provider: "openrouter", account_key: "default", label: "Legacy", attested: 0,
      // no `serving`, no flag
    }]);
    const { stdout } = await run(["accounts"], data);
    expect(stdout).toMatch(/not serving/);
  });
});
