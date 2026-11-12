// test/checkpoint-integration.test.js — the loop a human actually performs.
//
// The unit tests prove the store works. This proves the *integration*: an agent
// write must produce a checkpoint that a CLI invocation, run separately, can find
// and restore. It caught a real bug: the tool wrote to ctx.checkpointRoot while
// the CLI read the default root, so an agent's snapshot was unrecoverable by the
// person who needed it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

test("agent write + separate CLI restore recovers the destroyed file", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ac-e2e-"));
  const root = join(cwd, ".cp");
  const target = join(cwd, "keep.txt");
  const original = "PRECIOUS CONTENT\nline 2\n";
  await writeFile(target, original);

  // the agent overwrites the file, exactly as write.js does
  const { builtinTools } = await import("../src/tools/index.js");
  const w = await builtinTools.write.run({ path: "keep.txt", content: "DESTROYED\n" }, { cwd, checkpointRoot: root });
  assert.equal(w.checkpoint, 1);
  assert.equal(await readFile(target, "utf8"), "DESTROYED\n");

  // the human runs the CLI as a separate process, same root via env
  const cli = join(process.cwd(), "src", "cli.js");
  const env = { ...process.env, AC_CHECKPOINT_ROOT: root };
  const listed = await run(process.execPath, [cli, "checkpoint", "list", cwd], { env });
  assert.match(listed.stdout, /#0001/, "the CLI can see the agent's checkpoint");

  const restored = await run(process.execPath, [cli, "checkpoint", "restore", "1", cwd], { env });
  assert.match(restored.stdout, /restored 1 file/);
  assert.equal(await readFile(target, "utf8"), original, "bytes recovered exactly");
  await rm(cwd, { recursive: true, force: true });
});

test("restore without --prune never deletes a newer file", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ac-e2e2-"));
  const root = join(cwd, ".cp");
  await writeFile(join(cwd, "a.txt"), "original");
  const { CheckpointStore } = await import("../src/checkpoint.js");
  const store = new CheckpointStore({ root, cwd });
  const { seq } = await store.snapshot();

  await writeFile(join(cwd, "created-after.txt"), "must survive");

  const cli = join(process.cwd(), "src", "cli.js");
  const env = { ...process.env, AC_CHECKPOINT_ROOT: root };
  await run(process.execPath, [cli, "checkpoint", "restore", String(seq), cwd], { env });

  assert.equal(await readFile(join(cwd, "created-after.txt"), "utf8"), "must survive");
  await rm(cwd, { recursive: true, force: true });
});
