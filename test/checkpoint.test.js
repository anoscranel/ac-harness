// test/checkpoint.test.js — the snapshot layer must make a destructive edit
// recoverable. The load-bearing test is the last one: destroy a file the way
// write.js does, restore, and prove the bytes come back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CheckpointStore } from "../src/checkpoint.js";

async function sandbox() {
  const cwd = await mkdtemp(join(tmpdir(), "ac-cp-"));
  const root = join(cwd, ".store");
  return { cwd, root, store: new CheckpointStore({ root, cwd }) };
}

test("snapshot captures files and reports counts", async () => {
  const { cwd, store } = await sandbox();
  await writeFile(join(cwd, "a.txt"), "alpha");
  await mkdir(join(cwd, "sub"));
  await writeFile(join(cwd, "sub", "b.txt"), "beta");

  const r = await store.snapshot({ label: "first" });
  assert.equal(r.files, 2);
  assert.ok(r.seq >= 1);
  await rm(cwd, { recursive: true, force: true });
});

test("identical content is deduplicated across snapshots", async () => {
  const { cwd, store } = await sandbox();
  await writeFile(join(cwd, "same.txt"), "unchanged content");
  await store.snapshot({ label: "one" });
  const sizeAfterFirst = await store.size();
  await store.snapshot({ label: "two" });
  const sizeAfterSecond = await store.size();

  // The manifest grows by a few hundred bytes; the blob must NOT be re-stored.
  assert.ok(
    sizeAfterSecond - sizeAfterFirst < 600,
    `second snapshot should cost ~manifest only, grew ${sizeAfterSecond - sizeAfterFirst} bytes`,
  );
  await rm(cwd, { recursive: true, force: true });
});

test("restore brings back a destroyed file byte-for-byte", async () => {
  const { cwd, store } = await sandbox();
  const target = join(cwd, "important.txt");
  const original = "line one\nline two\n  indented\n";
  await writeFile(target, original);

  const { seq } = await store.snapshot({ label: "before destruction" });

  // Destroy it the way write.js would: full overwrite.
  await writeFile(target, "");
  assert.equal(await readFile(target, "utf8"), "");

  const r = await store.restore(seq);
  assert.equal(r.restored, 1);
  assert.equal(await readFile(target, "utf8"), original, "bytes restored exactly");
  await rm(cwd, { recursive: true, force: true });
});

test("restoring one path leaves other files alone", async () => {
  const { cwd, store } = await sandbox();
  await writeFile(join(cwd, "a.txt"), "A-original");
  await writeFile(join(cwd, "b.txt"), "B-original");
  const { seq } = await store.snapshot();

  await writeFile(join(cwd, "a.txt"), "A-destroyed");
  await writeFile(join(cwd, "b.txt"), "B-kept");

  const r = await store.restorePath(seq, "a.txt");
  assert.equal(r.ok, true);
  assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "A-original");
  assert.equal(await readFile(join(cwd, "b.txt"), "utf8"), "B-kept", "untouched file stays");
  await rm(cwd, { recursive: true, force: true });
});

test("a file created after the snapshot survives restore unless prune is asked", async () => {
  const { cwd, store } = await sandbox();
  await writeFile(join(cwd, "old.txt"), "old");
  const { seq } = await store.snapshot();

  await writeFile(join(cwd, "new.txt"), "created later");

  await store.restore(seq);
  assert.equal(await readFile(join(cwd, "new.txt"), "utf8"), "created later", "deletion is opt-in");

  await store.restore(seq, { prune: true });
  await assert.rejects(stat(join(cwd, "new.txt")), "prune removes it only when asked");
  await rm(cwd, { recursive: true, force: true });
});

test("the store never snapshots .git or node_modules", async () => {
  const { cwd, store } = await sandbox();
  await mkdir(join(cwd, ".git"));
  await writeFile(join(cwd, ".git", "config"), "[core]");
  await mkdir(join(cwd, "node_modules", "dep"), { recursive: true });
  await writeFile(join(cwd, "node_modules", "dep", "i.js"), "module.exports={}");
  await writeFile(join(cwd, "keep.txt"), "kept");

  const r = await store.snapshot();
  assert.equal(r.files, 1, "only the real file is tracked");
  await rm(cwd, { recursive: true, force: true });
});

test("restore refuses a path outside the project root", async () => {
  const { cwd, root, store } = await sandbox();
  await writeFile(join(cwd, "ok.txt"), "fine");
  const { seq } = await store.snapshot();
  const r = await store.restorePath(seq, "../escape.txt");
  assert.equal(r.ok, false);
  assert.match(r.error, /not in snapshot|outside/);
  await rm(cwd, { recursive: true, force: true });
});

test("list reports snapshots in order with labels", async () => {
  const { cwd, store } = await sandbox();
  await writeFile(join(cwd, "f.txt"), "1");
  await store.snapshot({ label: "alpha" });
  await writeFile(join(cwd, "f.txt"), "2");
  await store.snapshot({ label: "beta" });

  const list = await store.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].label, "alpha");
  assert.equal(list[1].label, "beta");
  assert.ok(list[1].seq > list[0].seq);
  await rm(cwd, { recursive: true, force: true });
});
