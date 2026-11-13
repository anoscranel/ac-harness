// src/acp.js — ship-3 spec §2: the ACP (agentclientprotocol) AGENT side.
// Narrow by design: initialize / session/new / session/load (unsupported) /
// session/prompt (streaming session/update with agent_message_chunk) /
// session/cancel. One ACP session per process; cancel aborts the in-flight
// turn. Every prompt runs through a real loop with the same policy engine;
// `ask` → deny via remoteDecide (no human on this stream, and a remote
// caller cannot answer its own permission prompt — spec §0).
//
// ONE PROTOCOL PER PROCESS: this file never serves MCP. Both spec conformance
// and bin routing keep them on separate stdio streams.

import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { EventLog } from "./events.js";
import { Policy } from "./policy.js";
import { defaultRules } from "./policy-defaults.js";
import { createRegistry } from "./tools/index.js";
import { remoteDecide } from "./remote-policy.js";
import { decide } from "./context.js";
import { createLoop } from "./loop.js";
import echo from "./providers/echo.js";
import { HARNESS_VERSION } from "./version.js";

const MAX_LINE = 1 << 20;

/**
 * Serve ACP over stdio. Layout of a session/prompt:
 *   request session/prompt {prompt}
 *   → notify session/update {sessionId, update:{sessionUpdate:"agent_message_chunk",
 *        content:{type:"text", text}}…}   (one per provider chunk)
 *   → respond {stopReason:"end_turn"} on clean completion
 *     (or {"stopReason":"cancelled"} after a session/cancel)
 * Tool calls inside a prompt are admitted only through the policy gate:
 * a remote `ask` denies and the DENIED tool output is appended into the
 * streamed message (the same deny-and-continue posture as headless run).
 */
