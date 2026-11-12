// test/version-bin.test.js — v0.4.0 Ship 3: single version source (all four
// call sites import it; HARNESS_VERSION === package.json.version) + the
// bin dispatcher (--version, replay).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

test("3.1 HARNESS_VERSION is the single source, equal to package.json.version", async () => {
  const { HARNESS_VERSION } = await import("../src/version.js");
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(HARNESS_VERSION, pkg.version);
  assert.match(HARNESS_VERSION, /^0\.4\.0$/);
});

test("3.1 the four call sites import version.js (no literal survives)", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const files = ["src/cli.js", "src/server.js", "src/tui/main.js", "src/loop.js"];
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), "utf8");
    assert.ok(
      src.includes(`version.js`) || src.includes("HARNESS_VERSION"),
      `${f} references the version module`,
    );
    assert.ok(
      !new RegExp(`const HARNESS_VERSION = "${pkg.version.replace(/\./g, "\\.")}"`).test(src),
      `${f} carries no version literal`,
    );
    // the loop DEFAULTS must also follow the single source
    if (f === "src/loop.js") {
      assert.ok(src.includes('harness_version: HARNESS_VERSION'), "loop DEFAULTS follow version.js");
    }
  }
});

test("3.2 bin: --version prints 0.4.0", () => {
  const out = execFileSync(process.execPath, [join(ROOT, "bin", "ac-harness.js"), "--version"], { encoding: "utf8" });
  assert.match(out.trim(), /^0\.4\.0$/);
});

test("3.2 bin: replay <log> works through the dispatcher", { skip: false }, async () => {
  // Build a tiny valid log via the real EventLog, then replay it through bin.
  const { EventLog } = await import("../src/events.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "s3-bin-"));
  try {
    const lp = join(dir, "ev.jsonl");
    const log = await EventLog.open(lp);
    await log.appendEvent("session.start", "harness", { harness_version: "0.4.0", session: "bin-test", config_sha: "0" });
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync(process.execPath, [join(ROOT, "bin", "ac-harness.js"), "replay", lp], { encoding: "utf8" });
    assert.ok(out.includes("events: 1"), "replay ran through the dispatcher");
    assert.ok(out.includes("canonical sha256: "), "replay prints the sha");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("3.3 README preflight paragraph states the real minimums", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  assert.ok(readme.includes("Node >= 24"), "states the Node minimum");
  assert.ok(/grep tool only/.test(readme), "rg scoped to the grep tool");
  assert.ok(/no install step beyond\s+cloning/.test(readme), "no-install claim present");
  assert.ok(/degrades with a clear/.test(readme), "degradation behavior stated");
});
