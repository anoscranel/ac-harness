#!/usr/bin/env node
// bin/ac-harness.js — v0.4.0 Ship 3: the installable entrypoint. A thin
// dispatcher: tui when interactive (TTY), chat when piped, replay <log>,
// server. Zero deps; node:* builtins only; delegates to the existing
// entrypoints without duplicating any logic.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const [cmd, ...rest] = process.argv.slice(2);

function run(script, args) {
  const child = spawn(process.execPath, [join(root, script), ...args], {
    stdio: "inherit",
  });
  child.on("error", (err) => {
    process.stderr.write(`ac-harness: ${err.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.exit(0); // signalled exits are user-initiated
    process.exit(code ?? 0);
  });
}

switch (cmd) {
  case "--help":
  case "-h":
  case "help": { // v0.11.0 S1: grouped help, exit 0, NO session, NO log file
    const help = `ac-harness v${(await import(join(root, "src", "version.js"))).HARNESS_VERSION} — the harness command surface

chat / session
  (default)         chat REPL when interactive the TUI opens instead
  chat              interactive REPL (echo provider by default)
  tui               alt-screen TUI (requires a real terminal)
  server            headless JSON-RPC 2.0 NDJSON stdio server
  run "<prompt>" [--provider id] [--policy-allow tool]  headless one-shot (exit 0/1/2)

inspection (all read-only)
  stats <log>       per-session usage report (turns, tokens, tools, asks)
  verify <log>      is this log intact? canonical sha + --expect comparison
  cron list         scheduled jobs as data (no daemon; start externally)
  checkpoint list   snapshots taken by write/edit/bash (undo targets)
  memory list       durable cross-session memory (list and search below)
  tools             the tool surface a session would run (builtin + mcp.*)
  doctor            six install-health checks

maintenance (destructive acts refuse without --yes)
  memory forget <id> [--yes]    remove ONE memory record (prints it first)
  logs prune --keep N | --older-than DAYS [--yes]   reclaim session-log space
  logs search <pattern> [--type t] [--tools name]   find WHICH session did X
  export <log> [--md] [--out <file>]                   a session as human-readable md
  checkpoint restore <seq> [--yes] [--prune]         roll files back (preview first)
  checkpoint prune --keep N                        bound the snapshot store

remote (stdio only; one protocol per process)
  mcp-server        the harness AS an MCP server (tools only)
  acp               the ACP agent side (initialize/session/prompt/cancel)
  replay <log>      canonical replay of a session log, prints sha256

run a subcommand with no arguments for its usage line; exit 0 here.`;
    console.log(help);
    process.exit(0);
    break;
  }
  case "--version":
  case "-v":
  case "version":
    // import lazily so --version works even if a heavy module is broken
    console.log(process.env.AC_HARNESS_VERSION_OVERRIDE ?? (await import(join(root, "src", "version.js"))).HARNESS_VERSION);
    break;
  case "replay":
    if (!rest[0]) {
      process.stderr.write("usage: ac-harness replay <log>\n");
      process.exit(2);
    }
    run("src/cli.js", ["replay", rest[0]]);
    break;
  case "mcp-server": // ship-3: the harness AS an MCP server (stdio, tools only)
    run("src/mcp-server.js", []);
    break;
  case "acp": // ship-3: the ACP agent side (separate process — one protocol per process)
    run("src/acp.js", []);
    break;
  case "checkpoint": { // v0.8.0 S1: the undo surface over the existing store
    // runs in-process (it prints lines + may exit non-zero on refusal)
    const { checkpointCommand } = await import(join(root, "src", "checkpoint-cli.js"));
    const r = await checkpointCommand(rest, { cwd: process.cwd(), stdout: process.stdout });
    process.exit(r.exitCode);
    break;
  }
  case "verify": { // v0.8.0 S2: read-only log verification
    const { verifyCommand } = await import(join(root, "src", "verify-cli.js"));
    const r = await verifyCommand(rest, { stdout: process.stdout });
    process.exit(r.exitCode);
    break;
  }
  case "doctor": { // v0.8.0 S4: six checks, ok/warn/fail, non-zero only on fail
    const { doctorCommand } = await import(join(root, "src", "doctor-cli.js"));
    const r = await doctorCommand({ stdout: process.stdout });
    process.exit(r.exitCode);
    break;
  }
  case "tools": { // v0.10.0 S1c: read-only tool listing (builtin + mcp groups)
    const { toolsCommand } = await import(join(root, "src", "tools-list-cli.js"));
    const { repoMcpConfigPath } = await import(join(root, "src", "mcp-config.js")); // S4-1: single source
    // repair-card MAJOR 3: ONE config-path semantic — the harness INSTALL
    // ROOT (repoMcpConfigPath), so `tools` shows exactly what a session would run.
    const r = await toolsCommand(rest, { stdout: process.stdout, configPath: repoMcpConfigPath() });
    process.exit(r.exitCode);
    break;
  }
  case "export": { // v0.12.0 S3: human-readable session transcript
    const { exportCommand } = await import(join(root, "src", "export-cli.js"));
    const r = await exportCommand(rest, { stdout: process.stdout });
    process.exit(r.exitCode);
    break;
  }
  case "memory": { // v0.11.0 S2: durable-memory surface (list/recall/forget)
    const { memoryCommand } = await import(join(root, "src", "memory-cli.js"));
    const r = await memoryCommand(rest, { stdout: process.stdout });
    process.exit(r.exitCode);
    break;
  }
  case "logs": { // v0.11.0 S3: session-log retention (list/prune)
    const { logsCommand } = await import(join(root, "src", "logs-cli.js"));
    const r = await logsCommand(rest, { stdout: process.stdout });
    process.exit(r.exitCode);
    break;
  }
  case "stats": // v0.5.0 H6
    if (!rest[0]) {
      process.stderr.write("usage: ac-harness stats <log>\n");
      process.exit(2);
    }
    run("src/cli.js", ["stats", rest[0]]);
    break;
  case "server":
    run("src/server.js", []);
    break;
  case "chat":
    run("src/cli.js", []);
    break;
  case "run": // v0.12.0 S1: headless one-shot — the cron/delegate primitive
    // pass-through with the SAME argv (cli.js owns --provider/--policy-allow
    // parsing and the 0/1/2 exit-code contract).
    run("src/cli.js", ["run", ...rest]);
    break;
  case "tui":
    run("src/tui/main.js", []);
    break;
  default:
    if (cmd !== undefined) {
      // v0.11.0 S1: a TYPED subcommand that does not exist is an error with
      // a pointer to --help — not an accidental new session.
      process.stderr.write(`unknown command: ${cmd}\ntry --help for the command list\n`);
      process.exit(2);
    }
    // NO subcommand: tui DEFAULT when interactive; the REPL when piped —
    // the TUI exits 0 with an advisory line when piped, so both are safe.
    if (process.stdout.isTTY) run("src/tui/main.js", []);
    else run("src/cli.js", []);
    break;
}
