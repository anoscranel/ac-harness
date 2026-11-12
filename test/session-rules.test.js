// test/session-rules.test.js — v0.6.0 SR1: session-scoped ask-consent rules.
// Written RED first (the addSessionRule API does not exist yet); red evidence
// recorded in findings/deviations.md §118.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------- pure policy: session rules live in memory, never widen the pin ---
test("SR1 red/green: an allow session rule short-circuits the next ask", async () => {
  const { Policy, defaultRules } = await import("../src/policy.js");
  const dr = (await import("../src/policy-defaults.js")).defaultRules();
  const p = new Policy({ rules: dr, logPath: "/tmp/sr1-logs/ev.jsonl" });
  // bash is an ask under the defaults → an ask now
  const before = p.evaluate({ tool: "bash", args: { command: "echo hi" } });
  assert.equal(before.verdict, "ask", "baseline: bash asks");
  // adding a session allow rule for bash flips it to allow
  assert.equal(typeof p.addSessionRule, "function", "addSessionRule exists (SR1)");
  p.addSessionRule({ tool: "bash" });
  const after = p.evaluate({ tool: "bash", args: { command: "echo hi" } });
  assert.equal(after.verdict, "allow", "session rule short-circuits the ask");
  assert.match(after.rule_path, /^session:/);
  // still ask for a DIFFERENT tool not covered (e.g. an mcp.* with no defaults)
  const other = p.evaluate({ tool: "totally.unknown.tool", args: {} });
  assert.equal(other.verdict, "deny", "other tools unaffected (zero-match deny)");
});

test("SR1: session rules can NEVER widen the pinned log-path deny", async () => {
  const { Policy } = await import("../src/policy.js");
  const dr = (await import("../src/policy-defaults.js")).defaultRules();
  const logPath = "/tmp/sr1-logs/ev.jsonl";
  const p = new Policy({ rules: dr, logPath });
  // allow-everything session rule
  p.addSessionRule({ tool: "*" });
  // a write INTO the log dir stays denied (pinned first, always)
  const w = p.evaluate({ tool: "write", args: { path: "/tmp/sr1-logs/ev.jsonl", content: "x" } });
  assert.equal(w.verdict, "deny");
  assert.equal(w.rule_path, "pinned.deny_log_path");
  assert.equal(w.violation.kind, "log-path-write");
  // bash touching the log path likewise
  const b = p.evaluate({ tool: "bash", args: { command: "echo x >> /tmp/sr1-logs/ev.jsonl" } });
  assert.equal(b.verdict, "deny");
  assert.equal(b.rule_path, "pinned.deny_log_path");
});

test("SR1: deny session rules rank over allow; clearSessionRules empties", async () => {
  const { Policy } = await import("../src/policy.js");
  const dr = (await import("../src/policy-defaults.js")).defaultRules();
  const p = new Policy({ rules: dr, logPath: "/tmp/sr1-logs/ev.jsonl" });
  p.addSessionRule({ tool: "bash" }, "allow");
  p.addSessionRule({ tool: "bash" }, "deny");
  const v = p.evaluate({ tool: "bash", args: { command: "ls" } });
  assert.equal(v.verdict, "deny", "deny > allow among session rules");
  assert.equal(typeof p.clearSessionRules, "function", "clearSessionRules exists");
  const n = p.clearSessionRules();
  assert.ok(n >= 2, "cleared the rules");
  const back = p.evaluate({ tool: "bash", args: { command: "ls" } });
  assert.equal(back.verdict, "ask", "back to the baseline ask");
});

test("SR1: session rules never persist — no fs access, listSessionRules is the view", async () => {
  const { Policy } = await import("../src/policy.js");
  const dr = (await import("../src/policy-defaults.js")).defaultRules();
  const p = new Policy({ rules: dr, logPath: "/tmp/sr1-logs/ev.jsonl" });
  p.addSessionRule({ tool: "grep" });
  const view = p.listSessionRules();
  assert.equal(view.length, 1);
  assert.deepEqual(view[0].match, { tool: "grep" });
  // /policy visibility is this same list — and the policy object exposes NO
  // serialization of session rules into rules (the static set is untouched)
  assert.ok(!p.rules.some((r) => String(r.id).startsWith("session:")));
});

