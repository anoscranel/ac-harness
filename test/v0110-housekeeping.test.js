// test/v0110-housekeeping.test.js — S1 --help, S2 memory CLI, S3 logs CLI.
// Destructive paths PROVE the refusal. House style: {timeout}, eager await,
// no fixed sleeps as synchronization.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";

const ROOT = join(new URL("..", import.meta.url).pathname);
const BIN = join(ROOT, "bin", "ac-harness.js");

// ---------- S1: --help -------------------------------------------------------
test("S1: --help prints grouped help, exits 0, writes NO log; -h and help too", () => {
  const out = execFileSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
  assert.match(out, /chat \/ session/);
  assert.match(out, /inspection \(all read-only\)/);
  assert.match(out, /maintenance \(destructive acts refuse without --yes\)/);
  assert.match(out, /remote \(stdio only; one protocol per process\)/);
  assert.ok(out.includes("memory forget"), "the new surface is listed");
  assert.ok(out.includes("logs prune"), "the new surface is listed (logs)");
  assert.ok(out.includes("replay"), "replay listed");
  for (const alias of ["-h", "help"]) {
    const alt = execFileSync(process.execPath, [BIN, alias], { encoding: "utf8" });
    assert.ok(alt.includes("chat / session"), `${alias} shows the same help`);
  }
});

test("S1: --help writes nothing to logs/ (before/after set equality)", async () => {
  const logsDir = join(ROOT, "logs");
  const before = (await readdir(logsDir).catch(() => [])).sort().join(",");
  execFileSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
  const after = (await readdir(logsDir).catch(() => [])).sort().join(",");
  assert.equal(after, before, "the logs/ dir is unchanged: no session file written");
});

