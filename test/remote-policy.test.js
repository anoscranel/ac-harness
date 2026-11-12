// test/remote-policy.test.js — ship-3 build order 1: the remote-caller
// policy shaping, pure unit tests first (spec §0).
import { test } from "node:test";
import assert from "node:assert/strict";
import { REMOTE_HIDDEN_TOOLS, remoteDecide, remoteToolList, isHiddenFromRemote } from "../src/remote-policy.js";
import { Policy } from "../src/policy.js";
import { defaultRules } from "../src/policy-defaults.js";
import { createRegistry } from "../src/tools/index.js";

test("REMOTE_HIDDEN_TOOLS: delegate + memory_remember, frozen", () => {
  assert.deepEqual([...REMOTE_HIDDEN_TOOLS], ["delegate", "memory_remember"]);
  assert.ok(Object.isFrozen(REMOTE_HIDDEN_TOOLS));
});

test("remoteToolList omits hidden tools; every visible tool has the 3-part shape", () => {
  const list = remoteToolList(createRegistry());
  const names = list.map((t) => t.name);
  assert.ok(!names.includes("delegate"), "delegate not listed");
  assert.ok(!names.includes("memory_remember"), "memory_remember not listed");
  assert.ok(names.includes("read"), "read listed");
  assert.ok(names.includes("memory_recall"), "recall still listed (ask-gated at decide time)");
  for (const t of list) {
    assert.equal(typeof t.name, "string");
    assert.equal(typeof t.description, "string");
    assert.equal(typeof t.inputSchema, "object");
  }
});

test("isHiddenFromRemote matches the frozen set", () => {
  assert.equal(isHiddenFromRemote("delegate"), true);
  assert.equal(isHiddenFromRemote("memory_remember"), true);
  assert.equal(isHiddenFromRemote("read"), false);
});

test("remoteDecide: allow passes through with its rule path", () => {
  const p = new Policy({ rules: defaultRules(), logPath: "/tmp/rp/ev.jsonl" });
  const d = remoteDecide(p, { tool: "read", args: { path: "/tmp/rp/x" } });
  assert.equal(d.verdict, "allow");
  assert.equal(d.rule_path, "defaults.allow_read");
});

test("remoteDecide: ASK maps to deny with the remote reason (the §0 core)", () => {
  const p = new Policy({ rules: defaultRules(), logPath: "/tmp/rp/ev.jsonl" });
  const d = remoteDecide(p, { tool: "bash", args: { command: "ls" } });
  assert.equal(d.verdict, "deny", "ask NEVER runs for a remote caller");
  assert.match(d.reason, /remote callers cannot answer permission prompts/);
  assert.equal(d.rule_path, "defaults.ask_bash");
});

test("remoteDecide: explicit deny keeps the rule path + violation carries through", () => {
  const p = new Policy({ rules: defaultRules(), logPath: "/tmp/rp/logs/ev.jsonl" });
  // pinned log-path deny — applies identically to remote calls
  const d = remoteDecide(p, { tool: "write", args: { path: "/tmp/rp/logs/ev.jsonl", content: "x" } });
  assert.equal(d.verdict, "deny");
  assert.equal(d.rule_path, "pinned.deny_log_path");
  assert.ok(d.violation, "the pinned violation surfaces");
});

test("remoteDecide: a session allow rule from THIS process never reaches remote callers' decisions…", () => {
  // …because remote surfaces never call addSessionRule and never accept one
  // over the wire. The pure function itself is rule-order agnostic; the
  // guarantee is structural (the surfaces don't expose the mechanism). Pin
  // the pure side: session rules, IF one somehow existed, still cannot
  // widen the PINNED deny (loop-switch-style invariant, restated remotely):
  const p = new Policy({ rules: defaultRules(), logPath: "/tmp/rp/logs/ev.jsonl" });
  p.addSessionRule({ tool: "*" }); // hypothetical worst case
  const d = remoteDecide(p, { tool: "write", args: { path: "/tmp/rp/logs/ev.jsonl", content: "x" } });
  assert.equal(d.verdict, "deny");
  assert.equal(d.rule_path, "pinned.deny_log_path");
});
