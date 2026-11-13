// src/mcp-bridge.js — v0.10.0 S1b: connect declared servers at session
// start, project their tools into the registry extras, isolate failures.
// The bridge OWNS the lifecycle: startup connect per enabled server, a
// failed start logs mcp.server.error {server, reason} and contributes ZERO
// tools (the session starts with the rest); a call through a closed/dead
// server returns an error result, never a hang; close() ends every live
// connection at session end.
//
// THREAT POSTURE UNCHANGED (the card's self-pushback 1): the spawn happens
// through McpClient.connect — policy-gated ("mcp.spawn" evaluate) exactly as
// it always was; tools land as mcp.<server>.<tool> so EVERY call gates on
// defaults.ask_mcp; env passes ONLY the names in envFrom (delegate-style
// allowlist; never the whole environment — a config that would pass
// everything is rejected at LOAD time, not here).

import { McpClient, mcpToolsAsRegistry } from "./mcp-client.js";
import { loadMcpConfig, spawnEnv, enabledServers } from "./mcp-config.js";

/**
 * Connect every enabled server in mcp.config.json and project their tools
 * into registry extras.
 *
 * @param {object} opts
 * @param {string} [opts.configPath] absolute path to mcp.config.json
 * @param {Policy} opts.policy the session's policy engine (spawn gate + call gate)
 * @param {EventLog} opts.log the session's event log (mcp.server.error lands here)
 * @param {(ask:object)=>Promise<"allow"|"deny"|undefined>} [opts.askResolver]
 *   the session's interactive ask resolver (headless deny-on-timeout default)
 * @param {(msg:string)=>void} [opts.warn] caller's warn channel (config drops)
 * @returns {Promise<{extras:Object, clients:Object<string, McpClient>, close:()=>Promise<void>}>}
 *   extras: the registry-ready mcp.<server>.<tool> entries; close() for session end.
 */
export async function connectMcpTools({
  configPath,
  policy,
  log,
  askResolver,
  warn = null,
} = {}) {
  const config = await loadMcpConfig(configPath, { warn });
  const extras = {};
  const clients = {};

  for (const server of enabledServers(config)) {
    let client = null;
    try {
      client = await McpClient.connect({
        command: server.command,
        args: server.args,
        policy,
        log,
        askResolver,
      });
      const tools = await client.listTools(); // pagination handled inside
      Object.assign(extras, mcpToolsAsRegistry(server.name, client, tools));
      clients[server.name] = client;
    } catch (err) {
      // Failure isolation (DC3): the server contributes ZERO tools; the
      // session starts with the rest; the reason is a durable event.
      const reason = String(err?.message ?? err);
      if (client) {
        try {
          // the connect may have spawned then died mid-handshake — settle it
          await client.close();
        } catch {
          /* already dead */
        }
        client = null;
      }
      if (typeof log?.appendEvent === "function") {
        try {
          await log.appendEvent("mcp.server.error", "harness", {
            server: server.name,
            reason,
          });
        } catch {
          /* the log is best-effort here, never the blocker */
        }
      }
      // The failed entry contributes no extras by construction (nothing
      // was assigned into extras before the throw) — continue with the rest.
    }
  }

  async function close() {
    for (const [name, c] of Object.entries(clients)) {
      try {
        await c.close();
      } catch {
        /* already dead: closing a dead client is a no-op, say nothing */
      }
      delete clients[name];
    }
  }

  return { extras, clients, close };
}

/**
 * Build the registry this session should use: builtins + MCP extras.
 * A caller without an MCP config gets the plain builtin registry (today's
 * exact behaviour — the additive guarantee).
 *
 * @param {Function} createRegistry from tools/index.js
 * @param {object} opts as connectMcpTools
 * @returns {Promise<{registry:object, closeMcp:()=>Promise<void>}>}
 */
export async function buildRegistryWithMcp(createRegistry, opts = {}) {
  if (!opts.configPath) {
    // no config named = nothing to connect; zero behavior change
    return { registry: createRegistry(), closeMcp: async () => {} };
  }
  const { extras, close } = await connectMcpTools(opts);
  return {
    registry: createRegistry(extras),
    closeMcp: close,
  };
}

export default { connectMcpTools, buildRegistryWithMcp };
