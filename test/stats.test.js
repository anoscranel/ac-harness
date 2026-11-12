// test/stats.test.js — v0.5.0 H6: the pure stats report. Runs against a
// FRESH session log (hand-counted in-test) + edge cases: unknown event
// types ignored, empty log → zeros, golden-log smoke via the CLI shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport, formatReport } from "../src/stats.js";
import { EventLog, readAll } from "../src/events.js";
import { Policy } from "../src/policy.js";
import { defaultRules } from "../src/policy-defaults.js";
import { createRegistry } from "../src/tools/index.js";
import echo from "../src/providers/echo.js";
import { decide } from "../src/context.js";
import { createLoop } from "../src/loop.js";

test("H6: fresh session log → hand-counted report", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h6-"));
  try {
    const lp = join(dir, "ev.jsonl");
    const log = await EventLog.open(lp);
    const policy = new Policy({ rules: defaultRules(), logPath: lp });
    const loop = createLoop({
      provider: echo,
      tools: createRegistry(),
      policy,
      log,
      decide,
      askResolver: async () => "allow",
      config: { session: "h6" },
    });
    // one plain turn + one tool turn (read on a temp file)
    const f = join(dir, "note.txt");
    await writeFile(f, "hello stats", "utf8");
    await loop.start("plain turn");
    await loop.start(`tool:read {"path":${JSON.stringify(f)}}`);
    await loop.end();

    const events = await readAll(lp);
    const r = buildReport(events);
    // hand count from the event shape: 2 turns; per turn.provider.response
    // input/output = char counts of the messages; read proposed+result once.
    const responses = log.events.filter((e) => e.type === "turn.provider.response");
    const expectedInput = responses.reduce((n, e) => n + (e.data.input_tokens ?? 0), 0);
    const expectedOutput = responses.reduce((n, e) => n + (e.data.output_tokens ?? 0), 0);
    assert.equal(r.turns, 2);
    assert.equal(r.tokens.input, expectedInput);
    assert.equal(r.tokens.output, expectedOutput);
    assert.equal(r.tools.read.calls, 1);
    assert.ok(r.tools.read.total_ms >= 0);
    assert.equal(r.compactions, 0);
    assert.equal(r.asks, 0);
    assert.ok(r.errors.length === 0);
    assert.ok(r.span.seconds > 0);
    // printable form carries the essentials
    const text = formatReport(r);
    assert.match(text, /turns: 2/);
    assert.match(text, /read: 1 calls/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("H6: unknown event types ignored, not fatal; empty log → zeros", () => {
  const r = buildReport([
    { seq: 0, ts: 1, type: "completely.new.event", actor: "harness", data: { weird: true } },
    { seq: 1, ts: 2, type: "turn.start", actor: "harness", data: { turn: 1, input: "x" } },
  ]);
  assert.equal(r.turns, 1); // unknown line skipped without throwing
  const empty = buildReport([]);
  assert.equal(empty.turns, 0);
  assert.equal(empty.tokens.input, 0);
  assert.deepEqual(empty.tools, {});
  assert.equal(empty.span.first_ts, null);
  assert.equal(empty.span.seconds, 0);
  // non-array input never throws
  const nada = buildReport(null);
  assert.equal(nada.turns, 0);
});

test("H6: session.error + policy errors + estimate flag surface in the report", () => {
  const r = buildReport([
    { seq: 0, ts: 10, type: "session.error", actor: "harness", data: { message: "boom", code: "internal" } },
    { seq: 1, ts: 20, type: "usage.estimated", actor: "harness", data: { chars: 8, estimate: "chars/4", estimate_flag: true } },
    { seq: 2, ts: 30, type: "policy.ask.resolved", actor: "policy", data: { call_id: "x", verdict: "allow", resolved_by: "client", timeout_ms: 30000 } },
  ]);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].code, "internal");
  assert.equal(r.tokens.estimated, true);
  assert.equal(r.asks, 1);
  assert.equal(r.span.seconds, 20);
});

test("H6: cli stats subcommand runs on a fresh log (end-to-end)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h6c-"));
  try {
    const lp = join(dir, "ev.jsonl");
    const log = await EventLog.open(lp);
    const policy = new Policy({ rules: defaultRules(), logPath: lp });
    const loop = createLoop({
      provider: echo,
      tools: createRegistry(),
      policy,
      log,
      decide,
      askResolver: async () => "allow",
      config: { session: "h6c" },
    });
    await loop.start("x");
    await loop.end();
    const { execFileSync } = await import("node:child_process");
    const root = new URL("..", import.meta.url).pathname;
    const out = execFileSync(process.execPath, [join(root, "src", "cli.js"), "stats", lp], { encoding: "utf8" });
    assert.match(out, /turns: 1/);
    assert.match(out, /tokens: input/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
