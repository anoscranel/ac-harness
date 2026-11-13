// test/v0120-automation.test.js — S1 run-through-bin exit codes, S2 logs
// search, S3 export determinism. House style: {timeout: 45_000}, real
// subprocess/bin level for S1; scratch dirs for S2/S3.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";

const ROOT = join(new URL("..", import.meta.url).pathname);
const BIN = join(ROOT, "bin", "ac-harness.js");

function runBin(args, { cwd = ROOT, timeout = 40_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: process.env.PATH, HOME: process.env.HOME },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, out, err });
    });
  });
}

// ---------- S1: run through bin ------------------------------------------------
test("S1: `ac-harness run \"hello\"` with echo exits 0 and prints the session summary", { timeout: 45_000 }, async () => {
  const r = await runBin(["run", "hello bin surface"]);
  assert.equal(r.code, 0, `exit 0 (stderr: ${r.err.slice(0, 200)})`);
  const parsed = JSON.parse(r.out);
  assert.ok(parsed.session.startsWith("run-"), "the run-mode summary shape");
  assert.equal(parsed.turns, 1);
  assert.equal(parsed.ok, true);
  // clean the run's log residue
  const { rm: rmf } = await import("node:fs/promises");
  await rmf(parsed.log, { force: true }).catch(() => {});
});

test("S1: a DENIED-ask run uses run-mode's real semantics: deny-and-continue, exit 0, denial recorded", { timeout: 45_000 }, async () => {
  // cli.js's documented contract: exit 1 only on a THROWN run error; an
  // unresolved ask in headless mode DENIES and the turn COMPLETES (the
  // deny-and-continue posture). The denied call is recorded in the log.
  const r = await runBin(["run", "tool:bash {\"command\":\"echo hi\"}"]);
  assert.equal(r.code, 0, `the designed posture (stderr: ${r.err.slice(0, 200)})`);
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.turns, 1);
  // the denial IS in the log — read it back
  const { readAll } = await import("../src/events.js");
  const evs = await readAll(parsed.log);
  assert.ok(evs.some((e) => e.type === "policy.ask.resolved" && e.data.verdict === "deny"), "the ask denied");
  assert.ok(evs.some((e) => e.type === "tool.result" && e.data.ok === false), "the call failed closed");
  const { rm: rmf } = await import("node:fs/promises");
  await rmf(parsed.log, { force: true }).catch(() => {});
});

test("S1: empty prompt exits 2 with the usage line; unknown provider exits 2", { timeout: 45_000 }, async () => {
  // cli.js's real semantics: flags are stripped and the remaining words are
  // the prompt; exit 2 is reserved for USAGE errors — no prompt at all, or an
  // unknown --provider id. (Unknown flags are tolerated and become prompt
  // text; that is the actual contract being mirrored, not invented.)
  const noPrompt = await runBin(["run"]);
  assert.equal(noPrompt.code, 2);
  assert.match(noPrompt.err + noPrompt.out, /usage/);
  const badProvider = await runBin(["run", "--provider", "no-such-provider-x", "hello"]);
  assert.equal(badProvider.code, 2);
  assert.match(badProvider.err, /unknown provider/);
});

test("S1: help lists run in the surface", () => {
  const out = execFileSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
  assert.match(out, /headless one-shot \(exit 0\/1\/2\)/, "run documented with its exit codes");
  assert.match(out, /logs search/, "S2's search documented");
  assert.match(out, /export <log>/, "S3's export documented");
});

