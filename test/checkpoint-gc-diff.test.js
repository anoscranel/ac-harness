// test/checkpoint-gc-diff.test.js — the GC must actually free space and the
// diff must report real changes. Both are load-bearing on a 97%-full disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CheckpointStore } from "../src/checkpoint.js";

async function sandbox() {
  const cwd = await mkdtemp(join(tmpdir(), "ac-gc-"));
  return { cwd, store: new CheckpointStore({ root: join(cwd, ".s"), cwd }) };
}

test("prune keeps the newest N and frees the old blobs", async () => {
  const { cwd, store } = await sandbox();
  // 6 snapshots, each with DIFFERENT content → distinct blobs
  for (let i = 0; i < 6; i++) {
    await writeFile(join(cwd, "f.txt"), `generation ${i}`);
    await store.snapshot({ label: `gen${i}` });
  }
  const before = await store.size();
  assert.equal((await store.list()).length, 6);

  const r = await store.prune({ keep: 2 });
  assert.equal(r.removed_manifests, 4, "4 old manifests removed");
  assert.equal(r.kept, 2);
  assert.equal((await store.list()).length, 2, "only newest 2 remain");

  const after = await store.size();
  assert.ok(after < before, `size must shrink: ${before} -> ${after}`);
  assert.ok(r.bytes_freed > 0, "reports bytes freed");
  await rm(cwd, { recursive: true, force: true });
});

test("prune(keep=all-existing) is a no-op, never deletes live history", async () => {
  const { cwd, store } = await sandbox();
  await writeFile(join(cwd, "a.txt"), "one");
  await store.snapshot();
  await writeFile(join(cwd, "a.txt"), "two");
  await store.snapshot();

  const r = await store.prune({ keep: 10 });
  assert.equal(r.removed_manifests, 0);
  assert.equal(r.removed_blobs, 0);
  assert.equal((await store.list()).length, 2, "nothing deleted when keep >= count");
  await rm(cwd, { recursive: true, force: true });
});

test("a blob shared by kept and pruned snapshots survives", async () => {
  const { cwd, store } = await sandbox();
  await writeFile(join(cwd, "stable.txt"), "never changes");
  await store.snapshot({ label: "first" });
  await store.snapshot({ label: "second" });
  await store.snapshot({ label: "third" });
  await store.snapshot({ label: "fourth" });

  const r = await store.prune({ keep: 1 }); // keeps only "fourth"
  assert.equal(r.kept, 1);
  // stable.txt's blob is referenced by "fourth" — must still exist
  const restored = await store.restore((await store.list())[0].seq);
  assert.equal(restored.restored, 1);
  await rm(cwd, { recursive: true, force: true });
});

test("diff reports added, removed and modified between snapshots", async () => {
  const { cwd, store } = await sandbox();
  await writeFile(join(cwd, "a.txt"), "A v1");
  await writeFile(join(cwd, "b.txt"), "B v1");
  const s1 = (await store.snapshot({ label: "before" })).seq;

  await writeFile(join(cwd, "a.txt"), "A v2"); // modified
  await writeFile(join(cwd, "c.txt"), "C new"); // added
  await rm(join(cwd, "b.txt")); // removed
  const s2 = (await store.snapshot({ label: "after" })).seq;

  const d = await store.diff(s1, s2);
  assert.deepEqual(d.added, ["c.txt"]);
  assert.deepEqual(d.modified, ["a.txt"]);
  assert.deepEqual(d.removed, ["b.txt"]);
  await rm(cwd, { recursive: true, force: true });
});

test("diff of identical snapshots is empty in all three axes", async () => {
  const { cwd, store } = await sandbox();
  await writeFile(join(cwd, "x.txt"), "same");
  const s1 = (await store.snapshot()).seq;
  const s2 = (await store.snapshot()).seq;
  const d = await store.diff(s1, s2);
  assert.deepEqual(d, { added: [], removed: [], modified: [] });
  await rm(cwd, { recursive: true, force: true });
});

test("diff with a nonexistent seq fails loudly, not silently empty", async () => {
  const { cwd, store } = await sandbox();
  await writeFile(join(cwd, "x.txt"), "data");
  const s1 = (await store.snapshot()).seq;
  await assert.rejects(store.diff(s1, 999), /ENOENT|not found|no such/i,
    "a made-up seq must throw, never return an empty diff");
  await rm(cwd, { recursive: true, force: true });
});
