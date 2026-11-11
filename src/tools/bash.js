// src/tools/bash.js — shell execution. The policy gate runs AHEAD of spawn:
// the loop evaluates policy before any tool runs, and this tool additionally
// refuses to spawn unless ctx.allowed === true (defence in depth).
// Cancellation: ctx.signal abort kills the child mid-execution.
import { spawn } from "node:child_process";

export const name = "bash";
export const description = "Run a shell command via sh -c. Gated by policy (ask by default).";

export const argsSchema = {
  type: "object",
  required: ["command"],
  additionalProperties: false,
  properties: {
    command: { type: "string", minLength: 1 },
    timeout_ms: { type: "integer" },
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

  return await new Promise((resolvePromise) => {
    // F2 (review-r1): detached so the child leads its own process group;
    // abort/timeout kills the GROUP (-pid), with SIGKILL escalation after 2s,
    // and finish() waits for exit (bounded 500ms) before resolving.
    const child = spawn("sh", ["-c", args.command], {
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
      });
    });
  });
}

export default { name, description, argsSchema, run };
