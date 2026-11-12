// test/repair-3.test.js — audit-a2 repairs: 6.1 single-hook containment +
// fallback, 6.2 strategy-honoring shared compaction applier (run == replay).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, canonicalize, readAll } from "../src/events.js";
import { Policy } from "../src/policy.js";
import { defaultRules } from "../src/policy-defaults.js";
import { createRegistry } from "../src/tools/index.js";
import echo from "../src/providers/echo.js";
import { decide as builtinDecide } from "../src/context.js";
import { makeDecide } from "../plugins/compact-smart/index.js";
import { createLoop } from "../src/loop.js";

async function makeLoop(dir, { decide, askResolver, hooks, config } = {}) {
  const logPath = join(dir, "events.jsonl");
  const log = await EventLog.open(logPath);
  const policy = new Policy({ rules: defaultRules(), logPath });
  const loop = createLoop({
    provider: echo,
    tools: createRegistry(),
    policy,
    log,
    decide: decide ?? builtinDecide,
    askResolver,
    hooks,
    config: { session: "repair-3", output_reserve: 0, ...config },
  });
  return { loop, log, logPath };
}

test("6.1: throwing plugin decide is contained; built-in decide takes over", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-r3-"));
  try {
    const { loop, log } = await makeLoop(dir, {
      decide: () => {
        throw new Error("decide-boom");
      },
      hooks: { decidePlugin: "decide-boomer" },
    });
    const r = await loop.start("hi");
    await loop.end();
    assert.equal(r.aborted, false, "turn completes despite the throwing decide");
    const violation = log.events.find(
      (e) => e.type === "plugin.violation" && e.data.name === "hooks.compaction-trigger",
    );
    assert.ok(violation, "plugin.violation logged for the throwing decide");
    assert.equal(violation.data.kind, "hook-error");
    assert.equal(violation.data.plugin, "decide-boomer");
    const decided = log.events.find((e) => e.type === "compaction.decided");
    assert.ok(decided, "compaction.decided still logged (fallback)");
    assert.equal(decided.data.verdict, "none", "built-in default decide produced the decision");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("6.1: throwing plugin verify-gate fails closed; turn completes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-r3-"));
  const editDir = await mkdtemp(join(tmpdir(), "harness-r3-edit-"));
  try {
    const target = join(editDir, "x.txt");
    const { loop, log } = await makeLoop(dir, {
      askResolver: () => "allow", // allow the write AND the failed-gate ask
      hooks: {
        verifyGate: async () => {
          throw new Error("gate-boom");
        },
        verifyGatePlugin: "gate-boomer",
      },
    });
    const r = await loop.start(`tool:write {"path":${JSON.stringify(target)},"content":"x"}`);
    await loop.end();
    assert.equal(r.aborted, false, "turn completes after the failed-closed gate");
    const violation = log.events.find(
      (e) => e.type === "plugin.violation" && e.data.name === "hooks.verify-gate",
    );
    assert.ok(violation, "plugin.violation logged for the throwing gate");
    const gateResult = log.events.find(
      (e) => e.type === "tool.result" && e.data.call_id === "verify-1",
    );
    assert.ok(gateResult, "gate run logged as tool.result");
    assert.equal(gateResult.data.ok, false, "failed closed");
    assert.ok(gateResult.data.error.includes("gate-boom"), "error string rides the summary");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(editDir, { recursive: true, force: true });
  }
});

/**
 * 6.2 harness: drive compact-smart through the loop with deterministic
 * pressure. echo's input_tokens = total message chars, so pressure is
 * controllable via context_limit. tail_turns=1 / older_than=1 put turn-0
 * messages outside the pinned tail at the turn-2 boundary.
 */
async function compactRun(dir, { contextLimit }) {
  const editDir = await mkdtemp(join(tmpdir(), "harness-r3-edit-"));
  const target = join(editDir, "tiny.txt");
  await writeFile(target, "x", "utf8"); // 1-byte tool-result → freed < 20%
  const input1 = `tool:read {"path":${JSON.stringify(target)}}`;
  const input2 = "y".repeat(200); // long second input lifts turn-2 pressure
  const { loop, log, logPath } = await makeLoop(dir, {
    decide: makeDecide({ tail_turns: 1, older_than: 1 }),
    config: { context_limit: contextLimit, output_reserve: 0 },
  });
  await loop.start(input1);
  const r2 = await loop.start(input2);
  await loop.end();
  return { loop, log, logPath, editDir, r2 };
}

