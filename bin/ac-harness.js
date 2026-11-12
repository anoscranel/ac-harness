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
