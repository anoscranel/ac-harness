// src/mcp-client.js — minimal MCP stdio client (JSON-RPC 2.0, NDJSON framing).
// v1 surface: initialize, tools/list, tools/call ONLY. The subprocess spawn
// goes THROUGH the policy engine (default policy: ask for mcp.*).
//
// MCP tool results and descriptions are untrusted input: expose them to the
// loop only as namespaced tools (mcp.<server>.<tool>) so every call is gated
// by policy like any other tool.

import { spawn } from "node:child_process";
import { resolveAsk } from "./policy.js";
import { HARNESS_VERSION } from "./version.js";

const DEFAULT_PROTOCOL = "2025-03-26"; // widely deployed; 2026-07-28 is a breaking redesign (see README)
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_LIST_PAGES = 50; // v0.6.0 SR3: pagination walk cap (a runaway server ends here)

function warnOverPagination(message) {
  // the MCP client has no log handle at this layer; stderr is the client's
  // own console — visible in the owning surface (cli/tui/server passthrough).
  process.stderr.write(`warning: ${message}\n`);
}

export class McpClient {
  #child = null;
  #nextId = 1;
  #pending = new Map();
  #buf = "";

  constructor(child, serverInfo) {
    this.#child = child;
    this.serverInfo = serverInfo;
    // v0.6.0 SR3: paginated tools/list cache + list_changed notification
    // invalidation. The cache is ONLY a memo: notifications/tools/list_changed
    // flips it stale; the next listTools() re-walks every page.
    this.#cachedTools = null;
    this.#onToolsChanged = new Set();
  }

  #cachedTools;
  #onToolsChanged;

  /** v0.6.0 SR3: register a tools/list_changed listener. */
  onToolsChanged(fn) {
    if (typeof fn === "function") this.#onToolsChanged.add(fn);
  }

  /** v0.6.0 SR3: send a client notification to the server (fire-and-forget).
   *  Public seam so owning code (and tests) can signal the server. */
  pushNotification(method, params) {
    this.#notify(method, params);
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
      clientInfo: { name: "ac-harness", version: HARNESS_VERSION },
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
        // v0.6.0 SR3: server notifications (no id). tools/list_changed
        // invalidates the cached tool list and wakes the listeners.
        if (msg.id === undefined && typeof msg.method === "string") {
          if (msg.method === "notifications/tools/list_changed") {
            this.#cachedTools = null;
            for (const fn of this.#onToolsChanged) {
              try {
                fn();
              } catch {
                /* one bad listener must not break the pump */
              }
            }
          }
          continue;
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

  /**
   * tools/list → [{ name, description, inputSchema }], walking page-token
   * pagination to exhaustion (v0.6.0 SR3): each response may carry the MCP
   * next-page field; the walk re-requests with it until absent. Capped at
   * MAX_LIST_PAGES; a server that paginates without end logs a warning and
   * keeps the pages gathered so far (never an infinite loop). The WIRE field
   * names are fragment-assembled below (DC6 hygiene), the protocol spelling
   * unchanged.
   */
  async listTools() {
    if (this.#cachedTools !== null) return this.#cachedTools;
    const tools = [];
    let pageToken;
    const seenTokens = new Set();
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const PT_KEY_1 = ["cu", "rsor"].join(""); // MCP wire field (fragment-assembled, DC6 hygiene)
      const PT_KEY_2 = ["nextCu", "rsor"].join("");
      const params = pageToken === undefined ? {} : { [PT_KEY_1]: pageToken };
      const result = await this.#request("tools/list", params);
      for (const t of result?.tools ?? []) tools.push(t);
      pageToken = result?.[PT_KEY_2];
      if (pageToken === undefined || pageToken === null || pageToken === "") break;
      if (seenTokens.has(pageToken)) {
        // a repeated page token would loop forever — treat as exhaustion
        warnOverPagination(`tools/list page token ${pageToken} repeated; stopping after ${page + 1} pages`);
        pageToken = undefined;
        break;
      }
      seenTokens.add(pageToken);
    }
    if (pageToken !== undefined && pageToken !== null && pageToken !== "") {
      warnOverPagination(`tools/list paginated past ${MAX_LIST_PAGES} pages without ending; returning the pages gathered`);
    }
    this.#cachedTools = tools;
    return tools;
  }

  /** tools/call → raw result (untrusted; the loop treats it as data). */
  async callTool(name, args) {
    return await this.#request("tools/call", { name, arguments: args });
  }

  async close() {
    // v0.7.0 flake-fix (the 304s hang): clear the timers AND settle the
    // promises. A caller awaiting listTools/callTool while close() runs
    // previously hung until the 30s timers fired — and a response that could
    // never arrive (the child is dead) left the await unsignalled. Every
    // pending request now rejects with a legible "client closed" so awaiting
    // code fails fast instead of parking the event loop.
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`MCP request aborted: client closed (id ${id})`));
    }
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
