/**
 * `aile mcp` — the MCP servers this machine lends.
 *
 *   aile mcp                       what is declared, and whether it can be served
 *   aile mcp check                 validate the file without starting anything
 *   aile mcp test <id>             actually start one and list its tools
 *   aile mcp path                  print the file's location
 *   aile mcp answer --job <f|-> -- <cmd> [args...]
 *                                  run ONE attended job in a fresh agent process
 *
 * Presentation only, like `aile config`: every rule about what a declaration may
 * contain lives in src/mcp/config.js, and every rule about the sandbox lives in
 * src/mcp/sandbox.js, so this file cannot admit something those would refuse.
 *
 * WHY `test` EXISTS AT ALL. The relay is a byte pipe and never parses MCP, so
 * nothing on the serving path would ever tell a lender "your image does not
 * start" — they would find out when a renter paid and got an error. `test` runs
 * the same sandbox with the same argv and does the handshake locally, so the
 * first thing that discovers a broken declaration is the lender, not a customer.
 */

import fs from "node:fs";
import { MCP_CONFIG_FILE, loadMcpServers } from "../mcp/config.js";
import { detectRuntime, buildRunArgs, containerName, describeEgress } from "../mcp/sandbox.js";
import { probeMcpServer } from "../mcp/client.js";
import {
  DEFAULT_MAX_ANSWER_BYTES,
  checkJobForLender,
  parseJobInput,
  runAttendedJob,
} from "../mcp/attended.js";
import { C } from "./colors.js";

function fail(msg, hint = null) {
  console.error(`\n${C.red}${msg}${C.reset}`);
  if (hint) console.error(`${C.dim}${hint}${C.reset}`);
  console.error();
  process.exit(1);
}

/** The runtime line, in the three states detectRuntime distinguishes. */
function runtimeLine(runtime) {
  if (runtime.ok) return `  Sandbox:   ${C.green}${runtime.message}${C.reset}`;
  const colour = runtime.state === "stopped" ? C.yellow : C.red;
  return `  Sandbox:   ${colour}${runtime.state}${C.reset} ${C.dim}${runtime.message}${C.reset}`;
}

function readServers() {
  try {
    return { servers: loadMcpServers(), error: null };
  } catch (e) {
    return { servers: [], error: e.message };
  }
}

function show(args) {
  const { servers, error } = readServers();
  const runtime = detectRuntime();

  if (args.json) {
    console.log(JSON.stringify({
      file: MCP_CONFIG_FILE,
      configError: error,
      runtime: { ok: runtime.ok, state: runtime.state, message: runtime.message },
      servers: servers.map((s) => ({
        id: s.id,
        name: s.name,
        enabled: s.enabled,
        image: s.image,
        command: s.command,
        // NEVER the env values. This output gets pasted into issues.
        env: Object.keys(s.env),
        egress: s.egress,
        egressEnforced: describeEgress(s).enforced,
        tools: s.tools,
        cpus: s.cpus,
        memoryMb: s.memoryMb,
        pids: s.pids,
        timeoutMs: s.timeoutMs,
      })),
      advertising: !error && runtime.ok ? servers.filter((s) => s.enabled).length : 0,
    }, null, 2));
    return;
  }

  console.log(`\n${C.bold}MCP servers${C.reset} ${C.dim}${MCP_CONFIG_FILE}${C.reset}\n`);

  if (error) {
    console.log(`  ${C.red}The file exists but does not load:${C.reset}`);
    console.log(`  ${C.dim}${error}${C.reset}\n`);
    console.log(`${C.dim}Nothing is advertised while that is true.${C.reset}\n`);
    return;
  }

  if (servers.length === 0) {
    console.log(`  ${C.dim}None declared. This machine lends no MCP capacity.${C.reset}\n`);
    console.log(`  Declare one by writing ${C.cyan}${MCP_CONFIG_FILE}${C.reset}:\n`);
    console.log(`${C.dim}    {
      "servers": [
        {
          "id": "claude-code",
          "image": "aile/claude-code-mcp:latest",
          "command": ["claude", "mcp", "serve"],
          "network": ["api.anthropic.com"],
          "env": { "ANTHROPIC_API_KEY": "sk-ant-…" }
        }
      ]
    }${C.reset}\n`);
    console.log(`${C.dim}Then: ${C.reset}${C.cyan}aile mcp test claude-code${C.reset}\n`);
    return;
  }

  for (const s of servers) {
    const state = s.enabled ? `${C.green}on${C.reset}` : `${C.dim}off${C.reset}`;
    console.log(`  ${C.bold}${s.id}${C.reset} ${state} ${C.dim}${s.name === s.id ? "" : s.name}${C.reset}`);
    console.log(`    image    ${C.dim}${s.image}${s.command.length ? ` ${s.command.join(" ")}` : ""}${C.reset}`);
    const eg = describeEgress(s);
    if (eg.hosts.length === 0) {
      console.log(`    network  ${C.green}none${C.reset} ${C.dim}— no network stack at all${C.reset}`);
    } else {
      console.log(`    network  ${C.yellow}${eg.hosts.join(", ")}${C.reset}`);
      console.log(`             ${C.yellow}advertised, not enforced${C.reset} ${C.dim}— the container has ordinary outbound network${C.reset}`);
    }
    const envKeys = Object.keys(s.env);
    if (envKeys.length) console.log(`    env      ${C.dim}${envKeys.join(", ")} (values not shown)${C.reset}`);
    console.log(`    limits   ${C.dim}${s.cpus} cpu · ${s.memoryMb}MB · ${s.pids} pids · ${Math.round(s.timeoutMs / 1000)}s${C.reset}`);
    if (s.tools.length) console.log(`    tools    ${C.dim}${s.tools.join(", ")} (claimed; the server rediscovers them)${C.reset}`);
    console.log();
  }

  console.log(runtimeLine(runtime));
  const enabled = servers.filter((s) => s.enabled).length;
  const advertising = runtime.ok ? enabled : 0;
  console.log(`  Lending:   ${advertising ? `${C.green}${advertising} server(s)${C.reset}` : `${C.yellow}nothing${C.reset}`}`);
  if (!runtime.ok && enabled > 0) {
    console.log(`\n${C.yellow}Declared but not served.${C.reset} ${C.dim}A rented MCP server only ever runs in a`);
    console.log(`container — there is no unsandboxed fallback, on purpose.${C.reset}`);
  }
  console.log(`\n${C.dim}Renters reach these through your node. Nothing listens on a port.${C.reset}\n`);
}