test("S1: unknown subcommand exits 2 with the --help pointer", () => {
  let err = "";
  let code = 0;
  try {
    execFileSync(process.execPath, [BIN, "no-such-thing"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    code = e.status;
    err = e.stderr?.toString() ?? "";
  }
  assert.equal(code, 2);
  assert.match(err, /unknown command: no-such-thing/);
  assert.match(err, /--help/);
});

// ---------- S2: memory CLI ---------------------------------------------------
test("S2: memory list/recall work; forget REFUSES without --yes then removes exactly one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "v0110mem-"));
  process.env.AC_MEMORY_PATH = join(dir, "memory.jsonl");
  try {
    const { memoryCommand } = await import("../src/memory-cli.js");
    const { Memory } = await import("../src/memory.js");
    const m = new Memory({ path: process.env.AC_MEMORY_PATH });
    const a = await m.remember("the deploy token lives in the vault", { scope: "ops" });
    const b = await m.remember("the garden path avoids mint", { scope: "home" });
    const c = await m.remember("ops note two", { scope: "ops" });

    // list: newest first, the store path stated
    const L = [];
    const listed = await memoryCommand(["list"], { stdout: { write: (s) => L.push(s) } });
    assert.equal(listed.exitCode, 0);
    const listText = listed.lines.join("\n");
    assert.ok(listText.includes(process.env.AC_MEMORY_PATH), "the store path is in the output");
    const idsInOrder = listed.lines.filter((l) => /^[0-9a-f]{12}\s/.test(l)).map((l) => l.slice(0, 12));
    assert.deepEqual([idsInOrder[0], idsInOrder[1]], [c.id, b.id], "newest first");

    // recall: the store's own search
    const rec = await memoryCommand(["recall", "mint"], { stdout: { write: () => {} } });
    assert.equal(rec.exitCode, 0);
    assert.equal(rec.lines.filter((l) => l.includes(b.id)).length, 1, "the search found the right record");
    assert.equal(rec.lines.filter((l) => l.includes(a.id)).length, 0);

    // forget REFUSES without --yes and prints the record
    const refused = await memoryCommand(["forget", b.id], { stdout: { write: () => {} } });
    assert.equal(refused.exitCode, 2);
    assert.ok(refused.lines.join("\n").includes(b.id), "the refusal names the record");
    assert.ok(refused.lines.join("\n").includes("garden path"), "the refusal prints the record text");
    assert.match(refused.lines.join("\n"), /refusing: re-run with --yes/);
    // nothing removed yet: still 3 live
    assert.equal((await m.all()).length, 3, "refusal removed nothing");

    // forget with --yes: exactly one record
    const done = await memoryCommand(["forget", b.id, "--yes"], { stdout: { write: () => {} } });
    assert.equal(done.exitCode, 0);
    const after = await (new (await import("../src/memory.js")).Memory({ path: process.env.AC_MEMORY_PATH })).all();
    assert.equal(after.length, 2, "exactly one removed");
    assert.ok(!after.some((r) => r.id === b.id), "the right one removed");
    assert.ok(after.some((r) => r.id === a.id), "others survive");
    void L;
  } finally {
    delete process.env.AC_MEMORY_PATH;
    await rm(dir, { recursive: true, force: true });
  }
});

test("S2: forget refuses an unknown id and exits 2", async () => {
  const dir = await mkdtemp(join(tmpdir(), "v0110mem2-"));
  process.env.AC_MEMORY_PATH = join(dir, "memory.jsonl");
  try {
    const { memoryCommand } = await import("../src/memory-cli.js");
    const miss = await memoryCommand(["forget", "deadbeefdead"], { stdout: { write: () => {} } });
    assert.equal(miss.exitCode, 2);
    assert.match(miss.lines.join("\n"), /no record deadbeefdead/);
  } finally {
    delete process.env.AC_MEMORY_PATH;
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- S3: logs CLI ------------------------------------------------------
test("S3: logs list totals; prune --keep refuses without --yes then keeps the 3 newest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "v0110logs-"));
  const logsDir = join(dir, "logs");
  await mkdir(logsDir, { recursive: true });
  try {
    const { logsCommand } = await import("../src/logs-cli.js");
    const names = [];
    for (let i = 0; i < 6; i++) {
      const n = `sess-${i}.jsonl`;
      names.push(n);
      await writeFile(join(logsDir, n), `${"[1,2,3,4,5,6,7,8,9].repeat"}.json\n`, "utf8");
      await new Promise((r) => setTimeout(r, 5));
    }
    const listed = await logsCommand(["list"], { stdout: { write: () => {} }, logsDir });
    assert.equal(listed.exitCode, 0);
    const total = (await import("node:fs/promises")).stat(join(logsDir, "sess-3.jsonl")).then((s) => s.size);
    assert.match(listed.lines.join("\n"), new RegExp(`total: ${(await total) * 6} bytes`));

    // refuse: --keep 3 without --yes
    const refused = await logsCommand(["prune", "--keep", "3"], { stdout: { write: () => {} }, logsDir });
    assert.equal(refused.exitCode, 2);
    const refuseText = refused.lines.join("\n");
    assert.match(refuseText, /prune would delete 3 log\(s\)/);
    assert.ok(refuseText.includes("sess-0.jsonl"), "the exact files are named BEFORE --yes");
    assert.ok(!refuseText.includes("sess-5.jsonl"), "the newest are not doomed");
    assert.match(refuseText, /refusing: re-run with --yes/);
    assert.ok((await readdir(logsDir)).length === 6, "refusal deleted nothing");

    // proceed: exactly the 3 newest survive
    const done = await logsCommand(["prune", "--keep", "3", "--yes"], { stdout: { write: () => {} }, logsDir });
    assert.equal(done.exitCode, 0);
    const after = (await readdir(logsDir)).sort();
    assert.deepEqual(after, ["sess-3.jsonl", "sess-4.jsonl", "sess-5.jsonl"], "exactly the 3 newest kept");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3: prune --older-than refuses and selects by mtime; note about live sessions present", async () => {
  const dir = await mkdtemp(join(tmpdir(), "v0110logs2-"));
  const logsDir = join(dir, "logs");
  await mkdir(logsDir, { recursive: true });
  try {
    const { logsCommand } = await import("../src/logs-cli.js");
    const { utimes } = await import("node:fs/promises");
    await writeFile(join(logsDir, "old.jsonl"), "x\n", "utf8");
    await writeFile(join(logsDir, "new.jsonl"), "y\n", "utf8");
    const old = new Date(Date.now() - 10 * 864e5);
    await utimes(join(logsDir, "old.jsonl"), old, old);
    const refused = await logsCommand(["prune", "--older-than", "5"], { stdout: { write: () => {} }, logsDir });
    assert.equal(refused.exitCode, 2);
    const t = refused.lines.join("\n");
    assert.ok(t.includes("old.jsonl"), "the old file is named");
    assert.ok(!t.includes("new.jsonl"), "the fresh file is protected by mtime");
    assert.match(t, /live session/, "the note explains the live-session semantics");
    const done = await logsCommand(["prune", "--older-than", "5", "--yes"], { stdout: { write: () => {} }, logsDir });
    assert.equal(done.exitCode, 0);
    assert.deepEqual((await readdir(logsDir)).sort(), ["new.jsonl"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
