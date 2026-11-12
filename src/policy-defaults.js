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
    // v0.7.0 A1 (audit-pending-v070): memory_recall is ASK-gated. Recalled
    // text is UNTRUSTED input (recorded in an earlier session — possibly by a
    // poisoned file read); feeding it into provider context silently is the
    // trifecta's untrusted-content leg. The recall TOOL also wraps output in
    // an explicit treat-as-data envelope (src/tools/memory.js).
    { id: "defaults.ask_recall", effect: "ask", match: { tool: "memory_recall" } },
    { id: "defaults.ask_write", effect: "ask", match: { tool: "write" } },
    { id: "defaults.ask_edit", effect: "ask", match: { tool: "edit" } },
    // memory_remember writes a fact other sessions will read: same class as an
    // edit, not a free action (and recall is ask-gated above — A1).
    { id: "defaults.ask_remember", effect: "ask", match: { tool: "memory_remember" } },
    // delegation spawns a child agent run: same risk class as bash (something
    // runs on this machine), so ask — the human approves the child's existence
    // and its explicit allowlist rides in args.
    { id: "defaults.ask_delegate", effect: "ask", match: { tool: "delegate" } },
    { id: "defaults.ask_bash", effect: "ask", match: { tool: "bash" } },
    { id: "defaults.ask_mcp", effect: "ask", match: { tool: "mcp.*" } },
  ];
}
