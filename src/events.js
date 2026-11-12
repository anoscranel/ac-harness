// src/events.js — the single-writer append-only JSONL event log.
// Spec: specs/invariants.md (event envelope, canonical form, single writer).
//
// Invariants implemented here:
//  - Envelope key order is fixed: {seq, ts, type, actor, data}. The fixed
//    order IS part of the canonical form.
//  - seq is 0-based, gapless, assigned by this writer only.
//  - ts is seconds with ms precision and is VOLATILE: stripped from the
//    canonical transcript. data.duration_ms is volatile too, stripped
//    recursively at any depth.
//  - Every appendEvent is a single awaited write (appendFile). No fsync in
//    v1: crash-loses-tail is an accepted, documented risk (see README).
//  - NDJSON, UTF-8, no BOM, LF-terminated.

import { createHash } from "node:crypto";
import { appendFile, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { EventEmitter } from "node:events";

/** Exhaustive v1 event-type set (specs/invariants.md §2). Added to, never removed.
 *  `session.branch` added by repair-2 (review-r1 F9): records a time-travel
 *  fork so later resumes can mask the abandoned tail. `session.provider.switch`
 *  added by provider-admin (specs/tui/tui-provider-admin.md §4): records a
 *  runtime provider swap (boundary-only; queued swaps apply at the turn
 *  boundary). Both additive, never removed. */
export const EVENT_TYPES = Object.freeze([
  "session.start",
  "session.end",
  "session.error",
  "session.branch",
  "session.provider.switch",
  "turn.start",
  "turn.cap",
  "turn.end",
  "log.torn_tail",
  "turn.provider.request",
  "turn.provider.chunk",
  "turn.provider.response",
  "tool.proposed",
  "policy.decision",
  "policy.ask.resolved",
  "tool.result",
  "compaction.decided",
  "compaction.applied",
  "plugin.loaded",
  "plugin.rejected",
  "plugin.violation",
  "policy.violation",
  "policy.error",
  "usage.estimated",
]);

export const ACTORS = Object.freeze([
  "harness",
  "tool",
  "provider",
  "policy",
  "plugin",
  "compaction",
]);

const TYPE_SET = new Set(EVENT_TYPES);
const ACTOR_SET = new Set(ACTORS);

/**
 * Canonical data key order per event type. Builders emit known keys in this
 * order, then any extra keys in the caller's insertion order (undefined
 * values are dropped by JSON.stringify). The fixture
 * fixtures/events.v1.jsonl pins one fully-specified example of each type.
 */
const DATA_KEY_ORDER = Object.freeze({
  "session.start": ["harness_version", "session", "config_sha"],
  "session.end": ["turns", "total_input_tokens", "total_output_tokens", "total_cost_micro_usd"],
  "session.error": ["message", "code"],
  "session.branch": ["from_seq", "new_base_seq"],
  "session.provider.switch": ["from", "to", "model"],
  "turn.start": ["turn", "input"],
  "turn.cap": ["turn", "max_iterations", "closed_calls"],
  "turn.end": ["turn", "reason", "closed_calls"],
  "log.torn_tail": ["skipped_lines", "first_skipped_seq"],
  "turn.provider.request": ["provider", "model", "messages", "tools", "prefix_tokens", "prefix_cached"],
  "turn.provider.chunk": ["delta", "done"],
  "turn.provider.response": ["finish", "input_tokens", "cached_tokens", "output_tokens", "estimate", "truncated"],
  "tool.proposed": ["call_id", "tool", "args", "args_sha"],
  "policy.decision": ["call_id", "verdict", "rule_path"],
  "policy.ask.resolved": ["call_id", "verdict", "resolved_by", "timeout_ms"],
  "tool.result": ["call_id", "ok", "bytes", "duration_ms", "sha256", "output", "truncated", "error"],
  "compaction.decided": ["version", "verdict"],
  "compaction.applied": ["version", "ranges", "strategy", "freed_events"],
  "plugin.loaded": ["plugin", "version", "status", "compat"],
  "plugin.rejected": ["plugin", "reason", "detail"],
  "plugin.violation": ["plugin", "kind", "name"],
  "policy.violation": ["kind", "path", "tool"],
  "policy.error": ["message", "source"],
  "usage.estimated": ["chars", "estimate", "estimate_flag"],
});

/** Reorder a data object: known keys in canonical order, extras after, undefined dropped. */
function orderData(type, data) {
  const keys = DATA_KEY_ORDER[type];
  const out = {};
  for (const k of keys) {
    if (data[k] !== undefined) out[k] = data[k];
  }
  for (const k of Object.keys(data)) {
    if (!keys.includes(k) && data[k] !== undefined) out[k] = data[k];
  }
  return out;
}

/**
 * Build a validated event payload (no seq/ts — the writer assigns those).
 * Throws on unknown type, unknown actor, or non-object data.
 */
export function buildEvent(type, actor, data) {
  if (!TYPE_SET.has(type)) throw new Error(`unknown event type: ${type}`);
  if (!ACTOR_SET.has(actor)) throw new Error(`unknown actor: ${actor}`);
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`event data must be a plain object (type ${type})`);
  }
  return { type, actor, data: orderData(type, data) };
}

