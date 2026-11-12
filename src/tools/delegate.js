// src/tools/delegate.js — run a child agent one-shot, headless.
//
// WHY THIS EXISTS
// The doctrine's law 2 is a two-tier split: a planner that never implements,
// and cheap fresh-context workers. Until now this harness had one tier. `run`
// (headless mode) is the primitive; `delegate` is the tier on top of it.
// Feature parity target: Hermes' delegate_tool family (MIT, design only; no
// code copied).
//
// SECURITY SHAPE — the trifecta, applied.
// A child that inherits the parent's tools could read secrets and write files
// (it holds untrusted content AND file access simultaneously). So:
//   1. The child gets an EXPLICIT tool allowlist via --policy-allow, one tool,
//      one session rule, one run. Default: read+grep only (research posture).
//   2. The child is launched with cwd PASSED THROUGH policy: delegation is
//      gated `ask` at the PARENT's policy layer (see policy-defaults), so a
//      human approves what a child may do before it exists.
//   3. The child never gets an interactive ask: its askResolver denies
//      (headless fail-closed). The parent's approval IS the whole authorisation.
//
// WHAT THE PARENT SEES: the child's stdout JSON summary + the log path (the
// child's own event log — the file is the checkpoint, always).

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url)); // src/tools
const CLI = resolve(HERE, "..", "cli.js");

const MAX_PROMPT_CHARS = 8000;
const DEFAULT_TIMEOUT_MS = 600_000;
// D4 (audit-delegate): the timeout is CLAMPED 30s..900s regardless of the
// env knob or the args — 0 must not be an instant kill, and no caller can
// park a child for hours. Env default flows through the same clamp.
const MIN_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 900_000;
export function clampDelegateTimeout(ms) {
  const n = Number(ms);
  const base = Number.isFinite(n) ? n : DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, base));
}
const TIMEOUT_MS = clampDelegateTimeout(process.env.AC_DELEGATE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);

// D1 (audit-delegate, HIGH): the child env is an EXPLICIT ALLOWLIST, never a
// copy of process.env. The child only needs the ability to resolve binaries
// (PATH), find its home/tmp (HOME, TMPDIR, TMP), speak (LANG/LC_ALL/TERM),
// honor NO_COLOR, read its provider config (HARNESS_PROVIDER_* keys live in
// the PARENT and pass through BY NAME), and its own delegate knobs
// (AC_DELEGATE_*). Everything else is stripped: secrets in the parent env —
// tokens, keys, session credentials for OTHER surfaces — are not the
// child's business, and a child that may hold untrusted content must never
// gain an egress credential by inheritance. Fail closed by construction.
const ENV_ALLOW_EXACT = new Set(["PATH", "HOME", "TMPDIR", "TMP", "LANG", "LC_ALL", "TERM", "NO_COLOR"]);
export function childEnv(parent) {
  const out = {};
  for (const [k, v] of Object.entries(parent ?? process.env)) {
    if (ENV_ALLOW_EXACT.has(k)) out[k] = v;
    else if (/^HARNESS_PROVIDER_/.test(k)) out[k] = v;
    else if (/^AC_DELEGATE_/.test(k)) out[k] = v;
    else if (k === "AC_DELEGATE_CHILD") out[k] = v; // D2: the depth marker passes through
  }
  out.AC_DELEGATE_CHILD = "1";
  return out;
}

// D3 (audit-delegate): 1 MiB cap per stream with a truncation marker — the
// same buffer-cap discipline bash.js/grep.js use (F27). A chatty child can
// balloon parent memory no longer.
const MAX_CAPTURE = 1 << 20;
const MARK = "\n[delegate: output truncated at 1 MiB]\n";
export function appendCapped(acc, chunk) {
  const next = acc + chunk;
  if (Buffer.byteLength(next, "utf8") <= MAX_CAPTURE) return next;
  return next.slice(0, MAX_CAPTURE) + MARK;
}

export const name = "delegate";
export const description =
  "Run a fresh child agent one-shot with a clean context. Default tools: read+grep (research only). " +
  "The child cannot ask; it denies and continues on unallowed tools.";
export const argsSchema = {
  type: "object",
  required: ["prompt"],
  additionalProperties: false,
  properties: {
    prompt: { type: "string", minLength: 1, maxLength: MAX_PROMPT_CHARS },
    allow: { type: "array", items: { type: "string" }, description: "extra tools the child may use, e.g. [\"bash\"]" },
    timeout_ms: { type: "number" },
  },
};

export async function run(args, ctx = {}) {
  const prompt = args.prompt;

  // tool allowlist: read+grep always; extras must come from args.allow.
  // bash/write/edit are NEVER included implicitly: a delegation with write
  // power needs the parent's explicit ask-approval of THIS call.
  const tools = ["read", "grep", ...(args.allow ?? [])].filter(
    (t) => t !== "delegate", // no recursion by a child: depth is capped at 2 total
  );

  const argv = [CLI, "run"];
  for (const t of tools) argv.push("--policy-allow", t);
  argv.push("--provider", "echo", prompt);

  const timeout = clampDelegateTimeout(args.timeout_ms ?? TIMEOUT_MS); // D4: 30s..900s

  return await new Promise((res) => {
    const child = spawn(process.execPath, argv, {
      cwd: ctx.cwd ?? process.cwd(),
      env: childEnv(process.env), // D1: allowlist, never the parent's whole env
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "", err = "";
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      err += `\n[delegate] timed out after ${timeout}ms`;
    }, timeout);

    child.stdout.on("data", (d) => (out = appendCapped(out, d))); // D3
    child.stderr.on("data", (d) => (err = appendCapped(err, d))); // D3
    child.on("error", (e) => {
      clearTimeout(t);
      res({ ok: false, error: `delegate spawn failed: ${e.message}`, output: "" });
    });
    child.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0) {
        res({
          ok: false,
          error: `delegate exited ${code}`,
          output: (out + err).slice(-2000),
        });
        return;
      }
      // the child prints a JSON summary as its last stdout block
      let summary = null;
      try {
        const lines = out.trim().split("\n");
        // the summary is a JSON object; the last non-empty line(s) form it —
        // find the opening brace of the final JSON block and slice from there
        const trimmed = lines[lines.length - 1].trim();
        summary = trimmed.startsWith("{") ? JSON.parse(trimmed) : JSON.parse(out.slice(out.indexOf("{\n")));
      } catch {
        summary = { raw: out.slice(-500) };
      }
      res({
        ok: true,
        output: JSON.stringify(summary),
        child_log: summary?.log ?? null,
        child_tokens: summary?.tokens ?? null,
      });
    });
  });
}

export default { name, description, argsSchema, run };
