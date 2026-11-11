// test/events.conformance.test.js — the W1↔W2 interface contract.
// Loads fixtures/events.v1.jsonl (byte-identical copy of the desk fixture),
// rebuilds every event through src/events.js emitters, and asserts canonical
// equality (specs/invariants.md §1, §6).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVENT_TYPES,
  EventLog,
  buildEvent,
  canonicalize,
  readAll,
  sha256,
} from "../src/events.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, "..", "fixtures", "events.v1.jsonl");

async function loadFixture() {
  const raw = await readFile(FIXTURE_PATH, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

test("fixture covers every v1 event type exactly", async () => {
  const fixture = await loadFixture();
  const seen = new Set(fixture.map((e) => e.type));
  for (const t of EVENT_TYPES) {
    // policy.error, session.error and session.branch (added in repair-2, F9)
    // are harness-failure/branch events with no golden fixture line;
    // everything else MUST appear (invariants §6).
    if (t === "policy.error" || t === "session.error" || t === "session.branch") continue;
    assert.ok(seen.has(t), `fixture is missing event type ${t}`);
  }
});

test("every fixture event rebuilds through events.js to canonical equality", async () => {
  const fixture = await loadFixture();
  const rebuilt = fixture.map((ev) => {
    const built = buildEvent(ev.type, ev.actor, ev.data);
    // Reassemble the envelope in the fixed order; ts is volatile and stripped
    // by canonicalize, so its value here is irrelevant.
    return { seq: ev.seq, ts: 0, type: built.type, actor: built.actor, data: built.data };
  });
  const expected = canonicalize(fixture);
  const actual = canonicalize(rebuilt);
  assert.equal(actual, expected);
  assert.equal(sha256(actual), sha256(expected));
});

test("canonicalize strips ts and every duration_ms recursively", () => {
  const events = [
    {
      seq: 0,
      ts: 1771670400.014,
      type: "tool.result",
      actor: "tool",
      data: {
        call_id: "c1",
        ok: true,
        bytes: 12,
        duration_ms: 2,
        sha256: "b5bb",
        nested: { duration_ms: 99, list: [{ duration_ms: 1, keep: "yes" }] },
      },
    },
  ];
  const canonical = canonicalize(events);
  assert.ok(!canonical.includes("duration_ms"), "duration_ms must be stripped");
  assert.ok(!canonical.includes("1771670400"), "ts must be stripped");
  assert.ok(canonical.includes('"keep":"yes"'));
});

test("EventLog appends are awaited, gapless, and round-trip canonically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-events-"));
  try {
    const path = join(dir, "events.jsonl");
    const log = await EventLog.open(path);
    await log.appendEvent("session.start", "harness", {
      harness_version: "0.1.0",
      session: "t",
      config_sha: "x",
    });
    // Concurrent appends must serialize: seq gapless, lines intact.
    await Promise.all([
      log.appendEvent("turn.start", "harness", { turn: 1, input: "a" }),
      log.appendEvent("turn.start", "harness", { turn: 2, input: "b" }),
      log.appendEvent("turn.start", "harness", { turn: 3, input: "c" }),
    ]);
    const disk = await readAll(path);
    assert.equal(disk.length, 4);
    assert.deepEqual(disk.map((e) => e.seq), [0, 1, 2, 3]);
    assert.equal(canonicalize(disk), log.canonical());
    // Resume: seq continues after the last recorded event.
    const reopened = await EventLog.open(path);
    assert.equal(reopened.seq, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildEvent rejects unknown types and actors", () => {
  assert.throws(() => buildEvent("nope", "harness", {}), /unknown event type/);
  assert.throws(() => buildEvent("turn.start", "nobody", {}), /unknown actor/);
});
