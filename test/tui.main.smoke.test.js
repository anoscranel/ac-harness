// test/tui.main.smoke.test.js — the TUI entry's non-TTY path (spec §6): run
// `node src/tui/main.js` with piped stdio and assert it prints the advisory
// line and exits 0 WITHOUT entering the alt-screen. No test ever spins up a
// real tty. (Main.js is a thin shell; the alt-screen path is exercised
// interactively, not in CI.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(new URL("../", import.meta.url).pathname);

test("non-TTY stdout: advisory line + exit 0, no alt-screen escape", () => {
  const r = spawnSync(process.execPath, ["src/tui/main.js"], {
    cwd: REPO_ROOT,
    input: "", // stdin piped (not a raw tty) and empty
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const advisory = "tui requires an interactive terminal; use `node src/cli.js`";
  assert.ok(r.stdout.includes(advisory));
  assert.ok(!r.stdout.includes("\x1b[?1049h")); // never entered alt-screen
});

test("TERM=dumb gate wins regardless of the TTY detector", () => {
  const r = spawnSync(process.execPath, ["src/tui/main.js"], {
    cwd: REPO_ROOT,
    input: "",
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, TERM: "dumb" },
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.ok(r.stdout.includes("tui requires an interactive terminal"));
});
