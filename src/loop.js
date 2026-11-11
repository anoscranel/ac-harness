// src/loop.js — reason → act → observe against providers + tools + policy.
//
//  - Abort-safe: one AbortController at the top; provider streams receive the
//    signal; the bash/grep tools kill their child mid-execution on abort.
//  - Checkpoint = the event log itself. Time-travel = resume(uptoSeq): state
//    is reconstructed from events <= seq; new events append at the tail (the
//    log is append-only — a branch is recorded, never a rewrite).
//  - Driver API: start / resume / abort / events (an AsyncGenerator of the
//    log's own event stream) / end.
//  - Every tool call is gated by policy BEFORE execution; `ask` resolves via
//    the injected askResolver (headless: 30s timeout deny, policy.ask.resolved).
//  - Compaction is decided at turn boundaries only, by the injected pure
//    `decide` (specs/compaction-trigger.md); the harness logs the decision.

import { resolveAsk } from "./policy.js";
import { sha256 } from "./events.js";
import { decide as builtinDecide } from "./context.js";

/** 6.2 (audit-a2): ONE shared compaction applier — run path and resume path
 *  call this same code, so replay mirrors apply byte-for-byte. Applies to
 *  EVERY message kind in each range; strategy "summarise" replaces content
 *  with the events-span placeholder, "drop" removes it with a dropped marker.
 *  Nothing outside the ranges is touched. */
function applyCompactionToMessages(messages, ranges, strategy) {
  for (const r of ranges ?? []) {
    for (let i = r.start; i < r.end; i++) {
      const m = messages[i];
      if (!m) continue;
      const span = `${r.event_log_span.first}..${r.event_log_span.last}`;
      m.content =
        strategy === "drop"
          ? `[dropped ${m.kind}; events ${span}]`
          : `[compacted ${m.kind}; events ${span}]`;
    }
  }
}

const DEFAULTS = {
  harness_version: "0.1.0",
  session: "default",
  config_sha: "0".repeat(8),
  context_limit: 128_000,
  output_reserve: 4_096,
  max_iterations: 8,
  budget: { max_session_tokens: 1_000_000, warn_fraction: 0.9 },
};

/** TB0 hook contract: coarse risk class handed to preTool hooks. */
function riskClassOf(tool) {
  if (tool === "read" || tool === "grep") return "read-only";
  if (tool === "write" || tool === "edit") return "write";
  return "exec"; // bash, mcp.*, anything else
}

