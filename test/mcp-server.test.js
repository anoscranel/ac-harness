// test/mcp-server.test.js — ship-3 DC2/DC4 evidence: a REAL client stub over
// stdio performs initialize → tools/list → tools/call(read) → tools/call(bash),
// and the log carries the remote-actor trail. House style: awaited conditions,
// per-test timeouts, no fixed sleeps as sync (test/helpers-timing.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAll } from "../src/events.js";

const ROOT = join(new URL("..", import.meta.url).pathname);
const SERVER = join(ROOT, "src", "mcp-server.js");

/** A real MCP client stub over stdio: one request per line, responses by id. */
function clientStub(child) {
  const seen = new Map();
  const lines = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!l) continue;
      try {
        const m = JSON.parse(l);
        if (m.id !== undefined) seen.set(m.id, m);
      } catch { /* tolerate partial */ }
    }
  });
  return {
    seen,
    lines,
    send: (id, method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"),
    notify: (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"),
  };
}

async function waitForResponse(stub, id, timeoutMs = 10_000) {
  const t0 = Date.now();
  while (!stub.seen.has(id)) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`response ${id} not delivered within ${timeoutMs}ms`);
    await new Promise((r) => {
      const t = setTimeout(r, 10);
      t.unref?.();
    });
  }
  return stub.seen.get(id);
}

test("DC4: initialize → tools/list → read works; bash denied; hidden tools absent", { timeout: 45_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp3srv-"));
  const child = spawn(process.execPath, [SERVER], {
    cwd: dir,
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  const stub = clientStub(child);
  try {
    // initialize
    stub.send(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {} });
    const init = await waitForResponse(stub, 1);
    assert.equal(init.result.serverInfo.name, "ac-harness");
    assert.equal(init.result.serverInfo.version.length > 0, true);
    assert.equal(init.result.capabilities.tools.listChanged, false);
    stub.notify("notifications/initialized", {});

    // ping
    stub.send(2, "ping", {});
    const ping = await waitForResponse(stub, 2);
    assert.deepEqual(ping.result, {});

    // tools/list: read present, delegate + memory_remember ABSENT (spec §0)
    stub.send(3, "tools/list", {});
    const list = await waitForResponse(stub, 3);
    const names = list.result.tools.map((t) => t.name);
    assert.ok(names.includes("read"), "read exposed");
    assert.ok(names.includes("bash"), "bash exposed (gate fires at call time)");
    assert.ok(!names.includes("delegate"), "delegate hidden");
    assert.ok(!names.includes("memory_remember"), "memory_remember hidden");
    for (const t of list.result.tools) {
      assert.equal(typeof t.inputSchema, "object", `${t.name} carries its inputSchema`);
    }

    // unknown method → -32601 (spec §1)
    stub.send(4, "bogus/method", {});
    const bogus = await waitForResponse(stub, 4);
    assert.equal(bogus.error.code, -32601);

    // unknown tool → -32602
    stub.send(5, "tools/call", { name: "no-such-tool", arguments: {} });
    const unknown = await waitForResponse(stub, 5);
    assert.equal(unknown.error.code, -32602);

    // hidden tool by direct call → -32602 (never a hint it exists)
    stub.send(6, "tools/call", { name: "delegate", arguments: { prompt: "x" } });
    const hidden = await waitForResponse(stub, 6);
    assert.equal(hidden.error.code, -32602);

    // tools/call read: allowed, returns the file text
    const target = join(dir, "hello.txt");
    await writeFile(target, "the mcp server reads this", "utf8");
    stub.send(7, "tools/call", { name: "read", arguments: { path: target } });
    const read = await waitForResponse(stub, 7);
    assert.ok(!read.result.isError, "read succeeded");
    assert.equal(read.result.content[0].type, "text");
    assert.match(read.result.content[0].text, /the mcp server reads this/);

    // tools/call bash: ask-by-default → remoteDecide DENIES (spec §0)
    stub.send(8, "tools/call", { name: "bash", arguments: { command: "echo pwned" } });
    const bash = await waitForResponse(stub, 8);
    assert.equal(bash.result.isError, true, "bash isError");
    assert.match(bash.result.content[0].text, /remote callers cannot answer permission prompts/);
  } finally {
    child.kill("SIGKILL");
  }
});

test("DC2: the denial is in the LOG with actor remote; allowed read too", { timeout: 45_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp3log-"));
  const child = spawn(process.execPath, [SERVER], {
    cwd: dir,
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  const stub = clientStub(child);
  try {
    stub.send(1, "initialize", {});
    await waitForResponse(stub, 1);
    stub.notify("notifications/initialized", {});
    const target = join(dir, "x.txt");
    await writeFile(target, "log-trail", "utf8");
    stub.send(2, "tools/call", { name: "read", arguments: { path: target } });
    await waitForResponse(stub, 2);
    stub.send(3, "tools/call", { name: "bash", arguments: { command: "ls" } });
    await waitForResponse(stub, 3);
    // let the log writes settle — AWAITED, not a sleep
    const logDir = join(dir, "logs");
    const { readdir } = await import("node:fs/promises");
    let files = [];
    const t0 = Date.now();
    while (files.length === 0 && Date.now() - t0 < 10_000) {
      try { files = await readdir(logDir); } catch { /* not yet */ }
      if (files.length === 0) await new Promise((r) => { const t = setTimeout(r, 10); t.unref?.(); });
    }
    assert.ok(files.length > 0, "the server's log exists");
    const events = await readAll(join(logDir, files[0]));
    // the read call: proposed → decision allow → result ok, ALL with actor remote
    const props = events.filter((e) => e.type === "tool.proposed");
    assert.equal(props.length, 2, "two calls proposed");
    for (const p of props) assert.equal(p.actor, "remote", "proposed logged with the remote actor");
    const decisions = events.filter((e) => e.type === "policy.decision");
    assert.equal(decisions.length, 2);
    const allow = decisions.find((d) => d.data.verdict === "allow");
    const deny = decisions.find((d) => d.data.verdict === "deny");
    assert.ok(allow, "read allowed");
    assert.ok(deny, "bash denied");
    assert.equal(deny.data.rule_path, "defaults.ask_bash", "the denial names the ask rule");
    for (const d of decisions) assert.equal(d.actor, "remote");
    const results = events.filter((e) => e.type === "tool.result");
    assert.equal(results.length, 2);
    const denied = results.find((r) => r.data.ok === false);
    assert.match(denied.data.error, /policy-denied/);
    for (const r of results) assert.equal(r.actor, "remote");
  } finally {
    child.kill("SIGKILL");
  }
});

test("bounded input: a >1 MiB line is rejected, not buffered", { timeout: 45_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp3big-"));
  const child = spawn(process.execPath, [SERVER], {
    cwd: dir,
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  const stub = clientStub(child);
  try {
    stub.send(1, "initialize", {});
    await waitForResponse(stub, 1);
    // a >1 MiB line: the server must reject it with -32600 and stay alive
    const big = "x".repeat((1 << 20) + 10);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping", params: { junk: big } }) + "\n");
    const rejected = await waitForResponse(stub, 99);
    assert.equal(rejected.error.code, -32600, "oversized line rejected");
    // the server still answers a normal ping afterwards
    stub.send(2, "ping", {});
    const ping = await waitForResponse(stub, 2);
    assert.deepEqual(ping.result, {});
  } finally {
    child.kill("SIGKILL");
  }
});
