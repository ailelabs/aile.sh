/**
 * `aile mcp answer` — run ONE attended job in a FRESH agent process.
 *
 * WHY THIS EXISTS
 * ---------------
 * `transport: "agent"` lends the lender's OWN running agent, and that agent
 * typically serves from one long-lived harness session. Every job it answers
 * in that session lands in a context still holding the previous renter's task
 * and answer — cross-renter bleed no server-side check can wipe, because the
 * server cannot reach into the lender's harness. The server CAN fence delivery
 * behind a reset token (`lib/mcp/agentQueue.ts`), which proves the agent passed
 * through a reset step; THIS module is the step itself. It runs the lender's
 * configured one-shot agent command as a brand-new process per job — empty
 * conversation, fresh scratch directory, constructed environment — captures its
 * answer, and deletes the scratch afterwards. A fresh process is the only thing
 * that actually clears context; the token only proves you used one.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not a poller and not a sandbox. It never talks to Aile — the lender's
 * agent keeps its own MCP connection and keeps calling `await_mcp_work` /
 * `submit_mcp_work` itself; this only executes one job it was handed. And it
 * does not containerize the agent command: that command runs with the
 * lender's own user privileges and whatever credentials its environment
 * carries, so point it at a least-privilege one-shot agent, never at an
 * interactive session with your keys in reach.
 *
 * SECURITY RULES, stated so they can be checked:
 * - no shell, ever: the command is spawned with `shell: false` and the task
 *   reaches it on stdin or in a file, never interpolated into a command line,
 *   so a hostile task cannot become a hostile command;
 * - constructed environment: the child inherits ONLY an allowlist (PATH, the
 *   platform minimum, and names the lender passes with --allow-env) plus the
 *   per-job AILE_MCP_* variables. Your Aile token, API keys and shell secrets
 *   are absent unless you explicitly allow them — and allowing them is the
 *   thing this module exists to talk you out of;
 * - stderr is diagnostics, never the answer: it is returned to the operator
 *   and never submitted to the renter, so a chatty agent cannot leak a
 *   previous job's scratch into the next answer;
 * - the scratch directory (cwd, HOME, TMPDIR for the child) is removed when
 *   the run ends, however it ends.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

/** An argv element exactly equal to this is replaced with the task file's path. */
export const TASK_FILE_TOKEN = "{{TASK_FILE}}";

/** Default wall-clock budget per job when the job names none. */
export const DEFAULT_TIMEOUT_MS = 110_000;

/** Default cap on a collected answer, in bytes. Under `submit_mcp_work`'s own
 * 262_144-character cap with headroom to spare. */
export const DEFAULT_MAX_ANSWER_BYTES = 200_000;

/** Cap on remembered stderr. Diagnostics, never submitted — so small is fine. */
export const MAX_STDERR_BYTES = 65_536;

/** Mirror of the server's `submit_mcp_work` content cap: an answer longer than
 * this in CHARACTERS would be refused at submit time, so truncate here with
 * the flag set rather than failing there. */
export const SUBMIT_CONTENT_MAX_CHARS = 262_144;

/** Grace between SIGTERM and SIGKILL on timeout. Short: the child already had its budget. */
const KILL_GRACE_MS = 3_000;

/** Extra pipe-drain slack past the answer cap. The child must never block on a
 * full pipe while we decide it has said enough — so past the cap we keep
 * READING and stop KEEPING. */
const DRAIN_SLACK_BYTES = 16_384;

/**
 * Parse one job as handed out by `await_mcp_work`.
 *
 * Accepts the parsed object or its JSON text. Returns the fields the runner
 * needs and nothing else — the rest of the view (notices, reset tokens,
 * envelope knobs) is for the polling agent, not for the child process, and
 * the child must not be able to read them off its own argv or env.
 */
