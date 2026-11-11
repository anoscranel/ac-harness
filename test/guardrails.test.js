// test/guardrails.test.js — Tier-B guardrails plugin: manifest conformance,
// pre-tool root gating, post-tool aggregation, on-event counting,
// stats-summary tool, and the verify-gate single-winner override via the
// Part-0 wiring (real plugins dir; compaction-trigger winner is compact-smart).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../src/internal/jsonschema.js";
import { EventLog } from "../src/events.js";
import { loadPlugins, wirePluginHooks } from "../src/plugins/loader.js";
import guardrails from "../plugins/guardrails/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const PLUGINS_DIR = join(REPO, "plugins");

function captureCtx(config = {}) {
  const hooks = new Map();
  const tools = new Map();
  return {
    config,
    registerHook: (name, fn) => hooks.set(name, fn),
    registerTool: (name, tool) => tools.set(name, tool),
    hooks,
    tools,
  };
}

test("both Tier-B manifests conform to the normative schema", async () => {
  const schema = JSON.parse(
    await readFile(join(REPO, "schemas", "plugin-manifest.schema.json"), "utf8"),
  );
  for (const name of ["compact-smart", "guardrails"]) {
    const manifest = JSON.parse(await readFile(join(PLUGINS_DIR, name, "manifest.json"), "utf8"));
    const r = validate(manifest, schema);
    assert.ok(r.ok, `${name} manifest invalid: ${r.errors.join("; ")}`);
  }
});

test("pre-tool root gating: inside vs outside allowed_roots (write/edit/bash)", () => {
  guardrails.reset();
  const ctx = captureCtx({ allowed_roots: "." }); // cwd-relative root = repo
  guardrails.register(ctx);
  const pre = ctx.hooks.get("pre-tool");

  // inside: repo-relative paths
  assert.equal(pre({ tool: "write", args: { path: "src/loop.js" } }).action, "allow");
  assert.equal(pre({ tool: "edit", args: { path: "README.md" } }).action, "allow");
  assert.equal(pre({ tool: "bash", args: { command: "cat src/loop.js" } }).action, "allow");
  // bash with no path-like token → allow
  assert.equal(pre({ tool: "bash", args: { command: "echo hi" } }).action, "allow");
  // outside: absolute paths outside the root
  assert.deepEqual(pre({ tool: "write", args: { path: "/etc/x" } }), {
    action: "deny",
    reason: "guardrails:root",
  });
  assert.equal(pre({ tool: "bash", args: { command: "cat /etc/passwd" } }).action, "deny");
  // non-gated tools always allow
  assert.equal(pre({ tool: "read", args: { path: "/etc/passwd" } }).action, "allow");
});

test("pre-tool honours allowed_roots overrides (comma-separated)", () => {
  guardrails.reset();
  const ctx = captureCtx({ allowed_roots: "/tmp,/var" });
  guardrails.register(ctx);
  const pre = ctx.hooks.get("pre-tool");
  assert.equal(pre({ tool: "write", args: { path: "/tmp/a.txt" } }).action, "allow");
  assert.equal(pre({ tool: "write", args: { path: "/var/tmp/b.txt" } }).action, "allow");
  assert.equal(pre({ tool: "write", args: { path: "src/loop.js" } }).action, "deny");
});

test("post-tool aggregates and on-event counts; stats-summary returns them", async () => {
  guardrails.reset();
  const ctx = captureCtx({});
  guardrails.register(ctx);
  const post = ctx.hooks.get("post-tool");
  const onEv = ctx.hooks.get("on-event");

  assert.equal(post({ tool: "read", durationMs: 5 }), null);
  assert.equal(post({ tool: "read", durationMs: 7 }), null);
  assert.equal(post({ tool: "bash", durationMs: 12 }), null);
  onEv({ type: "turn.start" });
  onEv({ type: "turn.start" });
  onEv({ type: "tool.result" });

  const tool = ctx.tools.get("stats-summary");
  const res = await tool.run({});
  assert.ok(res.ok);
  assert.ok(res.output.includes("read: 2 call(s), 12ms total"));
  assert.ok(res.output.includes("bash: 1 call(s), 12ms total"));
  assert.ok(res.output.includes("turn.start: 2"));
  assert.ok(res.output.includes("tool.result: 1"));
  assert.ok(res.output.includes("events counted: 3"));
});

test("verify-gate single-winner override via the Part-0 wiring (real plugins dir)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-gr-"));
  try {
    const log = await EventLog.open(join(dir, "e.jsonl"));
    const host = await loadPlugins({ dir: PLUGINS_DIR, harnessVersion: "0.1.0", log });
    const names = host.plugins.map((p) => p.name).sort();
    assert.deepEqual(names, ["compact-smart", "guardrails"]);

    const wired = await wirePluginHooks(host, log);
    // guardrails is the ONLY verify-gate declarer → it wins the single hook.
    assert.equal(host.singleHooks["verify-gate"].plugin, "guardrails");
    const gate = await wired.verifyGate({ editedFiles: [] });
    assert.equal(gate.ok, true);
    assert.ok(gate.summary.includes("guardrails gate"));
    // compact-smart holds the compaction-trigger single hook.
    assert.equal(host.singleHooks["compaction-trigger"].plugin, "compact-smart");
    assert.equal(typeof wired.decide, "function");
    // chain hooks from guardrails are wired
    assert.equal(wired.preTool.length, 1);
    assert.equal(wired.postTool.length, 1);
    assert.equal(wired.onEvent.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
