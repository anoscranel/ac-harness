// src/cli.js — interactive REPL and replay tool.
//   node src/cli.js                 → chat REPL (echo provider by default)
//   node src/cli.js replay <log>    → canonical replay: NO execution, prints
//                                     the canonical transcript sha256 (DC2)
// REPL commands: /policy /resume /compact /replay /help /quit
//
// Replay never re-executes tools or providers (specs/invariants.md §3): it
// reads the log, re-emits the recorded lines, and compares canonical forms.
// REPLAY PURITY: the replay path loads ONLY events.js (plus builtins). Every
// tool/provider/policy/loop import is deferred into chat() via dynamic
// import, so `node src/cli.js replay <log>` never module-evaluates tool or
// provider code (repair-1, audit-a1 defect 1).

import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { EventLog, readAll, canonicalize, sha256 } from "./events.js";

const HARNESS_VERSION = "0.1.0";

async function replayCommand(logPath) {
  const events = await readAll(logPath);
  const canonical = canonicalize(events);
  const sha = sha256(canonical);
  process.stdout.write(`events: ${events.length}\n`);
  process.stdout.write(`canonical sha256: ${sha}\n`);
  // Re-emit the recorded transcript lines (state reconstructed, side effects
  // NOT re-run). Tools and providers are never touched here.
  for (const ev of events) {
    if (
      ev.type === "turn.provider.chunk" ||
      ev.type === "tool.proposed" ||
      ev.type === "tool.result" ||
      ev.type === "policy.decision"
    ) {
      process.stdout.write(`[replay ${ev.seq}] ${ev.type} ${JSON.stringify(ev.data)}\n`);
    }
  }
}

