// test/surfaces-v080.test.js — v0.8.0 S1/S2/S4 surfaces.
// The mechanisms already had tests (checkpoint store, canonicalize, doctor
// internals); these pin the SURFACES a user types. Contract: each command
// returns { lines, exitCode } — see src/{checkpoint,verify,doctor}-cli.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointCommand } from "../src/checkpoint-cli.js";
import { verifyCommand } from "../src/verify-cli.js";
import { doctorCommand } from "../src/doctor-cli.js";

const text = (r) => (r.lines ?? []).join("\n");
const tmp = () => mkdtemp(join(tmpdir(), "ach-surf-"));

test("S1: checkpoint list on an empty store says so and exits 0", { timeout: 20_000 }, async () => {
  const dir = await tmp();
  const r = await checkpointCommand(["list"], { cwd: dir });
  assert.equal(r.exitCode, 0);
  assert.match(text(r), /no checkpoints/i);
});

test("S1: restore REFUSES without --yes, prints preview, touches nothing", { timeout: 25_000 }, async () => {
  const dir = await tmp();
  await writeFile(join(dir, "a.txt"), "before\n");
  const { CheckpointStore, resolveRoot } = await import("../src/checkpoint.js");
  const root = resolveRoot(join(dir, "cp"));
  const store = new CheckpointStore({ cwd: dir, root });
  const snap = await store.snapshot({ paths: ["a.txt"], label: "t" });
  await writeFile(join(dir, "a.txt"), "after\n");

  const r = await checkpointCommand(["restore", String(snap.seq)], { cwd: dir, root });
  assert.notEqual(r.exitCode, 0, "restore must refuse without --yes");
  assert.match(text(r), /--yes/i, "refusal names the flag that would proceed");
  assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "after\n", "file untouched");
});

test("S1: restore WITH --yes restores the file", { timeout: 25_000 }, async () => {
  const dir = await tmp();
  await writeFile(join(dir, "a.txt"), "before\n");
  const { CheckpointStore, resolveRoot } = await import("../src/checkpoint.js");
  const root = resolveRoot(join(dir, "cp"));
  const store = new CheckpointStore({ cwd: dir, root });
  const snap = await store.snapshot({ paths: ["a.txt"], label: "t" });
  await writeFile(join(dir, "a.txt"), "after\n");

  const r = await checkpointCommand(["restore", String(snap.seq), "--yes"], { cwd: dir, root });
  assert.equal(r.exitCode, 0);
  assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "before\n");
});

test("S2: verify prints a sha; --expect match exits 0, mismatch non-zero", { timeout: 25_000 }, async () => {
  const dir = await tmp();
  const log = join(dir, "e.jsonl");
  const { EventLog } = await import("../src/events.js");
  const el = await EventLog.open(log);
  await el.appendEvent("session.start", "harness", { harness_version: "test", session: "s" });
  await el.appendEvent("session.end", "harness", { turns: 0 });

  const ok = await verifyCommand([log]);
  assert.equal(ok.exitCode, 0);
  const sha = /canonical sha256: ([a-f0-9]{64})/.exec(text(ok))[1];
  assert.match(text(ok), /torn_tail: no/);

  assert.equal((await verifyCommand([log, "--expect", sha])).exitCode, 0, "match exits 0");
  assert.notEqual((await verifyCommand([log, "--expect", "0".repeat(64)])).exitCode, 0, "mismatch exits non-zero");
});

test("S2: a torn tail is reported, not a crash", { timeout: 25_000 }, async () => {
  const dir = await tmp();
  const log = join(dir, "t.jsonl");
  const { EventLog } = await import("../src/events.js");
  const el = await EventLog.open(log);
  await el.appendEvent("session.start", "harness", { harness_version: "test", session: "s" });
  await writeFile(log, (await readFile(log, "utf8")) + '{"seq":1,"ts":1,"type":"turn.st', "utf8");

  const r = await verifyCommand([log]);
  assert.match(text(r), /torn_tail: yes/);
});

test("S4: doctor reports every check and says whether the install is usable", { timeout: 40_000 }, async () => {
  const r = await doctorCommand({});
  const t = text(r);
  for (const label of ["node", "rg", "log dir", "provider", "plugins", "git"]) {
    assert.ok(new RegExp(label, "i").test(t), `doctor reports ${label}`);
  }
  assert.match(t, /\b(ok|warn|fail)\b/);
  assert.equal(r.exitCode, 0, "this device is usable");
});

test("S4: an old node is a FAIL, not a warn", { timeout: 25_000 }, async () => {
  const prev = process.env.AC_FAKE_NODE_VERSION;
  process.env.AC_FAKE_NODE_VERSION = "18.0.0";
  try {
    const r = await doctorCommand({});
    assert.notEqual(r.exitCode, 0, "old node exits non-zero");
    assert.match(text(r), /fail/i);
  } finally {
    if (prev === undefined) delete process.env.AC_FAKE_NODE_VERSION;
    else process.env.AC_FAKE_NODE_VERSION = prev;
  }
});
