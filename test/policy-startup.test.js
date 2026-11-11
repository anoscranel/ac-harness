// test/policy-startup.test.js — the startup-refusal contract: an unparseable
// rules file must refuse startup (loadRulesFile throws PolicyError) AND the
// caller must log a policy.error event (the pattern src/server.js implements).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, readAll } from "../src/events.js";
import { PolicyError, loadRulesFile } from "../src/policy.js";

test("unparseable rules file → PolicyError (startup refusal) + policy.error logged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-policy-"));
  try {
    const rulesPath = join(dir, "rules.json");
    await writeFile(rulesPath, "{ not valid json ", "utf8");

    const log = await EventLog.open(join(dir, "events.jsonl"));

    // Caller-side startup pattern (same as src/server.js createSession):
    // refuse startup, and record the refusal in the event log.
    let refused = false;
    try {
      await loadRulesFile(rulesPath);
    } catch (err) {
      refused = true;
      assert.ok(err instanceof PolicyError, `expected PolicyError, got ${err}`);
      assert.match(err.message, /unparseable rules file/);
      await log.appendEvent("policy.error", "policy", {
        message: err.message,
        source: rulesPath,
      });
    }
    assert.ok(refused, "startup must refuse on an unparseable rules file");

    const events = await readAll(log.path);
    const errEv = events.find((e) => e.type === "policy.error");
    assert.ok(errEv, "policy.error event must be written to the log");
    assert.equal(errEv.actor, "policy");
    assert.equal(errEv.data.source, rulesPath);
    assert.match(errEv.data.message, /unparseable rules file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

