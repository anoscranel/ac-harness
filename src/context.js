// src/context.js — the compaction-trigger seam: default policy for
// specs/compaction-trigger.md (v2). Pure: no network, no clock, no storage,
// no I/O, no tokeniser. The HARNESS logs compaction.decided after each call;
// this module emits nothing. Swappable atomically via the plugin hook
// `compaction-trigger` (a `single` hook — specs/plugin-manifest.md §hooks).

/** Pinned tail: the final N=4 turns are never compacted (spec v2). */
export const PINNED_TAIL_TURNS = 4;

/** Default trigger ratio: compact when used + reserve >= 0.80 * limit. */
export const DEFAULT_RATIO = 0.8;

/**
 * @param {{input_tokens:int, cached_tokens:int, output_reserve:int,
 *          context_limit:int, estimate:boolean}} u UsageSnapshot
 * @param {int} turns count of completed turns
 * @param {{max_session_tokens:int, warn_fraction:float}} budget (unused by default)
 * @param {Array} msgs MsgMeta[] — ⚠️ extended with optional
 *   `event_span:{first:int,last:int}` so the Decision can carry
 *   event_log_span (spec v2 requires it in output but defines no input path;
 *   see findings/deviations.md). Missing spans surface as -1.
 * @returns {object} Decision (version:1)
 */
export function decide(u, turns, budget, msgs) {
  const used = u.input_tokens + u.output_reserve;
  if (used < DEFAULT_RATIO * u.context_limit) {
    return { version: 1, verdict: "none" };
  }

  const inPinnedTail = (m) =>
    m.pinned === true || m.turn_index >= turns - PINNED_TAIL_TURNS;

  const targets = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.kind === "tool-result" && !inPinnedTail(m)) targets.push(i);
  }

  if (targets.length === 0) {
    return { version: 1, verdict: "block", reason: "context-limit-uncompacted" };
  }

  // Coalesce consecutive indices into half-open ranges [start, end).
  const ranges = [];
  let start = targets[0];
  let prev = targets[0];
  for (let i = 1; i <= targets.length; i++) {
    if (i < targets.length && targets[i] === prev + 1) {
      prev = targets[i];
      continue;
    }
    ranges.push(makeRange(msgs, start, prev + 1));
    if (i < targets.length) {
      start = targets[i];
      prev = targets[i];
    }
  }

  return {
    version: 1,
    verdict: "compact",
    ranges,
    strategy: "summarise",
    reason: "context-limit",
  };
}

function makeRange(msgs, start, end) {
  let first = -1;
  let last = -1;
  for (let i = start; i < end; i++) {
    const span = msgs[i]?.event_span;
    if (span && typeof span.first === "number" && typeof span.last === "number") {
      if (first === -1 || span.first < first) first = span.first;
      if (span.last > last) last = span.last;
    }
  }
  return { start, end, event_log_span: { first, last } };
}

export default { decide, PINNED_TAIL_TURNS, DEFAULT_RATIO };
