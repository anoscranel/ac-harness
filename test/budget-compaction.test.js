// test/budget-compaction.test.js — v0.5.0 H1 (budget enforcement) + H2
// (real extractive summariser). Written RED first per the card; the red
// output is recorded in findings/deviations.md §109–110.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCompactionToMessages } from "../src/loop.js";
import { EventLog } from "../src/events.js";
import { Policy } from "../src/policy.js";
import { defaultRules } from "../src/policy-defaults.js";
import { createRegistry } from "../src/tools/index.js";
import echo from "../src/providers/echo.js";
import { decide } from "../src/context.js";
import { createLoop } from "../src/loop.js";

function bigProvider({ perTurnTokens = 15, finish = "stop", tool_calls = null } = {}) {
  return {
    id: "big",
    model: "big",
    async *stream(request) {
      yield { delta: "x".repeat(perTurnTokens), done: false };
      yield {
        done: true,
        finish,
        usage: { input_tokens: perTurnTokens, cached_tokens: 0, output_tokens: perTurnTokens },
        estimate: false,
        chars: perTurnTokens * 2,
        ...(tool_calls ? { tool_calls } : {}),
      };
    },
  };
}

async function makeLoop(logPath, { provider, config } = {}) {
  const log = await EventLog.open(logPath);
  const policy = new Policy({ rules: defaultRules(), logPath });
  const loop = createLoop({
    provider,
    tools: createRegistry(),
    policy,
    log,
    decide,
    askResolver: async () => "allow",
    config: { session: "v050", ...(config ?? {}) },
  });
  return { loop, log };
}

