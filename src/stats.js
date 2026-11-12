// src/stats.js — v0.5.0 H6 (F-D12.1): pure event-log → usage report.
// "What did this session spend" without ad-hoc jq. Takes PARSED events
// (readAll output) → report object. No pricing (theta's call, not this
// module's). Unknown event types are ignored, never fatal. Pure: no clock
// reads (wall-clock span comes from recorded ts), no I/O, no randomness.

/**
 * @param {Array<{seq:number, ts:number, type:string, actor:string, data:object}>} events
 * @returns {object} the report (plain, printable, deterministic)
 */
export function buildReport(events) {
  const list = Array.isArray(events) ? events : [];
  const report = {
    turns: 0,
    tokens: { input: 0, cached: 0, output: 0, estimated: false },
    tools: {}, // name -> { calls, total_ms }
    asks: 0,
    compactions: 0,
    errors: [],
    span: { first_ts: null, last_ts: null, seconds: 0 },
  };

  for (const ev of list) {
    if (!ev || typeof ev !== "object") continue;
    const d = ev.data ?? {};
    if (typeof ev.ts === "number") {
      if (report.span.first_ts === null) report.span.first_ts = ev.ts;
      if (ev.ts > report.span.last_ts) report.span.last_ts = ev.ts;
    }
    switch (ev.type) {
      case "turn.start":
        report.turns += 1;
        break;
      case "turn.provider.response": {
        report.tokens.input += d.input_tokens ?? 0;
        report.tokens.cached += d.cached_tokens ?? 0;
        report.tokens.output += d.output_tokens ?? 0;
        break;
      }
      case "usage.estimated":
        report.tokens.estimated = true; // an estimate flag was raised somewhere
        break;
      case "tool.proposed": {
        const name = d.tool ?? "unknown";
        const row = report.tools[name] ?? { calls: 0, total_ms: 0 };
        row.calls += 1;
        report.tools[name] = row;
        break;
      }
      case "tool.result": {
        // attribute the duration to the most recent proposed tool (seq order
        // makes tool.proposed the nearest preceding call_id record)
        const name = report.lastProposedTool ?? "unknown";
        const row = report.tools[name] ?? { calls: 0, total_ms: 0 };
        row.total_ms += d.duration_ms ?? 0;
        report.tools[name] = row;
        break;
      }
      case "policy.ask.resolved":
        report.asks += 1;
        break;
      case "compaction.applied":
        report.compactions += 1;
        break;
      case "session.error":
      case "policy.error":
        report.errors.push({ code: d.code ?? null, message: String(d.message ?? "").slice(0, 200) });
        break;
      default:
        break; // unknown types ignored (additive schema — never fatal)
    }
    if (ev.type === "tool.proposed") report.lastProposedTool = d.tool ?? "unknown";
  }
  delete report.lastProposedTool;
  if (report.span.first_ts !== null && report.span.last_ts !== null) {
    report.span.seconds = Math.max(0, Math.round((report.span.last_ts - report.span.first_ts) * 1000) / 1000);
  }
  return report;
}

/**
 * v0.8.0 S3 (cost honesty): money computed from a provider PROFILE's
 * pricing {input_per_mtok, output_per_mtok} — the ONLY source. No pricing
 * table ships in core; without a profile this stays n/a (a zero would read
 * as "free" when it means "unmeasured"). Micro-USD integers only (the same
 * discipline as loop's total_cost_micro_usd).
 * @returns null when the profile carries no pricing; else
 *   {input_micro_usd, output_micro_usd, total_micro_usd, input_per_mtok,
 *    output_per_mtok, source}
 */
export function computeCostFromProfile(report, profile) {
  const pricing = profile?.pricing;
  if (!pricing || !Number.isFinite(pricing.input_per_mtok) || !Number.isFinite(pricing.output_per_mtok)) {
    return null;
  }
  const input = Math.round((report.tokens.input / 1e6) * pricing.input_per_mtok);
  const output = Math.round((report.tokens.output / 1e6) * pricing.output_per_mtok);
  return {
    input_micro_usd: input,
    output_micro_usd: output,
    total_micro_usd: input + output,
    input_per_mtok: pricing.input_per_mtok,
    output_per_mtok: pricing.output_per_mtok,
    source: profile.id ?? "profile",
  };
}

/** Human-readable printer (the CLI stats subcommand uses this). */
export function formatReport(report, { logPath = null, cost = null } = {}) {
  const lines = [];
  if (logPath) lines.push(`log: ${logPath}`);
  lines.push(`turns: ${report.turns}`);
  lines.push(
    `tokens: input ${report.tokens.input} · cached ${report.tokens.cached} · output ${report.tokens.output}` +
      (report.tokens.estimated ? " (estimate flagged)" : ""),
  );
  if (cost) {
    lines.push(
      `cost: $${(cost.total_micro_usd / 1e6).toFixed(4)} (from provider profile "${cost.source}": input $${cost.input_per_mtok}/Mtok · output $${cost.output_per_mtok}/Mtok)`,
    );
  } else {
    lines.push(`cost: n/a (no pricing table configured \u2014 token counts only)`);
  }
  const toolNames = Object.keys(report.tools).sort();
  if (toolNames.length === 0) {
    lines.push("tools: none");
  } else {
    lines.push("tools:");
    for (const t of toolNames) {
      const row = report.tools[t];
      lines.push(`  ${t}: ${row.calls} calls · ${row.total_ms}ms total`);
    }
  }
  lines.push(`policy asks: ${report.asks}`);
  lines.push(`compactions: ${report.compactions}`);
  lines.push(`errors: ${report.errors.length}${report.errors.length > 0 ? "" : ""}`);
  for (const e of report.errors) {
    lines.push(`  ${e.code ?? "?"}: ${e.message}`);
  }
  lines.push(`span: ${report.span.seconds}s`);
  return lines.join("\n");
}

export default { buildReport, formatReport };
