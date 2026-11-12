// test/cron-recovery.test.js — audit-cron adoption conditions C1 (redaction
// before durable write) + C2 (stale running:true recovery). Keyed by the
// audit IDs so the trail is legible. REDACTOR HAZARD: the secret-shaped
// fixture is fragment-assembled — no secret-shaped literal exists in source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronStore } from "../src/cron.js";

async function store(dir) {
  const root = join(dir, "cron-root");
  return new CronStore({ root });
}

// ---------- C1: redaction before every durable write ------------------------
test("C1: a secret-shaped prompt never reaches the job file (redact() reused)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cronC1-"));
  try {
    const s = await store(dir);
    // fragment-assembled fixture (redactor hazard)
    const SECRET = ["sk", "abcdefgh12345678"].join("-");
    const job = await s.define({
      name: "daily-prompt-audit",
      schedule_hours: 1,
      prompt: `check the token ${SECRET} in the registry`,
    });
    const raw = await readFile(join(s.jobsDir, `${job.id}.json`), "utf8");
    assert.ok(!raw.includes(SECRET), "the secret never hit disk");
    assert.ok(raw.includes("[REDACTED]"), "redaction marker present");
    // and a NORMAL prompt round-trips unchanged
    const s2 = await store(dir);
    const plain = await s2.define({
      name: "clean",
      schedule_hours: 1,
      prompt: "summarize the changelog",
    });
    const raw2 = await readFile(join(s2.jobsDir, `${plain.id}.json`), "utf8");
    const parsed = JSON.parse(raw2);
    assert.equal(parsed.prompt, "summarize the changelog", "normal text unchanged");
    assert.equal(parsed.name, "clean");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("C1: name is screened too; the id stays stable across a re-define", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cronC1b-"));
  try {
    const s = await store(dir);
    const SECRET = ["ghp", "abcdefgh1234567890"].join("_");
    const a = await s.define({ name: `job-${SECRET}`, schedule_hours: 1, prompt: "p" });
    const raw = await readFile(join(s.jobsDir, `${a.id}.json`), "utf8");
    assert.ok(!raw.includes(SECRET), "name-level secret never hits disk");
    // idempotent re-define with the SAME input → same id (the id derives
    // from the unredacted pair — by design; only durable FIELDS are screened)
    const b = await s.define({ name: `job-${SECRET}`, schedule_hours: 1, prompt: "p" });
    assert.equal(b.id, a.id, "id stable across a re-define");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- C2: stale running:true recovery ----------------------------------
test("C2: a job left running:true with an old last_run RUNS on the next tick, reports recovered, and the flag clears", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cronC2-"));
  try {
    const s = await store(dir);
    // simulate the crash state: define, then OVERWRITE the file with the mark
    // left hanging and last_run 10 hours old (schedule 1h → stale at max(2h, 1h))
    const job = await s.define({ name: "ghost", schedule_hours: 1, prompt: "do a thing" });
    const id = job.id;
    const crashedState = {
      ...job,
      running: true,
      last_run: new Date(Date.now() - 10 * 36e5).toISOString(), // 10h ago
    };
    await writeFile(join(s.jobsDir, `${id}.json`), JSON.stringify(crashedState, null, 2));

    let ran = 0;
    const results = await s.tick(async () => {
      ran += 1;
      return { ok: true };
    });
    assert.equal(ran, 1, "the stale-marked job RAN (recovery)");
    assert.equal(results.length, 1);
    assert.equal(results[0].ran, true);
    assert.equal(results[0].recovered, true, "the result reports restored recovery");
    assert.equal(results[0].ok, true);
    // and the flag CLEARED on disk
    const after = JSON.parse(await readFile(join(s.jobsDir, `${id}.json`), "utf8"));
    assert.equal(after.running, false, "running cleared by the recovery run");
    assert.equal(after.last_outcome, "ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("C2: a FRESH running mark still blocks (double-start protection intact)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cronC2b-"));
  try {
    const s = await store(dir);
    const job = await s.define({ name: "busy", schedule_hours: 1, prompt: "p" });
    // simulate a live run: running:true, last_run NOW (the mark updates on
    // the re-define path? No — simulate by writing directly like the crash
    // case but with a fresh timestamp)
    const freshMark = {
      ...job,
      running: true,
      last_run: new Date().toISOString(), // just marked
    };
    await writeFile(join(s.jobsDir, `${job.id}.json`), JSON.stringify(freshMark, null, 2));
    let ran = 0;
    const results = await s.tick(async () => {
      ran += 1;
      return { ok: true };
    });
    assert.equal(ran, 0, "a fresh mark blocks (not stale)");
    assert.equal(results[0].ran, false);
    assert.equal(results[0].skipped, "not due");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("C2: running:true with last_run null = crash at the flip → recovers immediately", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cronC2c-"));
  try {
    const s = await store(dir);
    const job = await s.define({ name: "flip", schedule_hours: 1, prompt: "p" });
    const crashAtFlip = { ...job, running: true, last_run: null };
    await writeFile(join(s.jobsDir, `${job.id}.json`), JSON.stringify(crashAtFlip, null, 2));
    let ran = 0;
    const results = await s.tick(async () => {
      ran += 1;
      return { ok: true };
    });
    assert.equal(ran, 1);
    assert.equal(results[0].recovered, true, "null last_run + running = immediate recovery");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
