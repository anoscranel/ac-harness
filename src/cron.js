// src/cron.js — scheduled runs, as data. No daemon, no polling loop.
//
// WHY THIS SHAPE (and not Hermes' cron_providers, which runs a scheduler)
// A background supervisor is the one thing a phone-class harness cannot
// afford: Android kills it, it burns the battery, and it competes with the
// 97%-full disk for headroom. So the design splits the two halves of cron:
//
//   - WHAT to run and WHEN  → lives here, as a JSON file the agent can read
//   - STARTING it           → stays external (termux-job-scheduler, crond,
//                             a human, or the operator's daily session)
//
// The contract is idempotency: `tick` may be called any number of times at
// any moment, and it runs exactly the jobs that are due and not currently
// running. A missed window is a skipped run (at-most-once), recorded as such
// — because on this device, a quietly-duplicated side effect is worse than a
// quietly-missed one.
//
// Job record shape (one JSON object per file in <root>/jobs/):
//   { id, schedule_hours, prompt, allow: [tools], last_run: null|ISO,
//     last_outcome: null|"ok"|"failed", running: false }
//
// Feature parity target: Hermes' cron family (MIT, design only; no code).

import { mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { redact } from "./events.js"; // C1: same redaction as the event log + memory (one implementation)

export const DEFAULT_ROOT = join(
  process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
  "ac-harness",
  "cron",
);

const nowIso = () => new Date().toISOString();
const idOf = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);

export class CronStore {
  constructor({ root = process.env.AC_CRON_ROOT || DEFAULT_ROOT } = {}) {
    this.root = root;
    this.jobsDir = join(root, "jobs");
    this.runsDir = join(root, "runs");
  }

  async #ensure() {
    await mkdir(this.jobsDir, { recursive: true });
    await mkdir(this.runsDir, { recursive: true });
  }

  /** Define or update a job. Same id = idempotent overwrite. */
  async define({ id = null, name, schedule_hours, prompt, allow = ["read", "grep"] }) {
    if (!name || !prompt) throw new Error("cron job needs name and prompt");
    if (!Number.isFinite(schedule_hours) || schedule_hours <= 0) {
      throw new Error("schedule_hours must be a positive number");
    }
    await this.#ensure();
    // C1 (audit-cron, HIGH): job files OUTLIVE the event log — the same
    // durable-store rule memory obeys (ship-1 A2/A3). The SAME redact()
    // the event log uses screens prompt + name BEFORE any writeFile; the id
    // derives from the UNredacted pair so a re-define stays idempotent for
    // the user's own input while the DURABLE fields never carry a secret.
    const job = {
      id: id || idOf(`${name}:${prompt}`),
      name: redact(name),
      schedule_hours,
      prompt: redact(prompt),
      allow,
      last_run: null,
      last_outcome: null,
      running: false,
    };
    // existing state survives a re-define with the same id
    try {
      const old = JSON.parse(await readFile(join(this.jobsDir, `${job.id}.json`), "utf8"));
      job.last_run = old.last_run;
      job.last_outcome = old.last_outcome;
      job.running = old.running;
    } catch { /* new job */ }
    await writeFile(join(this.jobsDir, `${job.id}.json`), JSON.stringify(job, null, 2));
    return job;
  }

  async list() {
    try {
      const names = (await readdir(this.jobsDir)).filter((f) => f.endsWith(".json"));
      const out = [];
      for (const n of names) {
        out.push(JSON.parse(await readFile(join(this.jobsDir, n), "utf8")));
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * True when the job is due (never ran, or its window elapsed).
   * C2 (audit-cron, MED): a `running:true` left by a crashed process is
   * STALE when last_run is null or older than max(2x schedule_hours, 1h) —
   * the mark-then-run mark EXPIRES instead of silently stopping the job
   * forever. A fresh mark still blocks (double-start protection intact).
   */
  #isDue(job, at = new Date()) {
    if (job.running) {
      if (!job.last_run) return true; // marked but nothing ever ran: crash at the flip
      const sinceMarkH = (at - new Date(job.last_run)) / 36e5;
      return sinceMarkH >= Math.max(2 * job.schedule_hours, 1);
    }
    if (!job.last_run) return true;
    const elapsedH = (at - new Date(job.last_run)) / 36e5;
    return elapsedH >= job.schedule_hours;
  }

  /** C2: true when THIS due pass is the recovery of a stale running mark. */
  #isStaleRecovery(job, at = new Date()) {
    if (!job.running) return false;
    if (!job.last_run) return true;
    const sinceMarkH = (at - new Date(job.last_run)) / 36e5;
    return sinceMarkH >= Math.max(2 * job.schedule_hours, 1);
  }

  /**
   * Run every due job via the callback (the host supplies the actual runner —
   * headless `run`, delegate, or a test double). Idempotent: concurrent ticks
   * see `running:false` only for jobs they themselves flip, because the flag
   * is written BEFORE the runner starts (mark-then-run, the asyncio-shield
   * pattern that survives a crashed tick).
   *
   * @param {(job)=>Promise<{ok:boolean, log?:string}>} runner
   * @returns {Promise<Array<{id, name, ran:boolean, ok?:boolean, skipped?:string}>>}
   */
  async tick(runner, { at = new Date(), force = false } = {}) {
    const results = [];
    for (const job of await this.list()) {
      const recovered = !force && this.#isStaleRecovery(job, at);
      if (!force && !this.#isDue(job, at)) {
        results.push({ id: job.id, name: job.name, ran: false, skipped: "not due" });
        continue;
      }
      // mark-then-run: flip the flag on disk first, so a second tick racing
      // us (or a crash mid-run) leaves the job visibly running/failed, never
      // silently double-started
      job.running = true;
      await writeFile(join(this.jobsDir, `${job.id}.json`), JSON.stringify(redact(job), null, 2));
      let ok = false, logPath = null;
      try {
        const r = await runner(job);
        ok = !!r?.ok;
        logPath = r?.log ?? null;
      } catch (e) {
        ok = false;
        await writeFile(
          join(this.runsDir, `${job.id}-${Date.now()}.err`),
          String(e && e.stack || e),
        );
      }
      const final = await this.#load(job.id);
      final.running = false; // C2: the stale mark clears on the recovery run
      final.last_run = nowIso();
      final.last_outcome = ok ? "ok" : "failed";
      await writeFile(join(this.jobsDir, `${final.id}.json`), JSON.stringify(redact(final), null, 2));
      results.push({ id: job.id, name: job.name, ran: true, ok, ...(recovered ? { recovered: true } : {}) });
      void logPath;
    }
    return results;
  }

  async #load(id) {
    return JSON.parse(await readFile(join(this.jobsDir, `${id}.json`), "utf8"));
  }

  async remove(id) {
    await rm(join(this.jobsDir, `${id}.json`), { force: true });
    return true;
  }
}

export default CronStore;
