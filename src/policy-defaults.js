// src/policy-defaults.js — the default rule set (data, not code).
// The pinned log-path deny itself lives in src/policy.js (evaluated in code so
// no rules file can remove it); this module exposes the human-legible rule id
// plus the default asks for bash and MCP calls (builder-brief 003b item 6).

export const PINNED_LOG_DENY_ID = "pinned.deny_log_path";

/**
 * Default rules. Conservative v1 posture:
 *   read, grep            → allow (read-only)
 *   write, edit, remember → ask
 *   bash                  → ask   (arbitrary execution)
 *   mcp.* (spawn + calls) → ask   (subprocess + untrusted tool surface)
 * Zero matches still deny (engine semantics), so anything unlisted is denied.
 */
export function defaultRules() {
  return [
    { id: "defaults.allow_read", effect: "allow", match: { tool: "read" } },
    { id: "defaults.allow_grep", effect: "allow", match: { tool: "grep" } },
    // memory_recall is read-only over the agent's own durable notes: same class
    // as read/grep, not a state change.
    { id: "defaults.allow_recall", effect: "allow", match: { tool: "memory_recall" } },
    { id: "defaults.ask_write", effect: "ask", match: { tool: "write" } },
    { id: "defaults.ask_edit", effect: "ask", match: { tool: "edit" } },
    // memory_remember writes a fact other sessions will read: same class as an
    // edit, not a free action. memory_recall stays allowed (read-only).
    { id: "defaults.ask_remember", effect: "ask", match: { tool: "memory_remember" } },
    { id: "defaults.ask_bash", effect: "ask", match: { tool: "bash" } },
    { id: "defaults.ask_mcp", effect: "ask", match: { tool: "mcp.*" } },
  ];
}
