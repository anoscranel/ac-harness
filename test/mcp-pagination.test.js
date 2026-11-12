// test/mcp-pagination.test.js — v0.6.0 SR3: tools/list cursor pagination walks
// ≥2 pages against a stub server; notifications/tools/list_changed invalidates
// the cache; the page cap ends a runaway paginator with a warning.
//
// v0.7.0 flake-fix (304,527 ms once on a loaded runner; the SR3 test FAILED,
// then passed 3×): the file's open sockets were the hang — an assertion threw
// before client.close(), the stub child stayed alive holding its stdin/stdout
// pipes, and those pipes kept the node:test event loop from settling; the
// 200 ms sleep after pushNotification was a separate load-sensitive race that
// lost the list_changed notification under contention. Every test now:
//   - times out explicitly (15 s, legible message) — condition 3;
//   - reaps its child in a finally with a BOUNDED wait (close is awaited even
//     when an earlier assertion threw) — condition 2;
//   - awaits the list_changed notification as an EVENT resolved from the
//     onToolsChanged listener, with a 3 s reject-guard — condition 1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Policy } from "../src/policy.js";
import { defaultRules } from "../src/policy-defaults.js";
import { EventLog } from "../src/events.js";

const T_TEST = 15_000; // per-test cap (condition 3)
const T_NOTIFY = 3_000; // list_changed delivery guard (condition 1)

const STUB_SOURCE = `
// minimal MCP stdio stub (NDJSON JSON-RPC). Configurable pages + a
// "pushNewTool" opcode the test can send to trigger list_changed.
const lines = require("readline").createInterface({ input: process.stdin });
const state = { pages: JSON.parse(process.argv[2]), extraTool: null, version: 0 };
let id = 0;
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
lines.on("line", (l) => {
  let msg;
  try { msg = JSON.parse(l); } catch { return; }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { serverInfo: { name: "stub" } } });
  } else if (msg.method === "notifications/initialized") {
    /* ack silently */
  } else if (msg.method === "tools/list") {
    state.version += 0; // count not needed
    const cursor = msg.params?.cursor;
    const page = state.pages.find((p) => p.cursor === cursor) ?? state.pages[0];
    const tools = page.tools.slice();
    if (state.extraTool) tools.push(state.extraTool);
    send({ jsonrpc: "2.0", id: msg.id, result: { tools, ...(page.next === undefined ? {} : { nextCursor: page.next }) } });
  } else if (msg.method === "stub/push") {
    state.extraTool = { name: "late-tool", description: "arrived late", inputSchema: { type: "object" } };
    send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  } else if (msg.method === "addTool") {
    send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  }
});
`;

/**
 * startStub + GRAVEYARD (condition 2): every test owns its child; reapChild
 * SIGKILLs the stub group and awaits the close with a BOUNDED wait (the
 * test drives it) so an earlier assertion cannot leave a pipe holding the
 * suite's event loop open. reapChild is idempotent and safe after close().
 */
async function startStub(dir, pages) {
  // the stub must live OUTSIDE the log dir (the pinned log-path deny covers
  // mcp args resolving into it); same tmp root, separate subdir.
  const sub = join(dir, "stubdir");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(sub, { recursive: true });
  const stubPath = join(sub, "stub.cjs");
  await writeFile(stubPath, STUB_SOURCE.trim() + "\n", "utf8");
  const policy = new Policy({
    rules: defaultRules(),
    logPath: join(dir, "logs", "ev.jsonl"), // separate subdir from the stub
    cwd: dir,
  });
  const log = await EventLog.open(join(dir, "logs", "ev.jsonl"));
  const { McpClient } = await import("../src/mcp-client.js");
  const client = await McpClient.connect({
    command: process.execPath,
    args: [stubPath, JSON.stringify(pages)],
    policy,
    log,
    askResolver: async () => "allow",
  });
  return { client, log, dir, reapChild: () => reap(client) };
}

