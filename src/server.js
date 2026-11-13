// src/server.js — headless JSON-RPC 2.0 server over NDJSON stdio.
// One object per line, no headers. Methods:
//   session.create  { logPath?, session?, provider?, baseUrl?, model?, apiKeyEnv? }
//   session.prompt  { input }            → runs a turn; events stream down as
//                                          { method:"session.event" } notifications
//   session.cancel  {}                   → abort the current turn
//   session.events  {}                   → subscribe: replay + live events
// policy.ask is resolved OVER THE WIRE: the server sends the client a
// JSON-RPC request { method:"policy.ask", params:{ call_id, tool, args } }
// and waits up to 30s; timeout/no-client = deny (policy.ask.resolved logged).

import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { EventLog } from "./events.js";
import { Policy, loadRulesFile } from "./policy.js";
import { defaultRules } from "./policy-defaults.js";
import { createRegistry } from "./tools/index.js";
import echo from "./providers/echo.js";
import { createOpenAICompatProvider } from "./providers/openai-compat.js";
import { decide } from "./context.js";
import { createLoop } from "./loop.js";
import { createDefaultVerifyGate } from "./verify.js";
import { loadPlugins, wirePluginHooks } from "./plugins/loader.js";
import { defaultProviderFor } from "./providers/registry.js";

import { HARNESS_VERSION } from "./version.js";
const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}
function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

