// src/mcp-client.js — minimal MCP stdio client (JSON-RPC 2.0, NDJSON framing).
// v1 surface: initialize, tools/list, tools/call ONLY. The subprocess spawn
// goes THROUGH the policy engine (default policy: ask for mcp.*).
//
// MCP tool results and descriptions are untrusted input: expose them to the
// loop only as namespaced tools (mcp.<server>.<tool>) so every call is gated
// by policy like any other tool.

import { spawn } from "node:child_process";
import { resolveAsk } from "./policy.js";

const DEFAULT_PROTOCOL = "2025-03-26"; // widely deployed; 2026-07-28 is a breaking redesign (see README)
const REQUEST_TIMEOUT_MS = 30_000;

export class McpClient {
  #child = null;
  #nextId = 1;
  #pending = new Map();
  #buf = "";

  constructor(child, serverInfo) {
    this.#child = child;
    this.serverInfo = serverInfo;
  }

  /**
   * Policy-gated connect. The spawn is evaluated as tool "mcp.spawn" BEFORE
   * any process exists; ask resolves through the environment's ask channel.
   */
  static async connect({ command, args = [], policy, log, askResolver, protocolVersion = DEFAULT_PROTOCOL }) {
    const call = { tool: "mcp.spawn", args: { command, args } };
    const decision = policy.evaluate(call);
    await log.appendEvent("policy.decision", "policy", {
      call_id: `mcp-spawn-${Date.now()}`,
      verdict: decision.verdict,
      rule_path: decision.rule_path,
    });
    let allowed = decision.verdict === "allow";
    if (decision.verdict === "ask") {
      const res = await resolveAsk({
        call_id: "mcp-spawn",
        tool: "mcp.spawn",
        args: call.args,
        askFn: askResolver,
      });
      await log.appendEvent("policy.ask.resolved", "policy", {
        call_id: "mcp-spawn",
        verdict: res.verdict,
        resolved_by: res.resolved_by,
        timeout_ms: res.timeout_ms,
      });
      allowed = res.verdict === "allow";
    }
    if (!allowed) throw new Error(`MCP spawn denied by policy: ${command}`);

    // F2 (review-r1): detached group so close() can kill the whole tree.
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "inherit"],
      detached: process.platform !== "win32",
    });
    const client = new McpClient(child, null);
    client.#pump();

    const init = await client.#request("initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "agent-harness", version: "0.1.0" },
    });
    client.serverInfo = init?.serverInfo ?? null;
    client.#notify("notifications/initialized", {});
    return client;
  }

  #pump() {
    const MAX_BUF = 16 << 20; // F27: 16 MiB parser buffer; overflow aborts.
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk) => {
      this.#buf += chunk;
      if (this.#buf.length > MAX_BUF) {
        for (const [, p] of this.#pending) {
          clearTimeout(p.timer);
          p.reject(new Error("MCP parser buffer overflow (16 MiB); connection aborted"));
        }
        this.#pending.clear();
        this.#killGroup();
        return;
      }
      let nl;
      while ((nl = this.#buf.indexOf("\n")) >= 0) {
        const line = this.#buf.slice(0, nl).trim();
        this.#buf = this.#buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // tolerate non-JSON noise on stdout
        }
        if (msg.id !== undefined && this.#pending.has(msg.id)) {
          const { resolve: res, reject: rej, timer } = this.#pending.get(msg.id);
          this.#pending.delete(msg.id);
          clearTimeout(timer);
          if (msg.error) rej(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
          else res(msg.result);
        }
      }
    });
  }

  #killGroup() {
    try {
      process.kill(-this.#child.pid, "SIGTERM");
    } catch {
      try {
        this.#child.kill("SIGTERM");
      } catch {
        /* already dead */
      }
    }
  }

  #send(obj) {
    this.#child.stdin.write(JSON.stringify(obj) + "\n");
  }

  #notify(method, params) {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  #request(method, params) {
    const id = this.#nextId++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rej(new Error(`MCP request ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve: res, reject: rej, timer });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** tools/list → [{ name, description, inputSchema }] */
  async listTools() {
    const result = await this.#request("tools/list", {});
    return result?.tools ?? [];
  }

  /** tools/call → raw result (untrusted; the loop treats it as data). */
  async callTool(name, args) {
    return await this.#request("tools/call", { name, arguments: args });
  }

  async close() {
    for (const [, p] of this.#pending) clearTimeout(p.timer);
    this.#pending.clear();
    this.#killGroup();
  }
}

/**
 * Wrap an MCP server's tools as namespaced registry entries
 * ("mcp.<serverName>.<tool>") so the loop gates every call through policy.
 */
export function mcpToolsAsRegistry(serverName, client, tools) {
  const out = {};
  for (const t of tools) {
    const nsName = `mcp.${serverName}.${t.name}`;
    out[nsName] = {
      name: nsName,
      description: t.description ?? "",
      argsSchema: t.inputSchema ?? { type: "object" },
      run: async (args) => {
        const result = await client.callTool(t.name, args);
        const text = (result?.content ?? [])
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        return { ok: result?.isError !== true, output: text, error: result?.isError ? text : undefined };
      },
    };
  }
  return out;
}

export default McpClient;
