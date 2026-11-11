// src/policy-defaults.js — the default rule set (data, not code).
// The pinned log-path deny itself lives in src/policy.js (evaluated in code so
// no rules file can remove it); this module exposes the human-legible rule id
// plus the default asks for bash and MCP calls (builder-brief 003b item 6).

export const PINNED_LOG_DENY_ID = "pinned.deny_log_path";

/**
 * Default rules. Conservative v1 posture:
 *   read, grep            → allow (read-only)
 *   write, edit           → ask
 *   bash                  → ask   (arbitrary execution)
 *   mcp.* (spawn + calls) → ask   (subprocess + untrusted tool surface)
 * Zero matches still deny (engine semantics), so anything unlisted is denied.
 */
export function defaultRules() {
  return [
    { id: "defaults.allow_read", effect: "allow", match: { tool: "read" } },
    { id: "defaults.allow_grep", effect: "allow", match: { tool: "grep" } },
    { id: "defaults.ask_write", effect: "ask", match: { tool: "write" } },
    { id: "defaults.ask_edit", effect: "ask", match: { tool: "edit" } },
    { id: "defaults.ask_bash", effect: "ask", match: { tool: "bash" } },
    { id: "defaults.ask_mcp", effect: "ask", match: { tool: "mcp.*" } },
  ];
}
