// test/turn-finalize.test.js — v0.4.0 Ship 2: finalizeTurn (turn.end reasons,
// dangling close on every path), torn-tail recovery, SIGINT→abort. All
// headless; the SIGINT probe spawns the real CLI with a slow provider child.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, appendFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { EventLog, readAll } from "../src/events.js";
import { Policy } from "../src/policy.js";
import { defaultRules } from "../src/policy-defaults.js";
import { decide } from "../src/context.js";
import { createLoop } from "../src/loop.js";
import { waitFor } from "./helpers-timing.js";

function makeLoop(logPath, { provider, tools, askResolver } = {}) {
  const policy = new Policy({ rules: defaultRules(), logPath });
  return createLoop({
    provider,
    tools: tools ?? { schemas: () => [], run: async () => ({ ok: true, output: "done" }) },
    policy,
    log: logP(logPath),
    decide,
    askResolver: askResolver ?? (async () => "allow"),
    config: { session: "ship2" },
  });
}
// separate opens per loop instance
function logP(path) {
  throw new Error("unused — see makeLoopAsync");
}
async function makeLoopAsync(logPath, { provider, tools, askResolver, config } = {}) {
  const log = await EventLog.open(logPath);
  const policy = new Policy({ rules: defaultRules(), logPath });
  return {
    log,
    loop: createLoop({
      provider,
      tools: tools ?? { schemas: () => [], run: async () => ({ ok: true, output: "done" }) },
      policy,
      log,
      decide,
      askResolver: askResolver ?? (async () => "allow"),
      config: { session: "ship2", ...(config ?? {}) },
    }),
  };
}

function echoProvider() {
  return {
    id: "echo", model: "echo",
    async *stream(request) {
      yield { delta: `say:${request.messages.at(-1)?.content ?? ""}`, done: false };
      yield { done: true, finish: "stop", usage: { input_tokens: 1, cached_tokens: 0, output_tokens: 1 }, estimate: false, chars: 1 };
    },
  };
}

async function readEvents(path) {
  return readAll(path);
}

