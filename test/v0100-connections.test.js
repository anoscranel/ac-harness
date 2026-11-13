// test/v0100-connections.test.js — S1a config validation, S1b bridge
// (failure isolation + real tools via the repo's OWN mcp-server subcommand),
// S1c `ac-harness tools`, S2 acp session/load. House style: awaited
// conditions, per-test timeouts, neutral tmp paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, appendFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const ROOT = join(new URL("..", import.meta.url).pathname);

// ---------- S1a: mcp-config validation ---------------------------------------
test("S1a: valid config round-trips; inline env VALUE rejected; bad name rejected; missing file = zero", async () => {
  const { loadMcpConfig, enabledServers, spawnEnv } = await import("../src/mcp-config.js");
  const dir = await mkdtemp(join(tmpdir(), "v0100a-"));
  try {
    const f = join(dir, "mcp.config.json");

    // valid
    const warns = [];
    await writeFile(f, JSON.stringify({
      version: 1,
      servers: {
        "local-tools": { command: "node", args: ["src/mcp-server.js"], envFrom: ["SOME_NAME"], enabled: true },
        "disabled-one": { command: "whatever", enabled: false },
      },
    }) + "\n", "utf8");
    const cfg = await loadMcpConfig(f, { warn: (m) => warns.push(m) });
    assert.deepEqual(cfg.servers["local-tools"], {
      command: "node",
      args: ["src/mcp-server.js"],
      envFrom: ["SOME_NAME"],
      enabled: true,
    });
    assert.equal(cfg.servers["disabled-one"].enabled, false);
    assert.equal(warns.length, 0, "valid config does not warn");
    // enabledServers filters to enabled-only
    const plan = enabledServers(cfg);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].name, "local-tools");
    // spawnEnv passes ONLY the named vars
    process.env.SOME_NAME = "NAME-VALUE-1";
    const childEnv = spawnEnv(["SOME_NAME", "ABSENT"], process.env);
    assert.equal(childEnv.SOME_NAME, "NAME-VALUE-1");
    assert.equal("ABSENT" in childEnv, false, "absent name simply not passed");
    assert.ok(!("PATH" in childEnv), "nothing else leaks through");
    delete process.env.SOME_NAME;

    // inline env VALUE: rejected
    await writeFile(f, JSON.stringify({
      servers: { "leaky": { command: "x", env: { KEY: "super-secret-value" } } },
    }) + "\n", "utf8");
    const warns2 = [];
    const cfg2 = await loadMcpConfig(f, { warn: (m) => warns2.push(m) });
    assert.equal(cfg2.servers.leaky, undefined, "inline-env entry rejected entirely");
    assert.equal(Object.keys(cfg2.servers).length, 0);
    assert.match(warns2[0], /leaky/);
    assert.match(warns2[0], /envFrom/);

    // bad name rejected
    await writeFile(f, JSON.stringify({
      servers: { "Bad_Name": { command: "x" }, "also bad": { command: "x" }, "ok-name2": { command: "y" } },
    }) + "\n", "utf8");
    const warns3 = [];
    const cfg3 = await loadMcpConfig(f, { warn: (m) => warns3.push(m) });
    assert.deepEqual(Object.keys(cfg3.servers), ["ok-name2"]);
    assert.equal(warns3.length, 2, "both bad names warned");

    // missing file = zero servers, no warn
    const cfg4 = await loadMcpConfig(join(dir, "nope.json"), { warn: (m) => warns3.push(m) });
    assert.deepEqual(cfg4.servers, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- S1b: bridge — real tools via the repo's own mcp-server ----------
async function acpStub(child) {
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
  return {
    seen, notifications,
    send: (id, method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"),
  };
}
async function waitResponse(stub, id, timeoutMs = 10_000) {
  const t0 = Date.now();
  while (!stub.seen.has(id)) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`response ${id} not delivered within ${timeoutMs}ms`);
    await new Promise((r) => { const t = setTimeout(r, 10); t.unref?.(); });
  }
  return stub.seen.get(id);
}

test("S1b/S1c: a real declared server (the repo's OWN mcp-server) tools arrive, are callable, and a DEAD server is isolated", { timeout: 45_000 }, async () => {
  const { EventLog } = await import("../src/events.js");
  const { Policy } = await import("../src/policy.js");
  const { defaultRules } = await import("../src/policy-defaults.js");
  const { buildRegistryWithMcp } = await import("../src/mcp-bridge.js");
  const { createRegistry } = await import("../src/tools/index.js");

  const dir = await mkdtemp(join(tmpdir(), "v0100b-"));
  const cfgPath = join(dir, "mcp.config.json");
  const logPath = join(dir, "logs", "ev.jsonl");
  await mkdir(join(dir, "logs"), { recursive: true });

  await writeFile(cfgPath, JSON.stringify({
    version: 1,
    servers: {
      // the repo's OWN mcp-server subcommand as the server under test (DC2)
      "harness-mirror": { command: process.execPath, args: [join(ROOT, "src", "mcp-server.js")] },
      // a dead server (DC3)
      "dead-one": { command: "/nonexistent/binary/that/does/not/exist" },
    },
  }) + "\n", "utf8");

  const log = await EventLog.open(logPath);
  const policy = new Policy({ rules: defaultRules(), logPath });
  const side = await buildRegistryWithMcp(createRegistry, {
    configPath: cfgPath,
    policy,
    log,
    askResolver: async () => "allow", // the CONNECT spawn: allow (the CALL below is what asks)
  });

  try {
    // harness-mirror's tools arrived as mcp.harness-mirror.<tool>
    const names = side.registry.names();
    assert.ok(names.includes("mcp.harness-mirror.read"), "the mirrored read tool arrived");
    assert.ok(!names.some((n) => n.startsWith("mcp.dead-one")), "the dead server contributed ZERO tools");

    // DC3: the dead server logged mcp.server.error with its reason
    const errEvent = log.events.find((e) => e.type === "mcp.server.error");
    assert.ok(errEvent, "mcp.server.error logged");
    assert.equal(errEvent.data.server, "dead-one");
    assert.match(errEvent.data.reason, /spawn/i);

    // callable end-to-end: read a real file through the mirrored tool
    await writeFile(join(dir, "probe.txt"), "bridged round trip", "utf8");
    const decision = policy.evaluate({ tool: "mcp.harness-mirror.read", args: { path: join(dir, "probe.txt") } });
    assert.equal(decision.verdict, "ask", "mcp.* calls ask (the S1b unchanged stance)");
    const res = await side.registry.run("mcp.harness-mirror.read", { path: join(dir, "probe.txt") }, { allowed: true });
    assert.ok(res.ok, `mirrored call succeeded: ${res.error ?? ""}`);
    assert.match(res.output, /bridged round trip/);
  } finally {
    await side.closeMcp();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- S1c: ac-harness tools (the bin surface) --------------------------
test("S1c smoke: bin tools lists builtins + the declared mcp group", { timeout: 45_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "v0100c-"));
  try {
    const cfgPath = join(dir, "mcp.config.json");
    await writeFile(cfgPath, JSON.stringify({
      servers: { "ac-harness": { command: process.execPath, args: [join(ROOT, "src", "mcp-server.js")] } },
    }) + "\n", "utf8");
    const { toolsCommand } = await import("../src/tools-list-cli.js");
    const lines = [];
    // declared-but-not-spawned mode (no policy/log): honest per-server line
    const r = await toolsCommand([], {
      stdout: { write: (s) => lines.push(s) },
      configPath: cfgPath,
    });
    assert.equal(r.exitCode, 0);
    const text = lines.join("\n");
    assert.match(text, /builtin \(\d+\):/);
    assert.match(text, /  read — /);
    assert.match(text, /mcp\.ac-harness — declared, enabled/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- S2: acp session/load ----------------------------------------------
test("S2: session/load on a real log answers with the descriptor; missing log errors naming the path; a torn tail loads to the last intact event", { timeout: 45_000 }, async () => {
  const ACP = join(ROOT, "src", "acp.js");
  const dir = await mkdtemp(join(tmpdir(), "v0100s2-"));
  const child = spawn(process.execPath, [ACP], {
    cwd: dir,
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  const stub = await acpStub(child);
  try {
    stub.send(1, "initialize", {});
    await waitResponse(stub, 1);
    stub.send(2, "session/new", {});
    await waitResponse(stub, 2);

    // build a REAL log in the ACP process's logDir (<cwd>/logs)
    const { EventLog, readAll, canonicalize, sha256 } = await import("../src/events.js");
    const realLog = join(dir, "logs", "loadme.jsonl");
    const srcLog = await EventLog.open(realLog);
    await srcLog.appendEvent("session.start", "harness", { harness_version: "0", session: "loadme", config_sha: "0" });
    await srcLog.appendEvent("turn.start", "harness", { turn: 1, input: "hello" });
    await srcLog.appendEvent("turn.end", "harness", { turn: 1, reason: "complete", closed_calls: [] });

    // load it by logPath
    stub.send(3, "session/load", { logPath: realLog });
    const loaded = await waitResponse(stub, 3);
    assert.equal(loaded.result.events, 3);
    assert.equal(loaded.result.turns, 1);
    assert.equal(loaded.result.stopped_at, false);
    assert.ok(Array.isArray(loaded.result.limits));
    assert.match(loaded.result.limits.join(";"), /policy session-rules are per-process and NOT restored/);
    assert.match(loaded.result.limits.join(";"), /tools are never re-run/);
    assert.match(loaded.result.limits.join(";"), /torn tail loads to the last intact event/);

    // missing log: error naming the tried path
    stub.send(4, "session/load", { logPath: join(dir, "nope.jsonl") });
    const missing = await waitResponse(stub, 4);
    assert.equal(missing.error.code, -32602);
    assert.match(missing.error.message, /log not found/);
    assert.match(missing.error.message, /nope\.jsonl/);

    // torn tail: corrupt the loaded log with a broken last line, load again
    await appendFile(realLog, '{"seq":9,"ts":1.5,"type":"turn.sta', "utf8");
    stub.send(5, "session/load", { logPath: realLog });
    const torn = await waitResponse(stub, 5);
    // 3 original events + the log.torn_tail recovery event the re-open wrote
    // (the torn line itself is skipped — and its recovery IS recorded).
    assert.equal(torn.result.events, 4, "loads to the last intact event + the torn_tail recovery event");
    assert.equal(torn.result.turns, 1);
    void canonicalize; void sha256;
    void readAll;
  } finally {
    child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});