/** Validate, and say exactly what would run, without running it. */
function check(args) {
  const { servers, error } = readServers();
  if (error) fail(error, `Fix ${MCP_CONFIG_FILE} and run this again.`);

  if (args.json) {
    console.log(JSON.stringify({ ok: true, servers: servers.map((s) => s.id) }, null, 2));
    return;
  }

  console.log(`\n${C.green}${MCP_CONFIG_FILE} is valid${C.reset} ${C.dim}(${servers.length} server(s))${C.reset}\n`);
  for (const s of servers) {
    // The exact argv, so a lender can read the sandbox rather than trust it.
    const argv = buildRunArgs(s, { name: containerName(s.id, 0) });
    console.log(`  ${C.bold}${s.id}${C.reset}`);
    console.log(`    ${C.dim}docker ${argv.join(" ")}${C.reset}\n`);
  }
  console.log(`${C.dim}Env values are passed through the runtime's own environment, never argv.${C.reset}\n`);
}

/** Start one for real and do the handshake. The only command here that spends anything. */
async function test(args) {
  const id = args._[2];
  if (!id) fail("Which server?", "aile mcp test <id>   —   aile mcp   lists them");

  const { servers, error } = readServers();
  if (error) fail(error);
  const server = servers.find((s) => s.id === id);
  if (!server) {
    fail(`No MCP server called "${id}".`, servers.length ? `Declared: ${servers.map((s) => s.id).join(", ")}` : `Nothing is declared in ${MCP_CONFIG_FILE}`);
  }

  const runtime = detectRuntime();
  if (!runtime.ok) fail(runtime.message);

  if (!args.json) {
    console.log(`\n${C.dim}Starting ${server.image} in a sandbox…${C.reset}`);
  }

  let result;
  try {
    result = await probeMcpServer(server, {
      timeoutMs: Number(args.timeout) > 0 ? Number(args.timeout) * 1000 : 120000,
      // The child's stderr is worth seeing HERE and nowhere else: this is the
      // lender's own machine, run by hand, and a broken image says why on stderr.
      log: args.debug ? console : { debug() {}, warn: console.warn, error: console.error },
    });
  } catch (e) {
    if (args.json) {
      console.log(JSON.stringify({ ok: false, id, error: e.message }, null, 2));
      process.exit(1);
    }
    fail(`${id} did not serve: ${e.message}`, "Re-run with --debug to see the container's own output.");
  }

  if (args.json) {
    console.log(JSON.stringify({
      ok: true,
      id,
      serverInfo: result.serverInfo,
      protocolVersion: result.protocolVersion,
      tools: result.tools.map((t) => ({ name: t.name, description: t.description || null })),
    }, null, 2));
    return;
  }

  const info = result.serverInfo;
  console.log(`\n${C.green}${id} serves${C.reset} ${C.dim}${info ? `${info.name || "?"} ${info.version || ""}` : ""}${C.reset}`);
  if (result.protocolVersion) console.log(`${C.dim}MCP ${result.protocolVersion}${C.reset}`);

  if (result.tools.length === 0) {
    console.log(`\n${C.yellow}It exposes no tools.${C.reset} ${C.dim}A renter would get an empty toolbox.${C.reset}\n`);
    return;
  }

  console.log(`\n${C.bold}Tools${C.reset} ${C.dim}(${result.tools.length})${C.reset}`);
  for (const t of result.tools.slice(0, 40)) {
    const desc = (t.description || "").split("\n")[0].slice(0, 70);
    console.log(`  ${C.cyan}${t.name}${C.reset} ${C.dim}${desc}${C.reset}`);
  }
  if (result.tools.length > 40) console.log(`  ${C.dim}…and ${result.tools.length - 40} more${C.reset}`);

  // What the renter actually gets, said plainly. A coding agent in a throwaway
  // box is useful and limited, and a lender should know which before listing it.
  console.log(`\n${C.dim}That is what a renter would see. The container is destroyed when the`);
  console.log(`session ends, so nothing a renter does persists between calls.${C.reset}\n`);
}

