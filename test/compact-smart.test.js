// test/compact-smart.test.js — Tier-B compact-smart plugin: all 5 ladder
// steps, config defaults + overrides, determinism, purity by construction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decide, makeDecide } from "../plugins/compact-smart/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const U = (input_tokens, context_limit = 1000, output_reserve = 100) => ({
  input_tokens,
  cached_tokens: 0,
  output_reserve,
  context_limit,
  estimate: false,
});
const BUDGET = { max_session_tokens: 1_000_000, warn_fraction: 0.9 };

function msgFactory() {
  let seq = 0;
  return function msg(kind, turn_index, { pinned = false, bytes = 100 } = {}) {
    seq += 2;
    return {
      role: kind === "tool-result" ? "tool" : kind,
      turn_index,
      pinned,
      byte_len: bytes,
      kind,
      event_span: { first: seq - 2, last: seq - 1 },
    };
  };
}

test("step 1: below ratio → none", () => {
  const msg = msgFactory();
  // p = (600 + 100) / 1000 = 0.70 < 0.75
  const msgs = [msg("tool-result", 0)];
  assert.deepEqual(decide(U(600), 10, BUDGET, msgs), { version: 1, verdict: "none" });
});

test("step 2: at ratio → compact non-pinned tool-results outside the tail", () => {
  const msg = msgFactory();
  // p = (800 + 100) / 1000 = 0.90 >= 0.75; tail = last 4 turns (turn_index >= 6)
  const msgs = [
    msg("user", 0),
    msg("tool-result", 0, { bytes: 5000 }),
    msg("tool-result", 1, { bytes: 5000 }),
    msg("assistant", 2),
    msg("tool-result", 8, { bytes: 5000 }), // inside pinned tail → kept
  ];
  const d = decide(U(800), 10, BUDGET, msgs);
  assert.equal(d.verdict, "compact");
  assert.equal(d.strategy, "summarise");
  assert.equal(d.reason, "pressure-tool-results");
  assert.deepEqual(d.ranges, [{ start: 1, end: 3, event_log_span: { first: 2, last: 5 } }]);
});

test("step 3: small tool-result freeing extends to old assistant messages", () => {
  const msg = msgFactory();
  // One tiny tool-result (<20% of bytes) + one old assistant msg (age >= 6).
  const msgs = [
    msg("tool-result", 0, { bytes: 10 }), // tiny
    msg("assistant", 1, { bytes: 5000 }), // age = 19 - 1 = 18 >= 6
    msg("assistant", 18, { bytes: 5000 }), // age = 1 < 6 → kept
  ];
  const d = decide(U(800), 20, BUDGET, msgs);
  assert.equal(d.verdict, "compact");
  assert.equal(d.reason, "pressure-plus-assistant");
  assert.deepEqual(
    d.ranges.map((r) => [r.start, r.end]),
    [
      [0, 2], // adjacent indices merged
    ],
  );
});

test("step 4: p >= 0.97 → strategy drop, reason pressure-critical", () => {
  const msg = msgFactory();
  const msgs = [msg("tool-result", 0, { bytes: 5000 })];
  const d = decide(U(900, 1000, 100), 10, BUDGET, msgs); // p = 1.0
  assert.equal(d.verdict, "compact");
  assert.equal(d.strategy, "drop");
  assert.equal(d.reason, "pressure-critical");
});

test("step 5: nothing compactible at pressure → block", () => {
  const msg = msgFactory();
  const msgs = [
    msg("user", 0),
    msg("assistant", 9), // inside pinned tail
    msg("tool-result", 9, { pinned: true }), // pinned
  ];
  const d = decide(U(800), 10, BUDGET, msgs);
  assert.deepEqual(d, { version: 1, verdict: "block", reason: "nothing-compactible" });
});

test("config: defaults vs overrides", () => {
  const msg = msgFactory();
  const msgs = [msg("tool-result", 0, { bytes: 5000 })];
  // default ratio 0.75: p = 0.70 → none
  assert.equal(decide(U(600), 10, BUDGET, msgs).verdict, "none");
  // override ratio 0.5: p = 0.70 → compact
  const lowRatio = makeDecide({ ratio: 0.5 });
  assert.equal(lowRatio(U(600), 10, BUDGET, msgs).verdict, "compact");
  // override tail_turns=1: turn_index 8 is outside a 1-turn tail
  const shortTail = makeDecide({ tail_turns: 1 });
  const tailMsgs = [msg("tool-result", 8, { bytes: 5000 })];
  assert.equal(shortTail(U(800), 10, BUDGET, tailMsgs).verdict, "compact");
  // invalid values fall back to defaults
  const bad = makeDecide({ ratio: 9, tail_turns: 0, older_than: -3 });
  assert.equal(bad(U(600), 10, BUDGET, msgs).verdict, "none");
});

test("determinism: same input twice → identical output", () => {
  const msg = msgFactory();
  const msgs = [
    msg("tool-result", 0, { bytes: 5000 }),
    msg("assistant", 1, { bytes: 4000 }),
    msg("tool-result", 2, { bytes: 3000 }),
  ];
  const a = decide(U(800), 20, BUDGET, msgs);
  const b = decide(U(800), 20, BUDGET, msgs);
  assert.deepEqual(a, b);
});

test("purity by construction: index.js has no imports, no I/O, no clock", async () => {
  const src = await readFile(join(HERE, "..", "plugins", "compact-smart", "index.js"), "utf8");
  assert.ok(!/^\s*import\s/m.test(src), "no imports");
  assert.ok(!/\brequire\s*\(/.test(src), "no require");
  assert.ok(!/\bprocess\s*\.|Date\s*\.|Math\s*\.\s*random|fetch\s*\(|node:/.test(src), "no I/O or clock");
});
