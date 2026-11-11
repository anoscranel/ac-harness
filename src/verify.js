// src/verify.js — the verify-gate: run test/lint/build hooks after edits.
// Default hook: `node --check` on each edited src file (cheapest first), then
// `node --test`. Exit codes decide pass/fail; no model judges the result.
// A failed verify-gate makes the LOOP pause and ask (policy) — see loop.js.
// `verify-gate` is a `single` plugin hook (specs/plugin-manifest.md §hooks):
// a plugin may replace this default wholesale.

import { spawn } from "node:child_process";

const TEST_TIMEOUT_MS = 300_000;
const CHECK_TIMEOUT_MS = 30_000;
const MAX_CAPTURE = 1 << 20; // 1 MiB per stream (F27)

function run(cmd, args, { cwd, timeoutMs, signal }) {
  return new Promise((resolvePromise) => {
    // F2 (review-r1): detached process group; abort/timeout kills the group
    // with SIGTERM, escalating to SIGKILL after 2s.
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let out = "";
    let err = "";
    let exited = false;
    let settled = false;
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
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(escalation);
      signal?.removeEventListener("abort", onAbort);
      resolvePromise(result);
    };
    const killAndSettle = (suffix) => {
      if (!exited) {
        killGroup("SIGTERM");
        escalation = setTimeout(() => {
          if (!exited) killGroup("SIGKILL");
        }, 2_000);
      }
      setTimeout(() => settle({ code: -1, out, err: err + suffix }), 500);
    };
    const onAbort = () => killAndSettle("\n<aborted>");
    const timer = setTimeout(() => killAndSettle("\n<timeout>"), timeoutMs);

    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d) => {
      if (out.length < MAX_CAPTURE) out += d.toString("utf8");
      else if (!out.endsWith("\n<truncated>")) out += "\n<truncated>";
    });
    child.stderr.on("data", (d) => {
      if (err.length < MAX_CAPTURE) err += d.toString("utf8");
      else if (!err.endsWith("\n<truncated>")) err += "\n<truncated>";
    });
    child.on("error", (e) => settle({ code: -1, out, err: String(e.message) }));
    child.on("exit", () => {
      exited = true;
    });
    child.on("close", (code) => {
      exited = true;
      settle({ code, out, err });
    });
  });
}

/**
 * Default verify gate.
 * @param {object} opts
 * @param {string} opts.cwd repo root to run in
 * @returns {({editedFiles:string[], signal?:AbortSignal}) => Promise<{ok:boolean, results:Array, summary:string}>}
 */
export function createDefaultVerifyGate({ cwd }) {
  return async function verifyGate({ editedFiles = [], signal } = {}) {
    const results = [];

    // Cheapest first: syntax-check every edited src file.
    for (const file of editedFiles) {
      const r = await run(process.execPath, ["--check", file], {
        cwd,
        timeoutMs: CHECK_TIMEOUT_MS,
        signal,
      });
      results.push({ name: `node --check ${file}`, code: r.code, tail: r.err.slice(-2000) });
      if (r.code !== 0) {
        return { ok: false, results, summary: `node --check failed: ${file}` };
      }
    }

    // Then the test suite.
    const t = await run(process.execPath, ["--test"], { cwd, timeoutMs: TEST_TIMEOUT_MS, signal });
    results.push({ name: "node --test", code: t.code, tail: t.err.slice(-2000) });
    if (t.code !== 0) {
      return { ok: false, results, summary: "node --test failed" };
    }

    return { ok: true, results, summary: "ok" };
  };
}

export default { createDefaultVerifyGate };
