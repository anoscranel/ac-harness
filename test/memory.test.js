// test/memory.test.js — memory must be durable, atomic, and correct under update.
// The load-bearing test is supersede: a changed fact must not leave the old one
// readable beside it (stale memory is worse than none).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Memory } from "../src/memory.js";

async function sandbox() {
  const cwd = await mkdtemp(join(tmpdir(), "ac-mem-"));
  return { cwd, path: join(cwd, "memory.jsonl") };
}

test("a remembered fact is recalled across instances (durability)", async () => {
  const { cwd, path } = await sandbox();
  const m1 = new Memory({ path });
  await m1.remember("the notes live at /srv/notes/project");

  // a completely fresh instance, as if a new session started
  const m2 = new Memory({ path });
  const hits = await m2.recall("notes");
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /notes/);
  await rm(cwd, { recursive: true, force: true });
});

test("recall filters by scope and tag", async () => {
  const { cwd, path } = await sandbox();
  const m = new Memory({ path });
  await m.remember("build uses node 24", { scope: "harness", tags: ["build"] });
  await m.remember("notes are at /srv/notes", { scope: "team", tags: ["paths"] });

  assert.equal((await m.recall("", { scope: "harness" })).length, 1);
  assert.equal((await m.recall("", { tag: "paths" })).length, 1);
  assert.equal((await m.recall("", { scope: "desk", tag: "build" })).length, 0);
  await rm(cwd, { recursive: true, force: true });
});

test("supersede hides the old fact and keeps it in the file for audit", async () => {
  const { cwd, path } = await sandbox();
  const m = new Memory({ path });
  const old = await m.remember("the harness has 5 tools");
  await m.remember("the harness has 7 tools", { supersedes: old.id });

  const live = await m.all();
  assert.equal(live.length, 1, "only the current fact is live");
  assert.match(live[0].text, /7 tools/);

  const everything = await m.recall("", { includeSuperseded: true });
  assert.equal(everything.length, 2, "history is preserved, not deleted");

  const raw = await readFile(path, "utf8");
  assert.match(raw, /5 tools/, "the superseded record is still on disk");
  await rm(cwd, { recursive: true, force: true });
});

test("superseding a superseded fact leaves one live record", async () => {
  const { cwd, path } = await sandbox();
  const m = new Memory({ path });
  const a = await m.remember("version 1");
  const b = await m.remember("version 2", { supersedes: a.id });
  await m.remember("version 3", { supersedes: b.id });

  const live = await m.all();
  assert.equal(live.length, 1);
  assert.equal(live[0].text, "version 3");
  await rm(cwd, { recursive: true, force: true });
});

test("a torn final line is skipped, not fatal", async () => {
  const { cwd, path } = await sandbox();
  const m = new Memory({ path });
  await m.remember("a complete fact");
  // simulate a process killed mid-write
  await writeFile(path, (await readFile(path, "utf8")) + '{"id":"half","text":"trunc', "utf8");

  const m2 = new Memory({ path });
  const hits = await m2.recall("");
  assert.equal(hits.length, 1, "the good record survives");
  assert.match(hits[0].text, /complete fact/);
  await rm(cwd, { recursive: true, force: true });
});

test("stats report total, live and superseded counts", async () => {
  const { cwd, path } = await sandbox();
  const m = new Memory({ path });
  const a = await m.remember("one");
  await m.remember("two", { supersedes: a.id });
  const s = await m.stats();
  assert.deepEqual({ total: s.total, live: s.live, superseded: s.superseded }, { total: 2, live: 1, superseded: 1 });
  await rm(cwd, { recursive: true, force: true });
});

test("memory survives a large batch and stays greppable", async () => {
  const { cwd, path } = await sandbox();
  const m = new Memory({ path });
  for (let i = 0; i < 200; i++) await m.remember(`fact number ${i}`, { tags: ["bulk"] });
  const hits = await m.recall("fact number 150");
  assert.equal(hits.length, 1);
  assert.equal((await m.stats()).total, 200);
  await rm(cwd, { recursive: true, force: true });
});
