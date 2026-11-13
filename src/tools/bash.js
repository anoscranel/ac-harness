// src/tools/bash.js — shell execution. The policy gate runs AHEAD of spawn:
// the loop evaluates policy before any tool runs, and this tool additionally
// refuses to spawn unless ctx.allowed === true (defence in depth).
// Cancellation: ctx.signal abort kills the child mid-execution.
import { spawn } from "node:child_process";
import { CheckpointStore, resolveRoot } from "../checkpoint.js";

export const name = "bash";
export const description =
  "Run a shell command via sh -c. Gated by policy (ask by default). " +
  "Snapshots the working tree first (v0.9.0 S3) so a bash rewrite is undoable " +
  "like write/edit; --no-snapshot opts a deliberate run out.";

export const argsSchema = {
  type: "object",
  required: ["command"],
  additionalProperties: false,
  properties: {
    command: { type: "string", minLength: 1 },
    timeout_ms: { type: "integer" },
    no_snapshot: { type: "boolean", description: "v0.9.0 S3: skip the pre-run snapshot (deliberate; default ON)" },
  },
};

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_CAPTURE = 1 << 20; // 1 MiB per stream

export async function run(args, ctx = {}) {
  if (ctx.allowed !== true) {
    // The loop's policy gate is the primary boundary; this is the backstop.
    return { ok: false, error: "policy gate did not allow this bash call", output: "" };
  }
  const timeoutMs = args.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  // v0.9.0 S3 (the v0.8.0 survey's dead-end 3): bash is the ONLY mutating
  // tool without an undo. Snapshot BEFORE the shell runs — the most damaging
  // tool should be the most undoable. Content-addressed store: an unchanged
  // tree costs a manifest, not copies. Best-effort exactly like write.js: a
  // checkpoint failure never blocks the run but IS reported.
  // Guards: --no-snapshot opts a deliberate run out entirely; a byte budget
  // (default 32 MiB PER RUN, store.total) skips with a reason instead of
  // stalling a phone-class device on a big tree.
  let checkpoint = null;
  if (args.no_snapshot === true) {
    checkpoint = { skipped: "no_snapshot: requested" };
  } else {
    try {
      const cwd = ctx.cwd ?? process.cwd();
      const store = new CheckpointStore({ root: resolveRoot(ctx.checkpointRoot), cwd });
      const SNAP_BYTE_BUDGET = Number(process.env.AC_BASH_SNAPSHOT_MAX_BYTES || 32 << 20);
      const bytes = await store.size();
      if (bytes > SNAP_BYTE_BUDGET) {
        // one tally, then the snapshot WOULD walk the same tree: skip
        checkpoint = {
          skipped: `snapshot budget: store is ${bytes} bytes (budget ${SNAP_BYTE_BUDGET}); snapshot skipped`,
        };
      } else {
        const { seq } = await store.snapshot({
          label: `bash:${args.command.slice(0, 40)}`,
        });
        checkpoint = seq;
      }
    } catch (e) {
      checkpoint = { error: String(e && e.message || e) };
    }
  }

  return await new Promise((resolvePromise) => {
    // F2 (review-r1): detached so the child leads its own process group;
    // abort/timeout kills the GROUP (-pid), with SIGKILL escalation after 2s,
    // and finish() waits for exit (bounded 500ms) before resolving.
    // v0.6.0 SR4 (F-D10.6): platform shell selection. On win32 there is no
    // sh and no process-group signalling — cmd.exe /d /s /c (delays
    // AutoRun extensions, strip-quote semantics, then the command) replaces
    // sh -c; the 1 MiB caps + timeout + abort semantics below are unchanged
    // (the platform kill path degrades to child.kill; the detached flag is
    // already False on win32).
    const onWindows = process.platform === "win32";
    const shell = onWindows ? "cmd.exe" : "sh";
    const shellArgs = onWindows ? ["/d", "/s", "/c", args.command] : ["-c", args.command];
    const child = spawn(shell, shellArgs, {
      cwd: ctx.cwd ?? process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: ctx.env ?? process.env,
      detached: process.platform !== "win32",
    });
    let out = "";
    let err = "";
    let settled = false;
    let exited = false;
    let truncated = false;
    let escalation;

    const killGroup = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already dead */
        }
      }
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(escalation);
      ctx.signal?.removeEventListener("abort", onAbort);
      resolvePromise(result);
    };
    const killAndSettle = (reason) => {
      if (exited) return finish(reason());
      killGroup("SIGTERM");
      // SIGKILL escalation if the group ignores SIGTERM.
      escalation = setTimeout(() => {
        if (!exited) killGroup("SIGKILL");
      }, 2_000);
      // Bounded wait for death (500ms), then resolve regardless.
      setTimeout(() => finish(reason()), 500);
    };
    const onAbort = () =>
      killAndSettle(() => ({ ok: false, error: "aborted", output: out + err, truncated }));
    const timer = setTimeout(
      () =>
        killAndSettle(() => ({
          ok: false,
          error: `timeout after ${timeoutMs}ms`,
          output: out + err,
          truncated,
        })),
      timeoutMs,
    );

    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    // U+FFFD replacement on decode (specs/invariants.md §5).
    child.stdout.on("data", (d) => {
      if (out.length < MAX_CAPTURE) out += d.toString("utf8");
      else truncated = true;
    });
    child.stderr.on("data", (d) => {
      if (err.length < MAX_CAPTURE) err += d.toString("utf8");
      else truncated = true;
    });
    child.on("error", (e) => finish({ ok: false, error: `spawn failed: ${e.message}`, output: "" }));
    child.on("exit", () => {
      exited = true;
    });
    child.on("close", (code) => {
      exited = true;
      const output = out + (err ? `\n[stderr]\n${err}` : "");
      finish({
        ok: code === 0,
        output,
        error: code === 0 ? undefined : `exit code ${code}`,
        bytes: Buffer.byteLength(output, "utf8"),
        truncated,
        checkpoint, // v0.9.0 S3: seq | {skipped} | {error} — the undo trail
      });
    });
  });
}

export default { name, description, argsSchema, run };