export async function mcpCommand(args) {
  const sub = args._[1];
  if (args.path || sub === "path") {
    console.log(MCP_CONFIG_FILE);
    return;
  }
  switch (sub) {
    case undefined: case "list": case "ls": show(args); break;
    case "check": case "validate": check(args); break;
    case "test": case "probe": await test(args); break;
    case "answer": await answer(args); break;
    default:
      fail(`Unknown: aile mcp ${sub}`, "aile mcp [check|test <id>|path|answer --job <file|-> -- <agent-cmd>]");
  }
}

/**
 * Run ONE attended (`transport: "agent"`) job in a fresh agent process.
 *
 *   aile mcp answer --job job.json --lender mcpl_x --timeout 90
 *     --allow-env LEND_MODEL -- claude -p --output-format text
 *
 * This never talks to Aile and holds no credential: the lender's agent keeps
 * its own MCP connection, polls `await_mcp_work` itself, hands ONE job here,
 * and submits the printed answer itself with `submit_mcp_work`. What this adds
 * is the context boundary the poll loop cannot give itself — the command after
 * `--` starts as a brand-new process per job, so the previous renter's work is
 * nowhere in its context. See src/mcp/attended.js for the rules that child runs
 * under; stdout here is one JSON line for the polling agent to submit, and
 * everything human-readable goes to stderr so a pipe stays parseable.
 */
async function answer(args) {
  const dash = args._.indexOf("--");
  const command = dash === -1 ? [] : args._.slice(dash + 1);
  if (command.length === 0 || typeof command[0] !== "string") {
    fail(
      "No agent command.",
      "aile mcp answer --job <file|-> [--lender <id>] [--timeout <s>] [--max-bytes <n>] "
      + "[--allow-env A,B] [--keep-home] -- <agent-cmd> [args...]",
    );
  }

  let job;
  try {
    job = parseJobInput(readJobInput(args.job));
  } catch (e) {
    fail(e.message, "Pass the `job` object from await_mcp_work as a file, or pipe it with --job -.");
  }
  try {
    checkJobForLender(job, args.lender || null);
  } catch (e) {
    fail(e.message);
  }

  let timeoutMs = null;
  if (args.timeout !== undefined) {
    const secs = Number(args.timeout);
    if (!Number.isFinite(secs) || secs <= 0) fail("--timeout takes seconds greater than 0.");
    timeoutMs = Math.floor(secs * 1000);
  }
  let maxAnswerBytes = DEFAULT_MAX_ANSWER_BYTES;
  if (args["max-bytes"] !== undefined) {
    const n = Number(args["max-bytes"]);
    if (!Number.isInteger(n) || n <= 0) fail("--max-bytes takes a positive byte count.");
    maxAnswerBytes = n;
  }
  const allowEnv = args["allow-env"] !== undefined
    ? String(args["allow-env"]).split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  if (!args.json) {
    console.error(`${C.dim}Answering job ${job.jobId} in a fresh ${command[0]} process…${C.reset}`);
  }

  const stop = new AbortController();
  const onSigint = () => stop.abort();
  process.once("SIGINT", onSigint);
  let result;
  try {
    result = await runAttendedJob({
      job,
      lenderId: args.lender || null,
      command,
      timeoutMs,
      maxAnswerBytes,
      allowEnv,
      keepHome: args["keep-home"] === true,
      signal: stop.signal,
    });
  } finally {
    process.removeListener("SIGINT", onSigint);
  }

  // stdout is the machine contract: one JSON line the polling agent submits —
  // `answer` as its content, or a short `error` (never `detail`, which stays
  // local diagnostics). The exit code stays 0 either way: a failed JOB is data
  // for submit_mcp_work, not a CLI failure.
  console.log(JSON.stringify(result));
  if (!args.json && !result.ok) {
    console.error(`${C.yellow}Job failed: ${result.error}.${C.reset} ${C.dim}Submit that short code as the `
      + `job's \`error\`, not the detail above it — then poll again with this job's contextReset.${C.reset}`);
  }
}

/** The job JSON: a file, or `-` / absent for stdin. A TTY with no file is a usage error, not a hang. */
function readJobInput(spec) {
  if (spec && spec !== "-") {
    try {
      return fs.readFileSync(spec, "utf8");
    } catch (e) {
      fail(`Cannot read ${spec}: ${e.message}`);
    }
  }
  if (process.stdin.isTTY) {
    fail("No job input.", "aile mcp answer --job <file> -- <agent-cmd>   (or pipe the job JSON with --job -)");
  }
  try {
    return fs.readFileSync(0, "utf8");
  } catch (e) {
    fail(`Cannot read the job from stdin: ${e.message}`);
  }
}
