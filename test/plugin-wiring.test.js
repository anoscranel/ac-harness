// test/plugin-wiring.test.js — TB0: plugin hooks/decisions reach the loop.
// Covers: no-plugins regression, chain-hook fold (deny > allow), single-hook
// winners (verify-gate adaptation + compaction-trigger override), and the
// on-event circuit breaker (3 consecutive throws → disabled + violation).
import { test } from "node:test";
import { waitFor } from "./helpers-timing.js";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/events.js";
import { Policy } from "../src/policy.js";
import { defaultRules } from "../src/policy-defaults.js";
import { createRegistry } from "../src/tools/index.js";
import echo from "../src/providers/echo.js";
import { decide } from "../src/context.js";
import { createLoop } from "../src/loop.js";
import { loadPlugins, wirePluginHooks } from "../src/plugins/loader.js";

const HARNESS_VERSION = "0.1.0";

async function makePlugin(dir, name, { hooks = [], body = "" }) {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(
    join(dir, name, "manifest.json"),
    JSON.stringify({
      manifest: name,
      version: "0.0.1",
      compat: "^0.1.0",
      capabilities: { hooks },
      description: `test plugin ${name}`,
      licence: "MIT",
    }),
    "utf8",
  );
  await writeFile(join(dir, name, "index.js"), body, "utf8");
}

async function makeLoop(dir, { wired, askResolver } = {}) {
  const logPath = join(dir, "events.jsonl");
  const log = await EventLog.open(logPath);
  const policy = new Policy({ rules: defaultRules(), logPath });
  const loop = createLoop({
    provider: echo,
    tools: createRegistry(),
    policy,
    log,
    decide: wired?.decide ?? decide,
    askResolver,
    hooks: {
      preTool: wired?.preTool ?? [],
      postTool: wired?.postTool ?? [],
      onEvent: wired?.onEvent ?? [],
    },
    config: { session: "tb0" },
  });
  return { loop, log };
}