// ---------- the loop consults them: the second identical bash does not ask ---
test("SR1 loop: after an always-answer, the next identical call runs with NO ask", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sr1-"));
  try {
    const { EventLog } = await import("../src/events.js");
    const { Policy } = await import("../src/policy.js");
    const { defaultRules } = await import("../src/policy-defaults.js");
    const { createRegistry } = await import("../src/tools/index.js");
    const echo = (await import("../src/providers/echo.js")).default;
    const { decide } = await import("../src/context.js");
    const { createLoop } = await import("../src/loop.js");
    const lp = join(dir, "ev.jsonl");
    const log = await EventLog.open(lp);
    const policy = new Policy({ rules: defaultRules(), logPath: lp });
    let asked = 0;
    const askResolver = async (ask) => {
      asked += 1;
      policy.addSessionRule({ tool: ask.tool }); // the surface's "always"
      return "allow";
    };
    const loop = createLoop({
      provider: echo,
      tools: createRegistry(),
      policy,
      log,
      decide,
      askResolver,
      config: { session: "sr1" },
    });
    await loop.start(`tool:bash {"command":"echo one"}`);
    await loop.start(`tool:bash {"command":"echo one"}`);
    await loop.end();
    assert.equal(asked, 1, "only the FIRST bash asked; the second was allowed by the session rule");
    const results = log.events.filter((e) => e.type === "tool.result" && e.data.error === "policy-denied");
    assert.equal(results.length, 0, "both calls ran");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- SR1 surfaces: ask.js onAlways + cli banner contract ----------
test("SR1 tui: the (a) answer fires onAlways with the ask payload and still allows", async () => {
  const { createAsk } = await import("../src/tui/ask.js");
  const alwaysSaw = [];
  let keyHandler = null;
  const ask = createAsk({
    showBanner: () => {},
    clearBanner: () => {},
    setKeyHandler: (h) => { keyHandler = h; },
    onAlways: (a) => { alwaysSaw.push(a); },
  });
  const p = ask.resolver({ call_id: "c1", tool: "bash", args: { command: "ls" } });
  keyHandler("a");
  assert.equal(await p, "allow");
  assert.equal(alwaysSaw.length, 1);
  assert.equal(alwaysSaw[0].tool, "bash", "the surface received the ask payload");
});

test("SR1 tui: y/n answers do NOT fire onAlways (only always does)", async () => {
  const { createAsk } = await import("../src/tui/ask.js");
  const alwaysSaw = [];
  let keyHandler = null;
  const ask = createAsk({
    showBanner: () => {},
    clearBanner: () => {},
    setKeyHandler: (h) => { keyHandler = h; },
    onAlways: (a) => { alwaysSaw.push(a); },
  });
  const p = ask.resolver({ call_id: "c1", tool: "bash", args: {} });
  keyHandler("y");
  assert.equal(await p, "allow");
  const p2 = ask.resolver({ call_id: "c2", tool: "bash", args: {} });
  keyHandler?.("n"); // plain no — also no rule
  await p2;
  assert.equal(alwaysSaw.length, 0, "no rule written for plain yes/no");
});

test("SR1 policy: rule path cited as session:N; /policy view mirrors the set", async () => {
  const { Policy } = await import("../src/policy.js");
  const dr = (await import("../src/policy-defaults.js")).defaultRules();
  const p = new Policy({ rules: dr, logPath: "/tmp/sr1-logs/ev.jsonl" });
  const id = p.addSessionRule({ tool: "grep" });
  assert.match(id, /^session:1$/);
  const v = p.evaluate({ tool: "grep", args: { pattern: "x" } });
  assert.equal(v.verdict, "allow");
  assert.equal(v.rule_path, "session:1");
});
