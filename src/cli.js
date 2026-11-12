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

import { HARNESS_VERSION } from "./version.js";

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
  const { defaultProviderFor } = await import("./providers/registry.js");
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

  // no-default-provider A2: FIRST user-configured profile or echo. No network
  // probing ever. Same pre-createInterface rule as the plugin load above
  // (deviation 16b: any await between createInterface and handler attachment
  // closes piped stdin's readline).
  const defaultRow = await defaultProviderFor(process.env, { profiles: [] });
  const provider = defaultRow
    ? (await import("./providers/openai-compat.js")).createOpenAICompatProvider({
        id: defaultRow.id,
        baseUrl: defaultRow.baseUrl,
        model: defaultRow.model,
        apiKey: process.env[defaultRow.apiKeyEnv],
      })
    : echo;

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });

  // REPL ask channel: prompt the user, 30s timeout (headless-timeout deny).
  // v0.6.0 SR1: "a(lways)" writes an in-memory session rule (never disk) and
  // answers allow — the next matching call short-circuits the ask entirely.
  const askResolver = (ask) =>
    new Promise((resolvePromise) => {
      process.stdout.write(
        `\npolicy asks: allow ${ask.tool} ${JSON.stringify(ask.args)}? [y/N/a(lways)] (${ASK_TIMEOUT_MS / 1000}s) `,
      );
      const timer = setTimeout(() => {
        process.stdout.write("\n(timeout → deny)\n");
        resolvePromise(undefined);
      }, ASK_TIMEOUT_MS);
      rl.question("", (answer) => {
        clearTimeout(timer);
        const t = answer.trim().toLowerCase();
        if (t === "a" || t === "always") {
          policy.addSessionRule({ tool: ask.tool });
          log
            .appendEvent("policy.rule.added", "policy", {
              tool: ask.tool,
              pattern: ask.args?.command ?? ask.args?.path ?? "*",
              count: policy.listSessionRules().length,
            })
            .catch(() => {});
          resolvePromise("allow");
          return;
        }
        resolvePromise(/^y(es)?$/i.test(t) ? "allow" : "deny");
      });
    });

  // no-default-provider A2: announce the chosen provider BEFORE the prompt.
  // (this block is post-createInterface; only the SETUP moved up — the
  // provider object already exists, no further awaits.)
  process.stdout.write(
    defaultRow
      ? `\x1b[2mdefault provider: ${defaultRow.id}/${defaultRow.model ?? "?"} (from providers.config.json|env)\x1b[0m${"\n"}`
      : "\x1b[2mno provider configured \u2014 using echo (offline); add one via the TUI ? panel or HARNESS_PROVIDER_<ID>_BASE_URL env vars\x1b[0m\n",
  );

  const loop = createLoop({
    provider,
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
    `ac-harness ${HARNESS_VERSION} — ${provider.id} provider, log: ${logPath}\n` +
      "commands: /policy /resume [seq] /compact /replay /quit\n",
  );
  rl.prompt();

  // Serialize line handling: an in-flight turn must finish before the next
  // line is processed (a fast "/quit" must not kill a running turn).
  let queue = Promise.resolve();
  let closed = false;
  let turnBusy = false; // v0.4.0 2.3: set while a turn is in flight
  let lastSigint = 0; // v0.4.0 2.3: second-SIGINT escape hatch
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
            } else if (rest[0] === "clear") {
              const n = policy.clearSessionRules();
              process.stdout.write(`session rules cleared (${n})\n`);
            } else {
              for (const r of policy.listSessionRules()) {
                process.stdout.write(`  ${r.id}: ${r.effect} ${JSON.stringify(r.match)} (session, in-memory)\n`);
              }
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
        turnBusy = true;
        try {
          const res = await loop.start(input);
          process.stdout.write(`${res.text}\n`);
        } finally {
          turnBusy = false;
        }
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

  // v0.4.0 2.3: SIGINT aborts an in-flight turn (turn.end reason "aborted"
  // lands via finalizeTurn); when idle it ends the session cleanly. A SECOND
  // SIGINT within a turn is the user escape hatch: immediate loud exit.
  process.on("SIGINT", () => {
    const now = Date.now();
    if (turnBusy) {
      if (now - lastSigint < 2000) {
        process.stdout.write("\n[sigint×2] force-exiting mid-turn\n");
        // eslint-disable-next-line no-process-exit
        process.exit(130);
      }
      lastSigint = now;
      process.stdout.write("\n[sigint] aborting turn… (again within 2s = force exit)\n");
      loop.abort();
      return;
    }
    // idle: the default action — close the readline (end-of-session path)
    rl.close();
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
  if (cmd === "checkpoint") {
    // checkpoint list [dir] | checkpoint restore <seq> [dir] | checkpoint show <seq> [dir]
    const { CheckpointStore, resolveRoot } = await import("./checkpoint.js");
    const sub = rest[0];
    const [, ...args] = rest;
    const dirFrom = (a) => {
      const cand = a?.[a.length - 1];
      return cand && !/^[0-9]+$/.test(cand) ? cand : process.cwd();
    };
    const store = new CheckpointStore({ root: resolveRoot(undefined), cwd: resolve(dirFrom(args)) });

    if (sub === "list" || sub === undefined) {
      const rows = await store.list();
      if (!rows.length) {
        process.stdout.write("no checkpoints for this directory\n");
        return;
      }
      for (const r of rows) {
        process.stdout.write(
          `#${String(r.seq).padStart(4, "0")}  ${r.at}  ${String(r.files).padStart(4)} files  ${r.label || ""}\n`,
        );
      }
      return;
    }
    if (sub === "show") {
      const seq = Number(args[0]);
      if (!Number.isFinite(seq)) {
        process.stderr.write("usage: node src/cli.js checkpoint show <seq> [dir]\n");
        process.exit(2);
      }
      const rows = await store.list();
      const row = rows.find((r) => r.seq === seq);
      if (!row) {
        process.stderr.write(`no checkpoint #${seq}\n`);
        process.exit(1);
      }
      process.stdout.write(`${JSON.stringify(row, null, 2)}\n`);
      return;
    }
    if (sub === "restore") {
      const seq = Number(args[0]);
      if (!Number.isFinite(seq)) {
        process.stderr.write("usage: node src/cli.js checkpoint restore <seq> [dir]\n");
        process.exit(2);
      }
      // Deleting files created after the snapshot is irreversible, so it needs
      // an explicit flag. Restoring is the safe half; pruning is the dangerous one.
      const prune = args.includes("--prune");
      const r = await store.restore(seq, { prune });
      process.stdout.write(
        `restored ${r.restored} file(s) from #${seq}` +
          (prune ? `, pruned ${r.pruned}` : "") +
          (r.skipped ? `, skipped ${r.skipped}` : "") +
          "\n",
      );
      return;
    }
    process.stderr.write(
      "usage: node src/cli.js checkpoint <list|show <seq>|restore <seq> [--prune]> [dir]\n",
    );
    process.exit(2);
  }
  if (cmd === "memory") {
    // memory recall [query] | memory stats | memory remember <text>
    const { Memory } = await import("./memory.js");
    const m = new Memory({});
    const sub = rest[0];
    if (sub === "stats") {
      const s = await m.stats();
      process.stdout.write(`${s.live} live / ${s.total} total (${s.superseded} superseded)\n${s.path}\n`);
      return;
    }
    if (sub === "remember") {
      const text = rest.slice(1).join(" ");
      if (!text) {
        process.stderr.write("usage: node src/cli.js memory remember <text>\n");
        process.exit(2);
      }
      const r = await m.remember(text);
      process.stdout.write(`remembered ${r.id}\n`);
      return;
    }
    const hits = await m.recall(rest.slice(1).join(" "));
    if (!hits.length) {
      process.stdout.write("no matching memory\n");
      return;
    }
    for (const h of hits) process.stdout.write(`[${h.at.slice(0, 10)}] ${h.scope}: ${h.text}\n`);
    return;
  }
  if (cmd === "stats") {
    // v0.5.0 H6: what did this session spend? (pure report; no pricing)
    if (!rest[0]) {
      process.stderr.write("usage: node src/cli.js stats <log>\n");
      process.exit(2);
    }
    const { readAll } = await import("./events.js");
    const { buildReport, formatReport } = await import("./stats.js");
    const events = await readAll(resolve(rest[0]));
    const report = buildReport(events);
    process.stdout.write(formatReport(report, { logPath: resolve(rest[0]) }) + "\n");
    return;
  }
  if (cmd === undefined) {
    await chat();
    return;
  }
  process.stderr.write(
    `unknown subcommand: ${cmd}\n` +
      "  replay <log> | stats <log> | checkpoint <list|show|restore> [dir] | memory <recall|stats|remember>\n",
  );
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`cli fatal: ${err.message}\n`);
  process.exit(1);
});
