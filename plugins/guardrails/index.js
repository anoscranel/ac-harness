// plugins/guardrails/index.js — first-party guardrails plugin
// (specs/tier-b/guardrails-plugin.md). Exercises every manifest capability
// class: chain hooks (pre-tool, post-tool, on-event), a single hook
// (verify-gate), a namespaced tool (stats-summary), and config.
//
// Deterministic; no network; every hook is wrapped in try/catch and reports
// the error string instead of throwing. State is in-memory and bounded
// (event counting stops at 10k events); reset() clears it.

import { spawn } from "node:child_process";
import { resolve, isAbsolute } from "node:path";

const EVENT_CAP = 10_000;
const CHECK_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 300_000;

const state = {
  toolStats: new Map(), // tool -> { count, totalMs }
  eventCounts: new Map(), // type -> count
  eventTotal: 0,
  lastError: null,
};

export function reset() {
  state.toolStats.clear();
  state.eventCounts.clear();
  state.eventTotal = 0;
  state.lastError = null;
}

function rootsFromConfig(config, cwd) {
  const raw = typeof config?.allowed_roots === "string" && config.allowed_roots.trim() !== ""
    ? config.allowed_roots
    : ".";
  return raw
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => (isAbsolute(r) ? r : resolve(cwd, r)));
}

function underAnyRoot(path, roots) {
  return roots.some((root) => path === root || path.startsWith(root + "/"));
}

/** Path-like tokens of a bash command (redirections/quotes stripped). */
function bashPathTokens(command) {
  const out = [];
  for (let tok of command.split(/\s+/)) {
    tok = tok.replace(/^(?:[0-9]*>>?|<<?)/, "").replace(/^["']|["']$/g, "");
    if (tok.includes("/")) out.push(tok);
  }
  return out;
}

function preTool(config) {
  return ({ tool, args } = {}) => {
    try {
      if (tool !== "write" && tool !== "edit" && tool !== "bash") {
        return { action: "allow" };
      }
      const cwd = process.cwd();
      const roots = rootsFromConfig(config, cwd);
      const candidates = [];
      if ((tool === "write" || tool === "edit") && typeof args?.path === "string") {
        candidates.push(resolve(cwd, args.path));
      }
      if (tool === "bash" && typeof args?.command === "string") {
        for (const tok of bashPathTokens(args.command)) candidates.push(resolve(cwd, tok));
      }
      // No path-like target → nothing to root-gate.
      if (candidates.length === 0) return { action: "allow" };
      return candidates.every((p) => underAnyRoot(p, roots))
        ? { action: "allow" }
        : { action: "deny", reason: "guardrails:root" };
    } catch (err) {
      state.lastError = String(err?.message ?? err);
      return { action: "ask", reason: `guardrails:error: ${state.lastError}` };
    }
  };
}

function postTool() {
  return ({ tool, durationMs } = {}) => {
    try {
      const s = state.toolStats.get(tool) ?? { count: 0, totalMs: 0 };
      s.count += 1;
      s.totalMs += typeof durationMs === "number" ? durationMs : 0;
      state.toolStats.set(tool, s);
      return null;
    } catch (err) {
      state.lastError = String(err?.message ?? err);
      return null;
    }
  };
}

function onEvent() {
  return (ev) => {
    try {
      if (state.eventTotal >= EVENT_CAP) return null; // bounded growth
      state.eventTotal += 1;
      state.eventCounts.set(ev.type, (state.eventCounts.get(ev.type) ?? 0) + 1);
      return null;
    } catch (err) {
      state.lastError = String(err?.message ?? err);
      return null;
    }
  };
}

function runCmd(cmd, args, cwd, timeoutMs) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolvePromise({ code: -1, err: "<timeout>" });
    }, timeoutMs);
    child.stderr.on("data", (d) => {
      if (err.length < 4096) err += d.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolvePromise({ code: -1, err: String(e.message) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, err });
    });
  });
}

function verifyGate(repoRoot) {
  return async ({ editedFiles = [] } = {}) => {
    try {
      // 6.6 (audit-a2): anchor on the repo root handed through registration
      // context, NOT process.cwd() — the gate must run the repo's checks.
      const cwd = repoRoot;
      const jsFiles = editedFiles.filter((f) => f.endsWith(".js") || f.endsWith(".mjs"));
      for (const f of jsFiles) {
        const r = await runCmd(process.execPath, ["--check", f], cwd, CHECK_TIMEOUT_MS);
        if (r.code !== 0) {
          return { pass: false, summary: `node --check failed: ${f}: ${r.err.slice(-300)}` };
        }
      }
      const touchedSrc = editedFiles.some((f) => f.includes("/src/") || f.startsWith("src/"));
      if (touchedSrc) {
        const t = await runCmd(process.execPath, ["--test"], cwd, TEST_TIMEOUT_MS);
        if (t.code !== 0) return { pass: false, summary: "node --test failed" };
      }
      return { pass: true, summary: `guardrails gate: ${jsFiles.length} checked${touchedSrc ? " + tests" : ""}` };
    } catch (err) {
      return { pass: false, summary: `guardrails:error: ${err?.message ?? err}` };
    }
  };
}

function statsSummaryTool(config) {
  const maxNote =
    Number.isInteger(config?.max_note_chars) && config.max_note_chars > 0
      ? config.max_note_chars
      : 4000;
  return {
    name: "stats-summary",
    description: "Return the guardrails in-memory aggregates (tool stats, event counts).",
    argsSchema: { type: "object", properties: {} },
    run: async () => {
      try {
        const lines = ["tool stats:"];
        for (const [tool, s] of [...state.toolStats.entries()].sort()) {
          lines.push(`  ${tool}: ${s.count} call(s), ${s.totalMs}ms total`);
        }
        lines.push("event counts:");
        for (const [type, n] of [...state.eventCounts.entries()].sort()) {
          lines.push(`  ${type}: ${n}`);
        }
        lines.push(`events counted: ${state.eventTotal} (cap ${EVENT_CAP})`);
        let output = lines.join("\n");
        if (output.length > maxNote) output = output.slice(0, maxNote) + "\n<truncated>";
        return { ok: true, output };
      } catch (err) {
        return { ok: false, output: "", error: String(err?.message ?? err) };
      }
    },
  };
}

export function register(ctx) {
  const config = ctx?.config ?? {};
  const repoRoot = ctx?.repoRoot ?? process.cwd(); // 6.6: ctx carries it
  ctx.registerHook("pre-tool", preTool(config));
  ctx.registerHook("post-tool", postTool());
  ctx.registerHook("on-event", onEvent());
  ctx.registerHook("verify-gate", verifyGate(repoRoot));
  ctx.registerTool("stats-summary", statsSummaryTool(config));
}

export default { register, reset };
