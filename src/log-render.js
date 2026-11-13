// src/log-render.js — v0.12.0 S2: one-line human renderers for search hits.
// Pure: no tty, no state. Simple one-liners for the dominant record types
// (the full per-event TUI renderers live in src/tui/renderers.js for the
// screen; these are the plain-text equivalents for the log-search surface).

export function renderEventLine(ev) {
  const d = ev?.data ?? {};
  switch (ev?.type) {
    case "session.start":
      return `session ${d.session ?? "?"} (harness ${d.harness_version ?? "?"})`;
    case "session.end":
      return `session end (turns ${d.turns ?? "?"}, priced ${d.priced === true ? "yes" : "no"})`;
    case "turn.start":
      return `user: ${one(d.input)}`;
    case "turn.provider.chunk":
      return `chunk: ${one(d.delta)}`;
    case "turn.provider.response":
      return `provider done (finish ${d.finish ?? "?"})`;
    case "tool.proposed":
      return `tool ${d.tool ?? "?"} called`;
    case "tool.result":
      return `tool result ${(d.ok === false ? "failed" : "ok")}${typeof d.duration_ms === "number" ? ` ${d.duration_ms}ms` : ""}`;
    case "policy.decision":
      return `policy ${d.verdict ?? "?"} [${d.rule_path ?? ""}]`;
    case "policy.ask.resolved":
      return `ask resolved ${d.verdict ?? "?"} (by ${d.resolved_by ?? "?"})`;
    case "compaction.applied":
      return `compaction applied (freed ${d.freed_events ?? 0})`;
    case "compaction.decided":
      return `compaction decided ${d.verdict ?? "?"}`;
    case "session.error":
      return `error: ${one(d.message)}`;
    case "session.warn":
      return `warn: ${one(d.kind)} ${d.used ?? ""}/${d.cap ?? ""}`;
    case "mcp.server.error":
      return `mcp server ${d.server ?? "?"} failed: ${one(d.reason)}`;
    case "checkpoint.error":
      return `checkpoint error: ${one(d.message)}`;
    case "plugin.loaded":
      return `plugin loaded ${d.plugin ?? "?"} ${d.status ?? ""}`;
    case "plugin.rejected":
      return `plugin rejected ${d.plugin ?? "?"}: ${one(d.reason)}`;
    default:
      return one(JSON.stringify(d));
  }
}

function one(v) {
  const s = String(v ?? "");
  return s.length > 96 ? s.slice(0, 93) + "…" : s;
}

export default { renderEventLine };