async function chat() {
  // Deferred imports: chat-only modules (policy, tools, providers, loop).
  // Kept out of the module top level so the replay path never loads them.
  const { Policy, loadRulesFile, ASK_TIMEOUT_MS } = await import("./policy.js");
  const { defaultRules } = await import("./policy-defaults.js");
  const { createRegistry } = await import("./tools/index.js");
  const { default: echo } = await import("./providers/echo.js");
  const { decide } = await import("./context.js");
  const { createLoop } = await import("./loop.js");
  const { createDefaultVerifyGate } = await import("./verify.js");
  const { loadPlugins, wirePluginHooks } = await import("./plugins/loader.js");
  const { readFile: readPluginConfig } = await import("node:fs/promises");
  const repoRoot = resolve(new URL("..", import.meta.url).pathname);

  const sessionId = `repl-${Date.now()}`;
  const logPath = resolve(`logs/${sessionId}.jsonl`);
  const log = await EventLog.open(logPath);
  const policy = new Policy({ rules: defaultRules(), logPath });

  // F22 (review-r1): plugins are loadable — discovery + manifest validation +
  // capability registration run at REPL startup. 6.5 (audit-a2): the default
  // plugins/ dir is anchored on the REPO ROOT, not the launch cwd.
  // NB: this await must complete BEFORE createInterface — with piped stdin,
  // readline can close before listeners attach if any await sits between
  // createInterface and the handler registrations below.
  const pluginHost = await loadPlugins({ dir: resolve(repoRoot, "plugins"), harnessVersion: HARNESS_VERSION, log });
  // TB0: per-plugin config from <repoRoot>/plugins.config.json (per-user
  // local file, gitignored, never committed — 6.3).
  let pluginConfig = {};
  try {
    pluginConfig = JSON.parse(await readPluginConfig(resolve(repoRoot, "plugins.config.json"), "utf8"));
  } catch {
    /* absent or unparseable = defaults */
  }
  // TB0: activate hook plugins and merge their hooks/decisions into the loop.
  const wired = await wirePluginHooks(pluginHost, log, { config: pluginConfig });
  // 6.4 (audit-a2): the decide the LOOP uses — /compact must report the same.
  const effectiveDecide = wired.decide ?? decide;

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });

  // REPL ask channel: prompt the user, 30s timeout (headless-timeout deny).
  const askResolver = (ask) =>
    new Promise((resolvePromise) => {
      process.stdout.write(
        `\npolicy asks: allow ${ask.tool} ${JSON.stringify(ask.args)}? [y/N] (${ASK_TIMEOUT_MS / 1000}s) `,
      );
      const timer = setTimeout(() => {
        process.stdout.write("\n(timeout → deny)\n");
        resolvePromise(undefined);
      }, ASK_TIMEOUT_MS);
      rl.question("", (answer) => {
        clearTimeout(timer);
        resolvePromise(/^y(es)?$/i.test(answer.trim()) ? "allow" : "deny");
      });
    });

  const loop = createLoop({
    provider: echo,
    tools: createRegistry(),
    policy,
    log,
    // TB0: a plugin's compaction-trigger single-hook winner replaces the
    // built-in default decide; otherwise the built-in.
    decide: effectiveDecide,
    askResolver,
    config: { session: sessionId, harness_version: HARNESS_VERSION },
    hooks: {
      // TB0: chain hooks merge in load order; the verify-gate single-hook
      // winner overrides the built-in default gate.
      preTool: wired.preTool,
      postTool: wired.postTool,
      onEvent: wired.onEvent,
      verifyGate: wired.verifyGate ?? createDefaultVerifyGate({ cwd: repoRoot }),
      decidePlugin: wired.decidePlugin, // 6.1: owner names for containment
      verifyGatePlugin: wired.verifyGatePlugin,
    },
  });

  if (pluginHost.plugins.length > 0) {
    process.stdout.write(`plugins loaded: ${pluginHost.plugins.map((p) => p.name).join(", ")}\n`);
  }

  process.stdout.write(
    `agent-harness ${HARNESS_VERSION} — echo provider, log: ${logPath}\n` +
      "commands: /policy /resume [seq] /compact /replay /quit\n",
  );
  rl.prompt();

  // Serialize line handling: an in-flight turn must finish before the next
  // line is processed (a fast "/quit" must not kill a running turn).
  let queue = Promise.resolve();
  let closed = false;
  rl.on("line", (line) => {
    queue = queue.then(() => handleLine(line.trim())).catch((err) => {
      process.stdout.write(`error: ${err.message}\n`);
    });
  });

  async function handleLine(input) {
    try {
      if (input.startsWith("/")) {
        const [cmd, ...rest] = input.split(/\s+/);
        switch (cmd) {
          case "/quit":
          case "/exit":
            await loop.end();
            rl.close();
            return;
          case "/policy": {
            if (rest[0] === "reload" && rest[1]) {
              try {
                const rules = await loadRulesFile(resolve(rest[1]));
                policy.rules = [...defaultRules(), ...rules];
                process.stdout.write(`policy reloaded: ${rules.length} extra rules\n`);
              } catch (err) {
                await log.appendEvent("policy.error", "policy", {
                  message: err.message,
                  source: rest[1],
                });
                process.stdout.write(`policy error (kept old rules): ${err.message}\n`);
              }
            } else {
              for (const r of policy.rules) {
                process.stdout.write(`  ${r.id}: ${r.effect} ${JSON.stringify(r.match)}\n`);
              }
              process.stdout.write(`  pinned.deny_log_path: deny ${policy.logDir}\n`);
            }
            break;
          }
          case "/resume": {
            const seq = rest[0] === undefined ? Number.MAX_SAFE_INTEGER : Number(rest[0]);
            const st = await loop.resume(seq);
            process.stdout.write(`resumed at seq ${seq}: ${st.messages} messages, ${st.turns} turns\n`);
            break;
          }
          case "/compact": {
            const snapshot = {
              input_tokens: loop.state.lastUsage?.input_tokens ?? 0,
              cached_tokens: loop.state.lastUsage?.cached_tokens ?? 0,
              output_reserve: 4_096,
              context_limit: 128_000,
              estimate: loop.state.lastUsage?.estimate ?? false,
            };
            const metas = loop.state.messages.map((m) => ({
              role: m.role,
              turn_index: m.turn_index,
              pinned: m.pinned,
              byte_len: Buffer.byteLength(m.content ?? "", "utf8"),
              kind: m.kind,
              event_span: m.event_span,
            }));
            const d = effectiveDecide(snapshot, loop.state.turns, { max_session_tokens: 0, warn_fraction: 0 }, metas);
            process.stdout.write(`decision: ${JSON.stringify(d)}\n`);
            break;
          }
          case "/replay":
            process.stdout.write(`canonical sha256: ${log.canonicalSha256()}\n`);
            break;
          case "/help":
            process.stdout.write("commands: /policy /resume [seq] /compact /replay /quit\n");
            break;
          default:
            process.stdout.write(`unknown command: ${cmd}\n`);
        }
      } else if (input) {
        const res = await loop.start(input);
        process.stdout.write(`${res.text}\n`);
      }
    } catch (err) {
      process.stdout.write(`error: ${err.message}\n`);
    }
    if (!closed) rl.prompt();
  }

  rl.on("close", () => {
    closed = true;
    // Drain the queue before ending so an in-flight turn is not killed.
    queue.then(async () => {
      await loop.end();
      process.stdout.write(`\nsession ended; canonical sha256: ${log.canonicalSha256()}\n`);
      process.exit(0);
    });
  });
}

async function main() {
  // A piped CLI (replay | head) must exit quietly on EPIPE, not stack-dump.
  process.stdout?.on?.("error", (err) => {
    if (err?.code === "EPIPE") process.exit(0);
    throw err;
  });
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "replay") {
    if (!rest[0]) {
      process.stderr.write("usage: node src/cli.js replay <log>\n");
      process.exit(2);
    }
    await replayCommand(resolve(rest[0]));
    return;
  }
  if (cmd === undefined) {
    await chat();
    return;
  }
  process.stderr.write(`unknown subcommand: ${cmd}\n`);
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`cli fatal: ${err.message}\n`);
  process.exit(1);
});
