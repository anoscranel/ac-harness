// src/tui/renderers.js — event → rendered-line mapping (spec §4/§5): one
// function per event type, unknown events → dim fallback. Pure strings +
// style tokens; no terminal access. Ask args are rendered through the
// redaction classes' DISPLAY application: renderers re-screen every string
// with the same regex classes events.js applies pre-log (defense-in-depth —
// the log is already redacted; this keeps the SCREEN clean if an event any
// future path bypasses the log-gate).

import { style, sanitizeForTerminal } from "./screen.js";
import { wrapLine } from "./viewport.js";

// Same secret shapes as src/events.js (kept as a local re-screen; the two
// lists MUST stay in sync — enforced by test/redaction-sync.test.js, repair-4 N3).
export const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /(ghp|ghs|gho|ghu|ghr)_[A-Za-z0-9]{16,}/g,
  /github_pat_[A-Za-z0-9_]{16,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-[A-Za-z0-9-]{8,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
  /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
  /([A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET))=([^\s"']{4,})/g,
  /([A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET))=(["'])[^"']*\2/g,
];

/** Display-application of the redaction classes to any string (recursive). */
export function redactForDisplay(value) {
  if (typeof value === "string") {
    let out = value;
    for (const re of SECRET_PATTERNS) {
      out = out.replace(re, (m) => {
        if (m.includes("://")) return m.replace(/:\/\/[^\s/@:]+:[^\s/@]+@/, "://[REDACTED]@");
        if (m.includes("=")) return m.replace(/=.*/, "=[REDACTED]");
        return "[REDACTED]";
      });
    }
    return out;
  }
  if (Array.isArray(value)) return value.map(redactForDisplay);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactForDisplay(v);
    return out;
  }
  return value;
}

const dim = (s) => `${style.dim}${s}${style.reset}`;
const err = (s) => `${style.red}${s}${style.reset}`;
const warn = (s) => `${style.yellow}${s}${style.reset}`;
const ok = (s) => `${style.cyan}${s}${style.reset}`;

/** Content pipeline (repair-4 D2): redact first (pattern match on raw bytes),
 *  then strip terminal-hazard control bytes BEFORE any styling is applied. */
function clean(s) {
  return sanitizeForTerminal(redactForDisplay(String(s ?? "")));
}

function displayArgs(args) {
  if (args === undefined || args === null) return "";
  try {
    // D2: sanitize the arg VALUES before stringify — JSON.stringify would
    // otherwise escape raw control bytes into harmless-looking \u… text while
    // the eventual stringified JSON still carries them for the paint layer.
    const safeArgs = redactForDisplay(args);
    if (Array.isArray(safeArgs)) {
      return clean(JSON.stringify(safeArgs.map(sanitizeForTerminal)));
    }
    if (safeArgs !== null && typeof safeArgs === "object") {
      const out = {};
      for (const [k, v] of Object.entries(safeArgs)) {
        out[k] = typeof v === "string" ? sanitizeForTerminal(v) : redactForDisplay(v);
      }
      return clean(JSON.stringify(out));
    }
    return clean(String(safeArgs));
  } catch {
    return clean(String(args));
  }
}

/** user: one line per submission (spec §1 '› text'). */
export function renderUser(input) {
  return `› ${clean(input)}`;
}

/** assistant chunk → live assistant line (streaming repaint targets it). */
export function renderAssistantText(text) {
  return clean(text);
}

/** tool call row: '⚒ tool {args-summary} → ok 2ms'. */
export function renderToolProposed(ev) {
  const d = ev?.data ?? {};
  return `⚒ ${clean(d.tool)} ${displayArgs(d.args)} …`;
}

export function renderToolResult(ev) {
  const d = ev?.data ?? {};
  const tail = d.ok === false ? `${style.red}✗${style.reset}` : "ok";
  const ms = typeof d.duration_ms === "number" ? ` ${d.duration_ms}ms` : "";
  const note = d.error ? ` (${clean(d.error)})` : "";
  const bytes = typeof d.bytes === "number" ? `, ${d.bytes}b` : "";
  return `⚒ → ${tail}${ms}${bytes}${note}`;
}

export function renderPolicyDecision(ev) {
  const d = ev?.data ?? {};
  const verdict = d.verdict === "allow" ? "allow" : d.verdict === "ask" ? "ask" : "deny";
  return dim(`policy ${verdict} [${d.rule_path ?? ""}]`);
}

export function renderAskResolved(ev) {
  const d = ev?.data ?? {};
  return dim(`ask ${d.verdict ?? "?"} (by ${d.resolved_by ?? "?"})`);
}

export function renderVerifyFail(detail) {
  return err(`✗ verify-gate failed: ${clean(detail)} — see transcript`);
}

export function renderCompaction(ev) {
  const d = ev?.data ?? {};
  return dim(`compaction ${d.verdict ?? d.strategy ?? ""}${d.freed_events !== undefined ? ` freed ${d.freed_events}` : ""}`);
}

export function renderSessionStart(ev) {
  const d = ev?.data ?? {};
  return dim(`session ${d.session ?? ""} · harness ${d.harness_version ?? ""}`);
}

export function renderSessionEnd(ev) {
  const d = ev?.data ?? {};
  return dim(`session end · turns ${d.turns ?? 0} · in ${d.total_input_tokens ?? 0} out ${d.total_output_tokens ?? 0}`);
}

export function renderError(ev) {
  const d = ev?.data ?? {};
  return err(`✗ ${clean(d.message ?? "error")}${d.code ? ` (${clean(d.code)})` : ""}`);
}

export function renderPlugin(ev) {
  const d = ev?.data ?? {};
  const head = ev.type.replace("plugin.", "");
  return dim(`${head} ${d.plugin ?? ""}${d.reason ? `: ${d.reason}` : d.status ? `: ${d.status}` : ""}`);
}

export function renderUsage(ev) {
  const d = ev?.data ?? {};
  return dim(`usage ~${d.chars ?? 0} chars (${d.estimate ?? "?"})`);
}

export function renderBranch(ev) {
  const d = ev?.data ?? {};
  return dim(`branch from seq ${d.from_seq ?? "?"} → base ${d.new_base_seq ?? "?"}`);
}

export function renderProviderMeta(ev) {
  const d = ev?.data ?? {};
  if (ev.type === "turn.provider.request") {
    return dim(`→ ${d.provider ?? "?"}/${d.model ?? "?"} · ${d.messages ?? 0} msgs · ${d.tools ?? 0} tools`);
  }
  return dim(`← finish ${d.finish ?? "?"} · in ${d.input_tokens ?? 0} out ${d.output_tokens ?? 0}`);
}

/** The ASK banner (spec §3.1): rendered with args through the redaction filter
 *  (D2: args pass through clean()/displayArgs — terminal-safe before styling). */
export function renderAskBanner(ask) {
  const tool = clean(ask?.tool ?? "?");
  return warn(`⚠ ASK ${tool} ${displayArgs(ask?.args)} — [y]es / [n]o / [a]lways`);
}

/**
 * Event → array of rendered lines. Chunk events extend rather than re-render
 * (handled by the caller's live-line logic); this table is the render map the
 * tests pin. Returns [] for types that render nothing (chunk accumulation is
 * handled by main.js's live assistant line).
 */
export function renderEvent(ev) {
  switch (ev?.type) {
    case "session.start":
      return [renderSessionStart(ev)];
    case "session.end":
      return [renderSessionEnd(ev)];
    case "session.error":
      return [renderError(ev)];
    case "session.branch":
      return [renderBranch(ev)];
    case "turn.start":
      return [renderUser(ev.data?.input)];
    case "turn.provider.request":
    case "turn.provider.response":
      return [renderProviderMeta(ev)];
    case "turn.provider.chunk":
      return []; // live assistant line — no static row
    case "tool.proposed":
      return [renderToolProposed(ev)];
    case "policy.decision":
      return [renderPolicyDecision(ev)];
    case "policy.ask.resolved":
      return [renderAskResolved(ev)];
    case "tool.result":
      return [renderToolResult(ev)];
    case "compaction.decided":
    case "compaction.applied":
      return [renderCompaction(ev)];
    case "plugin.loaded":
    case "plugin.rejected":
    case "plugin.violation":
      return [renderPlugin(ev)];
    case "policy.violation":
      return [warn(`policy violation: ${clean(JSON.stringify(redactForDisplay(ev.data ?? {})))}`)];
    case "policy.error":
      return [renderError(ev)];
    case "usage.estimated":
      return [renderUsage(ev)];
    default:
      // Unknown events → dim fallback (never crash; forward-compat render hook).
      return [dim(`${clean(ev?.type ?? "unknown")} ${clean(JSON.stringify(redactForDisplay(ev?.data ?? {})))}`)];
  }
}

/** Wrap rendered lines into viewport rows at a width (used by main.js paint). */
export function renderEventWrapped(ev, width) {
  const out = [];
  for (const line of renderEvent(ev)) {
    if (line === "") continue;
    out.push(...wrapLine(line, width));
  }
  return out;
}

export default {
  redactForDisplay,
  renderUser,
  renderAssistantText,
  renderToolProposed,
  renderToolResult,
  renderPolicyDecision,
  renderAskResolved,
  renderVerifyFail,
  renderCompaction,
  renderSessionStart,
  renderSessionEnd,
  renderError,
  renderPlugin,
  renderUsage,
  renderBranch,
  renderProviderMeta,
  renderAskBanner,
  renderEvent,
  renderEventWrapped,
};
