// src/tui/main.js — TUI entry: arg parse, TTY check, alt-screen, wiring to
// the loop (mirrors cli.js chat() 1:1 — same dynamic-import discipline so the
// core observe surface stays identical), teardown on every exit path.
//
//   node src/tui/main.js          → alt-screen TUI (echo provider default)
//
// Non-TTY / TERM=dumb: print ONE advisory line and exit 0 (spec §0 — tests and
// CI stay safe; no alt-screen when piped).
//
// The TUI is a VIEWER over the event stream (spec §4): it subscribes to the
// EventLog 'event' emitter exactly like server.js subscribers and renders
// from events. State (messages) comes from the loop — no parallel copy.

import { resolve } from "node:path";

const HARNESS_VERSION = "0.1.0";
const DISPLAY_NAME = "ac-harness";
// --- TTY gate (before any wiring): graceful non-TTY exit --------------------
if (!process.stdout.isTTY || process.env.TERM === "dumb") {
  process.stdout.write("tui requires an interactive terminal; use `node src/cli.js`\n");
  process.exit(0);
}

// Dynamic imports INSIDE main(): the TUI mirrors cli.js chat()'s load
// discipline — nothing at module top level but builtins + the TTY gate, so a
// future non-interactive subcommand stays as pure as the replay path.
async function main() {
  const { EventLog } = await import("../events.js");
  const { Policy } = await import("../policy.js");
  const { defaultRules } = await import("../policy-defaults.js");
  const { createRegistry } = await import("../tools/index.js");
  const { default: echo } = await import("../providers/echo.js");
  const { decide } = await import("../context.js");
  const { createLoop } = await import("../loop.js");
  const { createDefaultVerifyGate } = await import("../verify.js");
  const { loadPlugins, wirePluginHooks } = await import("../plugins/loader.js");
  const { readFile: readPluginConfig } = await import("node:fs/promises");

  const { ansi, style, boxLine, createScreen } = await import("./screen.js");
  const { createViewport, wrapLine } = await import("./viewport.js");
  const { createComposer, parseSubmission, splitKeys } = await import("./composer.js");
  const { createAsk } = await import("./ask.js");
  const R = await import("./renderers.js");

  const repoRoot = resolve(new URL("../../", import.meta.url).pathname);

  // --- session objects (mirrors cli.js chat(), same order and semantics) ----
  const sessionId = `tui-${Date.now()}`;
  const logPath = resolve(`logs/${sessionId}.jsonl`);
  const log = await EventLog.open(logPath);
  const policy = new Policy({ rules: defaultRules(), logPath });

  // NB (mirrors cli.js comment): every await must complete BEFORE raw-mode
  // key handling attaches, so plugin loading sits above the input setup.
  const pluginHost = await loadPlugins({
    dir: resolve(repoRoot, "plugins"),
    harnessVersion: HARNESS_VERSION,
    log,
  });
  let pluginConfig = {};
  try {
    pluginConfig = JSON.parse(await readPluginConfig(resolve(repoRoot, "plugins.config.json"), "utf8"));
  } catch {
    /* absent or unparseable = defaults */
  }
  const wired = await wirePluginHooks(pluginHost, log, { config: pluginConfig });
  const effectiveDecide = wired.decide ?? decide;

  // --- screen zones ----------------------------------------------------------
  const screen = createScreen({
    write: (s) => process.stdout.write(s),
    cols: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  });
  const HINT = "enter send · ↑↓ history · pgup/pgdn scroll · ^C/^D quit · /help";
  // D4: mutables — SIGWINCH recomputes the layout, paint()/chunkPaint read
  // the live value instead of a stale const.
  let viewportRows = Math.max(3, screen.rows - 6); // status(1) + box(3) + hint(1) + spare(1)
  const viewport = createViewport({ maxLines: 10_000, height: viewportRows });
  const composer = createComposer({ width: Math.max(10, screen.cols - 4) });
  const history = composer.history;

  let askHandler = null; // non-null while a policy ask waits on a single key
  const ask = createAsk({
    showBanner: (a) => {
      appendRows([R.renderAskBanner(a)]);
    },
    clearBanner: () => paint(),
    setKeyHandler: (h) => {
      askHandler = h;
    },
  });

  // --- helpers ---------------------------------------------------------------
  function statusLine() {
    const t = loop ? `${loop.state.totalInput}/${loop.state.totalOutput}` : "0/0";
    const gate = askHandler ? `${style.yellow}ASK PENDING${style.reset}` : "open";
    return `${style.bold}${DISPLAY_NAME}${style.reset} ${style.dim}${sessionId} · echo/echo · tokens ${t}${style.reset} · gate ${gate}`;
  }

  function appendRows(rows) {
    const wrapped = [];
    for (const r of rows) for (const w of wrapLine(r, screen.cols)) wrapped.push(w);
    viewport.push(wrapped);
    paint();
  }

  /** Full repaint: status bar, viewport, composer box, hint line. */
  function paint() {
    if (!screen.isActive) return;
    const out = [];
    out.push(ansi.saveCaret + ansi.clearEntireLine + statusLine());
    const vis = viewport.visible();
    for (let i = 0; i < viewportRows; i++) {
      out.push(ansi.moveTo(1, 2 + i) + ansi.clearLineRight);
      if (i < vis.length) out.push(vis[i]);
    }
    const v = composer.view();
    const lines = boxLine(screen.cols, `> ${v.text}`).split("\n");
    for (let i = 0; i < lines.length; i++) {
      out.push(ansi.moveTo(1, 2 + viewportRows + i) + ansi.clearLineRight + lines[i]);
    }
    out.push(ansi.moveTo(1, 2 + viewportRows + lines.length) + ansi.clearLineRight + style.dim + HINT + style.reset);
    // park the caret at the composer text position
    const caretRow = 2 + viewportRows + 1;
    const caretCol = 3 + v.caretCol;
    out.push(ansi.moveTo(caretCol, caretRow));
    screen.emit(out.join(""));
  }

  // --- key handling (raw mode; no readline prompt) ---------------------------
  if (process.stdin.setRawMode) process.stdin.setRawMode(true);
  process.stdin.resume();

  let quitRequested = false;

  async function quit(code = 0) {
    if (quitRequested) return;
    quitRequested = true;
    try {
      if (loop) await loop.end();
      ask.abortPending();
    } finally {
      teardown();
      // D9: written AFTER teardown so the line lands on the restored main
      // screen (inside the alt-screen it vanished at exit).
      process.stdout.write(`\nsession ended; canonical sha256: ${log.canonicalSha256()}\n`);
      process.exit(code);
    }
  }

  process.stdin.on("data", (buf) => {
    const chunk = buf.toString("utf8");
    // Ask mode (§3): single-key y/n/a/-^C; composer disabled while pending.
    if (askHandler) {
      // D1: escape sequences are consumed WHOLE (one shared splitKeys token
      // stream) — an arrow-up can never decompose into ESC, "[", "A" and
      // resolve the ask as "A". Esc tokens reach the handler as one token it
      // ignores; printable runs resolve per true single-char key.
      for (const tok of splitKeys(chunk)) {
        if (askHandler === null) break; // resolved mid-chunk: drop this chunk's tail
        if (tok.length === 1) {
          askHandler(tok);
        } else if (tok.startsWith("\x1b")) {
          askHandler(tok); // whole esc-seq token — the ask handler ignores it
        } else {
          for (const ch of tok) {
            if (askHandler === null) break;
            askHandler(ch); // pasted text: per single key
          }
        }
      }
      paint();
      return;
    }
    // D6/D8: one shared tokenizer — whole escape tokens, printable insert
    // runs, per-newline submits in order (paste works); an unrecognized
    // escape drops the rest of the chunk (never composer input).
    for (const tok of splitKeys(chunk)) handleKey(tok);
    paint();
  });

  function handleKey(seq) {
    const r = composer.key(seq);
    switch (r.action) {
      case "send":
        void handleSubmit(r.text);
        break;
      case "viewport":
        if (r.verb === "pageUp") viewport.scrollUp(Math.max(1, viewportRows - 1));
        else viewport.scrollDown(Math.max(1, viewportRows - 1));
        break;
      case "quit":
        void quit(0);
        break;
      case "clear":
      case "edit":
      case "move":
      case "history":
      case "ignored":
      case "noop":
      default:
        break;
    }
    if (seq === "\x1b[A" || seq === "\x1b[B") paint();
  }

  async function handleSubmit(text) {
    viewport.pinToBottom();
    const parsed = parseSubmission(text);
    if (parsed.command) {
      switch (parsed.command) {
        case "/quit":
        case "/exit":
          await quit(0);
          return;
        case "/policy": {
          const rows = policy.rules.map(
            (r) => `  ${r.id}: ${r.effect} ${JSON.stringify(r.match)}`,
          );
          rows.push(`  pinned.deny_log_path: deny ${policy.logDir}`);
          appendRows(rows);
          return;
        }
        case "/resume": {
          const seq = parsed.args[0] === undefined ? Number.MAX_SAFE_INTEGER : Number(parsed.args[0]);
          const st = await loop.resume(seq);
          appendRows([`resumed at seq ${seq}: ${st.messages} messages, ${st.turns} turns`]);
          return;
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
          appendRows([`decision: ${JSON.stringify(d)}`]);
          return;
        }
        case "/replay":
          appendRows([`canonical sha256: ${log.canonicalSha256()}`]);
          return;
        case "/help":
          appendRows(["commands: /policy /resume [seq] /compact /replay /quit"]);
          return;
        default:
          appendRows([`unknown command: ${parsed.command}`]);
          return;
      }
    }
    try {
      const res = await loop.start(text);
      if (loop.state.ended) {
        // verify-gate deny may end the session mid-turn; surface + exit
        appendRows([`turn aborted: ${res.aborted === true ? "gate" : "end"}`]);
      }
    } catch (err) {
      appendRows([`${style.red}error: ${err.message}${style.reset}`]);
    }
    paint();
  }

  // --- SIGWINCH reflow (spec §2 no-tearing resize; D4: fresh layout) ---------
  process.on("SIGWINCH", () => {
    screen.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 24);
    viewportRows = Math.max(3, screen.rows - 6); // recompute BEFORE resize/paint
    viewport.resize(viewportRows);
    composer.setWidth(Math.max(10, screen.cols - 4));
    paint();
  });

  // --- exit paths: one teardown for quit/crash/signals (spec §1) ------------
  let tornDown = false;
  function teardown() {
    if (tornDown) return;
    tornDown = true;
    try {
      if (process.stdin.setRawMode) process.stdin.setRawMode(false);
      process.stdin.pause();
    } catch {
      /* stdin already gone */
    }
    screen.leave(); // ShowCaret + LeaveAltScreen + normal video
  }
  process.on("exit", teardown);
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      ask.abortPending(); // an in-flight ask resolves deny; the loop records it
      quit(0);
    });
  }

  // --- loop wiring: EXACTLY cli.js chat()'s shape (echo default) ------------
  const askResolver = ask.resolver; // SAME contract as the REPL askResolver
  const loop = createLoop({
    provider: echo,
    tools: createRegistry(),
    policy,
    log,
    decide: effectiveDecide,
    askResolver,
    config: { session: sessionId, harness_version: HARNESS_VERSION },
    hooks: {
      preTool: wired.preTool,
      postTool: wired.postTool,
      onEvent: wired.onEvent,
      verifyGate: wired.verifyGate ?? createDefaultVerifyGate({ cwd: repoRoot }),
      decidePlugin: wired.decidePlugin,
      verifyGatePlugin: wired.verifyGatePlugin,
    },
  });

  // --- the VIEWER: subscribe to the event stream like server.js -------------
  let liveText = ""; // streaming assistant line (repaint target, not viewport rows)
  log.on("event", (ev) => {
    if (ev.type === "turn.provider.chunk") {
      liveText += ev.data.delta ?? "";
      // Repaint ONLY the live assistant line (caret-save/restore — spec §1:
      // never a full-viewport repaint per chunk).
      chunkPaint();
      return;
    }
    // If the loop-side race/timeout settles an ask before a key did, free the
    // keymap so the composer re-enables (banner row still renders below).
    if (ev.type === "policy.ask.resolved" && askHandler) ask.abortPending();
    // D3: commit the completed assistant reply to the viewport BEFORE
    // clearing liveText — scrollback keeps the answer.
    if (ev.type === "turn.provider.response" && liveText !== "") {
      appendRows([R.renderAssistantText(liveText)]);
    }
    const rows = R.renderEvent(ev);
    if (ev.type === "turn.provider.response") liveText = ""; // cleared AFTER the push
    if (rows.length > 0) {
      if (ev.type === "tool.result" && ev.data?.error?.includes("verify-gate")) {
        appendRows([R.renderVerifyFail(ev.data.error)]);
      } else {
        appendRows(rows);
      }
    }
  });

  function chunkPaint() {
    if (!screen.isActive) return;
    const line = R.renderAssistantText(liveText);
    const rows = wrapLine(line, screen.cols).slice(-viewportRows);
    // Stable anchor: the row right after the last committed viewport line.
    const anchorRow = 2 + Math.min(viewportRows - 1, viewport.length);
    const out = [ansi.saveCaret];
    rows.forEach((r, idx) => {
      out.push(ansi.moveTo(1, anchorRow + idx) + ansi.clearLineRight + r);
    });
    // restore caret to the composer slot
    out.push(ansi.restoreCaret);
    screen.emit(out.join(""));
  }

  // --- go --------------------------------------------------------------------
  screen.enter();
  appendRows([
    `${DISPLAY_NAME} ${HARNESS_VERSION} — echo provider, log: ${logPath}`,
    "commands: /policy /resume [seq] /compact /replay /quit",
  ]);
  paint();
}

main().catch((err) => {
  process.stderr.write(`tui fatal: ${err.message}\n`);
  process.exit(1);
});
