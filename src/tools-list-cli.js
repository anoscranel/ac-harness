// src/tools-list-cli.js — v0.10.0 S1c: `ac-harness tools`. A READ-ONLY
// listing of what a session would run: builtins, then every mcp.<server>
// group that arrived. Connects the declared servers briefly (list only,
// close immediately) because a dead server's absence is exactly the
// information the command exists to show. Never calls a tool.

import { createRegistry } from "./tools/index.js";
import { connectMcpTools } from "./mcp-bridge.js";
import { loadMcpConfig, enabledServers } from "./mcp-config.js";
import { resolve } from "node:path";

/**
 * @param {string[]} argv (unused today; reserved)
 * @param {{stdout?:{write:(s:string)=>void}, configPath?:string, policy?:Policy, log?:EventLog}} [opts]
 * @returns {Promise<{lines:string[], exitCode:number}>}
 */
export async function toolsCommand(argv = [], { stdout = process.stdout, configPath, policy, log } = {}) {
  const realConfigPath = configPath ?? resolve(process.cwd(), "mcp.config.json");
  const lines = [];
  const out = (s) => {
    lines.push(s);
    if (stdout) stdout.write(s + "\n");
  };

  const registry = createRegistry(); // builtins, always
  const builtins = registry.schemas();
  out(`builtin (${builtins.length}):`);
  for (const t of builtins) out(`  ${t.name} — ${t.description}`);

  // MCP servers: connect read-only, list, close. A missing config = the
  // honest "no mcp.config.json" line (not a failure).
  const config = await loadMcpConfig(realConfigPath, { warn: (m) => out(m) });
  const planned = enabledServers(config);
  if (planned.length === 0) {
    out(`mcp (0): no mcp.config.json servers (declare mcp.config.json)`);
    return { lines, exitCode: 0 };
  }

  let connectedCount = 0;
  const groups = {};
  if (policy && log) {
    // Full connect via the bridge (policy-gated spawn, failure isolation,
    // mcp.server.error logged into the caller's log).
    const { extras, close } = await connectMcpTools({ configPath: realConfigPath, policy, log });
    for (const name of Object.keys(extras)) {
      // repair-card MINOR 2: dots are legal in TOOL names (and never in
      // server names — the config regex). Parse by FIRST dot, not split:
      // "mcp.<server>.<rest-with-dots>".
      if (!name.startsWith("mcp.")) continue;
      const rest = name.slice(4);
      const dot = rest.indexOf(".");
      if (dot < 1) continue; // no tool part
      const server = rest.slice(0, dot);
      const tool = rest.slice(dot + 1);
      (groups[server] ??= []).push(tool);
    }
    connectedCount = Object.keys(groups).length;
    await close();
  } else {
    // No policy/log handed in (a bare `ac-harness tools` probe before any
    // session exists): list the DECLARED servers and their enabled state
    // without spawning anything — honest about not having connected.
    for (const s of planned) {
      groups[s.name] = null; // declared but not listed
    }
  }

  const total = Object.values(groups).reduce((n, g) => n + (g?.length ?? 0), 0);
  out(`mcp (${total} tool(s), ${connectedCount > 0 || Object.keys(groups).length > 0 ? Object.keys(groups).length : 0} server(s)):`);
  for (const [server, tools] of Object.entries(groups)) {
    if (tools === null) {
      out(`  mcp.${server} — declared, enabled (tools listed at session start; run from a session to see them)`);
    } else {
      out(`  mcp.${server} (${tools.length}):`);
      for (const t of tools.sort()) out(`    ${t}`);
    }
  }
  return { lines, exitCode: 0 };
}

export default toolsCommand;