export function createLoop({
  provider,
  tools,
  policy,
  log,
  decide,
  askResolver,
  config = {},
  hooks = {},
}) {
  const cfg = { ...DEFAULTS, ...config };
  // F1 (review-r1): one AbortController PER TURN. abort() cancels the
  // in-flight turn only; the next start() gets a fresh controller, so a
  // post-abort session is not bricked.
  let turnController = new AbortController();

  const preTool = hooks.preTool ?? [];
  const postTool = hooks.postTool ?? [];
  const onEvent = hooks.onEvent ?? [];
  const verifyGate = hooks.verifyGate; // optional; wired in milestone 004
  // 6.1 (audit-a2): single-hook owner names for containment violations.
  const decidePlugin = hooks.decidePlugin ?? "unknown";
  const verifyGatePlugin = hooks.verifyGatePlugin ?? "unknown";

  const state = {
    started: false,
    ended: false,
    turns: 0, // completed turns
    messages: [], // { role, content, turn_index, pinned, kind, event_span, call_id? }
    totalInput: 0,
    totalOutput: 0,
    lastUsage: null,
  };

  // onEvent chain hooks observe every appended event, with a circuit breaker
  // (TB0): 3 consecutive throws from the same plugin hook → that hook is
  // disabled and a policy.violation is logged. Per-throw errors already log
  // plugin.violation (hook-error).
  const onEventState = onEvent.map((h) => ({ h, consecutiveErrors: 0, disabled: false }));
  log.on("event", (ev) => {
    for (const s of onEventState) {
      if (s.disabled) continue;
      Promise.resolve()
        .then(() => s.h.fn(ev))
        .then(() => {
          s.consecutiveErrors = 0;
        })
        .catch(async (err) => {
          s.consecutiveErrors += 1;
          // Disable BEFORE logging: the violation events re-enter this chain,
          // so the flag must be set first for the breaker to be deterministic.
          const tripped = s.consecutiveErrors >= 3;
          if (tripped) s.disabled = true;
          await log.appendEvent("plugin.violation", "harness", {
            plugin: s.h.plugin ?? "unknown",
            kind: "hook-error",
            name: "hooks.on-event",
            detail: String(err?.message ?? err),
          });
          if (tripped) {
            await log.appendEvent("policy.violation", "policy", {
              kind: "hook-disabled",
              path: `plugins/${s.h.plugin ?? "unknown"}`,
              tool: "hooks.on-event",
            });
          }
        });
    }
  });

  async function emitAskResolution(call_id, res) {
    await log.appendEvent("policy.ask.resolved", "policy", {
      call_id,
      verdict: res.verdict,
      resolved_by: res.resolved_by,
      timeout_ms: res.timeout_ms,
    });
  }

  async function runToolCall(call) {
    const { call_id, name, args } = call;
    await log.appendEvent("tool.proposed", "harness", {
      call_id,
      tool: name,
      args,
      args_sha: sha256(JSON.stringify(args ?? {})),
    });

    const decision = policy.evaluate({ tool: name, args });
    await log.appendEvent("policy.decision", "policy", {
      call_id,
      verdict: decision.verdict,
      rule_path: decision.rule_path,
    });
    if (decision.violation) {
      await log.appendEvent("policy.violation", "policy", decision.violation);
    }

    // TB0: pre-tool chain hooks fold into the verdict (deny > ask > allow).
    // Contract: preTool({tool, args, riskClass}) -> {action, reason?}.
    const RANK = { deny: 3, ask: 2, allow: 1 };
    let folded = decision.verdict;
    let foldedBy = null;
    let foldedReason;
    for (const h of preTool) {
      let action;
      try {
        action = await h.fn({ tool: name, args, riskClass: riskClassOf(name) });
      } catch (err) {
        await log.appendEvent("plugin.violation", "harness", {
          plugin: h.plugin ?? "unknown",
          kind: "hook-error",
          name: "hooks.pre-tool",
          detail: String(err?.message ?? err),
        });
        continue;
      }
      const a = action?.action;
      if (a !== "deny" && a !== "ask" && a !== "allow") continue;
      if (RANK[a] > RANK[folded]) {
        folded = a;
        foldedBy = h.plugin ?? "unknown";
        foldedReason = action.reason;
      }
    }
    if (folded !== decision.verdict) {
      await log.appendEvent("policy.decision", "policy", {
        call_id,
        verdict: folded,
        rule_path: `plugin:${foldedBy}`,
        ...(foldedReason ? { reason: foldedReason } : {}),
      });
    }

    let allowed = folded === "allow";
    if (folded === "ask") {
      const res = await resolveAsk({ call_id, tool: name, args, askFn: askResolver });
      await emitAskResolution(call_id, res);
      allowed = res.verdict === "allow";
    }

    if (!allowed) {
      const output = "denied by policy";
      await log.appendEvent("tool.result", "tool", {
        call_id,
        ok: false,
        bytes: 0,
        duration_ms: 0,
        sha256: sha256(output),
        error: "policy-denied",
      });
      return { output, ok: false };
    }

    const t0 = Date.now();
    const result = await tools.run(name, args, {
      signal: turnController.signal,
      cwd: cfg.cwd,
      allowed: true,
    });
    const duration_ms = Date.now() - t0;
    const output = result.ok ? result.output ?? "" : result.error ?? "tool error";

    for (const h of postTool) {
      try {
        // TB0 contract: postTool({tool, args, result, durationMs}) -> null.
        await h.fn({ tool: name, args, result, durationMs: duration_ms });
      } catch (err) {
        await log.appendEvent("plugin.violation", "harness", {
          plugin: h.plugin ?? "unknown",
          kind: "hook-error",
          name: "hooks.post-tool",
          detail: String(err?.message ?? err),
        });
      }
    }

    // F10 (review-r1): the output CONTENT is logged (redaction runs pre-log in
    // appendEvent), capped at 64 KiB UTF-8 with truncated:true + sha256 of the
    // FULL output — so resume/compaction can re-expand originals from the log.
    const OUTPUT_CAP = 64 << 10;
    const fullBytes = Buffer.byteLength(output, "utf8");
    const capped =
      fullBytes > OUTPUT_CAP
        ? Buffer.from(output, "utf8").subarray(0, OUTPUT_CAP).toString("utf8")
        : output;
    await log.appendEvent("tool.result", "tool", {
      call_id,
      ok: result.ok,
      bytes: result.bytes ?? fullBytes,
      duration_ms,
      sha256: sha256(output),
      output: capped,
      ...(fullBytes > OUTPUT_CAP ? { truncated: true } : {}),
      ...(result.ok ? {} : { error: result.error ?? "tool error" }),
    });
    return { output, ok: result.ok, path: result.path };
  }

  async function runTurn(input) {
    // F1: fresh controller for THIS turn; abort() below cancels only this one.
    turnController = new AbortController();
    const signal = turnController.signal;
    state.turns += 1;
    const turn = state.turns;
    const turnIndex = turn - 1;
    const turnStartEv = await log.appendEvent("turn.start", "harness", { turn, input });
    state.messages.push({
      role: "user",
      kind: "user",
      content: input,
      turn_index: turnIndex,
      pinned: false,
      event_span: { first: turnStartEv.seq, last: turnStartEv.seq },
    });

    // F19: edited files are tracked from tool RESULT payloads (write/edit
    // return `path`), never from message metadata.
    const editedFiles = [];

    let finalText = "";
    let turnTruncated = false; // F17: provider stream ended without [DONE]
    let iterationsExhausted = true; // F21: set false only on a clean break
    for (let iter = 0; iter < cfg.max_iterations; iter++) {
      const toolSchemas = tools.schemas();
      await log.appendEvent("turn.provider.request", "provider", {
        provider: provider.id,
        model: provider.model ?? "default",
        messages: state.messages.length,
        tools: toolSchemas.length,
      });

      let text = "";
      let final = null;
      const chunkSeqs = [];
      try {
        for await (const chunk of provider.stream(
          { model: provider.model, messages: state.messages, tools: toolSchemas },
          { signal },
        )) {
          if (chunk.done) {
            final = chunk;
          } else {
            text += chunk.delta;
            const ev = await log.appendEvent("turn.provider.chunk", "provider", {
              delta: chunk.delta,
              done: false,
            });
            chunkSeqs.push(ev.seq);
          }
        }
      } catch (err) {
        if (err?.name === "AbortError") {
          await log.appendEvent("session.error", "harness", {
            message: "aborted",
            code: "abort",
          });
          return { text, aborted: true, truncated: turnTruncated };
        }
        throw err;
      }
      if (!final) throw new Error("provider stream ended without a final frame");
      if (final.truncated === true) turnTruncated = true;

      const u = final.usage ?? { input_tokens: 0, cached_tokens: 0, output_tokens: 0 };
      await log.appendEvent("turn.provider.response", "provider", {
        finish: final.finish ?? "stop",
        input_tokens: u.input_tokens,
        cached_tokens: u.cached_tokens ?? 0,
        output_tokens: u.output_tokens,
        estimate: final.estimate === true,
        // F17: a stream that ended without [DONE] is recorded as truncated.
        ...(final.truncated === true ? { truncated: true } : {}),
      });
      if (final.estimate === true) {
        await log.appendEvent("usage.estimated", "harness", {
          chars: final.chars ?? 0,
          estimate: "chars/4",
          estimate_flag: true,
        });
      }
      state.totalInput += u.input_tokens;
      state.totalOutput += u.output_tokens;
      state.lastUsage = { ...u, estimate: final.estimate === true };

      const assistantSpan = {
        first: chunkSeqs[0] ?? turnStartEv.seq,
        last: chunkSeqs[chunkSeqs.length - 1] ?? turnStartEv.seq,
      };
      state.messages.push({
        role: "assistant",
        kind: "assistant",
        content: text,
        turn_index: turnIndex,
        pinned: false,
        event_span: assistantSpan,
      });
      finalText = text;

      const calls = final.tool_calls ?? [];
      if (calls.length === 0) {
        iterationsExhausted = false;
        break;
      }

      for (const call of calls) {
        const proposedSeq = log.seq; // next seq = the tool.proposed we are about to write
        const { output, ok, path: resultPath } = await runToolCall(call);
        const resultSeq = log.seq - 1; // last written = the tool.result
        state.messages.push({
          role: "tool",
          kind: "tool-result",
          content: output,
          turn_index: turnIndex,
          pinned: false,
          call_id: call.call_id,
          event_span: { first: proposedSeq, last: resultSeq },
        });
        // F19: a successful write/edit result carries the resolved path.
        if (ok && resultPath && (call.name === "write" || call.name === "edit")) {
          editedFiles.push(resultPath);
        }
      }
    }

    // F21 (review-r1): hitting max_iterations is no longer silent.
    if (iterationsExhausted) {
      await log.appendEvent("session.error", "harness", {
        message: `max_iterations (${cfg.max_iterations}) reached; turn ended with pending tool calls`,
        code: "max-iterations",
      });
    }

    // Verify gate: runs after any turn that edited files (F19 — tracked from
    // tool result payloads above; wired by cli.js / server.js).
    if (verifyGate) {
      const edited = editedFiles;
      if (edited.length > 0) {
        const call_id = `verify-${turn}`;
        await log.appendEvent("tool.proposed", "harness", {
          call_id,
          tool: "verify-gate",
          args: { edited_files: edited },
          args_sha: sha256(JSON.stringify(edited)),
        });
        const t0 = Date.now();
        // 6.1 (audit-a2): a throwing plugin gate is contained and treated as
        // failed-CLOSED (error string becomes the summary); the turn lives on.
        let vres;
        try {
          vres = await verifyGate({ editedFiles: edited, signal });
        } catch (err) {
          await log.appendEvent("plugin.violation", "harness", {
            plugin: verifyGatePlugin,
            kind: "hook-error",
            name: "hooks.verify-gate",
            detail: String(err?.message ?? err),
          });
          vres = { ok: false, summary: `verify-gate error: ${err?.message ?? err}` };
        }
        const duration_ms = Date.now() - t0;
        const output = vres.ok ? "verify-gate passed" : `verify-gate failed: ${vres.summary ?? ""}`;
        await log.appendEvent("tool.result", "tool", {
          call_id,
          ok: vres.ok,
          bytes: Buffer.byteLength(output, "utf8"),
          duration_ms,
          sha256: sha256(output),
          ...(vres.ok ? {} : { error: output }),
        });
        if (!vres.ok) {
          // Failed verify-gate = loop pauses and asks (policy).
          const res = await resolveAsk({
            call_id,
            tool: "verify-gate",
            args: { edited_files: edited },
            askFn: askResolver,
          });
          await emitAskResolution(call_id, res);
          if (res.verdict !== "allow") {
            await log.appendEvent("session.error", "harness", {
              message: "verify-gate failed; not allowed to continue",
              code: "verify-gate",
            });
            return { text: finalText, aborted: true, truncated: turnTruncated };
          }
        }
      }
    }

    // Compaction decision at the turn boundary (never mid-stream).
    const snapshot = {
      input_tokens: state.lastUsage?.input_tokens ?? 0,
      cached_tokens: state.lastUsage?.cached_tokens ?? 0,
      output_reserve: cfg.output_reserve,
      context_limit: cfg.context_limit,
      estimate: state.lastUsage?.estimate ?? false,
    };
    const metas = state.messages.map((m) => ({
      role: m.role,
      turn_index: m.turn_index,
      pinned: m.pinned,
      byte_len: Buffer.byteLength(m.content ?? "", "utf8"),
      kind: m.kind,
      event_span: m.event_span,
    }));
    // 6.1 (audit-a2): a throwing plugin decide is contained; the harness
    // falls back to the BUILT-IN default decide (kept reachable here even
    // when the configured decide is a plugin's).
    let decision;
    try {
      decision = decide(snapshot, state.turns, cfg.budget, metas);
    } catch (err) {
      await log.appendEvent("plugin.violation", "harness", {
        plugin: decidePlugin,
        kind: "hook-error",
        name: "hooks.compaction-trigger",
        detail: String(err?.message ?? err),
      });
      decision = builtinDecide(snapshot, state.turns, cfg.budget, metas);
    }
    await log.appendEvent("compaction.decided", "compaction", decision);

    if (decision.verdict === "compact") {
      let freed = 0;
      // 6.2: shared applier — every message kind in range, strategy honored.
      applyCompactionToMessages(state.messages, decision.ranges, decision.strategy);
      for (const r of decision.ranges) {
        freed += r.event_log_span.last >= r.event_log_span.first
          ? r.event_log_span.last - r.event_log_span.first + 1
          : r.end - r.start;
      }
      await log.appendEvent("compaction.applied", "compaction", {
        version: 1,
        ranges: decision.ranges,
        strategy: decision.strategy,
        freed_events: freed,
      });
    } else if (decision.verdict === "block") {
      await log.appendEvent("session.error", "harness", {
        message: decision.reason ?? "context-limit-uncompacted",
        code: "context",
      });
      return { text: finalText, aborted: true, truncated: turnTruncated };
    }

    return { text: finalText, aborted: false, truncated: turnTruncated };
  }

  async function start(input) {
    if (!state.started) {
      await log.appendEvent("session.start", "harness", {
        harness_version: cfg.harness_version,
        session: cfg.session,
        config_sha: cfg.config_sha,
      });
      state.started = true;
    }
    try {
      return await runTurn(input);
    } catch (err) {
      await log.appendEvent("session.error", "harness", {
        message: String(err?.message ?? err),
        code: "internal",
      });
      throw err;
    }
  }

  /**
   * Time-travel: rebuild in-memory state from events with seq <= uptoSeq.
   * The append-only log is never rewritten. F9 (review-r1): a backward resume
   * (uptoSeq < tail) FIRST records a session.branch event {from_seq,
   * new_base_seq}; later resumes merge ONLY events <= from_seq plus events
   * appended at/after new_base_seq — the abandoned tail is masked out, so a
   * branch-then-resume never produces a hybrid context. Turn numbering
   * continues globally from the branch prefix (never restarts).
   */
  async function resume(uptoSeq = Number.MAX_SAFE_INTEGER) {
    const { readAll } = await import("./events.js");
    const all = (await readAll(log.path)).filter((e) => e.seq <= uptoSeq);
    const tail = log.events.length > 0 ? log.events[log.events.length - 1].seq : -1;

    // Mask abandoned segments: for every recorded branch, drop events with
    // from_seq < seq < new_base_seq (branch markers themselves are kept).
    const branches = all.filter((e) => e.type === "session.branch");
    const events = all.filter((e) => {
      if (e.type === "session.branch") return true;
      for (const b of branches) {
        if (e.seq > b.data.from_seq && e.seq < b.data.new_base_seq) return false;
      }
      return true;
    });

    state.messages = [];
    state.turns = 0;
    // F11 (review-r1): reset usage totals before replaying recorded usage —
    // repeated resumes must not double-count.
    state.totalInput = 0;
    state.totalOutput = 0;
    state.lastUsage = null;
    let chunkBuffer = "";
    let chunkFirst = -1;
    let currentTurnIndex = -1;
    const proposed = new Map(); // call_id -> proposed seq
    for (const ev of events) {
      switch (ev.type) {
        case "session.start":
          state.started = true;
          break;
        case "turn.start":
          currentTurnIndex = ev.data.turn - 1;
          state.turns = Math.max(state.turns, ev.data.turn);
          state.messages.push({
            role: "user",
            kind: "user",
            content: ev.data.input,
            turn_index: currentTurnIndex,
            pinned: false,
            event_span: { first: ev.seq, last: ev.seq },
          });
          chunkBuffer = "";
          chunkFirst = -1;
          break;
        case "turn.provider.chunk":
          if (chunkFirst === -1) chunkFirst = ev.seq;
          chunkBuffer += ev.data.delta ?? "";
          break;
        case "turn.provider.response":
          state.messages.push({
            role: "assistant",
            kind: "assistant",
            content: chunkBuffer,
            turn_index: currentTurnIndex,
            pinned: false,
            event_span: { first: chunkFirst === -1 ? ev.seq : chunkFirst, last: ev.seq },
          });
          state.totalInput += ev.data.input_tokens ?? 0;
          state.totalOutput += ev.data.output_tokens ?? 0;
          state.lastUsage = {
            input_tokens: ev.data.input_tokens ?? 0,
            cached_tokens: ev.data.cached_tokens ?? 0,
            output_tokens: ev.data.output_tokens ?? 0,
            estimate: ev.data.estimate === true,
          };
          chunkBuffer = "";
          chunkFirst = -1;
          break;
        case "tool.proposed":
          proposed.set(ev.data.call_id, ev.seq);
          break;
        case "tool.result":
          state.messages.push({
            role: "tool",
            kind: "tool-result",
            // F10: rebuild from the logged output content (post-redaction,
            // capped); fall back to the error string for denied/failed calls.
            content: ev.data.output ?? (ev.data.ok ? "" : ev.data.error ?? ""),
            turn_index: currentTurnIndex,
            pinned: false,
            event_span: { first: proposed.get(ev.data.call_id) ?? ev.seq, last: ev.seq },
          });
          break;
        case "compaction.applied":
          // 6.2: resume mirrors apply byte-for-byte via the shared helper.
          applyCompactionToMessages(state.messages, ev.data.ranges ?? [], ev.data.strategy);
          break;
        default:
          break;
      }
    }

    // F9: a backward resume records the branch BEFORE any new turn events.
    if (uptoSeq < tail) {
      const branchSeq = log.seq; // the branch event itself lands here
      await log.appendEvent("session.branch", "harness", {
        from_seq: uptoSeq,
        new_base_seq: branchSeq + 1,
      });
    }
    return { messages: state.messages.length, turns: state.turns };
  }

  function abort() {
    // F1: aborts the CURRENT turn's controller only; the next turn gets a
    // fresh one (runTurn re-creates it).
    turnController.abort();
  }

  async function end() {
    if (state.ended || !state.started) return;
    state.ended = true;
    await log.appendEvent("session.end", "harness", {
      turns: state.turns,
      total_input_tokens: state.totalInput,
      total_output_tokens: state.totalOutput,
      total_cost_micro_usd: 0, // v1: no priced providers; integers only, never floats
    });
  }

  /** AsyncGenerator of the log's own event stream (existing, then live). */
  async function* events() {
    let offset = 0;
    while (offset < log.events.length) yield log.events[offset++];
    const queue = [];
    let wake = null;
    const onEvent = (ev) => {
      queue.push(ev);
      if (wake) {
        wake();
        wake = null;
      }
    };
    log.on("event", onEvent);
    try {
      for (;;) {
        if (queue.length === 0) {
          if (state.ended) return;
          await new Promise((r) => {
            wake = r;
          });
          continue;
        }
        yield queue.shift();
      }
    } finally {
      log.off("event", onEvent);
    }
  }

  return {
    start,
    resume,
    abort,
    events,
    end,
    state,
    get signal() {
      return turnController.signal;
    },
  };
}

export default createLoop;
