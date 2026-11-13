// src/export-cli.js — v0.12.0 S3: `ac-harness export <log>` — the
// transcript a human can read: a deterministic markdown rendering of a
// session log (default stdout, --out <file> writes a file + prints the
// path). Read-only over the log; the only write is the named --out file.
//
// Determinism: the content derives 100% from event data (seq-ordered walk
// of the parsed log); no clock, no version, no randomness — the same log
// exports byte-identically.
//
// Rendering rules (card S3): `# session <id>` header; one section per turn
// (turn.start's user text); assistant text REASSEMBLED from
// turn.provider.chunk deltas in seq order; tool calls as fenced one-liners
// (`result: ok 2ms`); policy asks/decisions inline; compaction notes as
// blockquotes. Redaction already happened at write time — nothing new is
// needed, and no raw JSON braces appear in the transcript body.

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** Render one parsed log into full markdown. Pure + deterministic. */
export function buildTranscript(events) {
  const evs = [...events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const start = evs.find((e) => e.type === "session.start");
  const sid = start?.data?.session ?? "unknown";
  const out = ["# Session " + sid, ""];

  let text = ""; // pending assistant deltas (flushed at provider.response)
  let turnOpen = false;
  for (const ev of evs) {
    const d = ev.data ?? {};
    switch (ev.type) {
      case "turn.start": {
        // flush any dangling text buffer (a truncated stream)
        if (text !== "") flushText();
        const at = typeof ev.ts === "number" ? new Date(ev.ts * 1000).toISOString() : "?";
        out.push("", "## Turn " + (d.turn ?? "?") + " (" + at + ")");
        turnOpen = true;
        const input = String(d.input ?? "").trim();
        if (input) out.push("", "### User");
        if (input) out.push("", input);
        break;
      }
      case "turn.provider.chunk":
        text += String(d.delta ?? "");
        break;
      case "turn.provider.response":
        flushText();
        break;
      case "session.end":
        flushText();
        break;
      case "tool.proposed":
        flushText();
        out.push("", "```text", "call: " + (d.tool ?? "?") + (d.args !== undefined ? " " + safeJson(d.args) : ""), "```");
        break;
      case "policy.decision":
        out.push("", "- policy " + (d.verdict ?? "?") + " [" + (d.rule_path ?? "?") + "]");
        break;
      case "policy.ask.resolved":
        out.push("", "- ask " + (d.verdict ?? "?") + " (" + (d.resolved_by ?? "?") + ")");
        break;
      case "tool.result": {
        const ok = d.ok === false ? "failed" : "ok";
        const ms = typeof d.duration_ms === "number" ? " " + d.duration_ms + "ms" : "";
        out.push("", "```text", "result: " + ok + ms + (d.error ? " " + String(d.error) : ""), "```");
        break;
      }
      case "compaction.applied":
        out.push("", "> compaction applied (freed " + (d.freed_events ?? 0) + " events)");
        break;
      case "compaction.decided":
        out.push("", "> compaction decided: " + (d.verdict ?? "?"));
        break;
      case "session.error":
        out.push("", "**error:** " + String(d.message ?? ""));
        break;
      default:
        break; // session.start/plugin.*/usage.*/warn intentionally omitted
    }
  }
  flushText();
  void turnOpen;
  return out.join("\n") + "\n";

  function flushText() {
    if (text === "") return;
    out.push("", "### Assistant", "", text);
    text = "";
  }
}

/**
 * @param {string[]} argv <log> [--md] [--out <file>]
 * @param {{stdout?:{write:(s:string)=>void}}} [opts]
 * @returns {Promise<{lines:string[], exitCode:number}>}
 */
export async function exportCommand(argv = [], { stdout = process.stdout } = {}) {
  const [log, ...rest] = argv;
  const outIdx = rest.indexOf("--out");
  const outPath = outIdx >= 0 ? rest[outIdx + 1] : null;
  const say = (s) => stdout.write(s + "\n");
  if (!log) {
    say("usage: ac-harness export <log> [--md] [--out <file>]");
    return { lines: ["usage"], exitCode: 2 };
  }

  let raw;
  try {
    raw = await readFile(log, "utf8");
  } catch (err) {
    say(`cannot read log ${log}: ${err.code ?? err.message}`);
    return { lines: [`cannot read log`], exitCode: 2 };
  }

  // torn-tail tolerant inline parse — a torn last line is skipped, and the
  // transcript honors that limit (nothing is invented).
  const events = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* torn line skipped */ }
  }
  const md = buildTranscript(events);
  if (outPath) {
    const where = resolve(outPath);
    await writeFile(where, md, "utf8");
    say(`wrote ${where}`);
    return { lines: [`wrote ${where}`], exitCode: 0 };
  }
  stdout.write(md);
  return { lines: [md], exitCode: 0 };
}

export default { exportCommand, buildTranscript };
