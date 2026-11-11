// test/context.test.js — default compaction-trigger policy (spec v2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, PINNED_TAIL_TURNS, DEFAULT_RATIO } from "../src/context.js";

const U = (input_tokens, context_limit = 1000) => ({
  input_tokens,
  cached_tokens: 0,
  output_reserve: 100,
  context_limit,
  estimate: false,
});
const BUDGET = { max_session_tokens: 1_000_000, warn_fraction: 0.9 };

function msg(i, kind, turn_index, pinned = false) {
  return {
    role: kind === "tool-result" ? "tool" : kind,
    turn_index,
    pinned,
    byte_len: 10,
    kind,
    event_span: { first: i * 2, last: i * 2 + 1 },
  };
}

test("named constants: pinned tail N=4, ratio 0.80", () => {
  assert.equal(PINNED_TAIL_TURNS, 4);
  assert.equal(DEFAULT_RATIO, 0.8);
});

test("below threshold → none", () => {
  // used = 700 + 100 reserve = 800 = 0.80 * 1000 → NOT below → triggers.
  // 699 + 100 = 799 < 800 → none.
  assert.deepEqual(decide(U(699), 10, BUDGET, []), { version: 1, verdict: "none" });
});

test("at/over threshold with tool-results outside pinned tail → compact, half-open ranges", () => {
  const turns = 10; // pinned tail = turn_index >= 6
  const msgs = [
    msg(0, "user", 0),
    msg(1, "tool-result", 0), // compactable
    msg(2, "tool-result", 1), // compactable (consecutive → same range)
    msg(3, "assistant", 2),
    msg(4, "tool-result", 3), // compactable (own range)
    msg(5, "tool-result", 7), // inside pinned tail — kept
  ];
  const d = decide(U(800), turns, BUDGET, msgs);
  assert.equal(d.verdict, "compact");
  assert.equal(d.strategy, "summarise");
  assert.equal(d.reason, "context-limit");
  assert.deepEqual(d.ranges, [
    { start: 1, end: 3, event_log_span: { first: 2, last: 5 } },
    { start: 4, end: 5, event_log_span: { first: 8, last: 9 } },
  ]);
});

test("pinned messages are never compacted", () => {
  const msgs = [msg(0, "tool-result", 0, true)]; // pinned
  const d = decide(U(900), 10, BUDGET, msgs);
  assert.equal(d.verdict, "block");
  assert.equal(d.reason, "context-limit-uncompacted");
});

test("decide is referentially transparent", () => {
  const msgs = [msg(0, "tool-result", 0)];
  const a = decide(U(900), 10, BUDGET, msgs);
  const b = decide(U(900), 10, BUDGET, msgs);
  assert.deepEqual(a, b);
});