// ---------- S2: logs search -----------------------------------------------------
test("S2: search finds a planted marker; --type filters; no matches exits 0; invalid regex exits 2", { timeout: 45_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "v0120s2-"));
  const logsDir = join(dir, "logs");
  await mkdir(logsDir, { recursive: true });
  try {
    const { logsCommand } = await import("../src/logs-cli.js");
    const put = { write: () => {} };
    const { appendFile } = await import("node:fs/promises");
    await appendFile(join(logsDir, "a.jsonl"), JSON.stringify({ seq: 0, ts: 1, type: "session.start", actor: "harness", data: { session: "marker-alpha" } }) + "\n", "utf8");
    await appendFile(join(logsDir, "a.jsonl"), JSON.stringify({ seq: 1, ts: 2, type: "turn.start", actor: "harness", data: { turn: 1, input: "NEEDLE_IN_HAYSTACK" } }) + "\n", "utf8");
    await appendFile(join(logsDir, "a.jsonl"), JSON.stringify({ seq: 2, ts: 3, type: "tool.proposed", actor: "harness", data: { call_id: "x", tool: "read", args: {} } }) + "\n", "utf8");
    await appendFile(join(logsDir, "b.jsonl"), JSON.stringify({ seq: 0, ts: 1, type: "session.start", actor: "harness", data: { session: "marker-beta" } }) + "\n", "utf8");

    const hit = await logsCommand(["search", "NEEDLE"], { stdout: put, logsDir });
    assert.equal(hit.exitCode, 0);
    const hitText = hit.lines.join("\n");
    assert.ok(hitText.includes("a.jsonl"), "names the file");
    assert.ok(hitText.includes("NEEDLE_IN_HAYSTACK"), "prints the human one-liner");
    assert.ok(hitText.includes("seq 1"), "event seq");
    assert.ok(hitText.includes("turn.start"), "type label");

    const typed = await logsCommand(["search", "marker", "--type", "session.start"], { stdout: put, logsDir });
    assert.ok(typed.lines.join("\n").includes("marker-beta"), "--type filter works");
    assert.ok(typed.lines.join("\n").includes("marker-alpha"), "both markers typed");

    const miss = await logsCommand(["search", "zzz-nomatch"], { stdout: put, logsDir });
    assert.equal(miss.exitCode, 0);
    assert.match(miss.lines.join("\n"), /no matches/);

    const bad = await logsCommand(["search", "["], { stdout: put, logsDir });
    assert.equal(bad.exitCode, 2);
    assert.match(bad.lines.join("\n"), /invalid regex/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S2: --tools filters by tool name and --limit caps with the honest cap line", { timeout: 45_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "v0120s2b-"));
  const logsDir = join(dir, "logs");
  await mkdir(logsDir, { recursive: true });
  try {
    const { logsCommand } = await import("../src/logs-cli.js");
    const put = { write: () => {} };
    const lines = [];
    for (let i = 0; i < 10; i++) {
      lines.push(JSON.stringify({ seq: i, ts: i, type: "tool.proposed", actor: "harness", data: { call_id: `c${i}`, tool: "read", args: { path: `/srv/x-${i}` } } }));
    }
    for (let i = 10; i < 14; i++) {
      lines.push(JSON.stringify({ seq: i, ts: i, type: "tool.proposed", actor: "harness", data: { call_id: `c${i}`, tool: "bash", args: { command: "ls" } } }));
    }
    await writeFile(join(logsDir, "many.jsonl"), lines.join("\n") + "\n", "utf8");
    const tools = await logsCommand(["search", "proposed", "--tools", "bash"], { stdout: put, logsDir });
    const ttext = tools.lines.join("\n");
    assert.ok(ttext.includes("bash"), "--tools bash lists bash rows");
    assert.ok(!ttext.includes('read'), "read rows excluded");
    const capped = await logsCommand(["search", "proposed", "--limit", "3"], { stdout: put, logsDir });
    assert.match(capped.lines.join("\n"), /showing first 3 matches \(cap reached/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- S3: export -----------------------------------------------------------
test("S3: export is deterministic (byte-identical twice) with the right content and --out writes", { timeout: 45_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "v0120s3-"));
  try {
    const { exportCommand, buildTranscript } = await import("../src/export-cli.js");
    const events = [
      { seq: 0, ts: 100, type: "session.start", actor: "harness", data: { session: "exp-fixture", harness_version: "0" } },
      { seq: 1, ts: 101, type: "turn.start", actor: "harness", data: { turn: 1, input: "double my words" } },
      { seq: 2, ts: 102, type: "turn.provider.chunk", actor: "provider", data: { delta: "echo: double ", done: false } },
      { seq: 3, ts: 103, type: "turn.provider.chunk", actor: "provider", data: { delta: "my words", done: false } },
      { seq: 4, ts: 104, type: "turn.provider.response", actor: "provider", data: { finish: "stop" } },
      { seq: 5, ts: 105, type: "tool.proposed", actor: "tool", data: { call_id: "c1", tool: "read", args: { path: "/srv/notes/probe.txt" } } },
      { seq: 6, ts: 106, type: "policy.decision", actor: "policy", data: { call_id: "c1", verdict: "allow", rule_path: "defaults.allow_read" } },
      { seq: 7, ts: 107, type: "tool.result", actor: "tool", data: { call_id: "c1", ok: true, duration_ms: 2 } },
      { seq: 8, ts: 108, type: "session.end", actor: "harness", data: { turns: 1 } },
    ];
    const logPath = join(dir, "exp.jsonl");
    await writeFile(logPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

    const a1 = await exportCommand([logPath], { stdout: { write: () => {} } });
    const a2 = await exportCommand([logPath], { stdout: { write: () => {} } });
    assert.equal(a1.exitCode, 0);
    assert.equal(a1.lines[0], a2.lines[0], "byte-identical across two exports");
    const md = a1.lines[0];
    assert.ok(md.includes("# Session exp-fixture"), "the header");
    assert.ok(md.includes("### User"), "user text header");
    assert.ok(md.includes("double my words"), "the user text");
    assert.ok(md.includes("echo: double my words"), "assistant text REASSEMBLED from two chunks");
    assert.ok(md.includes("result: ok 2ms"), "the tool row one-liner");
    assert.ok(md.includes("policy allow [defaults.allow_read]"), "policy decisions inline");
    assert.ok(!md.includes('{"seq"'), "no raw JSON braces in the body");
    // state purity of the pure builder
    assert.equal(buildTranscript(events), buildTranscript(events));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3: --out writes the file and prints the path; a missing log exits 2", { timeout: 45_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "v0120s3b-"));
  try {
    const { exportCommand } = await import("../src/export-cli.js");
    const events = [{ seq: 0, ts: 1, type: "session.start", actor: "harness", data: { session: "out-probe" } }];
    const logPath = join(dir, "o.jsonl");
    await writeFile(logPath, JSON.stringify(events.at(-1)) + "\n", "utf8");
    const sink = [];
    const r = await exportCommand([logPath, "--out", join(dir, "t.md")], { stdout: { write: (s) => sink.push(s) } });
    assert.equal(r.exitCode, 0);
    const { readFile } = await import("node:fs/promises");
    const file = await readFile(join(dir, "t.md"), "utf8");
    assert.ok(file.includes("# Session out-probe"));
    assert.match(sink.join("\n"), /wrote .+t\.md/);
    const miss = await exportCommand([join(dir, "nope.jsonl")], { stdout: { write: () => {} } });
    assert.equal(miss.exitCode, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
