// src/mcp-server.js — ship-3 spec §1: the harness AS an MCP server (stdio).
// Tools-only, no resources, no prompts, no server-initiated list_changed
// (spec §5). One process serves ONE protocol — this file never speaks ACP.
//
// Threat model (spec §0) is enforced at the policy layer:
//   - remoteDecide maps `ask` → deny (a remote caller cannot answer its own
//     permission prompt);
//   - delegate + memory_remember are not even listed (REMOTE_HIDDEN_TOOLS);
//   - the pinned log-path deny applies identically (Policy.evaluate, first).
// Every call appends tool.proposed + policy.decision + tool.result with
// actor "remote" into a shared event log — the same audit surface every
// other harness surface writes to.

import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { EventLog, sha256 } from "./events.js";
import { Policy } from "./policy.js";
import { defaultRules } from "./policy-defaults.js";
import { createRegistry } from "./tools/index.js";
import { HARNESS_VERSION } from "./version.js";
import { remoteDecide, remoteToolList, isHiddenFromRemote } from "./remote-policy.js";

const PROTOCOL_VERSION = "2025-03-26";
const MAX_LINE = 1 << 20; // spec hard rule: reject any line > 1 MiB

/** JSON-RPC framing: one complete message per line (NDJSON — same as server.js). */
export async function serveMcp({
  stdin = process.stdin,
  stdout = process.stdout,
  logDir = "logs",
  logName = `mcp-server-${Date.now()}.jsonl`,
} = {}) {
  await mkdir(resolve(logDir), { recursive: true });
  const logPath = resolve(logDir, logName);
  const log = await EventLog.open(logPath);
  const policy = new Policy({ rules: defaultRules(), logPath });
  const registry = createRegistry();
  const rl = createInterface({ input: stdin, crlfDelay: Infinity });

  const send = (obj) => stdout.write(JSON.stringify(obj) + "\n");
  const respond = (id, result) => send({ jsonrpc: "2.0", id, result });
  const respondError = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

  for await (const line of rl) {
    if (Buffer.byteLength(line, "utf8") > MAX_LINE) {
      // Bounded-input rule (hard): reject, never buffer. The id is extracted
      // best-effort so a well-formed-but-huge request still gets its id back.
      let bigId = null;
      try {
        const probe = JSON.parse(line);
        if (probe && probe.id !== undefined) bigId = probe.id;
      } catch { /* unparseable giant line: id stays null */ }
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
    if (msg.method === undefined) continue; // a response to nobody — ignore
    const id = msg.id;
    switch (msg.method) {
      case "initialize":
        respond(id, {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: "ac-harness", version: HARNESS_VERSION },
          capabilities: { tools: { listChanged: false } },
        });
        break;
      case "notifications/initialized":
        // client notification — no response, by protocol
        break;
      case "ping":
        respond(id, {});
        break;
      case "tools/list":
        respond(id, { tools: remoteToolList(registry) });
        break;
      case "tools/call":
        await handleCall(msg.params ?? {}, id);
        break;
      default:
        respondError(id, -32601, `method not found: ${msg.method}`);
    }
  }

  return { logPath };

  /**
   * The policy-gated call path (spec §1): policy FIRST (with the remote
   * shaping), then the SAME registry the loop uses, and the three-part
   * remote-actor event trail on every call — allowed or denied.
   */
  async function handleCall(params, id) {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (typeof name !== "string" || name === "") {
      respondError(id, -32602, "tools/call requires a string name");
      return;
    }
    if (isHiddenFromRemote(name)) {
      // hidden = not callable AND not listed; a name the client should never
      // have known. Unknown-tool shape, never a hint that it exists.
      respondError(id, -32602, `unknown tool: ${name}`);
      return;
    }
    const tool = registry.get(name);
    if (!tool) {
      respondError(id, -32602, `unknown tool: ${name}`);
      return;
    }

    const call_id = `remote-${Date.now()}`;
    await log.appendEvent("tool.proposed", "remote", {
      call_id,
      tool: name,
      args,
      args_sha: sha256(JSON.stringify(args ?? {})),
    });

    // dedupe the sha helper: events.js exports sha256
    const decision = remoteDecide(policy, { tool: name, args });
    await log.appendEvent("policy.decision", "remote", {
      call_id,
      verdict: decision.verdict,
      rule_path: decision.rule_path,
    });

    if (decision.verdict !== "allow") {
      const reason = decision.reason ?? "denied by policy";
      await log.appendEvent("tool.result", "remote", {
        call_id,
        ok: false,
        bytes: 0,
        duration_ms: 0,
        sha256: sha256(reason),
        error: `policy-denied (${decision.rule_path})`,
      });
      respond(id, { content: [{ type: "text", text: reason }], isError: true });
      return;
    }

    const t0 = Date.now();
    const result = await registry.run(name, args, { allowed: true, cwd: process.cwd() });
    const duration_ms = Date.now() - t0;
    const output = result.ok ? (result.output ?? "") : (result.error ?? "tool error");
    await log.appendEvent("tool.result", "remote", {
      call_id,
      ok: result.ok,
      bytes: result.bytes ?? Buffer.byteLength(output, "utf8"),
      duration_ms,
      sha256: sha256(output),
      ...(result.ok ? {} : { error: result.error ?? "tool error" }),
    });
    respond(id, {
      content: [{ type: "text", text: output }],
      ...(result.ok ? {} : { isError: true }),
    });
  }
}

export default serveMcp;

// entry: `node src/mcp-server.js` serves MCP over stdio (one protocol per
// process — this file never speaks ACP; bin dispatcher routes here).
if (import.meta.url === `file://${process.argv[1]}`) {
  serveMcp().catch((err) => {
    process.stderr.write(`mcp-server fatal: ${err.message}\n`);
    process.exit(1);
  });
}