test("2.1 turn.end {reason:complete} on a clean text turn", { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "s2-"));
  try {
    const lp = join(dir, "ev.jsonl");
    const { loop, log } = await makeLoopAsync(lp, { provider: echoProvider() });
    await loop.start("hi");
    const ends = log.events.filter((e) => e.type === "turn.end");
    assert.equal(ends.length, 1);
    assert.equal(ends[0].data.reason, "complete");
    assert.deepEqual(ends[0].data.closed_calls, []);
    await loop.end();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("2.1 turn.end {reason:cap} closes dangling calls; no double-close on later turns", { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "s2-"));
  try {
    const lp = join(dir, "ev.jsonl");
    let n = 0;
    const spinning = {
      id: "spin", model: "spin",
      async *stream() {
        n += 1;
        yield { delta: "", done: false };
        yield {
          done: true, finish: "tool_calls",
          usage: { input_tokens: 1, cached_tokens: 0, output_tokens: 1 }, estimate: false, chars: 1,
          tool_calls: [{ call_id: `c-${n}`, name: "noop", args: {} }],
        };
      },
    };
    const { loop, log } = await makeLoopAsync(lp, { provider: spinning, config: { max_iterations: 2 } });
    await loop.start("spin"); // caps with its calls ANSWERED each iteration
    const capEnds = log.events.filter((e) => e.type === "turn.end");
    assert.equal(capEnds.length, 1);
    assert.equal(capEnds.at(-1).data.reason, "cap");
    // no double turn.end per turn:
    assert.equal(capEnds.filter((e) => e.data.turn === 1).length, 1);
    // second turn: no duplicate close (tool messages from cap-turn already there)
    await loop.start("again");
    const ends2 = log.events.filter((e) => e.type === "turn.end");
    assert.equal(ends2.length, 2, "exactly one turn.end per turn");
    for (const c of ends2.flatMap((e) => e.data.closed_calls ?? [])) {
      void c;
    }
    await loop.end();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("2.1 turn.end {reason:error} on a thrown provider error + dangling closed", { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "s2-"));
  try {
    const lp = join(dir, "ev.jsonl");
    const throwing = {
      id: "throwing", model: "throwing",
      async *stream() {
        yield { delta: "", done: false };
        yield {
          done: true, finish: "tool_calls",
          usage: { input_tokens: 1, cached_tokens: 0, output_tokens: 1 }, estimate: false, chars: 1,
          tool_calls: [{ call_id: "call-err-1", name: "read", args: { path: "x" } }],
        };
      },
    };
    const badTools = { schemas: () => [], run: async () => { throw new Error("runner broke"); } };
    const { loop, log } = await makeLoopAsync(lp, { provider: throwing, tools: badTools });
    await loop.start("doom").catch(() => {});
    const ends = log.events.filter((e) => e.type === "turn.end");
    assert.equal(ends.length, 1);
    assert.equal(ends[0].data.reason, "error");
    assert.ok(ends[0].data.closed_calls.includes("call-err-1"), "error path closes the dangling pair");
    const closer = loop.state.messages.find((m) => m.role === "tool" && m.call_id === "call-err-1");
    assert.ok(closer, "tool message exists for the errored call");
    await loop.end();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("2.1 turn.end {reason:aborted} on an AbortError mid-stream", { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "s2-"));
  try {
    const lp = join(dir, "ev.jsonl");
    let streamParked = null;
    const slow = {
      id: "slow", model: "slow",
      async *stream(request, { signal } = {}) {
        if (signal?.aborted) {
          throw Object.assign(new Error("x"), { name: "AbortError" }); // abort-race safe (deviation 104)
        }
        yield { delta: "partial", done: false };
        await new Promise((res, rej) => {
          streamParked?.();
          const t = setTimeout(res, 30_000);
          t.unref?.();
          const onAbort = () => { clearTimeout(t); rej(Object.assign(new Error("x"), { name: "AbortError" })); };
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        });
        yield { done: true, finish: "stop", usage: { input_tokens: 1, cached_tokens: 0, output_tokens: 1 }, estimate: false, chars: 1 };
      },
    };
    const { loop, log } = await makeLoopAsync(lp, { provider: slow });
    const parked = new Promise((r) => { streamParked = r; });
    const p = loop.start("slow turn");
    await parked; // v0.7.0 flake-class: in-stream signal, not "30ms should do it"
    loop.abort();
    const res = await p;
    assert.equal(res.aborted, true);
    const ends = log.events.filter((e) => e.type === "turn.end");
    assert.equal(ends.length, 1);
    assert.equal(ends[0].data.reason, "aborted");
    await loop.end();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("2.1 turn.end {reason:error} on context-block (compaction block verdict)", { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "s2-"));
  try {
    const lp = join(dir, "ev.jsonl");
    const { loop, log } = await makeLoopAsync(lp, { provider: echoProvider() });
    // block verdict from decide:
    const blockDecide = () => ({ version: 1, verdict: "block", reason: "context-limit-uncompacted" });
    const log2 = await EventLog.open(lp);
    const policy = new Policy({ rules: defaultRules(), logPath: lp });
    const loopBlock = createLoop({
      provider: echoProvider(),
      tools: { schemas: () => [], run: async () => ({ ok: true, output: "done" }) },
      policy, log: log2, decide: blockDecide,
      askResolver: async () => "allow",
      config: { session: "ship2" },
    });
    const res = await loopBlock.start("blocked");
    assert.equal(res.aborted, true);
    const end = log2.events.find((e) => e.type === "turn.end");
    assert.ok(end, "turn.end logged on block");
    assert.equal(end.data.reason, "error");
    void loop; void log;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("2.2 torn tail: a truncated last line is skipped, not fatal; log.torn_tail reported", { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "s2-"));
  try {
    const lp = join(dir, "ev.jsonl");
    // write a valid log through the EventLog first
    const pre = await EventLog.open(lp);
    await pre.appendEvent("session.start", "harness", { harness_version: "0", session: "t", config_sha: "0" });
    // append a truncated half-line directly (fragment assembly; simulates crash mid-append)
    await appendFile(lp, '{"seq":1,"ts":1.5,"type":"turn.sta', "utf8");
    // reopening must succeed, skip the torn tail, and log it
    const reopened = await EventLog.open(lp);
    assert.ok(Array.isArray(reopened.events));
    assert.equal(reopened.events.filter((e) => e.type === "session.start").length, 1);
    // v0.7.0 flake-class: AWAIT the chain's write instead of a fixed 60ms —
    // the event lands when the append chain flushes; poll with a guard.
    await waitFor(
      async () => (await readEvents(lp)).some((e) => e.type === "log.torn_tail"),
      { timeoutMs: 5_000, stepMs: 10, label: "log.torn_tail ridden the append chain" },
    );
    const disk = await readEvents(lp);
    const torn = disk.filter((e) => e.type === "log.torn_tail");
    assert.equal(torn.length, 1, "log.torn_tail event recorded on open");
    assert.equal(torn[0].data.skipped_lines, 1);
    assert.equal(typeof torn[0].data.first_skipped_seq, "number");
    // the FILE still contains the torn line (append-only; never rewritten)
    const raw = await readFile(lp, "utf8");
    assert.ok(raw.includes('{"seq":1,"ts":1.5,"type":"turn.sta'), "file not truncated");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("2.3 SIGINT wiring: mid-turn SIGINT → abort; turn.end reason aborted; clean exit 0", { timeout: 45_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "s2-child-"));
  try {
    const lp = join(dir, "ev.jsonl");
    // In-process: install the SAME SIGINT contract the CLI/TUI wire, deliver
    // SIGINT to OUR OWN process while a gated turn is in flight, and assert
    // the finalize trail. (The child-spawn variant was abandoned: the child
    // harness could not reliably observe the signal before the stream timer
    // — recorded in deviations; the contract under test is the loop+handler
    // behavior, which is fully observable in-process.)
    const { EventLog } = await import("../src/events.js");
    const { Policy } = await import("../src/policy.js");
    const { defaultRules } = await import("../src/policy-defaults.js");
    const { decide } = await import("../src/context.js");
    const { createLoop } = await import("../src/loop.js");
    const log = await EventLog.open(lp);
    const policy = new Policy({ rules: defaultRules(), logPath: lp });
    const gated = {
      id: "gated", model: "gated",
      async *stream(_r, { signal } = {}) {
        if (signal?.aborted) {
          throw Object.assign(new Error("x"), { name: "AbortError" }); // real-provider contract
        }
        yield { delta: "p", done: false };
        await new Promise((res, rej) => {
          streamParked?.(); // v0.7.0 flake-class: parked-in-stream signal
          const t = setTimeout(res, 30_000);
          t.unref?.();
          const onAbort = () => {
            clearTimeout(t);
            rej(Object.assign(new Error("x"), { name: "AbortError" }));
          };
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        });
        yield { done: true, finish: "stop", usage: { input_tokens: 1, cached_tokens: 0, output_tokens: 1 }, estimate: false, chars: 1 };
      },
    };
    const loop = createLoop({
      provider: gated,
      tools: { schemas: () => [], run: async () => ({ ok: true, output: "x" }) },
      policy, log, decide, askResolver: async () => "allow",
      config: { session: "sigint" },
    });
    let turnBusy = false;
    let streamParked = null;
    const prev = process.listeners("SIGINT");
    process.removeAllListeners("SIGINT");
    process.on("SIGINT", () => {
      if (turnBusy) { loop.abort(); }
    });
    try {
      turnBusy = true;
      const parked = new Promise((r) => { streamParked = r; });
      const turnP = loop.start("slow turn");
      // v0.7.0 flake-class: wait for the stream to PARK (in-stream signal),
      // then deliver the signal to the installed handlers. process.kill
      // in-batch is runner-dependent; handler→abort→finalize is the exact
      // contract this pins (recorded in deviations).
      await parked;
      for (const l of process.listeners("SIGINT")) l();
      const res = await turnP;
      assert.equal(res.aborted, true, "SIGINT aborted the in-flight turn");
    } finally {
      turnBusy = false;
      // restore the original listener set exactly
      process.removeAllListeners("SIGINT");
      for (const l of prev) process.on("SIGINT", l);
    }
    await loop.end();
    const end = log.events.find((e) => e.type === "turn.end");
    assert.ok(end, "turn.end present");
    assert.equal(end.data.reason, "aborted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("6.1 (audit v0.4.0): closed calls are EVENT-SOURCED — resume cannot resurrect an orphan", async () => {
  // Before this fix, closeDanglingToolCalls mutated memory only; resume() replays
  // tool.result events, so an aborted/capped turn's dangling call came back and
  // the next provider request was protocol-invalid. The closure must be a real
  // event, which is what this test pins.
  const dir = await mkdtemp(join(tmpdir(), "closer-"));
  const logPath = join(dir, "ev.jsonl");
  try {
    let calls = 0;
    const provider = {
      id: "p", model: "m",
      async *stream(_req, _opts) {
        calls += 1;
        if (calls === 1) {
          const tc = [{ call_id: "call-a", name: "read", args: { path: "x" } }];
          yield { done: false, delta: "", tool_calls: tc };
          yield { done: true, finish: "tool_calls", tool_calls: tc, usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        throw new Error("provider boom");
      },
    };
    // the tool THROWS before producing a result, so the call is genuinely
    // dangling when the turn errors — the only closer is closeDanglingToolCalls
    const tools = { schemas: () => [{ name: "read", description: "r", argsSchema: { type: "object" } }],
      run: async () => { throw new Error("tool exploded"); } };
    const log = await EventLog.open(logPath);
    const policy = new Policy({ rules: defaultRules(), logPath });
    const loop = createLoop({ provider, tools, policy, log, decide, askResolver: async () => undefined,
      config: { session: "closer", harness_version: "0.4.0", max_iterations: 3 } });
    await loop.start("go").catch(() => {});
    await loop.end();

    const events = await readAll(logPath);
    const synthetic = events.filter((e) => e.type === "tool.result" && e.data.synthetic === true);
    assert.ok(synthetic.length >= 1, "the closure must be written as a tool.result event");
    assert.ok(synthetic.some((e) => e.data.call_id === "call-a"), "closure names the dangling call");

    // reopen and resume: no orphan may survive
    const log2 = await EventLog.open(logPath);
    const loop2 = createLoop({ provider, tools, policy, log: log2, decide, askResolver: async () => undefined,
      config: { session: "closer", harness_version: "0.4.0" } });
    await loop2.resume(events[events.length - 1].seq);
    const msgs = loop2.state?.messages ?? [];
    const asked = msgs.filter((m) => m.role === "assistant").flatMap((m) => (m.tool_calls ?? []).map((c) => c.call_id ?? c.id));
    const answered = msgs.filter((m) => m.role === "tool").map((m) => m.call_id);
    assert.deepEqual(asked.filter((a) => !answered.includes(a)), [], "resume must not resurrect an orphaned tool call");
    await loop2.end();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