// ---------- H1: budget enforcement ----------
test("H1: warn at the fraction, error+halt at the cap, session usable after", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h1-"));
  try {
    const lp = join(dir, "ev.jsonl");
    // per turn: input 15 + output 15 = 30 accumulated per turn.
    // max_session_tokens 20 → warn_fraction 0.9 → warn at 18, cap at 20.
    const { loop, log } = await makeLoop(lp, {
      provider: bigProvider({ perTurnTokens: 15 }),
      config: { budget: { max_session_tokens: 20, warn_fraction: 0.9 } },
    });
    // turn 1: 30 tokens accumulated — crosses warn (18) AND cap (20).
    const r1 = await loop.start("one");
    const warns = log.events.filter((e) => e.type === "session.warn" && e.data.kind === "budget");
    assert.ok(warns.length === 1, `exactly one budget warn (got ${warns.length})`);
    assert.equal(warns[0].data.used, 30);
    assert.equal(warns[0].data.cap, 20);
    assert.ok(Math.abs(warns[0].data.fraction - 1.5) < 1e-9, "fraction = used/cap");
    const budgetErr = log.events.find((e) => e.type === "session.error" && e.data.code === "budget");
    assert.ok(budgetErr, "session.error code:budget at the cap");
    assert.equal(budgetErr.data.used, 30);
    assert.equal(budgetErr.data.cap, 20);
    const ends = log.events.filter((e) => e.type === "turn.end");
    assert.ok(ends.length >= 1);
    assert.equal(ends[ends.length - 1].data.reason, "budget", "turn ended with reason budget");
    assert.ok(r1.aborted !== true || ends.at(-1).data.reason === "budget");
    // session usable after: a follow-up turn still runs (and still errors on
    // budget — over cap — but the LOOP is not bricked: turn.start and
    // turn.end appear again)
    await loop.start("two");
    const starts = log.events.filter((e) => e.type === "turn.start");
    assert.equal(starts.length, 2, "second turn ran");
    assert.ok(log.events.filter((e) => e.type === "turn.end").length === 2);
    await loop.end();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("H1: warn fires ONCE per session even across multiple crossings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h1b-"));
  try {
    const lp = join(dir, "ev.jsonl");
    // 8 per turn; warn at 0.9*100=90; cap 100. Turn1: 16 (no warn), turns
    // 2..3 cross 90 → warn once; still under cap.
    const { loop, log } = await makeLoop(lp, {
      provider: bigProvider({ perTurnTokens: 8 }),
      config: { budget: { max_session_tokens: 100, warn_fraction: 0.9 } },
    });
    await loop.start("one"); // 16
    await loop.start("two"); // 32
    await loop.start("three"); // 48 … none cross 90 yet
    for (let i = 0; i < 3; i++) await loop.start(`more-${i}`); // 96 → warn
    await loop.start("seven"); // 112 → cap → budget end
    const warns = log.events.filter((e) => e.type === "session.warn" && e.data.kind === "budget");
    assert.equal(warns.length, 1, "one warn per session (flag-guarded)");
    assert.ok(log.events.some((e) => e.type === "session.error" && e.data.code === "budget"));
    await loop.end();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("H1: budget 0 or absent = disabled (never warns, never halts)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h1c-"));
  try {
    // absent
    const lp1 = join(dir, "a.jsonl");
    const a = await makeLoop(lp1, { provider: bigProvider({ perTurnTokens: 60 }) });
    await a.loop.start("x");
    await a.loop.end();
    assert.equal(a.log.events.filter((e) => e.type === "session.warn").length, 0);
    assert.ok(!a.log.events.some((e) => e.type === "session.error" && e.data.code === "budget"));
    // explicit 0
    const lp2 = join(dir, "b.jsonl");
    const b = await makeLoop(lp2, {
      provider: bigProvider({ perTurnTokens: 60 }),
      config: { budget: { max_session_tokens: 0, warn_fraction: 0.9 } },
    });
    await b.loop.start("x");
    await b.loop.end();
    assert.equal(b.log.events.filter((e) => e.type === "session.warn").length, 0);
    assert.ok(!b.log.events.some((e) => e.type === "session.error" && e.data.code === "budget"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- H2: extractive summariser ----------
test("H2: summarise keeps head, tail, error lines, marker — run/resume byte-identical", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h2-"));
  try {
    // 5 KB tool output with an error line in the middle (card acceptance shape)
    const head = "START-OF-OUTPUT ".repeat(10); // 150 chars
    const middle = "filler line\n".repeat(400);
    const errLine = "ValueError: something failed mid-run\n";
    const tail = " END-OF-OUTPUT".repeat(10);
    const content = head + "\n" + middle + errLine + middle + tail;
    assert.ok(content.length > 5_000, `5KB fixture (got ${content.length})`);

    const { applyCompactionToMessages } = await import("../src/loop.js");
    // Same content, applier applied DIRECTLY (ranges don't need to match the
    // loop's — we pin the summariser's output shape here, and loop/resume
    // equality separately below).
    const range = [{ start: 0, end: 1, event_log_span: { first: 3, last: 7 } }];

    const runMsgs = [{ role: "tool", kind: "tool-result", content }];
    applyCompactionToMessages(runMsgs, range, "summarise");
    const out = runMsgs[0].content;
    assert.ok(out.length <= 600, `≤600 chars (got ${out.length})`);
    assert.ok(out.startsWith(head.slice(0, 200)), "head kept");
    assert.ok(out.includes(tail.slice(-200)), "tail kept");
    assert.ok(out.includes(errLine.trim()), "error line kept");
    assert.match(out, /<compacted: \d+ bytes \u2192 \d+ chars; events 3\.\.7; re-read with read\(offset,limit\) or replay>/);

    // deterministic: same input twice → identical string
    const runMsgsB = [{ role: "tool", kind: "tool-result", content }];
    applyCompactionToMessages(runMsgsB, range, "summarise");
    assert.equal(runMsgsB[0].content, out, "deterministic");

    // RESUME path equality: run a REAL loop session that compacts, resume it,
    // and assert the resumed tool-result content is byte-identical to the
    // direct applier output for the same recorded content. The resume path
    // replays compaction.applied through the SAME shared applier.
    const lp = join(dir, "ev.jsonl");
    const stubDecide = (snapshot, turns, budget, metas) => {
      // Mechanics-only stub (the real decide's pinned-tail-4 rule means a
      // 2-turn session never compacts; we are testing the applier here, not
      // the trigger): target every tool result once there are ≥2 turns.
      const targets = metas
        .map((m, i) => ({ m, i }))
        .filter(({ m }) => m.kind === "tool-result")
        .map(({ i }) => i);
      if (targets.length === 0 || turns < 2) return { version: 1, verdict: "none" };
      const ranges = [{
        start: targets[0],
        end: targets[targets.length - 1] + 1,
        event_log_span: { first: 3, last: 7 },
      }];
      return { version: 1, verdict: "compact", ranges, strategy: "summarise", reason: "context-limit" };
    };
    const { EventLog } = await import("../src/events.js");
    const { Policy } = await import("../src/policy.js");
    const { defaultRules } = await import("../src/policy-defaults.js");
    const { createRegistry } = await import("../src/tools/index.js");
    const echo = (await import("../src/providers/echo.js")).default;
    const { createLoop } = await import("../src/loop.js");
    log2 = await EventLog.open(lp);
    const loop2 = createLoop({
      provider: echo,
      tools: createRegistry(),
      policy: new Policy({ rules: defaultRules(), logPath: lp }),
      log: log2,
      decide: stubDecide,
      askResolver: async () => "allow",
      config: { session: "v050-h2" },
    });
    const target = join(dir, "big.txt");
    await writeFile(target, content, "utf8");
    await loop2.start(`tool:read {"path":${JSON.stringify(target)}}`);
    await loop2.start("second turn"); // compaction fires at this boundary
    await loop2.end();
    const loopCompacted = loop2.state.messages.find((m) => m.role === "tool" && /<compacted:/.test(m.content ?? ""));
    assert.ok(loopCompacted, "run-path loop compacted the tool result");
    assert.ok(loopCompacted.content.length <= 600, `loop output ≤600 (got ${loopCompacted.content.length})`);
    assert.ok(loopCompacted.content.includes("ValueError: something failed mid-run"), "loop output keeps the error line");

    // resume: a fresh loop re-reads the log and replays compaction.applied
    const reopened = await EventLog.open(lp);
    const loop3 = createLoop({
      provider: echo,
      tools: createRegistry(),
      policy: new Policy({ rules: defaultRules(), logPath: lp }),
      log: reopened,
      decide: stubDecide,
      askResolver: async () => "allow",
      config: { session: "v050-h2r" },
    });
    await loop3.resume(Number.MAX_SAFE_INTEGER);
    const resumed = loop3.state.messages.find((m) => m.role === "tool" && /<compacted:/.test(m.content ?? ""));
    assert.ok(resumed, "resume rebuilt the compacted content");
    assert.equal(resumed.content, loopCompacted.content, "resume-path == run-path (byte-identical)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
var log2;
test("H2: drop strategy keeps today's lossy marker", async () => {
  // the drop marker is unchanged (explicit loss); pin the shape
  const { applyCompactionToMessages } = await import("../src/loop.js");
  const msgs = [
    { role: "tool", kind: "tool-result", content: "whatever", call_id: "c1" },
  ];
  applyCompactionToMessages(msgs, [{ start: 0, end: 1, event_log_span: { first: 1, last: 2 } }], "drop");
  assert.match(msgs[0].content, /^\[dropped tool-result; events 1\.\.2\]$/);
});

test("H2: summarise caps error lines at 5 and is byte-stable (large fixture, per card acceptance)", async () => {
  const { applyCompactionToMessages } = await import("../src/loop.js");
  // LARGE fixture: compaction's real case. 9 error lines spread through
  // 6 KB of filler so head/tail do NOT carry them; the errors section must
  // appear with exactly 5 (the cap) and the output ≤600 chars.
  const mk = (n) => {
    const filler = ("filler data line for compaction testing\n").repeat(120);
    const errs = Array.from({ length: n }, (_, i) => `RuntimeError${i}: failure number ${i}`).join("\n");
    return { role: "tool", kind: "tool-result", content: "HEAD\n" + filler + errs + "\n" + filler + "TAIL" };
  };
  const msgs = [mk(9)];
  const content0 = msgs[0].content;
  assert.ok(content0.length > 5_000, "large fixture (card's real case)");
  applyCompactionToMessages(msgs, [{ start: 0, end: 1, event_log_span: { first: 0, last: 1 } }], "summarise");
  const out = msgs[0].content;
  assert.ok(out.length <= 600, `≤600 chars (got ${out.length})`);
  const errsSection = /\[errors]\n([^\n]*(?:\n(?!\[|<)[^\n]*)*)/.exec(out);
  assert.ok(errsSection, "an [errors] section exists");
  const errCount = (errsSection[1].match(/^\s*RuntimeError\d/gm) ?? []).length;
  // capped at 5 AND ≥1 (the head/tail+marker are fixed costs ≈500 chars, so
  // 5 long error lines may not fit inside 600 — the cap is an upper bound).
  assert.ok(errCount >= 1 && errCount <= 5, `errors section within 1..5 (got ${errCount})`);
  // determinism: identical input → identical string
  const msgs2 = [mk(9)];
  applyCompactionToMessages(msgs2, [{ start: 0, end: 1, event_log_span: { first: 0, last: 1 } }], "summarise");
  assert.equal(msgs2[0].content, out, "deterministic");
});

test("H2: short error lines fit all 5 within the 600 budget", async () => {
  const { applyCompactionToMessages } = await import("../src/loop.js");
  const filler = ("filler data line for compaction testing\n").repeat(120);
  const errs = Array.from({ length: 9 }, (_, i) => `ValueError:${i}`).join("\n");
  const msgs = [{ role: "tool", kind: "tool-result", content: "HEAD\n" + filler + errs + "\n" + filler + "TAIL" }];
  applyCompactionToMessages(msgs, [{ start: 0, end: 1, event_log_span: { first: 0, last: 1 } }], "summarise");
  const out = msgs[0].content;
  assert.ok(out.length <= 600, `≤600 (got ${out.length})`);
  const sec = /\[errors]\n([^\n]*(?:\n(?!\[|<)[^\n]*)*)/.exec(out);
  assert.ok(sec, "errors section present");
  const n = (sec[1].match(/^\s*ValueError:\d/gm) ?? []).length;
  assert.equal(n, 5, "all five caps fit when lines are short");
  // determinism
  const msgs2 = [{ role: "tool", kind: "tool-result", content: "HEAD\n" + filler + errs + "\n" + filler + "TAIL" }];
  applyCompactionToMessages(msgs2, [{ start: 0, end: 1, event_log_span: { first: 0, last: 1 } }], "summarise");
  assert.equal(msgs2[0].content, out, "byte-identical on identical input");
});

// ---------- H3: read paging + grep line cap ----------
import { run as readRun } from "../src/tools/read.js";
import { run as grepRun } from "../src/tools/grep.js";
import { probeRg } from "../src/tools/grep.js";

test("H3: read offset/limit returns exactly the window with <lines N..M of T>", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h3-"));
  try {
    // 10k-line file
    const f = join(dir, "ten-k.txt");
    const content = Array.from({ length: 10_000 }, (_, i) => `line-${i + 1}`).join("\n");
    await writeFile(f, content, "utf8");
    const r = await readRun({ path: f, offset: 5000, limit: 10 }, {});
    assert.ok(r.ok);
    const outLines = r.output.trimEnd().split("\n");
    assert.equal(outLines.length, 11, "10 content lines + 1 marker line");
    assert.equal(outLines[0], "line-5000");
    assert.equal(outLines[9], "line-5009");
    assert.match(outLines[10], /^<lines 5000\.\.5009 of 10000>$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("H3: read without paging args on a small file is byte-identical to today", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h3b-"));
  try {
    const f = join(dir, "small.txt");
    await writeFile(f, "hello world\nsecond line", "utf8");
    const r = await readRun({ path: f }, {});
    assert.equal(r.output, "hello world\nsecond line");
    assert.equal(r.bytes, Buffer.byteLength("hello world\nsecond line", "utf8"));
    assert.ok(!("range" in r), "no range on the legacy path");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("H3: grep caps a 5 KB single line at 300 columns + truncated:true", { skip: !probeRg(), timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "h3c-"));
  try {
    const f = join(dir, "minified.txt");
    const longLine = "x".repeat(5_000) + " MAGICTOKEN " + "y".repeat(1_000);
    await writeFile(f, longLine, "utf8");
    const r = await grepRun({ pattern: "MAGICTOKEN", path: f }, {});
    assert.ok(r.ok, "rg found the match");
    assert.ok(r.truncated === true, "truncated flag set");
    // the returned matching line must be cut near the column cap
    const matchLine = r.output.split("\n").find((l) => l.includes("MAGICTOKEN") || l.includes("[Omitted"));
    if (matchLine && matchLine.includes("MAGICTOKEN")) {
      assert.ok(matchLine.length <= 305, `line capped near 300 (got ${matchLine.length})`);
    } else {
      assert.ok(r.output.includes("[Omitted long matching line]"), "rg omitted the long line");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- H4: per-session server dispatch ----------
import { spawn } from "node:child_process";
import { waitFor } from "./helpers-timing.js";

function clientSession(child, lines) {
  // write then collect responses by id
  return new Promise((resolve) => {
    const ids = new Set();
    for (const l of lines) {
      const msg = JSON.parse(l);
      if (msg.id !== undefined) ids.add(msg.id);
    }
    const out = {};
    const onData = (d) => {
      for (const raw of d.toString().split("\n")) {
        if (!raw.trim()) continue;
        try {
          const m = JSON.parse(raw);
          if (m.id !== undefined && ids.has(m.id)) out[m.id] = m;
        } catch { /* partial */ }
      }
      if ([...ids].every((i) => out[i] !== undefined)) {
        child.stdout.off("data", onData);
        resolve(out);
      }
    };
    child.stdout.on("data", onData);
    for (const l of lines) child.stdin.write(l + "\n");
  });
}

function waitMs(ms) { return new Promise((r) => setTimeout(r, ms)); }

test("H4: a blocked prompt on one session does not block another session or session.create", { timeout: 45_000 }, async () => {
  const root = new URL("..", import.meta.url).pathname;
  const logA = join(root, "logs", "h4-A.jsonl");
  const child = spawn(process.execPath, [join(root, "src", "server.js")], { stdio: ["pipe", "pipe", "pipe"] });
  const seen = new Map();
  let childBuf = "";
  child.stdout.on("data", (d) => {
    // v0.10.0 repair: buffer ACROSS chunk boundaries — a JSON line split by
    // a chunk edge used to parse-fail and DROP the ack permanently (seen in
    // a loaded full-suite run: "create A acked" never arrived).
    childBuf += d.toString();
    let nl;
    while ((nl = childBuf.indexOf("\n")) >= 0) {
      const l = childBuf.slice(0, nl).trim();
      childBuf = childBuf.slice(nl + 1);
      if (!l) continue;
      try {
        const m = JSON.parse(l);
        if (m.id !== undefined) seen.set(m.id, m);
      } catch { /* tolerate partial */ }
    }
  });
  const send = (id, method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  try {
    // session A: UNREACHABLE provider (connection-refused → endurance retry
    // loop blocks its prompt chain). Wait for the create ACK before pA so
    // the ordering is deterministic (A is the recorded session from there on).
    send("createA", "session.create", { session: "H4-A", provider: "openai-compat", baseUrl: "https://127.0.0.1:1/v1", model: "m", logPath: logA });
    for (let i = 0; i < 200 && !seen.has("createA"); i++) await waitMs(100);
    assert.ok(seen.has("createA"), "create A acked");
    send("createB", "session.create", { session: "H4-B" });
    for (let i = 0; i < 200 && !seen.has("createB"); i++) await waitMs(100);
    assert.ok(seen.has("createB"), "create B acked");

    // pA blocks (its provider retries against a refused socket). pB and cC
    // are pipelineable ONLY AFTER pA has provably STARTED — v0.7.0 flake-class:
    // the old fixed 100ms nap raced the request landing on A's chain under
    // load. The deterministic signal is A's OWN LOG (logA is ours): once
    // A's turn.start is on disk, pA is inside its turn and blocking.
    send("pA", "session.prompt", { session_id: "H4-A", input: "blocked" });
    const { readAll: readA } = await import("../src/events.js");
    await waitFor(
      async () => {
        try {
          const evs = await readA(logA);
          return evs.some((e) => e.type === "turn.start");
        } catch {
          return false; // log not created yet — keep waiting
        }
      },
      { timeoutMs: 10_000, stepMs: 20, label: "session A's turn.start in its own log" },
    );
    send("pB", "session.prompt", { session_id: "H4-B", input: "free" });
    send("cC", "session.create", { session: "H4-C" });
    const t0 = Date.now();
    while ((!seen.has("pB") || !seen.has("cC")) && Date.now() - t0 < 10_000) await waitMs(50);
    assert.ok(seen.has("pB"), "session B\'s prompt completed while A was blocked (received after " + (Date.now() - t0) + "ms)");
    assert.ok(seen.has("cC"), "session.create C completed during A block");
    assert.equal(seen.get("pB").result.text, "echo: free");
    assert.ok(!seen.has("pA"), "pA itself is (correctly) still blocked");
  } finally {
    child.kill("SIGKILL");
    try { await rm(logA, { force: true }); } catch {}
  }
});

// ---------- H5: per-provider context limit ----------
test("H5: provider.contextLimit reaches decide()'s snapshot; absent → 128000", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h5-"));
  try {
    const { EventLog } = await import("../src/events.js");
    const { Policy } = await import("../src/policy.js");
    const { defaultRules } = await import("../src/policy-defaults.js");
    const { createRegistry } = await import("../src/tools/index.js");
    const echo = (await import("../src/providers/echo.js")).default;
    const { createLoop } = await import("../src/loop.js");
    const seen = [];
    const spyDecide = (snapshot, turns, budget, metas) => {
      seen.push(snapshot.context_limit);
      return { version: 1, verdict: "none" };
    };
    // provider WITH a context limit (plain integer on the provider object —
    // exactly the shape registry.buildFromEnv now produces)
    const limited = { ...echo, contextLimit: 8000 };
    const lp = join(dir, "a.jsonl");
    const log = await EventLog.open(lp);
    const loopA = createLoop({
      provider: limited,
      tools: createRegistry(),
      policy: new Policy({ rules: defaultRules(), logPath: lp }),
      log,
      decide: spyDecide,
      askResolver: async () => "allow",
      config: { session: "h5a" },
    });
    await loopA.start("x");
    assert.equal(seen.at(-1), 8000, "decide saw the provider's 8000");
    // absent → the 128000 default
    const lp2 = join(dir, "b.jsonl");
    const log2 = await EventLog.open(lp2);
    const loopB = createLoop({
      provider: echo,
      tools: createRegistry(),
      policy: new Policy({ rules: defaultRules(), logPath: lp2 }),
      log: log2,
      decide: spyDecide,
      askResolver: async () => "allow",
      config: { session: "h5b" },
    });
    await loopB.start("y");
    assert.equal(seen.at(-1), 128_000, "absent → 128000 default");
    await loopA.end();
    await loopB.end();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("H5: registry round-trips contextLimit (rowOf whitelist + env discovery)", async () => {
  const { listEnvProviders, saveProfiles, loadProfiles } = await import("../src/providers/registry.js");
  // env discovery: HARNESS_PROVIDER_<ID>_CONTEXT_LIMIT
  const rows = listEnvProviders({
    HARNESS_PROVIDER_TINY_BASE_URL: "https://t.test/v1",
    HARNESS_PROVIDER_TINY_MODEL: "m",
    HARNESS_PROVIDER_TINY_CONTEXT_LIMIT: "8000",
    B_B_URL: "", // noise
  });
  const tiny = rows.find((r) => r.id === "tiny");
  assert.ok(tiny, "env row discovered");
  assert.equal(tiny.contextLimit, 8000);
  // profiles round-trip through the whitelist
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const dir2 = await mkdtemp(join(tmpdir(), "h5b-"));
  try {
    const f = join(dir2, "providers.config.json");
    await saveProfiles(f, [{ id: "tiny", baseUrl: "https://t.test/v1", model: "m", source: "tui", contextLimit: 8000 }]);
    const raw = await readFile(f, "utf8");
    assert.ok(raw.includes("8000"), "contextLimit persisted");
    const back = await loadProfiles(f);
    assert.equal(back[0].contextLimit, 8000, "round-tripped");
  } finally {
    await rm(dir2, { recursive: true, force: true });
  }
});

test("H5: TUI add/edit form round-trips contextLimit", async () => {
  const { createProviderPanel } = await import("../src/tui/provider-panel.js");
  // add: field 5 accepts an integer and emits it on the profile
  const p = createProviderPanel({ providers: [] });
  p.openPanel();
  p.key("a");
  p.formSubmit("ctx-probe");
  p.formSubmit("https://ctx.test/v1");
  p.formSubmit("m");
  p.formSubmit(""); // apiKeyEnv blank — no key
  assert.equal(p.formField, "contextLimit", "fifth field is contextLimit");
  const bad = p.formSubmit("not-a-number");
  assert.equal(bad.action, "none");
  assert.match(bad.error, /positive integer/);
  p.formSubmit("8000");
  p.formSubmit(""); // inputPerMtok blank (v0.9.0 S1)
  const res = p.formSubmit(""); // outputPerMtok — finalizes
  assert.equal(res.action, "submit");
  assert.equal(res.profile.contextLimit, 8000, "emitted on the profile");
  // blank → field omitted (128k default)
  p.openPanel();
  p.key("a");
  p.formSubmit("ctx-probe2");
  p.formSubmit("https://ctx.test/v1");
  p.formSubmit("m");
  p.formSubmit("");
  p.formSubmit("");
  p.formSubmit(""); // pricing blanks (v0.9.0 S1)
  const res2 = p.formSubmit("");
  assert.equal(res2.action, "submit");
  assert.ok(!("contextLimit" in res2.profile), "blank = no field (default)");
  // edit prefill carries the current value
  const p2 = createProviderPanel({
    providers: [{ id: "tiny", baseUrl: "https://t.test/v1", model: "m", source: "tui", contextLimit: 8000 }],
  });
  p2.openPanel();
  p2.key("\x1b[B"); p2.key("\x1b[B"); // onto tiny
  p2.key("e");
  p2.formSubmit(""); // id locked
  p2.formSubmit("https://t.test/v1");
  p2.formSubmit("m");
  p2.formSubmit("");
  p2.formSubmit("12000"); // edit value
  p2.formSubmit(""); // inputPerMtok blank
  const res3 = p2.formSubmit(""); // outputPerMtok — finalizes (v0.9.0 S1)
  assert.equal(res3.action, "edit");
  assert.equal(res3.profile.contextLimit, 12000, "edited value emitted");
});

test("v0.5.0 desk-fix: compaction decisions without event_log_span must not throw", () => {
  // The compaction-trigger seam is plugin-overridable; a plugin returning a
  // well-formed decision with no event_log_span must degrade, not crash.
  const msgs = [
    { role: "tool", kind: "tool-result", content: "x".repeat(2000) },
    { role: "user", content: "keep me" },
  ];
  assert.doesNotThrow(() => applyCompactionToMessages(msgs, [{ start: 0, end: 1 }], "summarise"));
  assert.match(msgs[0].content, /compacted|events unknown/i);
  assert.equal(msgs[1].content, "keep me");
  assert.doesNotThrow(() => {
    const m2 = [{ role: "tool", kind: "tool-result", content: "y".repeat(2000) }];
    applyCompactionToMessages(m2, [{ start: 0, end: 1 }], "drop");
  });
});