/** Recursively delete every `duration_ms` key (volatile per invariants §1). */
function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "duration_ms") continue;
      out[k] = stripVolatile(v);
    }
    return out;
  }
  return value;
}

/**
 * Canonical transcript (specs/invariants.md §1): per event, drop `ts`, strip
 * every `duration_ms` recursively, re-serialize with the fixed envelope key
 * order {seq, type, actor, data}, LF-terminate each line.
 */
export function canonicalize(events) {
  let out = "";
  for (const ev of events) {
    const line = {
      seq: ev.seq,
      type: ev.type,
      actor: ev.actor,
      data: stripVolatile(ev.data ?? {}),
    };
    out += JSON.stringify(line) + "\n";
  }
  return out;
}

/** sha256 hex of a string or Buffer. */
export function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

/** Parse an NDJSON event log into an array of events. */
export async function readAll(path, { onTornTail = null } = {}) {
  const raw = await readFile(path, "utf8");
  const events = [];
  let skipped = 0;
  let firstSkippedSeq = null;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const ev = JSON.parse(line);
      events.push(ev);
    } catch {
      // v0.4.0 2.2: a truncated tail (crash mid-append) must NOT brick
      // startup. Skip + count; the file is NEVER truncated (append-only).
      if (skipped === 0) firstSkippedSeq = events.length === 0 ? 0 : events[events.length - 1].seq + 1;
      skipped += 1;
    }
  }
  if (skipped > 0 && typeof onTornTail === "function") {
    onTornTail({ skipped_lines: skipped, first_skipped_seq: firstSkippedSeq });
  }
  return events;
}

