// src/tools/grep.js — content search via the `rg` binary (the ONLY runtime
// non-builtin dependency). If rg is absent the tool warns once and fails
// gracefully (ok:false), never crashes the loop.
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

export const name = "grep";
export const description = "Search file contents with ripgrep (rg).";

export const argsSchema = {
  type: "object",
  required: ["pattern"],
  additionalProperties: false,
  properties: {
    pattern: { type: "string", minLength: 1 },
    path: { type: "string" },
    glob: { type: "string" },
    ignore_case: { type: "boolean" },
    max_results: { type: "integer" },
  },
};

const MAX_OUTPUT = 1 << 20; // 1 MiB cap on captured stdout

let rgAvailable; // memoized probe

export function probeRg() {
  if (rgAvailable === undefined) {
    try {
      const r = spawnSync("rg", ["--version"], { encoding: "utf8" });
      rgAvailable = r.error ? false : r.status === 0;
    } catch {
      rgAvailable = false;
    }
    if (!rgAvailable) {
      process.stderr.write("warning: rg binary not found; grep tool will fail gracefully\n");
    }
  }
  return rgAvailable;
}

export async function run(args, ctx = {}) {
  if (!probeRg()) {
    return { ok: false, error: "rg binary not found on PATH", output: "" };
  }
  const rgArgs = ["--line-number", "--no-heading", "--color", "never"];
  if (args.glob) rgArgs.push("--glob", args.glob);
  if (args.ignore_case) rgArgs.push("-i");
  if (args.max_results) rgArgs.push("--max-count", String(args.max_results));
  rgArgs.push("--", args.pattern);
  rgArgs.push(resolve(ctx.cwd ?? process.cwd(), args.path ?? "."));

  return await new Promise((resolvePromise) => {
    const child = spawn("rg", rgArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let truncated = false;
    const onAbort = () => child.kill("SIGTERM");
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    // F27: both streams capped at 1 MiB with a truncation marker.
    child.stdout.on("data", (d) => {
      if (out.length < MAX_OUTPUT) out += d.toString("utf8");
      else if (!truncated) {
        out += "\n<truncated>";
        truncated = true;
      }
    });
    child.stderr.on("data", (d) => {
      if (err.length < MAX_OUTPUT) err += d.toString("utf8");
      else if (!err.endsWith("\n<truncated>")) err += "\n<truncated>";
    });
    child.on("error", (e) => {
      ctx.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ ok: false, error: `rg spawn failed: ${e.message}`, output: "" });
    });
    child.on("close", (code) => {
      ctx.signal?.removeEventListener("abort", onAbort);
      // rg exit codes: 0 = matches, 1 = no matches, 2+ = error.
      if (code === 0 || code === 1) {
        resolvePromise({ ok: true, output: out, bytes: Buffer.byteLength(out, "utf8"), truncated });
      } else {
        resolvePromise({ ok: false, error: `rg exited ${code}: ${err.slice(0, 500)}`, output: out, truncated });
      }
    });
  });
}

export default { name, description, argsSchema, run };