export function parseJobInput(raw) {
  let job;
  if (typeof raw === "string") {
    // A hand-written job file may carry a UTF-8 BOM; JSON.parse chokes on it,
    // and "not valid JSON" would send the operator hunting a phantom typo.
    const text = raw.replace(/^\uFEFF/, "");
    try {
      job = JSON.parse(text);
    } catch {
      throw new Error("the job is not valid JSON — pass the `job` object from await_mcp_work");
    }
  } else {
    job = raw;
  }
  if (!job || typeof job !== "object" || Array.isArray(job)) {
    throw new Error("the job must be the `job` object from await_mcp_work, not an array or scalar");
  }
  if (typeof job.jobId !== "string" || job.jobId.length === 0 || job.jobId.length > 128) {
    throw new Error("the job has no usable jobId — pass the `job` object from await_mcp_work unchanged");
  }
  if (typeof job.task !== "string" || job.task.length === 0) {
    throw new Error(`job ${job.jobId} carries no task text — nothing to run`);
  }
  return {
    jobId: job.jobId,
    lenderId: typeof job.lenderId === "string" ? job.lenderId : null,
    task: job.task,
    deadlineMs:
      typeof job.deadlineMs === "number" && Number.isFinite(job.deadlineMs) && job.deadlineMs > 0
        ? Math.floor(job.deadlineMs)
        : null,
  };
}

/** The job must be served under the listing the operator named — a job file is
 * easy to mix up, and answering another listing's work is the failure the
 * server's ownership check exists to prevent. */
export function checkJobForLender(job, lenderId) {
  if (!lenderId) return;
  if (job.lenderId && job.lenderId !== lenderId) {
    throw new Error(
      `job ${job.jobId} belongs to listing ${job.lenderId}, not ${lenderId} — refusing to answer another listing's work`,
    );
  }
}

/** An env name that is safe to copy. Anything else is refused, not skipped. */
function checkEnvName(name) {
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`refusing to pass through env name ${JSON.stringify(String(name))} — not a plain variable name`);
  }
  return name;
}

/**
 * The child's whole environment, constructed — never inherited.
 *
 * Starts from PATH (nothing runs without it) plus the platform minimum, adds
 * exactly the names in `allowEnv` when the parent actually holds them, then
 * the per-job variables. Everything else the parent holds — Aile tokens, API
 * keys, shell secrets — is absent. `keepHome: false` (the default) also points
 * HOME at the scratch dir, so the child cannot read the operator's real dotfiles;
 * pass `keepHome: true` only if the agent command keeps its credentials there
 * and you accept that it can then also read everything else there.
 */