test("no plugins: wiring yields empty surface, loop behaviour unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-tb0-"));
  try {
    const log = await EventLog.open(join(dir, "e.jsonl"));
    const host = await loadPlugins({ dir: join(dir, "no-plugins"), harnessVersion: HARNESS_VERSION, log });
    const wired = await wirePluginHooks(host, log);
    assert.deepEqual(wired.preTool, []);
    assert.deepEqual(wired.postTool, []);
    assert.deepEqual(wired.onEvent, []);
    assert.equal(wired.decide, undefined);
    assert.equal(wired.verifyGate, undefined);

    const { loop, log: loopLog } = await makeLoop(dir, { wired });
    const r = await loop.start("hi");
    await loop.end();
    assert.equal(r.text, "echo: hi");
    assert.ok(!loopLog.events.some((e) => e.type === "plugin.loaded"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chain pre-tool hook folds deny over a policy allow", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-tb0-"));
  try {
    const pluginsDir = join(dir, "plugins");
    await makePlugin(pluginsDir, "deny-all", {
      hooks: ["pre-tool"],
      body: `export function register(ctx) {
        ctx.registerHook("pre-tool", () => ({ action: "deny", reason: "test-deny" }));
      }`,
    });
    const log = await EventLog.open(join(dir, "e.jsonl"));
    const host = await loadPlugins({ dir: pluginsDir, harnessVersion: HARNESS_VERSION, log });
    const wired = await wirePluginHooks(host, log);
    assert.equal(wired.preTool.length, 1);

    const { loop, log: loopLog } = await makeLoop(dir, { wired });
    await loop.start(`tool:read {"path":"package.json"}`);
    await loop.end();
    const decisions = loopLog.events.filter((e) => e.type === "policy.decision");
    // First decision: defaults.allow_read; second: the plugin fold.
    assert.equal(decisions[0].data.verdict, "allow");
    assert.equal(decisions[1].data.verdict, "deny");
    assert.equal(decisions[1].data.rule_path, "plugin:deny-all");
    assert.equal(decisions[1].data.reason, "test-deny");
    const result = loopLog.events.find((e) => e.type === "tool.result");
    assert.equal(result.data.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("single-hook winners: verify-gate lexicographic winner + compaction-trigger override", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-tb0-"));
  try {
    const pluginsDir = join(dir, "plugins");
    await makePlugin(pluginsDir, "aaa-gate", {
      hooks: ["verify-gate"],
      body: `export function register(ctx) {
        ctx.registerHook("verify-gate", async () => ({ pass: true, summary: "aaa-win" }));
      }`,
    });
    await makePlugin(pluginsDir, "zzz-gate", {
      hooks: ["verify-gate"],
      body: `export function register(ctx) {
        ctx.registerHook("verify-gate", async () => ({ pass: false, summary: "zzz-lose" }));
      }`,
    });
    await makePlugin(pluginsDir, "always-block", {
      hooks: ["compaction-trigger"],
      body: `export function register(ctx) {
        ctx.registerHook("compaction-trigger", () => ({ version: 1, verdict: "block", reason: "test-block" }));
      }`,
    });
    const log = await EventLog.open(join(dir, "e.jsonl"));
    const host = await loadPlugins({ dir: pluginsDir, harnessVersion: HARNESS_VERSION, log });
    const wired = await wirePluginHooks(host, log);

    // verify-gate: aaa-gate wins (lexicographic), {pass} adapted to {ok}.
    const gateResult = await wired.verifyGate({ editedFiles: [] });
    assert.equal(gateResult.ok, true);
    assert.equal(gateResult.summary, "aaa-win");
    // the loser's hook was never registered into the slot
    assert.equal(host.singleHooks["verify-gate"].plugin, "aaa-gate");

    // compaction-trigger winner replaces the default decide.
    const d = wired.decide(
      { input_tokens: 0, cached_tokens: 0, output_reserve: 0, context_limit: 1000, estimate: false },
      0,
      { max_session_tokens: 0, warn_fraction: 0 },
      [],
    );
    assert.equal(d.verdict, "block");
    assert.equal(d.reason, "test-block");

    // single-hook conflict was logged for zzz-gate
    assert.ok(
      log.events.some(
        (e) => e.type === "policy.violation" && e.data.kind === "single-hook-conflict",
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("on-event circuit breaker: 3 consecutive throws → disabled + policy.violation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-tb0-"));
  try {
    const pluginsDir = join(dir, "plugins");
    await makePlugin(pluginsDir, "always-throws", {
      hooks: ["on-event"],
      body: `export function register(ctx) {
        ctx.registerHook("on-event", () => { throw new Error("boom"); });
      }`,
    });
    const log = await EventLog.open(join(dir, "e.jsonl"));
    const host = await loadPlugins({ dir: pluginsDir, harnessVersion: HARNESS_VERSION, log });
    const wired = await wirePluginHooks(host, log);
    assert.equal(wired.onEvent.length, 1);

    const { loop, log: loopLog } = await makeLoop(dir, { wired });
    await loop.start("hi");
    await loop.end();
    // v0.7.0 flake-class: AWAIT the hook-chain's effect instead of a fixed
    // 200ms nap — the violations ride async promises; poll the log with a guard.
    await waitFor(
      () => loopLog.events.some((e) => e.type === "plugin.violation"),
      { timeoutMs: 5_000, stepMs: 10, label: "hook-error violations logged" },
    );

    const hookErrors = loopLog.events.filter(
      (e) => e.type === "plugin.violation" && e.data.kind === "hook-error" && e.data.plugin === "always-throws",
    );
    const disabled = loopLog.events.filter(
      (e) => e.type === "policy.violation" && e.data.kind === "hook-disabled",
    );
    assert.equal(hookErrors.length, 3, "exactly 3 hook-error violations before the breaker trips");
    assert.equal(disabled.length, 1, "one hook-disabled policy.violation");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
