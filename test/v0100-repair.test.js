// test/v0100-repair.test.js — the reviewer-repair evidence: the env WIRING
// (not the pure function), post-load prompt streaming, the sentinel probe,
// and the closed-client immediate reject.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const ROOT = join(new URL("..", import.meta.url).pathname);

// ---------- BLOCKER: the env WIRING proof ------------------------------------
test("BLOCKER: a REAL child server sees only envFrom names + the process base — the sentinel never arrives", { timeout: 45_000 }, async () => {
  const { EventLog } = await import("../src/events.js");
  const { Policy } = await import("../src/policy.js");
  const { defaultRules } = await import("../src/policy-defaults.js");
  const { createRegistry } = await import("../src/tools/index.js");
  const { connectMcpTools } = await import("../src/mcp-bridge.js");

  const dir = await mkdtemp(join(tmpdir(), "v0100r-"));
  const cfgPath = join(dir, "mcp.config.json");
  const logPath = join(dir, "logs", "ev.jsonl");
  await mkdir(join(dir, "logs"), { recursive: true });
  const sub = join(dir, "stubdir");
  await mkdir(sub, { recursive: true }); // servers OUTSIDE the log dir (pinned-deny)

  // A sentinel in the PARENT env that is NOT in envFrom, and a NAMED var
  // that is. A `node -e` server that reports its own process.env keys.
  process.env.SENTINEL_NOT_IN_LIST = "parent-only-secret";
  process.env.NAMED_IN_LIST = "declared-value";
  const serverSrc = `
    const lines = require("readline").createInterface({ input: process.stdin });
    const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
    lines.on("line", (l) => {
      let msg;
      try { msg = JSON.parse(l); } catch { return; }
      if (msg.method === "initialize") {
        const envKeys = Object.keys(process.env).sort();
        const report = {
          hasSentinel: !!process.env.SENTINEL_NOT_IN_LIST,
          hasNamed: !!process.env.NAMED_IN_LIST,
          hasBase: !!process.env.PATH && !!process.env.HOME,
          keyCount: envKeys.length,
        };
        send({ jsonrpc: "2.0", id: msg.id, result: { serverInfo: { name: "probe", envReport: report } } });
      } else if (msg.method === "tools/list") {
        send({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } });
      }
    });
  `;
  const serverPath = join(sub, "probe-server.cjs");
  await writeFile(serverPath, serverSrc, "utf8");

  await writeFile(cfgPath, JSON.stringify({
    version: 1,
    servers: {
      "env-probe": { command: process.execPath, args: [serverPath], envFrom: ["NAMED_IN_LIST"] },
    },
  }) + "\n", "utf8");

  const log = await EventLog.open(logPath);
  const policy = new Policy({ rules: defaultRules(), logPath });
  policy.addSessionRule({ tool: "mcp.*" }, "allow"); // allow the CONNECT spawn
  const side = await connectMcpTools({
    configPath: cfgPath,
    policy,
    log,
    askResolver: async () => "allow",
  });
  try {
    const client = side.clients["env-probe"];
    assert.ok(client, "the probe server connected");
    // The handshake report — the server's OWN view of its environment.
    const report = client.serverInfo?.envReport;
    assert.ok(report, "the probe reported its env");
    assert.equal(report.hasSentinel, false, "WIRING PROVEN: the parent-only sentinel never reached the child");
    assert.equal(report.hasNamed, true, "the envFrom-named var DID reach the child");
    assert.equal(report.hasBase, true, "the process base (PATH/HOME) is present");
    assert.ok(report.keyCount <= 10, `a MINIMAL env, not the parent's whole set (got ${report.keyCount} keys)`);
  } finally {
    delete process.env.SENTINEL_NOT_IN_LIST;
    delete process.env.NAMED_IN_LIST;
    await side.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- MINOR 1: closed flag immediate reject ---------------------------
test("MINOR 1: a request after close() rejects immediately with 'client closed'", { timeout: 15_000 }, async () => {
  const { EventLog } = await import("../src/events.js");
  const { Policy } = await import("../src/policy.js");
  const { defaultRules } = await import("../src/policy-defaults.js");
  const { McpClient } = await import("../src/mcp-client.js");
  const dir = await mkdtemp(join(tmpdir(), "v0100m1-"));
  // the pinned-deny log dir gets its OWN subdir (the deny covers everything
  // under it — the server script must live outside that subtree).
  const sub = join(dir, "stubdir");
  const logdir = join(dir, "logs");
  await mkdir(sub, { recursive: true });
  await mkdir(logdir, { recursive: true });
  try {
    const lp = join(logdir, "ev.jsonl");
    const log = await EventLog.open(lp);
    const policy = new Policy({ rules: defaultRules(), logPath: lp });
    policy.addSessionRule({ tool: "mcp.*" }, "allow"); // allow the spawn
    const serverSrc = `
      const lines = require("readline").createInterface({ input: process.stdin });
      const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
      lines.on("line", (l) => { try { const m = JSON.parse(l); if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { serverInfo: {} } }); if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [] } }); } catch {} });
    `;
    const sp = join(sub, "slow.cjs");
    await writeFile(sp, serverSrc, "utf8");
    const client = await McpClient.connect({
      command: process.execPath,
      args: [sp],
      policy,
      log,
      askResolver: async () => "allow",
    });
    await client.listTools(); // healthy
    await client.close();
    const t0 = Date.now();
    await assert.rejects(() => client.callTool("anything", {}), /client closed/);
    const dt = Date.now() - t0;
    assert.ok(dt < 1_000, `immediate (took ${dt}ms, not the 30s timeout)`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- MAJOR 1 test: prompt AFTER load streams session/update -----------
test("MAJOR 1: after session/load, a prompt STREAMS session/update chunks naming the LOADED session", { timeout: 45_000 }, async () => {
  const ACP = join(ROOT, "src", "acp.js");
  const dir = await mkdtemp(join(tmpdir(), "v0100s3-"));
  const child = spawn(process.execPath, [ACP], {
    cwd: dir,
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  const seen = new Map();
  const notifications = [];
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
        else if (m.method) notifications.push(m);
      } catch { /* partial */ }
    }
  });
  const send = (id, method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  const wait = async (id, ms = 10_000) => {
    const t0 = Date.now();
    while (!seen.has(id)) {
      if (Date.now() - t0 > ms) throw new Error(`response ${id} not delivered within ${ms}ms`);
      await new Promise((r) => { const t = setTimeout(r, 10); t.unref?.(); });
    }
    return seen.get(id);
  };
  const waitForCond = async (cond, ms, label) => {
    const t0 = Date.now();
    while (!(await cond())) {
      if (Date.now() - t0 > ms) throw new Error(`waitFor: ${label} not reached within ${ms}ms`);
      await new Promise((r) => { const t = setTimeout(r, 10); t.unref?.(); });
    }
  };
  try {
    send(1, "initialize", {});
    await wait(1);
    assert.equal(seen.get(1).result.agentCapabilities.loadSession, true, "MAJOR 2: the capability is true");
    send(2, "session/new", {});
    await wait(2);

    // a real log with one loaded-session id
    const { EventLog } = await import("../src/events.js");
    const realLog = join(dir, "logs", "loadme.jsonl");
    const srcLog = await EventLog.open(realLog);
    await srcLog.appendEvent("session.start", "harness", { harness_version: "0", session: "loadme", config_sha: "0" });
    await srcLog.appendEvent("turn.start", "harness", { turn: 1, input: "past" });
    await srcLog.appendEvent("turn.end", "harness", { turn: 1, reason: "complete", closed_calls: [] });

    send(3, "session/load", { logPath: realLog });
    const loaded = await wait(3);
    assert.equal(loaded.result.turns, 1);

    // THE missing probe: PROMPT after load and assert chunks arrive
    send(4, "session/prompt", { prompt: "post-load hello" });
    const done = await wait(4);
    assert.equal(done.result.stopReason, "end_turn");
    await waitForCond(
      () => notifications.some((n) => n.method === "session/update"),
      10_000,
      "post-load session/update chunks",
    );
    const chunk = notifications.find((n) => n.method === "session/update");
    assert.match(chunk.params.update.sessionUpdate, /agent_message_chunk/);
    // v011.0 S4-4: compare against the LOADED session's id exactly, not just length
    assert.equal(chunk.params.sessionId, "loadme", "the chunk names the LOADED session id");
    assert.match(notifications.filter((n) => n.method === "session/update").map((n) => n.params.update.content.text).join(""), /post-load hello/);
  } finally {
    child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- MINOR 2: dotted tool names group correctly -----------------------
test("MINOR 2: a dotted tool name groups under the right server through the REAL toolsCommand", { timeout: 15_000 }, async () => {
  // v011.0 S4-2: assert through the command's OUTPUT, not an inline re-parse.
  // A stub server that exposes one dotted tool name (mcp-fixed bugs pass in
  // registry-extras projection with server "srvx"): we drive the REAL
  // connect path with a policy (so the bridge lists real tools).
  const { EventLog } = await import("../src/events.js");
  const { Policy } = await import("../src/policy.js");
  const { defaultRules } = await import("../src/policy-defaults.js");
  const { toolsCommand } = await import("../src/tools-list-cli.js");
  const { mkdtemp, rm, writeFile, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "v0110md-"));
  try {
    const NL = String.fromCharCode(10);
    const stub = [
      "const lines = require(" + JSON.stringify("readline") + ").createInterface({ input: process.stdin });",
      "const send = (o) => process.stdout.write(JSON.stringify(o) + " + JSON.stringify(NL) + ");",
      "lines.on(" + JSON.stringify("line") + ", (l) => { try { const m = JSON.parse(l);",
      "  if (m.method === " + JSON.stringify("initialize") + ") send({ jsonrpc: " + JSON.stringify("2.0") + ", id: m.id, result: { serverInfo: {} } });",
      "  if (m.method === " + JSON.stringify("tools/list") + ") send({ jsonrpc: " + JSON.stringify("2.0") + ", id: m.id, result: { tools: [{ name: " + JSON.stringify("config.get_file.json") + ", description: " + JSON.stringify("dotted") + ", inputSchema: { type: " + JSON.stringify("object") + " } }] } });",
      "} catch {} });",
    ].join(NL);    const sub = join(dir, "stubdir");
    await mkdir(sub, { recursive: true });
    const sp = join(sub, "dotted.cjs");
    await writeFile(sp, stub, "utf8");
    const cfgPath = join(dir, "mcp.config.json");
    await writeFile(cfgPath, JSON.stringify({ servers: { "srvx": { command: process.execPath, args: [sp] } } }) + "\n", "utf8");
    const lp = join(dir, "logs", "ev.jsonl");
    const log = await EventLog.open(lp);
    const policy = new Policy({ rules: defaultRules(), logPath: lp });
    policy.addSessionRule({ tool: "mcp.*" }, "allow");
    // the COMMAND does its own connect+list+close; assert through its OUTPUT
    // only (no duplicate side connection to leak).
    const lines = [];
    const r = await toolsCommand([], {
      stdout: { write: (t) => lines.push(t) },
      configPath: cfgPath,
      policy,
      log,
    });
    assert.equal(r.exitCode, 0);
    const text = lines.join("\n");
    assert.ok(text.includes("mcp.srvx (1):"), "the dotted TOOL groups under server srvx");
    assert.ok(text.includes("config.get_file.json"), "the full dotted name is listed intact");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
