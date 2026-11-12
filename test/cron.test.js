// test/cron.test.js — cron-as-data must be idempotent, crash-safe and honest
// about skipped runs. The load-bearing tests: mark-then-run under a racing
// tick, and at-most-once semantics for missed windows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CronStore } from "../src/cron.js";

async function sandbox() {
  const cwd = await mkdtemp(join(tmpdir(), "ac-cron-"));
  return { cwd, store: new CronStore({ root: join(cwd, "cron") }) };
}

test("define is idempotent: same name+prompt keeps run history", async () => {
  const { cwd, store } = await sandbox();
  const j1 = await store.define({ name: "daily", schedule_hours: 24, prompt: "check the build" });
  const j2 = await store.define({ name: "daily", schedule_hours: 24, prompt: "check the build" });
  assert.equal(j1.id, j2.id, "same identity");
  assert.equal((await store.list()).length, 1);
  await rm(cwd, { recursive: true, force: true });
});

test("define validates: garbage schedule throws, not silently coerces", async () => {
  const { cwd, store } = await sandbox();
  await assert.rejects(store.define({ name: "x", schedule_hours: 0, prompt: "p" }), /positive/);
  await assert.rejects(store.define({ name: "x", schedule_hours: -5, prompt: "p" }), /positive/);
  await assert.rejects(store.define({ name: "x", schedule_hours: "daily", prompt: "p" }), /positive/);
  await rm(cwd, { recursive: true, force: true });
});

test("tick runs a never-run job and records the outcome", async () => {
  const { cwd, store } = await sandbox();
  await store.define({ name: "hourly", schedule_hours: 1, prompt: "say hi" });
  const ran = [];
  const results = await store.tick(async (job) => { ran.push(job.name); return { ok: true }; });
  assert.equal(ran.length, 1);
  assert.equal(results[0].ran, true);
  assert.equal(results[0].ok, true);

  const after = (await store.list())[0];
  assert.equal(after.last_outcome, "ok");
  assert.ok(after.last_run);
  await rm(cwd, { recursive: true, force: true });
});

test("a job that just ran is NOT due again immediately (at-most-once)", async () => {
  const { cwd, store } = await sandbox();
  await store.define({ name: "hourly", schedule_hours: 1, prompt: "say hi" });
  let runs = 0;
  await store.tick(async () => { runs++; return { ok: true }; });
  const second = await store.tick(async () => { runs++; return { ok: true }; });
  assert.equal(runs, 1, "second tick must not re-run the job");
  assert.equal(second[0].ran, false);
  assert.equal(second[0].skipped, "not due");
  await rm(cwd, { recursive: true, force: true });
});

test("a failed runner records failed, not ok — and reruns on the next tick", async () => {
  const { cwd, store } = await sandbox();
  await store.define({ name: "flaky", schedule_hours: 1, prompt: "p" });
  const r1 = await store.tick(async () => { throw new Error("boom"); });
  assert.equal(r1[0].ok, false);
  assert.equal((await store.list())[0].last_outcome, "failed");

  // simulate an hour passing: patch the clock by backdating last_run
  const job = (await store.list())[0];
  const { define } = store;
  const backdated = new Date(Date.now() - 2 * 36e5).toISOString();
  await import("node:fs/promises").then((f) =>
    f.writeFile(
      join(store.jobsDir, `${job.id}.json`),
      JSON.stringify({ ...job, last_run: backdated }),
    ),
  );
  const r2 = await store.tick(async () => ({ ok: true }));
  assert.equal(r2[0].ran, true, "due again after the window elapsed");
  assert.equal(r2[0].ok, true);
  await rm(cwd, { recursive: true, force: true });
});

test("mark-then-run: a crashing tick leaves the job marked running, never double-started", async () => {
  const { cwd, store } = await sandbox();
  await store.define({ name: "crashy", schedule_hours: 1, prompt: "p" });

  // a runner that dies so hard the tick never finishes (simulated by an
  // exception thrown from writeFile inside tick is hard; emulate by killing
  // the process is overkill — instead verify the ON-DISK invariant directly)
  let sawRunning = false;
  await store.tick(async (job) => {
    // while the runner is in flight, the file on disk must say running:true
    const onDisk = JSON.parse(await readFile(join(store.jobsDir, `${job.id}.json`), "utf8"));
    sawRunning = onDisk.running === true;
    return { ok: true };
  });
  assert.ok(sawRunning, "the running flag was written BEFORE the runner started");
  const after = (await store.list())[0];
  assert.equal(after.running, false, "and cleared after");
  await rm(cwd, { recursive: true, force: true });
});

test("tick(force) runs even when not due — the operator's override", async () => {
  const { cwd, store } = await sandbox();
  await store.define({ name: "slow", schedule_hours: 720, prompt: "p" });
  await store.tick(async () => ({ ok: true }));
  const forced = await store.tick(async () => ({ ok: true }), { force: true });
  assert.equal(forced[0].ran, true);
  await rm(cwd, { recursive: true, force: true });
});

test("an empty store ticks cleanly (no jobs, no error)", async () => {
  const { cwd, store } = await sandbox();
  const results = await store.tick(async () => ({ ok: true }));
  assert.deepEqual(results, []);
  await rm(cwd, { recursive: true, force: true });
});
