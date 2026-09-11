/**
 * `aile mcp answer`: one job, one fresh agent process, then nothing left behind.
 *
 * Most of these assert REFUSALS and ABSENCES, and that is the point of the
 * file. A runner that inherits the parent's secrets, runs the task through a
 * shell, or leaves the scratch dir behind would still answer jobs — the
 * failure would be silent, which is exactly what the tests are for.
 *
 * The spawn tests run real one-line `node -e` children: fast, local, and the
 * only honest way to check timeouts, kills and cleanup.
 */

import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_MAX_ANSWER_BYTES,
  DEFAULT_TIMEOUT_MS,
  TASK_FILE_TOKEN,
  buildChildEnv,
  checkJobForLender,
  defaultTimeoutFor,
  parseJobInput,
  resolveChildArgs,
  runAttendedJob,
} from "../src/mcp/attended.js";

const NODE = process.execPath;
const JOB = { jobId: "mcpj_test", lenderId: "mcpl_test", task: "say hi", deadlineMs: 60_000 };

function withSecrets(names, fn) {
  const saved = new Map();
  for (const [k, v] of Object.entries(names)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Run a real child and return its result. Every case cleans up after itself. */
function run(command, over = {}) {
  return runAttendedJob({ job: { ...JOB }, command, timeoutMs: 10_000, ...over });
}

describe("parseJobInput", () => {
  it("takes the await_mcp_work job object as-is", () => {
    expect(parseJobInput({ ...JOB })).toMatchObject({
      jobId: "mcpj_test",
      lenderId: "mcpl_test",
      task: "say hi",
      deadlineMs: 60_000,
    });
  });

  it("takes the same object as JSON text", () => {
    expect(parseJobInput(JSON.stringify(JOB)).jobId).toBe("mcpj_test");
  });

  it("tolerates a UTF-8 BOM on a hand-written job file", () => {
    expect(parseJobInput("\uFEFF" + JSON.stringify(JOB)).jobId).toBe("mcpj_test");
  });

  it("reads no other field: notices and tokens are for the poller, not the child", () => {
    const parsed = parseJobInput({ ...JOB, contextReset: { token: "secret" }, notice: "n" });
    expect("contextReset" in parsed).toBe(false);
    expect("notice" in parsed).toBe(false);
  });

  it("refuses what is not the job object", () => {
    expect(() => parseJobInput("{nope")).toThrow(/not valid JSON/);
    expect(() => parseJobInput(["mcpj_test"])).toThrow(/not an array or scalar/);
    expect(() => parseJobInput({ task: "t" })).toThrow(/no usable jobId/);
    expect(() => parseJobInput({ jobId: "mcpj_test" })).toThrow(/no task text/);
  });

  it("treats a garbage deadline as absent rather than as zero", () => {
    expect(parseJobInput({ ...JOB, deadlineMs: "soon" }).deadlineMs).toBeNull();
    expect(parseJobInput({ ...JOB, deadlineMs: -5 }).deadlineMs).toBeNull();
  });
});

describe("checkJobForLender", () => {
  it("passes a matching listing and a job that names none", () => {
    expect(() => checkJobForLender({ ...JOB }, "mcpl_test")).not.toThrow();
    expect(() => checkJobForLender({ ...JOB, lenderId: null }, "mcpl_test")).not.toThrow();
    expect(() => checkJobForLender({ ...JOB }, null)).not.toThrow();
  });

  it("refuses another listing's work", () => {
    expect(() => checkJobForLender({ ...JOB }, "mcpl_other")).toThrow(/another listing's work/);
  });
});

describe("buildChildEnv", () => {
  const workdir = path.join(os.tmpdir(), "aile-env-probe");

  it("constructs, never inherits: parent secrets are absent", () => {
    withSecrets({ AILE_TOKEN: "ail_parent", ANTHROPIC_API_KEY: "sk-ant-parent" }, () => {
      const env = buildChildEnv({ workdir, job: JOB });
      expect(env.PATH).toBe(process.env.PATH);
      expect("AILE_TOKEN" in env).toBe(false);
      expect("ANTHROPIC_API_KEY" in env).toBe(false);
      expect(env.AILE_MCP_JOB_ID).toBe("mcpj_test");
      expect(env.AILE_MCP_LENDER).toBe("mcpl_test");
      expect(env.AILE_MCP_WORKDIR).toBe(workdir);
    });
  });

  it("passes through exactly the names allowed, and refuses a hostile name", () => {
    withSecrets({ LEND_MODEL: "sonnet" }, () => {
      const env = buildChildEnv({ workdir, job: JOB, allowEnv: ["LEND_MODEL"] });
      expect(env.LEND_MODEL).toBe("sonnet");
    });
    expect(() => buildChildEnv({ workdir, job: JOB, allowEnv: ["A;rm"] })).toThrow(/not a plain variable name/);
  });

  it("gives the child a fresh HOME unless told to keep the operator's", () => {
    const fresh = buildChildEnv({ workdir, job: JOB });
    expect(fresh.HOME).toBe(workdir);
    expect(fresh.TMPDIR).toBe(workdir);
    const kept = buildChildEnv({ workdir, job: JOB, keepHome: true });
    expect(kept.HOME).toBe(process.env.HOME);
  });
});

describe("resolveChildArgs", () => {
  it("replaces exactly the token element, as one element", () => {
    const { args, usesTaskFile } = resolveChildArgs(["-p", TASK_FILE_TOKEN, "--x"], "/tmp/w/task.txt");
    expect(args).toEqual(["-p", "/tmp/w/task.txt", "--x"]);
    expect(usesTaskFile).toBe(true);
  });

  it("leaves everything else alone, including near-misses", () => {
    const { args, usesTaskFile } = resolveChildArgs(["--prompt={{TASK_FILE}}", "x"], "/tmp/w/task.txt");
    // Interpolating into a larger string is where an injection would hide, so
    // a token that is not the whole element is not a token at all.
    expect(args).toEqual(["--prompt={{TASK_FILE}}", "x"]);
    expect(usesTaskFile).toBe(false);
  });
});

describe("defaultTimeoutFor", () => {
  it("takes the job's deadline minus headroom, floored, with a fallback", () => {
    expect(defaultTimeoutFor({ deadlineMs: 60_000 })).toBe(55_000);
    expect(defaultTimeoutFor({ deadlineMs: 6_000 })).toBe(10_000);
    expect(defaultTimeoutFor({ deadlineMs: null })).toBe(DEFAULT_TIMEOUT_MS);
  });
});

describe("runAttendedJob", () => {
  it("runs the command fresh per job and answers on stdout", async () => {
    const res = await run([
      NODE, "-e", "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>process.stdout.write('A:'+s))",
    ]);
    expect(res.ok).toBe(true);
    expect(res.answer).toBe("A:say hi");
    expect(res.truncated).toBe(false);
    expect(res.answerBytes).toBe(Buffer.byteLength("A:say hi", "utf8"));
  });

  it("removes the scratch directory however the run ends", async () => {
    const res = await run([NODE, "-e", "process.stdout.write(process.env.AILE_MCP_WORKDIR)"]);
    expect(res.ok).toBe(true);
    expect(fs.existsSync(res.answer)).toBe(false);
  });

  it("feeds the task file when the command asks for it by token", async () => {
    const res = await run([
      NODE, "-e", "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))",
      TASK_FILE_TOKEN,
    ]);
    expect(res.ok).toBe(true);
    expect(res.answer).toBe("say hi");
  });

  it("reports a nonzero exit as failure, never as an answer", async () => {
    const res = await run([NODE, "-e", "process.stdout.write('almost');process.exit(3)"]);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("agent_failed");
    expect(res.detail).toContain("code 3");
    expect("answer" in res).toBe(false);
  });

  it("reports silence as failure: exit 0 with no output answers nothing", async () => {
    const res = await run([NODE, "-e", "process.stderr.write('thinking out loud')"]);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("empty_answer");
    // And the chatter stays in diagnostics — it must never ride along as content.
    expect("answer" in res).toBe(false);
  });

  it("kills a hung child at the budget and says so", async () => {
    const res = await run([NODE, "-e", "setTimeout(()=>{},30000)"], { timeoutMs: 200 });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("timed_out");
  });

  it("caps the answer and flags the cut", async () => {
    const res = await run([NODE, "-e", "process.stdout.write('x'.repeat(1000))"], { maxAnswerBytes: 100 });
    expect(res.ok).toBe(true);
    expect(res.truncated).toBe(true);
    expect(res.answerBytes).toBeLessThanOrEqual(100);
  });

  it("keeps the child's secrets out of a fresh HOME by default", async () => {
    const res = await run([NODE, "-e", "process.stdout.write(process.env.HOME || '')"]);
    expect(res.ok).toBe(true);
    // Fresh per job (the dir is gone afterwards) and not the operator's.
    expect(res.answer).not.toBe(process.env.HOME);
    expect(fs.existsSync(res.answer)).toBe(false);
  });

  it("never spawns when already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    let spawned = false;
    const res = await runAttendedJob({
      job: { ...JOB },
      command: [NODE, "-e", ""],
      signal: ac.signal,
      spawnImpl: () => {
        spawned = true;
        throw new Error("spawned despite abort");
      },
    });
    expect(spawned).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("aborted");
  });

  it("refuses to run with no command", async () => {
    const res = await runAttendedJob({ job: { ...JOB }, command: [] }).catch((e) => e);
    expect(res).toBeInstanceOf(Error);
    expect(res.message).toMatch(/after `--`/);
  });

  it("defaults the cap under submit_mcp_work's own limit", () => {
    // A runner cap above the server's content cap would manufacture answers
    // the submit call refuses — the default must leave headroom.
    expect(DEFAULT_MAX_ANSWER_BYTES).toBeLessThan(262_144);
  });
});
