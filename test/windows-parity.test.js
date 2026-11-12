// test/windows-parity.test.js — v0.6.0 SR4: platform-specific assumptions,
// gated by platform so Linux CI stays green and Windows CI proves itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

const IS_WIN = process.platform === "win32";

test("SR4: bash tool spawns the PLATFORM shell and captures output", async () => {
  // The shell choice lives inside run(); observable contract: the tool works
  // on THIS platform and reports its stdout (cmd.exe /d /s /c on win32).
  const { run } = await import("../src/tools/bash.js");
  const res = await run({ command: "echo smoke-sr4" }, { allowed: true });
  assert.ok(res.ok, `bash ran on ${process.platform}`);
  assert.match(res.output, /smoke-sr4/, "the command's stdout is captured");
});

test("SR4 win32: bash uses cmd.exe (Windows_NT env expansion)", { skip: !IS_WIN }, async () => {
  // Only meaningful on actual win32 (never monkey-patch process.platform —
  // the card forbids simulations that diverge from prod paths).
  const { run } = await import("../src/tools/bash.js");
  const res = await run({ command: "echo %OS%" }, { allowed: true });
  assert.ok(res.ok, "cmd.exe runs");
  assert.match(res.output, /Windows_NT/);
});

test("SR4: read paging is CRLF-aware; the <lines> marker is Unix-newline terminated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sr4-"));
  try {
    // CRLF content (what Windows text looks like)
    const f = join(dir, "crlf.txt");
    const content = Array.from({ length: 10 }, (_, i) => `row-${i + 1}`).join("\r\n");
    await writeFile(f, content, "utf8");
    const { run } = await import("../src/tools/read.js");
    const r = await run({ path: f, offset: 3, limit: 2 }, {});
    assert.ok(r.ok);
    const outLines = r.output.trimEnd().split("\n");
    assert.equal(outLines[0], "row-3", "no CR leaked into the line content");
    assert.equal(outLines[1], "row-4");
    assert.match(outLines[2], /^<lines 3\.\.4 of 10>$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SR4: paths the harness builds carry the platform sep (join/resolve derived)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sr4b-"));
  try {
    const f = join(dir, "a.txt");
    await writeFile(f, "one\ntwo", "utf8");
    const { run } = await import("../src/tools/read.js");
    const r = await run({ path: f, offset: 2, limit: 5 }, {});
    assert.match(r.output, /<lines 2\.\.2 of 2>/);
    assert.ok(dir.includes(sep), "tmpdir carries the platform sep");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SR4: no pty tool ships (the absence IS the graceful degradation)", async () => {
  // The card names "pty-process absence: document and degrade." There is no
  // pty tool in the registry, so nothing CAN throw. This pins the invariant
  // so a future pty tool lands WITH its platform gate, not accidentally.
  const { builtinTools } = await import("../src/tools/index.js");
  const names = Object.keys(builtinTools);
  assert.equal(names.filter((n) => /pty/.test(n)).length, 0, "no pty tool registered");
});
