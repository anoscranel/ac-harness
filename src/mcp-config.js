// src/mcp-config.js — v0.10.0 S1a: servers declared once, as data.
// The same discipline as providers.config.json (registry.js rowOf): a strict
// whitelist validated at LOAD time, malformed entries DROPPED with a legible
// warning (never stored half-formed), never a startup blocker. env values
// are NOT accepted inline — only `envFrom`, a LIST of env-var NAMES the
// bridge reads from the process env at spawn time. An inline `env` object is
// a rejected config (a VALUE in a config file is exactly the disclosure class the
// rest of the harness refuses).

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Load + validate mcp.config.json.
 * @param {string} file absolute path
 * @param {{warn?: (msg:string)=>void}} [opts]
 * @returns {Promise<{servers: Object<string, {command:string, args:string[], envFrom:string[], enabled:boolean}>}>}
 *   normalized, validated rows; absent/wrong-shape file = zero servers.
 */
export async function loadMcpConfig(file, { warn = null } = {}) {
  const say = (msg) => {
    if (typeof warn === "function") warn(msg);
  };
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return { servers: {} }; // absent = zero servers, not a warn worth noise
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    say(`mcp.config.json unparseable: ${err.message} (no servers loaded)`);
    return { servers: {} };
  }
  if (data === null || typeof data !== "object" || data.servers === null || typeof data.servers !== "object") {
    say("mcp.config.json has wrong shape (need {servers:{...}}; no servers loaded)");
    return { servers: {} };
  }

  const servers = {};
  for (const [name, entry] of Object.entries(data.servers)) {
    if (!SERVER_NAME_RE.test(name)) {
      say(`mcp.config server "${name}" rejected: name must match ^[a-z0-9][a-z0-9-]*$ (it becomes the tool namespace)`);
      continue;
    }
    if (entry === null || typeof entry !== "object") {
      say(`mcp.config server "${name}" rejected: entry must be an object`);
      continue;
    }
    if (typeof entry.command !== "string" || entry.command === "") {
      say(`mcp.config server "${name}" rejected: command is a required non-empty string`);
      continue;
    }
    if (entry.env !== undefined) {
      // The one rule that cannot warn-and-drop: an inline env VALUE is the
      // value-in-config class itself. Rejected with the reason spelled out.
      say(`mcp.config server "${name}" rejected: inline "env" values are not accepted — pass variable NAMES via "envFrom" (the bridge reads the process env at spawn time)`);
      continue;
    }
    let args = [];
    if (entry.args !== undefined) {
      if (!Array.isArray(entry.args) || entry.args.some((a) => typeof a !== "string")) {
        say(`mcp.config server "${name}" rejected: args must be a string array`);
        continue;
      }
      args = entry.args;
    }
    let envFrom = [];
    if (entry.envFrom !== undefined) {
      if (!Array.isArray(entry.envFrom) || entry.envFrom.some((n) => typeof n !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(n))) {
        say(`mcp.config server "${name}" rejected: envFrom must be a list of env-var NAMES ([A-Z][A-Z0-9_]*`);
        continue;
      }
      envFrom = entry.envFrom;
    }
    servers[name] = {
      command: entry.command,
      args,
      envFrom, // NAMES ONLY — values are read from the process env at spawn
      enabled: entry.enabled === undefined ? true : entry.enabled === true,
    };
  }
  return { servers };
}

/**
 * Build the per-server spawn env (repair-card BLOCKER): a MINIMAL PROCESS
 * BASE (everything a child needs to be a functioning process) PLUS the
 * names in envFrom — nothing else. This is delegate's childEnv discipline:
 * the child is a subprocess the operator declared, not an heir to the
 * parent's secrets. If the base set proves too thin on a platform, grow the
 * BASE here — never fall back to the whole environment.
 * @returns {{[k:string]:string}} env for spawn
 */
export function spawnEnv(envFrom, parent = process.env) {
  const out = {};
  // minimal functioning-process base (platform aware)
  const BASE = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];
  if (process.platform === "win32") BASE.push("SystemRoot", "SYSTEMROOT", "ComSpec", "PATHEXT");
  for (const name of BASE) {
    const v = parent[name];
    if (typeof v === "string") out[name] = v;
  }
  for (const name of envFrom ?? []) {
    const v = parent[name];
    if (typeof v === "string") out[name] = v; // absent name = simply not passed
  }
  return out;
}

/**
 * Project the config into a CLI-registry-extras-ready plan (S1b): one entry
 * per ENABLED server, preserving load order.
 * @returns {Array<{name:string, command:string, args:string[], envFrom:string[]}>}
 */
export function enabledServers({ servers } = {}) {
  return Object.entries(servers ?? {})
    .filter(([, s]) => s.enabled !== false && s.enabled === true)
    .map(([name, s]) => ({ name, command: s.command, args: s.args, envFrom: s.envFrom }));
}

export function repoMcpConfigPath() {
  // <root>/src/mcp-config.js -> <root>/mcp.config.json
  return join(dirname(fileURLToPath(import.meta.url)), "..", "mcp.config.json");
}

export default { loadMcpConfig, spawnEnv, enabledServers, repoMcpConfigPath };
export { repoMcpConfigPath as MCP_CONFIG_PATH };
