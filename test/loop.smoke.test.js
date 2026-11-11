// test/loop.smoke.test.js — end-to-end loop against the echo provider:
// reason→act→observe, policy gating, ask-timeout deny, replay determinism.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, canonicalize, readAll, sha256 } from "../src/events.js";
import { Policy } from "../src/policy.js";
import { defaultRules } from "../src/policy-defaults.js";
import { createRegistry } from "../src/tools/index.js";
import echo from "../src/providers/echo.js";
import { decide } from "../src/context.js";
import { createLoop } from "../src/loop.js";

async function makeLoop(dir, { askResolver } = {}) {
  const logPath = join(dir, "events.jsonl");
  const log = await EventLog.open(logPath);
  const policy = new Policy({ rules: defaultRules(), logPath });
  const tools = createRegistry();
  const loop = createLoop({
    provider: echo,
    tools,
    policy,
    log,
    decide,
    askResolver,
    config: { session: "smoke", context_limit: 128_000, output_reserve: 4_096 },
  });
  return { loop, log, logPath };
}

test("echo turn: request → chunks → response, deterministic replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-loop-"));
  try {
    // Run 1
    let { loop, log } = await makeLoop(join(dir, "a"));
    const r1 = await loop.start("hi");
    await loop.end();
    assert.equal(r1.text, "echo: hi");
    const canon1 = log.canonical();

    // Run 2 (fresh log, same input) → identical canonical transcript (DC2).
    const { loop: loop2, log: log2 } = await makeLoop(join(dir, "b"));
    await loop2.start("hi");
    await loop2.end();
    assert.equal(log2.canonical(), canon1);
    assert.equal(sha256(log2.canonical()), sha256(canon1));

    // Event shape sanity
    const types = log.events.map((e) => e.type);
    assert.ok(types.includes("session.start"));
    assert.ok(types.includes("turn.start"));
    assert.ok(types.includes("turn.provider.request"));
    assert.ok(types.includes("turn.provider.chunk"));
    assert.ok(types.includes("turn.provider.response"));
    assert.ok(types.includes("compaction.decided"));
    assert.ok(types.includes("session.end"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tool call: read allowed by default policy; result recorded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-loop-"));
  try {
    const target = join(dir, "x.txt");
    await writeFile(target, "hello world", "utf8");
    const { loop, log } = await makeLoop(dir);
    const res = await loop.start(`tool:read {"path":${JSON.stringify(target)}}`);
    await loop.end();
    assert.ok(res.text.includes("hello world"));
    const proposed = log.events.find((e) => e.type === "tool.proposed");
    const decision = log.events.find((e) => e.type === "policy.decision");
    const result = log.events.find((e) => e.type === "tool.result");
    assert.equal(proposed.data.tool, "read");
    assert.equal(decision.data.verdict, "allow");
    assert.equal(decision.data.rule_path, "defaults.allow_read");
    assert.equal(result.data.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pinned deny: write to the log path is denied and logged as violation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-loop-"));
  try {
    const { loop, log, logPath } = await makeLoop(dir);
    await loop.start(`tool:write {"path":${JSON.stringify(logPath)},"content":"x"}`);
    await loop.end();
    const decision = log.events.find((e) => e.type === "policy.decision");
    const violation = log.events.find((e) => e.type === "policy.violation");
    const result = log.events.find((e) => e.type === "tool.result");
    assert.equal(decision.data.verdict, "deny");
    assert.equal(decision.data.rule_path, "pinned.deny_log_path");
    assert.equal(violation.data.kind, "log-path-write");
    assert.equal(result.data.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ask with no resolver → headless-timeout deny + policy.ask.resolved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-loop-"));
  try {
    const { loop, log } = await makeLoop(dir); // no askResolver
    await loop.start(`tool:bash {"command":"echo hi"}`);
    await loop.end();
    const ask = log.events.find((e) => e.type === "policy.ask.resolved");
    const result = log.events.find((e) => e.type === "tool.result");
    assert.equal(ask.data.verdict, "deny");
    assert.equal(ask.data.resolved_by, "headless-timeout");
    assert.equal(ask.data.timeout_ms, 30_000);
    assert.equal(result.data.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resume rebuilds state from the log (time-travel at event index)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-loop-"));
  try {
    const { loop, log, logPath } = await makeLoop(dir);
    await loop.start("hello");
    await loop.end();
    const total = log.events.length;

    const log2 = await EventLog.open(logPath);
    const policy = new Policy({ rules: defaultRules(), logPath });
    const loop2 = createLoop({
      provider: echo,
      tools: createRegistry(),
      policy,
      log: log2,
      decide,
      config: { session: "smoke" },
    });
    const st = await loop2.resume(total - 1);
    assert.ok(st.messages >= 2); // user + assistant
    assert.equal(st.turns, 1);
    assert.equal(loop2.state.messages[0].content, "hello");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("events() is an AsyncGenerator of the log's own stream", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-loop-"));
  try {
    const { loop, log } = await makeLoop(dir);
    const seen = [];
    const consumer = (async () => {
      for await (const ev of loop.events()) {
        seen.push(ev.type);
        if (ev.type === "session.end") break;
      }
    })();
    await loop.start("hi");
    await loop.end();
    await consumer;
    assert.deepEqual(seen, log.events.map((e) => e.type));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("canonicalize(readAll(path)) equals the in-memory canonical transcript", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-loop-"));
  try {
    const { loop, log, logPath } = await makeLoop(dir);
    await loop.start("hi");
    await loop.end();
    const disk = await readAll(logPath);
    assert.equal(canonicalize(disk), log.canonical());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
