// test/memory-tools.test.js — the memory verbs must be registered, callable, and
// gated correctly. A tool the model cannot call is not a feature; a write-capable
// tool that resolves to `allow` is a security defect.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("both memory tools are in the builtin registry", async () => {
  const { builtinTools } = await import("../src/tools/index.js");
  assert.ok(builtinTools.memory_recall, "memory_recall registered");
  assert.ok(builtinTools.memory_remember, "memory_remember registered");
  assert.equal(typeof builtinTools.memory_recall.run, "function");
  assert.equal(typeof builtinTools.memory_remember.run, "function");
});

test("recall asks (untrusted-content gate, v0.7.0 A1); remember asks; unknown denies", async () => {
  const { Policy } = await import("../src/policy.js");
  const { defaultRules } = await import("../src/policy-defaults.js");
  const p = new Policy({ rules: defaultRules(), logPath: "/tmp/mt.jsonl" });

  // v0.7.0 A1 (sibling harness op): memory_recall is ask-gated — recalled
  // memory is untrusted content and must not auto-inject. Adopted 2026-11-12.
  assert.equal(p.evaluate({ tool: "memory_recall", args: {} }).verdict, "ask");
  assert.equal(p.evaluate({ tool: "memory_remember", args: {} }).verdict, "ask");
  assert.equal(p.evaluate({ tool: "not_a_tool", args: {} }).verdict, "deny");
});

test("remember then recall round-trips through the tool interface", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ac-mt-"));
  const ctx = { memoryPath: join(cwd, "m.jsonl") };
  const { builtinTools } = await import("../src/tools/index.js");

  const w = await builtinTools.memory_remember.run(
    { text: "the harness ships zero npm dependencies", scope: "harness", tags: ["design"] },
    ctx,
  );
  assert.equal(w.ok, true);

  const r = await builtinTools.memory_recall.run({ query: "zero npm" }, ctx);
  assert.equal(r.count, 1);
  assert.match(r.output, /zero npm dependencies/);
  await rm(cwd, { recursive: true, force: true });
});

test("recall on an empty store is a clean empty result, not an error", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ac-mt2-"));
  const { builtinTools } = await import("../src/tools/index.js");
  const r = await builtinTools.memory_recall.run({ query: "anything" }, { memoryPath: join(cwd, "none.jsonl") });
  assert.equal(r.ok, true);
  assert.equal(r.count, 0);
  await rm(cwd, { recursive: true, force: true });
});

test("write and edit tools report a checkpoint id in their result", async () => {
  const { mkdir } = await import("node:fs/promises");
  const cwd = await mkdtemp(join(tmpdir(), "ac-cp-tool-"));
  const ctx = { cwd, checkpointRoot: join(cwd, ".cp") };
  const { builtinTools } = await import("../src/tools/index.js");

  // seed a file so the edit has something to replace
  await builtinTools.write.run({ path: "f.txt", content: "original text" }, ctx);
  const e = await builtinTools.edit.run({ path: "f.txt", oldString: "original", newString: "changed" }, ctx);

  assert.equal(e.ok, true);
  assert.ok(e.checkpoint, "edit result carries a checkpoint reference");
  assert.notEqual(e.checkpoint, null);
  await rm(cwd, { recursive: true, force: true });
});