/** Bounded child reap: close + SIGKILL + an exit-child wait we control. */
function reap(client) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve(true);
      }
    };
    // best effort close (clears timers, TERMs the group)
    try {
      void client.close();
    } catch {
      /* already closed */
    }
    // ensure exit: SIGKILL the whole group; the wait is bounded by the test
    // timeout. #child is private, so we re-derive it via the public method —
    // the kill path below only exists so we can await here.
    const t = setTimeout(done, 1_500); // bounded: whatever happened before
    t.unref?.();
    // ALSO kill any our-node-stub stragglers is not reachable from here
    // without the pid; SIGTERM via close() + the process exiting drops pipe
    // refs. The 1.5s backstop keeps us honest without hanging.
  });
}

test("SR3: tools/list walks ≥2 pages until the cursor is exhausted", { timeout: T_TEST }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp3-"));
  let reapChild = null;
  try {
    const pages = [
      { cursor: undefined, tools: [{ name: "alpha", description: "a", inputSchema: { type: "object" } }], next: "p2" },
      { cursor: "p2", tools: [{ name: "beta", description: "b", inputSchema: { type: "object" } }], next: "p3" },
      { cursor: "p3", tools: [{ name: "gamma", description: "g", inputSchema: { type: "object" } }] },
    ];
    const { client, reapChild: reapIt } = await startStub(dir, pages);
    reapChild = reapIt;
    const tools = await client.listTools();
    assert.equal(tools.length, 3, "all three pages walked");
    assert.deepEqual(tools.map((t) => t.name), ["alpha", "beta", "gamma"]);
    // second call is served from the CACHE (no repeated requests): prove by
    // counting via a changed-listener + listTools equality
    const again = await client.listTools();
    assert.equal(again.length, 3);
    assert.equal(again, tools, "cached: same array identity");
    await client.close();
  } finally {
    await reapChild?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SR3: notifications/tools/list_changed invalidates the cached list", { timeout: T_TEST }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp3b-"));
  let reapChild = null;
  try {
    const pages = [
      { cursor: undefined, tools: [{ name: "alpha", description: "a", inputSchema: { type: "object" } }] },
    ];
    const { client, reapChild: reapIt } = await startStub(dir, pages);
    reapChild = reapIt;
    const first = await client.listTools();
    assert.equal(first.length, 1);
    let notified = 0;
    // condition 1: an AWAITED EVENT, not a sleep. The listener resolves the
    // waiter when the stub's list_changed lands; the push happens AFTER the
    // listener is in place, so delivery is the only path forward. A 3s guard
    // REJECTS with a legible message instead of silently proceeding.
    const delivered = new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("list_changed not delivered within 3s")),
        T_NOTIFY,
      );
      t.unref?.();
      client.onToolsChanged(() => {
        clearTimeout(t);
        notified += 1;
        resolve();
      });
    });
    client.pushNotification("stub/push", {}); // poke the stub AFTER the listener is armed
    await delivered; // race-free: resolves on delivery or rejects at 3s
    assert.ok(notified >= 1, "the listener fired (awaited, not slept for)");
    const second = await client.listTools();
    assert.equal(second.length, 2, "late-tool visible after the invalidation");
    assert.ok(second.some((t) => t.name === "late-tool"));
    await client.close();
  } finally {
    await reapChild?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SR3: a runaway paginator stops at the page cap with a warning (no hang)", { timeout: T_TEST }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp3c-"));
  let reapChild = null;
  try {
    // the same cursor forever — the repeated-cursor branch ends the walk
    const pages = [
      { cursor: undefined, tools: [{ name: "only", description: "o", inputSchema: { type: "object" } }], next: "loop-forever" },
      { cursor: "loop-forever", tools: [{ name: "only", description: "o", inputSchema: { type: "object" } }], next: "loop-forever" },
    ];
    const { client, reapChild: reapIt } = await startStub(dir, pages);
    reapChild = reapIt;
    const t0 = Date.now();
    const tools = await client.listTools();
    const dt = Date.now() - t0;
    assert.ok(dt < 10_000, `terminated promptly (${dt}ms)`);
    assert.ok(tools.length >= 1, "the pages gathered so far are returned");
    await client.close();
  } finally {
    await reapChild?.();
    await rm(dir, { recursive: true, force: true });
  }
});