test("6.2: step-3 summarise applies to assistant AND tool-result ranges", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-r3-"));
  let editDir;
  try {
    // p2 ≈ 0.8 (>= ratio 0.75, < 0.97): input chars ≈ 50 + 0 + 1 + 200 = 251
    ({ editDir } = await (async () => {
      const run = await compactRun(dir, { contextLimit: 320 });
      editDir = run.editDir;
      const { loop, log } = run;
      const decided = log.events.find((e) => e.type === "compaction.decided" && e.data.verdict === "compact");
      assert.ok(decided, "a compact decision was made");
      assert.equal(decided.data.strategy, "summarise");
      assert.equal(decided.data.reason, "pressure-plus-assistant");
      const applied = log.events.find((e) => e.type === "compaction.applied");
      assert.ok(applied);
      // Every message kind in range got compacted — not just tool-result.
      // v0.5.0 H2: the marker changed from the lossy tombstone
      // "[compacted <kind>; events A..B]" to the extractive summary with the
      // "<compacted: ...; events A..B; ...>" tail. Both kinds appear.
      const kinds = loop.state.messages
        .filter((m) => /<compacted: .*events \d+\.\.\d+/.test(m.content ?? ""))
        .map((m) => m.kind);
      assert.ok(kinds.includes("assistant"), "assistant range compacted");
      assert.ok(kinds.includes("tool-result"), "tool-result range compacted");
      assert.ok(/<compacted: .*events \d+\.\.\d+/.test(loop.state.messages[1].content ?? ""), "assistant content carries the new marker");
      return run;
    })());
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (editDir) await rm(editDir, { recursive: true, force: true });
  }
});

test("6.2: step-4 drop removes content with a dropped marker; differs from summarise", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-r3-"));
  let editDir;
  try {
    const run = await compactRun(dir, { contextLimit: 250 }); // p2 ≈ 1.0 >= 0.97
    editDir = run.editDir;
    const { loop, log } = run;
    const decided = log.events.find((e) => e.type === "compaction.decided" && e.data.verdict === "compact");
    assert.ok(decided);
    assert.equal(decided.data.strategy, "drop");
    assert.equal(decided.data.reason, "pressure-critical");
    const dropped = loop.state.messages.filter((m) => m.content.startsWith("[dropped "));
    assert.ok(dropped.length >= 2, "drop applied across the range");
    assert.ok(dropped.some((m) => m.kind === "assistant"));
    assert.ok(dropped.some((m) => m.kind === "tool-result"));
    assert.ok(loop.state.messages[1].content.match(/^\[dropped assistant; events \d+\.\.\d+\]$/));
    assert.ok(
      !loop.state.messages.some((m) => m.content.startsWith("[compacted ")),
      "drop and summarise markers differ",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (editDir) await rm(editDir, { recursive: true, force: true });
  }
});

test("6.2: run vs replay — resume mirrors apply byte-for-byte, canonical sha equal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-r3-"));
  let editDir;
  try {
    const run = await compactRun(dir, { contextLimit: 320 });
    editDir = run.editDir;
    const { loop, log, logPath } = run;
    const liveContents = loop.state.messages.map((m) => m.content);

    // Replay: fresh loop over the same log; resume replays compaction.applied
    // through the SAME shared helper.
    const log2 = await EventLog.open(logPath);
    const policy = new Policy({ rules: defaultRules(), logPath });
    const loop2 = createLoop({
      provider: echo,
      tools: createRegistry(),
      policy,
      log: log2,
      decide: makeDecide({ tail_turns: 1, older_than: 1 }),
      config: { session: "repair-3-replay" },
    });
    await loop2.resume(Number.MAX_SAFE_INTEGER);
    assert.deepEqual(
      loop2.state.messages.map((m) => m.content),
      liveContents,
      "resumed state equals live state (shared applier)",
    );
    assert.equal(canonicalize(await readAll(logPath)), log.canonical(), "canonical sha chain holds");
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (editDir) await rm(editDir, { recursive: true, force: true });
  }
});
