// test/repair-r1.test.js — the three probes named by repair-card-r1:
// abort-per-turn (F1), branch-merge non-corruption (F9), verify-gate-fires (F19).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/events.js";
import { Policy } from "../src/policy.js";
import { defaultRules } from "../src/policy-defaults.js";
import { createRegistry } from "../src/tools/index.js";
import echo from "../src/providers/echo.js";
import { decide } from "../src/context.js";
import { createLoop } from "../src/loop.js";

async function makeLoop(dir, { askResolver, hooks } = {}) {
  const logPath = join(dir, "events.jsonl");
  const log = await EventLog.open(logPath);
  const policy = new Policy({ rules: defaultRules(), logPath });
  const loop = createLoop({
    provider: echo,
    tools: createRegistry(),
    policy,
    log,
    decide,
    askResolver,
    hooks,
    config: { session: "repair-r1" },
  });
  return { loop, log, logPath };
}

test("F1 abort-per-turn: post-abort start() runs a normal turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-r1-"));
  try {
    const { loop, log } = await makeLoop(dir);
    const r1 = await loop.start("one");
    assert.equal(r1.aborted, false);
    loop.abort(); // aborts the (completed) turn's controller
    const r2 = await loop.start("two");
    assert.equal(r2.aborted, false, "post-abort turn must run normally");
    assert.equal(r2.text, "echo: two");
    await loop.end();
    const turns = log.events.filter((e) => e.type === "turn.start").map((e) => e.data.turn);
    assert.deepEqual(turns, [1, 2]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("F9 branch-merge: branch then resume picks ONLY the branch path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-r1-"));
  try {
    const { loop, log } = await makeLoop(dir);
    await loop.start("first");
    await loop.start("second");
    // Branch point: the last event of turn 1 (its compaction.decided).
    const turn2Start = log.events.find((e) => e.type === "turn.start" && e.data.turn === 2);
    const branchAt = turn2Start.seq - 1;

    await loop.resume(branchAt); // backward resume → session.branch recorded
    const branch = log.events.find((e) => e.type === "session.branch");
    assert.ok(branch, "session.branch must be logged on backward resume");
    assert.equal(branch.data.from_seq, branchAt);
    assert.equal(branch.data.new_base_seq, branch.seq + 1);

    const r = await loop.start("third"); // continues globally: turn 2 in the live timeline
    assert.equal(r.aborted, false);

    // Full resume must merge ONLY the branch path: "first"+"third", never "second".
    const st = await loop.resume(Number.MAX_SAFE_INTEGER);
    const contents = loop.state.messages.map((m) => m.content);
    assert.ok(contents.includes("first"), "branch prefix kept");
    assert.ok(contents.includes("third"), "new timeline kept");
    assert.ok(!contents.includes("second"), "abandoned tail masked out");
    assert.equal(st.turns, 2, "turn numbering continues globally, never restarts");
    await loop.end();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("F19 verify-gate fires after a turn that edits a file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-r1-"));
  const editDir = await mkdtemp(join(tmpdir(), "harness-r1-edit-"));
  try {
    // NB: the edit target must live OUTSIDE the log's directory — the pinned
    // deny covers the whole log dir (that deny firing here once masked the
    // gate in this test's first draft).
    const target = join(editDir, "edited.txt");
    const gateCalls = [];
    const stubGate = async ({ editedFiles }) => {
      gateCalls.push(editedFiles);
      return { ok: true, results: [], summary: "ok" };
    };
    const { loop, log } = await makeLoop(dir, {
      askResolver: () => "allow", // write is `ask` by default; allow it
      hooks: { verifyGate: stubGate },
    });
    await loop.start(`tool:write {"path":${JSON.stringify(target)},"content":"x"}`);
    await loop.end();

    assert.equal(gateCalls.length, 1, "verify gate must fire once");
    assert.deepEqual(gateCalls[0], [target], "edited file comes from the tool result payload");

    const proposed = log.events.find((e) => e.type === "tool.proposed" && e.data.tool === "verify-gate");
    const result = log.events.find((e) => e.type === "tool.result" && e.data.call_id === proposed?.data.call_id);
    assert.ok(proposed, "verify-gate run is logged as tool.proposed");
    assert.equal(result?.data.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(editDir, { recursive: true, force: true });
  }
});