export function buildChildEnv({ allowEnv = [], workdir, job, keepHome = false } = {}) {
  if (!workdir) throw new Error("buildChildEnv needs the job's scratch directory");
  const env = { PATH: process.env.PATH || "" };
  // A process on Windows does not start without this; on POSIX it is absent
  // and stays absent.
  if (process.platform === "win32" && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  for (const name of allowEnv) {
    checkEnvName(name);
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.AILE_MCP_JOB_ID = job.jobId;
  env.AILE_MCP_LENDER = job.lenderId || "";
  env.AILE_MCP_WORKDIR = workdir;
  if (keepHome) {
    if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
    if (process.env.USERPROFILE !== undefined) env.USERPROFILE = process.env.USERPROFILE;
  } else {
    env.HOME = workdir;
    if (process.platform === "win32") env.USERPROFILE = workdir;
  }
  env.TMPDIR = workdir;
  if (process.platform === "win32") {
    env.TEMP = workdir;
    env.TMP = workdir;
  }
  return env;
}

/**
 * Substitute the task-file token. Only an argv element EXACTLY equal to
 * `{{TASK_FILE}}` is replaced, as one element — never interpolated into a
 * larger string, which is where an injection would hide.
 */
export function resolveChildArgs(argv, taskFile) {
  let usesTaskFile = false;
  const args = (argv || []).map((a) => {
    if (a === TASK_FILE_TOKEN) {
      usesTaskFile = true;
      return taskFile;
    }
    return a;
  });
  return { args, usesTaskFile };
}

/** Default timeout: the job's own deadline minus headroom, so WE kill the
 * child while there is still time to report the timeout — or the fallback when
 * the job names none. An explicit operator timeout always wins. */
export function defaultTimeoutFor(job) {
  if (job.deadlineMs) return Math.max(10_000, Math.min(job.deadlineMs - 5_000, 300_000));
  return DEFAULT_TIMEOUT_MS;
}

/**
 * Run one job in a fresh agent process and capture its answer.
 *
 * `command` is `[cmd, ...args]` with NO shell: args containing spaces or
 * metacharacters are passed verbatim to the child, never parsed. The task
 * reaches the child on stdin, unless an argv element is exactly
 * `{{TASK_FILE}}` — then it ALSO goes in a 0600 file in the scratch dir whose
 * path replaces the token, and stdin stays empty so the child cannot be
 * confused by two prompts.
 *
 * Resolves `{ ok: true, jobId, lenderId, answer, answerBytes, truncated }` or
 * `{ ok: false, jobId, lenderId, error, detail }`. `error` is a short code the
 * polling agent can submit as its `error`; `detail` is operator diagnostics
 * (exit codes, stderr tails) that must stay local and never be submitted.
 */
export function runAttendedJob({
  job,
  lenderId = null,
  command,
  timeoutMs = null,
  maxAnswerBytes = DEFAULT_MAX_ANSWER_BYTES,
  allowEnv = [],
  keepHome = false,
  tmpBase = null,
  spawnImpl = spawn,
  signal = null,
} = {}) {
  if (!job || typeof job.jobId !== "string") {
    return Promise.reject(new Error("runAttendedJob needs a job parsed by parseJobInput"));
  }
  if (!Array.isArray(command) || command.length === 0 || typeof command[0] !== "string" || !command[0]) {
    return Promise.reject(new Error("no agent command — put it after `--`, e.g. `aile mcp answer --job j.json -- claude -p`"));
  }
  const budget = timeoutMs ?? defaultTimeoutFor(job);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    // Already aborted before anything started: do NOT create a scratch dir or
    // spawn — there is nobody left to answer to.
    if (signal?.aborted) {
      finish({
        ok: false, jobId: job.jobId, lenderId: job.lenderId || lenderId,
        error: "aborted", detail: "the run was aborted before it started",
      });
      return;
    }

    let workdir;
    try {
      workdir = fs.mkdtempSync(path.join(tmpBase || os.tmpdir(), "aile-job-"));
    } catch (e) {
      finish({
        ok: false, jobId: job.jobId, lenderId: job.lenderId || lenderId,
        error: "no_scratch", detail: `could not create a scratch directory: ${e?.message || e}`,
      });
      return;
    }

    const cleanup = () => {
      try {
        fs.rmSync(workdir, { recursive: true, force: true });
      } catch { /* best effort: a leftover scratch dir is litter, not a leak into the next job */ }
    };

    const done = (result) => {
      cleanup();
      finish(result);
    };
    const failed = (error, detail) =>
      done({ ok: false, jobId: job.jobId, lenderId: job.lenderId || lenderId, error, detail });

    let env;
    try {
      env = buildChildEnv({ allowEnv, workdir, job, keepHome });
    } catch (e) {
      failed("bad_env", e?.message || String(e));
      return;
    }

    // The task file exists only when the command asks for it by token. 0600:
    // the task is a renter's untrusted input, but it is still their data, and
    // the scratch dir is shared with nobody.
    const { args, usesTaskFile } = resolveChildArgs(command.slice(1), path.join(workdir, "task.txt"));
    if (usesTaskFile) {
      try {
        fs.writeFileSync(path.join(workdir, "task.txt"), job.task, { mode: 0o600 });
      } catch (e) {
        failed("no_scratch", `could not write the task file: ${e?.message || e}`);
        return;
      }
    }

    let child;
    try {
      child = spawnImpl(command[0], args, {
        cwd: workdir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        // NO SHELL. This is the load-bearing option in this file: with a shell
        // the task text would be one metacharacter away from command execution.
        shell: false,
        windowsHide: true,
      });
    } catch (e) {
      failed("spawn_failed", `could not start ${command[0]}: ${e?.message || e}`);
      return;
    }
    if (!child || !child.stdout || !child.stdin) {
      failed("spawn_failed", `could not start ${command[0]}: no child process returned`);
      return;
    }

    const outChunks = [];
    let outBytes = 0;
    let truncated = false;
    const keep = maxAnswerBytes + DRAIN_SLACK_BYTES;
    child.stdout.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      outBytes += buf.length;
      // Past the cap we keep DRAINING and stop KEEPING: a child blocked on a
      // full pipe it nobody reads is a hang, not a cap.
      if (outBytes - buf.length < keep) outChunks.push(buf.slice(0, keep - (outBytes - buf.length)));
      if (outBytes > maxAnswerBytes) truncated = true;
    });

    const errChunks = [];
    let errBytes = 0;
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        errBytes += buf.length;
        if (errBytes - buf.length < MAX_STDERR_BYTES) {
          errChunks.push(buf.slice(0, MAX_STDERR_BYTES - (errBytes - buf.length)));
        }
      });
    }
    const stderrText = () => Buffer.concat(errChunks).toString("utf8");

    let killTimer = null;
    const kill = (why) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill("SIGTERM");
      } catch { /* already gone */ }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch { /* already gone */ }
      }, KILL_GRACE_MS);
      // A timer that outlives the run would hold the loop open for nothing.
      if (killTimer.unref) killTimer.unref();
      void why;
    };

    const timer = setTimeout(() => {
      kill("timeout");
      failed("timed_out", `the agent command did not finish within ${budget}ms and was killed`);
    }, budget);
    if (timer.unref) timer.unref();

    const onAbort = () => {
      kill("abort");
      failed("aborted", "the run was aborted before the agent command finished");
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });

    child.on("error", (e) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener?.("abort", onAbort);
      // ENOENT and friends: the command is not installed. Say which.
      failed("spawn_failed", `could not run ${command[0]}: ${e?.message || e}`);
    });

    child.on("close", (code, sig) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener?.("abort", onAbort);
      if (settled) return;
      if (sig) {
        failed("killed", `the agent command died on signal ${sig}${stderrText() ? `: ${stderrText().slice(-500)}` : ""}`);
        return;
      }
      if (code !== 0) {
        // Strict: a nonzero exit is the command reporting failure, and an
        // answer next to a failure is how a renter gets charged for a guess.
        failed(
          "agent_failed",
          `${command[0]} exited with code ${code}${stderrText() ? `: ${stderrText().slice(-500)}` : ""}`,
        );
        return;
      }
      let raw = Buffer.concat(outChunks);
      if (raw.length > maxAnswerBytes) {
        // Hard cut at the byte cap. StringDecoder drops a trailing partial
        // character instead of emitting U+FFFD, so the cut is clean.
        raw = raw.subarray(0, maxAnswerBytes);
        truncated = true;
      }
      const decoder = new StringDecoder("utf8");
      let answer = decoder.write(raw) + decoder.end();
      if (answer.length > SUBMIT_CONTENT_MAX_CHARS) {
        answer = answer.slice(0, SUBMIT_CONTENT_MAX_CHARS);
        truncated = true;
      }
      if (answer.length === 0) {
        failed("empty_answer", `${command[0]} exited 0 but wrote nothing — submit an error for this job, not silence`);
        return;
      }
      done({
        ok: true,
        jobId: job.jobId,
        lenderId: job.lenderId || lenderId,
        answer,
        answerBytes: Buffer.byteLength(answer, "utf8"),
        truncated,
      });
    });

    // The task goes in exactly one place: the file when the command asked for
    // it, stdin otherwise. EPIPE means the child exited without reading, which
    // the close handler reports — so it is swallowed here, not thrown.
    if (!usesTaskFile) {
      try {
        child.stdin.on("error", () => {});
        child.stdin.write(job.task);
        child.stdin.end();
      } catch {
        try {
          child.stdin.destroy();
        } catch { /* already gone */ }
      }
    } else {
      try {
        child.stdin.on("error", () => {});
        child.stdin.end();
      } catch { /* already closed */ }
    }
  });
}
