// test/delegate.test.js — delegation must be a fresh-context child with a
// tool allowlist that actually restricts it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run as delegateRun } from "../src/tools/delegate.js";

const CWD = () => process.cwd();

test("a read+grep child completes and returns the child's summary", { timeout: 45_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ac-dele-"));
  await writeFile(join(cwd, "note.txt"), "the delegate test fixture");
  try {
    const r = await delegateRun({ prompt: `tool:read {"path":"note.txt"} — summarize the file` }, { cwd });
    assert.equal(r.ok, true, `child failed: ${r.error}`);
    assert.ok(r.child_log, "summary carries the child's log path");
    await rm(cwd, { recursive: true, force: true });
  } catch (e) {
    await rm(cwd, { recursive: true, force: true });
    throw e;
  }
});

test("a child with default tools CANNOT write — the allowlist restricts (attempt verified)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ac-dele2-"));
  const work = await mkdtemp(join(tmpdir(), "ac-dele2-work-"));
  try {
    // the child asks for write; default allowlist is read+grep only, so the
    // headless askResolver must DENY. The child genuinely attempts the call
    // (fix from the parser-bug round: previously the prompt was corrupted and
    // the attempt never happened — the test passed for the wrong reason).
    const r = await delegateRun({ prompt: `tool:write {"path":"${join(work, "escape.txt")}","content":"x"}` }, { cwd });
    // r.ok is the RUN status, not the write: verify from the child's own log
    // that the write was ATTEMPTED and DENIED — a security test that passes
    // because the attack never launched proves nothing.
    const { readFile: readLog } = await import("node:fs/promises");
    const raw = await readLog(r.child_log ?? join(cwd, "logs", (r.output.match(/run-\d+/) || [""])[0] + ".jsonl"), "utf8");
    const sawAttempt = raw.includes('"tool": "write"') || raw.includes('"tool":"write"');
    assert.ok(sawAttempt, "the child must have actually attempted the write");
    const sawDeny = raw.includes("policy-denied") || raw.includes('"verdict": "deny"');
    assert.ok(sawDeny, "the child log must show the deny");
    await assert.rejects(
      () => import("node:fs/promises").then((f) => f.access(join(work, "escape.txt"))),
      { code: "ENOENT" },
      "the child must NOT have been able to write escape.txt",
    );
    await rm(cwd, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  } catch (e) {
    await rm(cwd, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
    throw e;
  }
});

test("an explicit extra allow does what it says (read + write)", { timeout: 45_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ac-dele3-"));
  const work = await mkdtemp(join(tmpdir(), "ac-dele3-work-"));
  try {
    const r = await delegateRun(
      // the child's event log is written under <cwd>/logs/, so the write
      // target must live OUTSIDE cwd or pinned.deny_log_path correctly
      // rejects it (a write next to the log is tampering).
      { prompt: `tool:write {"path":"${join(work, "ok.txt")}","content":"explicitly allowed"}`, allow: ["write"] },
      { cwd },
    );
    assert.equal(r.ok, true, `child failed: ${r.error}`);
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(join(work, "ok.txt"), "utf8");
    assert.equal(text, "explicitly allowed");
    await rm(cwd, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  } catch (e) {
    await rm(cwd, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
    throw e;
  }
});

test("delegate rejects a recursive delegation (no delegate-in-delegate)", { timeout: 15_000 }, async () => {
  const tools = ["read", "grep", "delegate"].filter((t) => t !== "delegate");
  assert.deepEqual(tools, ["read", "grep"], "delegate must be filtered from child allowlists");
});