// --- Best-effort secret redaction (pre-log) -------------------------------
// Honesty limit (stated in README): this is pattern matching, not a guarantee.
// Treat every event log as potentially sensitive regardless.
// F12 (review-r1): classes screened = generic API keys, JWTs, Bearer tokens,
// KEY=value assignments, GitHub token families, AWS access key ids, Slack
// tokens, Google API keys, PEM block markers, connection strings with
// embedded credentials, and quoted .env-style values. Anything beyond that
// list is DOCUMENTED-UNSCREENED (see SECURITY.md "unscreened classes").
// Repair-4 N3: exported so test/redaction-sync.test.js can pin this list and
// the TUI's display-side copy (src/tui/renderers.js) to deep equality.
export const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g, // API-key shaped tokens
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, // JWTs
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /(ghp|ghs|gho|ghu|ghr)_[A-Za-z0-9]{16,}/g, // GitHub token families
  /github_pat_[A-Za-z0-9_]{16,}/g, // GitHub fine-grained PATs
  /AKIA[0-9A-Z]{16}/g, // AWS access key ids
  /xox[baprs]-[A-Za-z0-9-]{8,}/g, // Slack tokens
  /AIza[0-9A-Za-z_-]{20,}/g, // Google API keys
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g, // PEM block markers
  /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, // scheme://user:pass@host
  /([A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET))=([^\s"']{4,})/g, // KEY=value assignments
  /([A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET))=(["'])[^"']*\2/g, // KEY="value" (quoted)
];

function redact(value) {
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
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v);
    return out;
  }
  return value;
}

/**
 * The single writer. One EventLog owns one log path for the life of the
 * process. Appends are awaited and serialized through a promise chain so
 * concurrent callers cannot interleave lines or reuse a seq.
 */
export class EventLog extends EventEmitter {
  #chain = Promise.resolve();

  constructor(path) {
    super();
    this.path = path;
    this.seq = 0;
    this.events = [];
  }

  /** Open (or create) a log, resuming seq after the last recorded event. */
  static async open(path) {
    const log = new EventLog(path);
    await mkdir(dirname(path), { recursive: true });
    let torn = null;
    try {
      log.events = await readAll(path, {
        onTornTail: (info) => {
          torn = info;
        },
      });
      log.seq = log.events.length === 0 ? 0 : log.events[log.events.length - 1].seq + 1;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    // v0.4.0 2.2: report the torn tail as an EVENT (observability surface),
    // on open, only when lines were skipped. A torn fragment has no trailing
    // newline, so the report must FIRST seal the fragment with one newline
    // (append-only: the fragment bytes stay, never truncated) — otherwise
    // the report would glue onto the torn line and become unparseable itself.
    // A failed report is non-fatal: startup survives either way.
    if (torn !== null) {
      try {
        // exactly-once per tail: skip if this tail was already reported
        // (the torn fragment stays in the file forever — append-only — so
        // every open would otherwise re-report the same tail).
        const alreadyReported = log.events.some(
          (e) => e.type === "log.torn_tail" && e.data.first_skipped_seq === torn.first_skipped_seq,
        );
        if (!alreadyReported) {
          const raw = await readFile(path, "utf8").catch(() => "");
          if (raw !== "" && !raw.endsWith("\n")) {
            await appendFile(path, "\n", "utf8"); // seal the fragment (append-only)
          }
          await log.appendEvent("log.torn_tail", "harness", {
            skipped_lines: torn.skipped_lines,
            first_skipped_seq: torn.first_skipped_seq,
          });
        }
      } catch {
        /* the torn tail was already tolerated; a failed report is non-fatal */
      }
    }
    return log;
  }

  /**
   * Append one event. Accepts (type, actor, data) or a single
   * {type, actor, data} object. Awaited: resolves only after the line is
   * written. Emits "event" with the stored event.
   */
  async appendEvent(type, actor, data) {
    if (typeof type === "object" && type !== null) {
      ({ type, actor, data } = type);
    }
    const built = buildEvent(type, actor, redact(data ?? {}));
    const seq = this.seq++; // assigned synchronously, in call order
    const ts = Date.now() / 1000; // seconds, ms precision; volatile
    const event = { seq, ts, type: built.type, actor: built.actor, data: built.data };
    const line = JSON.stringify(event) + "\n";
    const write = this.#chain.then(() => appendFile(this.path, line, "utf8"));
    // Keep the chain alive even if one write rejects; surface the error to
    // this caller only.
    this.#chain = write.catch(() => {});
    await write;
    this.events.push(event);
    this.emit("event", event);
    return event;
  }

  /** Canonical transcript of everything written so far. */
  canonical() {
    return canonicalize(this.events);
  }

  /** sha256 of the canonical transcript (attestation form; never log contents). */
  canonicalSha256() {
    return sha256(this.canonical());
  }
}