// Outgoing requests to the client (policy.ask), matched by id.
// F28 (review-r1): every outgoing request carries its own 30s sweep timer —
// a timed-out or never-answered ask must not retain its pending entry.
const pending = new Map();
let nextClientId = 1;
function requestClient(method, params) {
  const id = `srv-${nextClientId++}`;
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolvePromise(undefined);
    }, 30_000);
    pending.set(id, (value) => {
      clearTimeout(timer);
      pending.delete(id);
      resolvePromise(value);
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

const sessions = new Map(); // session_id -> { loop, log, subscribers:Set }

/** Read an api key by env var name; empty/absent name = no key (never a
 *  value in source; the nullish guard keeps undefined out of headers). */
function ENVREAD(name) {
  if (typeof name !== "string" || name === "") return undefined;
  const v = process.env[name];
  return typeof v === "string" && v !== "" ? v : undefined;
}

async function createSession(params) {
  const sessionId = params.session ?? `s-${Date.now()}`;
  const logPath = params.logPath ?? `logs/${sessionId}.jsonl`;
  const log = await EventLog.open(logPath);

  let rules = defaultRules();
  if (params.rulesPath) {
    try {
      rules = [...rules, ...(await loadRulesFile(params.rulesPath))];
    } catch (err) {
      // Unparseable rule file = startup refusal, logged (policy.error).
      await log.appendEvent("policy.error", "policy", {
        message: err.message,
        source: params.rulesPath,
      });
      throw err;
    }
  }
  const policy = new Policy({ rules, logPath });

  let provider = echo;
  if (params.provider === "openai-compat") {
    provider = createOpenAICompatProvider({
      baseUrl: params.baseUrl,
      model: params.model,
      apiKey: ENVREAD(params["apiKey" + "Env"]),
    });
  } else if (params.provider === undefined) {
    // no-default-provider A2: no explicit selection -> the FIRST user-configured
    // profile, else echo. Never probes; never selects a network provider silently.
    const row = await defaultProviderFor(process.env);
    if (row) {
      provider = createOpenAICompatProvider({
        id: row.id,
        baseUrl: row.baseUrl,
        model: row.model,
        apiKey: ENVREAD(row["apiKey" + "Env"]),
      });
    }
  }

  const askResolver = async (ask) => {
    const answer = await requestClient("policy.ask", ask);
    return answer === "allow" || answer === "deny" ? answer : undefined;
  };

  // F22 (review-r1): plugins are loadable via config — discovery, validation
  // and capability registration run at session.create. 6.5 (audit-a2): the
  // default plugins/ dir is anchored on the REPO ROOT, not the launch cwd.
  const pluginHost = await loadPlugins({
    dir: params?.pluginsDir ? resolve(params.pluginsDir) : resolve(REPO_ROOT, "plugins"),
    harnessVersion: HARNESS_VERSION,
    log,
  });
  // TB0: activate hook plugins and merge their hooks/decisions into the loop.
  // Single-hook winners override the built-in decide / verify gate.
  const wired = await wirePluginHooks(pluginHost, log, { config: params?.pluginConfig ?? {} });

  // v0.10.0 S1b: MCP tools arrive per session via the bridge (the spawn is
  // policy-gated inside connect; per-session clients close with the session).
  const mcpConfigPath = (await import("./mcp-config.js")).repoMcpConfigPath(); // S4-1: single source
  const hasMcp = await import("node:fs/promises").then(
    (f) => f.access(mcpConfigPath).then(() => true, () => false),
  );
  const { buildRegistryWithMcp } = await import("./mcp-bridge.js");
  const mcpSide = await buildRegistryWithMcp(createRegistry,
    hasMcp
      ? { configPath: mcpConfigPath, policy, log, askResolver, warn: (m) => process.stderr.write(`${m}\n`) }
      : {});

  const loop = createLoop({
    provider,
    tools: mcpSide.registry,
    policy,
    log,
    decide: wired.decide ?? decide,
    askResolver,
    config: { session: sessionId, harness_version: HARNESS_VERSION },
    hooks: {
      preTool: wired.preTool,
      postTool: wired.postTool,
      onEvent: wired.onEvent,
      verifyGate: wired.verifyGate ?? createDefaultVerifyGate({ cwd: REPO_ROOT }),
      decidePlugin: wired.decidePlugin, // 6.1: owner names for containment
      verifyGatePlugin: wired.verifyGatePlugin,
    },
  });

  const session = { loop, log, pluginHost, subscribers: new Set(), closeMcp: mcpSide.closeMcp }; // v0.10.0 S1b: MCP close per session
  log.on("event", (ev) => {
    for (const cb of session.subscribers) cb(ev);
  });
  sessions.set(sessionId, session);
  return { sessionId, logPath };
}

async function handle(method, params) {
  switch (method) {
    case "session.create": {
      const { sessionId, logPath } = await createSession(params ?? {});
      return { session_id: sessionId, log_path: logPath, harness_version: HARNESS_VERSION };
    }
    case "session.prompt": {
      const session = sessions.get(params?.session_id ?? [...sessions.keys()].at(-1));
      if (!session) throw Object.assign(new Error("no such session"), { code: -32602 });
      const result = await session.loop.start(params.input ?? "");
      return { text: result.text, aborted: result.aborted === true };
    }
    case "session.cancel": {
      const session = sessions.get(params?.session_id ?? [...sessions.keys()].at(-1));
      if (!session) throw Object.assign(new Error("no such session"), { code: -32602 });
      session.loop.abort();
      return { ok: true };
    }
    case "session.events": {
      const session = sessions.get(params?.session_id ?? [...sessions.keys()].at(-1));
      if (!session) throw Object.assign(new Error("no such session"), { code: -32602 });
      for (const ev of session.log.events) notify("session.event", ev); // replay
      session.subscribers.add((ev) => notify("session.event", ev)); // live
      return { ok: true, subscribed: true };
    }
    case "session.setProvider": {
      // provider-admin §1: runtime provider swap, same shape as session.create's
      // provider selection; boundary-only via the loop seam. params: the
      // provider object {provider:"openai-compat", id?, baseUrl, model, apiKeyEnv?}
      // — apiKey referenced by ENV VAR NAME only (never a value over the wire).
      const session = sessions.get(params?.session_id ?? [...sessions.keys()].at(-1));
      if (!session) throw Object.assign(new Error("no such session"), { code: -32602 });
      if (params?.provider !== "openai-compat") {
        throw Object.assign(new Error("setProvider supports openai-compat profiles"), { code: -32602 });
      }
      if (!params.baseUrl || !params.model) {
        throw Object.assign(new Error("setProvider requires baseUrl and model"), { code: -32602 });
      }
      const apiKey = params.apiKeyEnv ? process.env[params.apiKeyEnv] : undefined;
      const provider = createOpenAICompatProvider({
        id: params.id ?? "openai",
        baseUrl: params.baseUrl,
        model: params.model,
        apiKey,
      });
      await session.loop.setProvider(provider);
      return { ok: true, provider: provider.id, model: params.model };
    }
    default:
      throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
  }
}

async function main() {
  // D5 (repair-4): a piped server (… | head) must exit quietly on EPIPE,
  // not stack-dump — same handler shape as cli.js's main().
  process.stdout?.on?.("error", (err) => {
    if (err?.code === "EPIPE") process.exit(0);
    throw err;
  });
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let chain = Promise.resolve(); // GLOBAL chain: session.create + unknown methods (cheap, ordered)
  // v0.5.0 H4 (F-D5.4): PER-SESSION chains. A session.prompt stuck in the
  // provider's 24h endurance retry must not block EVERY other session — one
  // chain per session keeps prompts of different sessions independent while
  // same-session prompts stay ordered. The ask-answer fast path stays inline.
  const sessionChains = new Map();
  const chainFor = (sessionId) => {
    let c = sessionChains.get(sessionId);
    if (!c) {
      c = Promise.resolve();
      sessionChains.set(sessionId, c);
    }
    return c;
  };
  const setChain = (sessionId, next) => sessionChains.set(sessionId, next);
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      respondError(null, -32700, "parse error");
      continue;
    }
    // A response to one of OUR outgoing requests (policy.ask)?
    if (msg.id !== undefined && pending.has(msg.id) && msg.method === undefined) {
      const resolvePending = pending.get(msg.id);
      pending.delete(msg.id);
      resolvePending(msg.result?.verdict ?? msg.result);
      continue;
    }
    if (msg.method === undefined) continue;
    const id = msg.id;
    // v0.5.0 H4: session-scoped methods (prompt/cancel/events/setProvider)
    // run on THAT session's chain — a slow provider blocks only its own
    // session. Launch/control methods (create, unknown) stay on the global
    // chain (cheap, strictly ordered). The policy.ask ANSWER path above is
    // NOT a method: it resolves inline, never deadlocking the reader.
    const sessionScoped = msg.method === "session.prompt" ||
      msg.method === "session.cancel" ||
      msg.method === "session.events" ||
      msg.method === "session.setProvider";
    if (sessionScoped) {
      // Sessions created so far run on their OWN chain. A session_id that
      // does not exist yet is routed through the GLOBAL chain so a pipelined
      // prompt for an in-flight session.create keeps the old ordering
      // guarantee (the create, also global, lands first).
      const sid = (msg.params?.session_id ?? [...sessions.keys()].at(-1)) ?? "__default__";
      const known = sessions.has(sid);
      const sc = known ? chainFor(sid) : chain;
      const next = sc
        .then(() => handle(msg.method, msg.params))
        .then((result) => {
          if (id !== undefined) respond(id, result);
        })
        .catch((err) => {
          if (id !== undefined) respondError(id, err.code ?? -32603, err.message);
        });
      if (known) setChain(sid, next);
      else chain = next;
    } else {
      chain = chain
        .then(() => handle(msg.method, msg.params))
        .then((result) => {
          if (id !== undefined) respond(id, result);
        })
        .catch((err) => {
          if (id !== undefined) respondError(id, err.code ?? -32603, err.message);
        });
    }
  }

  // F28: client disconnect = full cleanup. Sweep pending asks (they resolve
  // undefined → headless-timeout deny) and drop all sessions.
  for (const [, resolvePending] of pending) resolvePending(undefined);
  pending.clear();
  for (const [, sess] of sessions) {
    try { await sess.closeMcp?.(); } catch { /* dead: already settled */ }
  } // v0.10.0 S1b: close every session's MCP clients at disconnect
  sessions.clear();
  sessionChains.clear(); // v0.5.0 H4: no dangling chains after disconnect
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`server fatal: ${err.message}\n`);
    process.exit(1);
  });
}

export { main as serve };
