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
    // v0.10.0 S1c: the config is OPERATOR-OWNED and lives in the project
    // directory being worked on (cwd), like cron's store — not the bin dir.
    const { resolve } = await import("node:path");
    const r = await toolsCommand(rest, { stdout: process.stdout, configPath: resolve(process.cwd(), "mcp.config.json") });
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
  case "tui":
    run("src/tui/main.js", []);
    break;
  default:
    // tui DEFAULT when interactive; the REPL when piped (non-TTY) — the
    // TUI itself exits 0 with an advisory line in that case, so both are
    // safe, but the REPL is the better non-interactive experience.
    if (process.stdout.isTTY) run("src/tui/main.js", []);
    else run("src/cli.js", []);
    break;
}