export async function serveAcp({
  stdin = process.stdin,
  stdout = process.stdout,
  logDir = "logs",
  logName = `acp-${Date.now()}.jsonl`,
} = {}) {
  await mkdir(resolve(logDir), { recursive: true });
  const logPath = resolve(logDir, logName);
  const log = await EventLog.open(logPath);
  const policy = new Policy({ rules: defaultRules(), logPath });
  const registry = createRegistry();

  const send = (obj) => stdout.write(JSON.stringify(obj) + "\n");
  const respond = (id, result) => send({ jsonrpc: "2.0", id, result });
  const respondError = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
  const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

  /** ONE ACP session per process (spec §2 boundary). */
  let loop = null;
  let sessionId = null;
  let streamingPrompt = null; // {cancelled, controller}
  let promptSeq = 0;

  const rl = createInterface({ input: stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (Buffer.byteLength(line, "utf8") > MAX_LINE) {
      let bigId = null;
      try {
        const probe = JSON.parse(line);
        if (probe && probe.id !== undefined) bigId = probe.id;
      } catch { /* unparseable: null id */ }
      respondError(bigId, -32600, "request too large (line > 1 MiB rejected)");
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      respondError(null, -32700, "parse error");
      continue;
    }
    if (msg.method === undefined) continue;
    const id = msg.id;
    switch (msg.method) {
      case "initialize":
        respond(id, {
          protocolVersion: 1,
          agentCapabilities: { promptStreaming: true, loadSession: false },
          authMethods: [],
        });
        break;
      case "session/new": {
        promptSeq = 0;
        sessionId = `acp-session-${Date.now()}`;
        loop = createLoop({
          provider: echo,
          tools: registry,
          policy,
          log,
          decide,
          // ask → deny on this surface: there is no human here, and a remote
          // caller cannot answer its own permission prompt (spec §0).
          askResolver: async () => "deny",
          config: { session: sessionId, harness_version: HARNESS_VERSION },
        });
        respond(id, { sessionId });
        break;
      }
      case "session/load": {
        // v0.10.0 S2: the event log IS the session store. Load = resolve the
        // log, replay it through the same resume() path (torn tail tolerated
        // to the last intact event), answer with the descriptor + the honest
        // limits. Not-found = an error naming the tried path.
        let candidate;
        if (typeof msg.params?.logPath === "string" && msg.params.logPath !== "") {
          candidate = resolve(msg.params.logPath);
        } else if (typeof msg.params?.sessionId === "string" && msg.params.sessionId !== "") {
          candidate = resolve(logDir.replace(/[\\/]$/, ""), `${msg.params.sessionId}.jsonl`);
        } else {
          respondError(id, -32602, "session/load requires sessionId or logPath");
          break;
        }
        const { readFile: rf } = await import("node:fs/promises");
        try {
          await rf(candidate, "utf8");
        } catch {
          respondError(id, -32602, `session/load: log not found (tried ${candidate})`);
          break;
        }
        // one ACP session per process: a load REPLACES the live session's
        // state (the old loop's log stays on disk; this process now serves
        // the loaded transcript).
        const { readAll } = await import("./events.js");
        // One ACP session per process: a load points the LIVE session at the
        // loaded transcript. The loop is rebuilt ON THE LOADED LOG (same
        // createLoop + resume() path as the REPL's /resume) so the streamed
        // continuation carries the loaded context.
        const loadedLog = await EventLog.open(candidate);
        const loadedPolicy = new Policy({ rules: defaultRules(), logPath: candidate });
        loop = createLoop({
          provider: echo,
          tools: registry,
          policy: loadedPolicy,
          log: loadedLog,
          decide,
          askResolver: async () => "deny",
          config: { session: msg.params?.sessionId ?? candidate, harness_version: HARNESS_VERSION },
        });
        await loop.resume(); // v0.10.0 S2: the SAME resume() path as the REPL
        const evs = await readAll(candidate);
        const turns = evs.filter((e) => e.type === "turn.start").length;
        respond(id, {
          sessionId: msg.params?.sessionId ?? candidate,
          log: candidate,
          turns,
          events: evs.length,
          stopped_at: evs.filter((e) => e.type === "session.end").length > 0,
          limits: [
            "transcript + turn state only",
            "policy session-rules are per-process and NOT restored",
            "tools are never re-run",
            "a torn tail loads to the last intact event",
          ],
        });
        break;
      }
      case "session/prompt": {
        const text = msg.params?.prompt ?? "";
        if (!loop) { respondError(id, -32602, "no session: call session/new first"); break; }
        if (streamingPrompt) { respondError(id, -32602, "a prompt is already streaming (one per process)"); break; }
        promptSeq += 1;
        const controller = new AbortController();
        streamingPrompt = { cancelled: false, controller, promptSeq };
        let final = "";
        const streamSub = (ev) => {
          if (ev.type === "turn.provider.chunk" && ev.data?.delta && ev.seq > 0) {
            if (ev.data.delta) final += ev.data.delta;
            notify("session/update", {
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: ev.data.delta },
              },
            });
          }
        };
        log.on("event", streamSub);
        let result;
        try {
          result = await loop.start(text);
        } catch (err) {
          log.off("event", streamSub);
          streamingPrompt = null;
          respondError(id, -32603, `agent error: ${err?.message ?? err}`);
          break;
        }
        log.off("event", streamSub);
        const wasCancelled = streamingPrompt.cancelled;
        streamingPrompt = null;
        // stopReason per ACP: end_turn on clean completion; the harness
        // records an aborted turn (user cancel) as stopReason "cancelled".
        respond(id, {
          stopReason: result.aborted === true ? "cancelled" : "end_turn",
          ...(wasCancelled ? { cancelled: true } : {}),
        });
        break;
      }
      case "session/cancel": {
        if (streamingPrompt) {
          streamingPrompt.cancelled = true;
          streamingPrompt.controller.abort(); // mirrors loop.abort() semantics
          loop.abort();
          respond(id, { cancelled: true });
        } else {
          respond(id, { cancelled: false });
        }
        break;
      }
      default:
        respondError(id, -32601, `method not found: ${msg.method}`);
    }
  }
  return { logPath };
}

export default serveAcp;

// entry: `node src/acp.js` serves ACP over stdio (never MCP — one protocol
// per process).
if (import.meta.url === `file://${process.argv[1]}`) {
  serveAcp().catch((err) => {
    process.stderr.write(`acp fatal: ${err.message}\n`);
    process.exit(1);
  });
}
