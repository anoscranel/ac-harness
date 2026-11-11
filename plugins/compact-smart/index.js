// plugins/compact-smart/index.js — tiered deterministic compaction-trigger
// policy (specs/tier-b/compact-smart.md). Pure: no imports, no I/O, no clock,
// no tokeniser. decide(u, turns, budget, msgs) -> Decision (version:1).
//
// Ladder (pressure p = (input_tokens + output_reserve) / context_limit):
//   1. p < ratio                       → none
//   2. p >= ratio                      → compact non-pinned tool-results
//      outside the pinned tail        (summarise, "pressure-tool-results")
//   3. step-2 frees <20% of bytes      → also old assistant msgs
//                                       ("pressure-plus-assistant")
//   4. p >= 0.97                       → strategy drop ("pressure-critical")
//   5. empty selection at p >= ratio   → block ("nothing-compactible")

const DEFAULTS = { ratio: 0.75, tail_turns: 4, older_than: 6 };
const CRITICAL = 0.97;
const MIN_FREED_FRACTION = 0.2;

function cleanConfig(config = {}) {
  const c = { ...DEFAULTS };
  if (typeof config.ratio === "number" && config.ratio >= 0.5 && config.ratio <= 0.95) {
    c.ratio = config.ratio;
  }
  if (Number.isInteger(config.tail_turns) && config.tail_turns >= 1) {
    c.tail_turns = config.tail_turns;
  }
  if (Number.isInteger(config.older_than) && config.older_than >= 1) {
    c.older_than = config.older_than;
  }
  return c;
}

function spanOf(msgs, start, end) {
  let first = -1;
  let last = -1;
  for (let i = start; i < end; i++) {
    const s = msgs[i]?.event_span;
    if (s && typeof s.first === "number" && typeof s.last === "number") {
      if (first === -1 || s.first < first) first = s.first;
      if (s.last > last) last = s.last;
    }
  }
  return { first, last };
}

function toRanges(indices, msgs) {
  const ranges = [];
  let start = -1;
  let prev = -1;
  for (const i of indices) {
    if (start === -1) {
      start = i;
    } else if (i !== prev + 1) {
      ranges.push({ start, end: prev + 1, event_log_span: spanOf(msgs, start, prev + 1) });
      start = i;
    }
    prev = i;
  }
  if (start !== -1) ranges.push({ start, end: prev + 1, event_log_span: spanOf(msgs, start, prev + 1) });
  return ranges;
}

function decideWith(cfg, u, turns, _budget, msgs) {
  const p = (u.input_tokens + u.output_reserve) / u.context_limit;
  if (p < cfg.ratio) return { version: 1, verdict: "none" };

  const pinned = (m) => m.pinned === true || m.turn_index >= turns - cfg.tail_turns;
  const totalBytes = msgs.reduce((n, m) => n + (m.byte_len ?? 0), 0);

  const toolIdx = [];
  let freed = 0;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.kind === "tool-result" && !pinned(m)) {
      toolIdx.push(i);
      freed += m.byte_len ?? 0;
    }
  }

  const selected = [...toolIdx];
  let reason = "pressure-tool-results";
  if (totalBytes === 0 || freed / totalBytes < MIN_FREED_FRACTION) {
    const lastTurn = turns - 1;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.kind === "assistant" && !pinned(m) && lastTurn - m.turn_index >= cfg.older_than) {
        selected.push(i);
      }
    }
    if (selected.length > toolIdx.length) reason = "pressure-plus-assistant";
  }

  if (selected.length === 0) {
    return { version: 1, verdict: "block", reason: "nothing-compactible" };
  }

  selected.sort((a, b) => a - b);
  const critical = p >= CRITICAL;
  return {
    version: 1,
    verdict: "compact",
    ranges: toRanges(selected, msgs),
    strategy: critical ? "drop" : "summarise",
    reason: critical ? "pressure-critical" : reason,
  };
}

/** Default-config decide (spec: index.js exports decide). */
export function decide(u, turns, budget, msgs) {
  return decideWith(DEFAULTS, u, turns, budget, msgs);
}

export function makeDecide(config) {
  const cfg = cleanConfig(config);
  return (u, turns, budget, msgs) => decideWith(cfg, u, turns, budget, msgs);
}

export function register(ctx) {
  // Unknown config keys warn, never reject (spec §config) — via the
  // registration ctx warn channel (audit-a2 6.7).
  const KNOWN = new Set(["ratio", "tail_turns", "older_than"]);
  for (const k of Object.keys(ctx?.config ?? {})) {
    if (!KNOWN.has(k)) ctx?.warn?.(`compact-smart: unknown config key "${k}"`);
  }
  ctx.registerHook("compaction-trigger", makeDecide(ctx?.config));
}

export default { decide, makeDecide, register };
