// test/v080-surfaces.test.js — v0.8.0 S1–S4 surfaces over existing
// mechanisms. Neutral-path fixtures only (/srv-... fake roots via tmpdir —
// tmpdir IS the machine-local store; the card bans REAL operator paths in
// test fixtures, and tmp dirs are synthetic).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";

const ROOT = join(new URL("..", import.meta.url).pathname);

// ---------- S1: checkpoint CLI ----------------------------------------------
test("S1: checkpoint list/show/restore work; restore REFUSES without --yes", { timeout: 45_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "v080cp-"));
  try {
    // import AFTER env setup so resolveRoot sees our AC_CHECKPOINT_ROOT
    process.env.AC_CHECKPOINT_ROOT = join(dir, "cpstore");
    const { CheckpointStore } = await import("../src/checkpoint.js");
    const { checkpointCommand } = await import("../src/checkpoint-cli.js");
    const sink = [];
    const stdout = { write: (s) => sink.push(s) };

    // two snapshots with a change between (labels per the house style)
    const work = join(dir, "work");
    await mkdir(work, { recursive: true });
    const store = new CheckpointStore({ root: join(dir, "cpstore"), cwd: work });
    await writeFile(join(work, "a.txt"), "v1");
    await store.snapshot({ label: "first" });
    await writeFile(join(work, "a.txt"), "v2-overwritten");
    await writeFile(join(work, "new.txt"), "created later");
    await store.snapshot({ label: "second" });
    // the env var stays set for the whole test: checkpointCommand resolves
    // AC_CHECKPOINT_ROOT at CALL time, so it must see the same store.

    // list: two rows, newest first
    const listed = await checkpointCommand(["list"], { cwd: work, stdout });
    assert.equal(listed.exitCode, 0);
    assert.ok(sink.join("").includes("second"), "newest label listed");
    assert.ok(sink.join("").includes("first"));

    // show: manifest + diff vs the previous snapshot
    const [secondSeq] = [2];
    const shown = await checkpointCommand(["show", String(secondSeq)], { cwd: work, stdout });
    assert.equal(shown.exitCode, 0);
    const showText = shown.lines.join("\n");
    assert.ok(showText.includes("checkpoint"));
    assert.ok(showText.includes("diff vs 1"), "diff against the previous snapshot");
    assert.ok(showText.includes("~ a.txt") || showText.includes("+ new.txt"), "the change is visible");

    // restore REFUSES without --yes (DC2: prove the refusal, not just success)
    const refused = await checkpointCommand(["restore", "1"], { cwd: work, stdout });
    assert.equal(refused.exitCode, 2, "refusal exits non-zero");
    assert.match(refused.lines.join("\n"), /would OVERWRITE/);
    assert.match(refused.lines.join("\n"), /refusing: re-run with --yes/);
    // and the file was NOT touched
    assert.equal(await readFile(join(work, "a.txt"), "utf8"), "v2-overwritten");

    // --yes restores (preview was the contract; now act)
    const restored = await checkpointCommand(["restore", "1", "--yes"], { cwd: work, stdout });
    assert.equal(restored.exitCode, 0);
    assert.match(restored.lines.join("\n"), /restored/);
    assert.equal(await readFile(join(work, "a.txt"), "utf8"), "v1", "the overwrite happened");
    // --prune also requires --yes: refusal when passed alone
    const pruneRefused = await checkpointCommand(["restore", "1", "--prune"], { cwd: work, stdout });
    assert.equal(pruneRefused.exitCode, 2, "--prune without --yes refuses");
    assert.match(pruneRefused.lines.join("\n"), /--prune would DELETE/);
    // new.txt still there
    assert.ok((await readFile(join(work, "new.txt"), "utf8")).length > 0);
  } finally {
    delete process.env.AC_CHECKPOINT_ROOT;
    await rm(dir, { recursive: true, force: true });
  }
});

test("S1: prune --keep N keeps the newest and reports freed bytes", { timeout: 45_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "v080pr-"));
  try {
    const { CheckpointStore } = await import("../src/checkpoint.js");
    const { checkpointCommand } = await import("../src/checkpoint-cli.js");
    const work = join(dir, "work");
    await mkdir(work, { recursive: true });
    process.env.AC_CHECKPOINT_ROOT = join(dir, "store");
    const store = new CheckpointStore({ root: join(dir, "store"), cwd: work });
    await writeFile(join(work, "f.txt"), "data-0");
    for (let i = 1; i <= 5; i++) {
      await writeFile(join(work, "f.txt"), `data-${i}-distinct-${"x".repeat(i * 50)}`);
      await store.snapshot({ label: `snap-${i}` });
    }
    const sink = [];
    const out = await checkpointCommand(["prune", "--keep", "2"], {
      cwd: work,
      stdout: { write: (s) => sink.push(s) },
    });
    assert.equal(out.exitCode, 0);
    assert.match(out.lines.join("\n"), /kept 2/);
    const remaining = await store.list();
    assert.equal(remaining.length, 2);
    assert.equal(Math.max(...remaining.map((r) => r.seq)), 5, "newest kept");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- S2: verify --------------------------------------------------------
test("S2: verify prints events + sha; --expect matches a healthy log; corrupted exits non-zero", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "v080vf-"));
  try {
    const { EventLog, canonicalize, sha256, readAll } = await import("../src/events.js");
    const { verifyCommand } = await import("../src/verify-cli.js");
    const lp = join(dir, "ev.jsonl");
    const log = await EventLog.open(lp);
    await log.appendEvent("session.start", "harness", { harness_version: "0", session: "t", config_sha: "0" });
    await log.appendEvent("turn.start", "harness", { turn: 1, input: "x" });
    const expected = sha256(canonicalize(await readAll(lp)));

    const sink = [];
    const okRun = await verifyCommand([lp, "--expect", expected], {
      stdout: { write: (s) => sink.push(s) },
    });
    assert.equal(okRun.exitCode, 0);
    assert.match(okRun.lines.join("\n"), /events: 2/);
    assert.match(okRun.lines.join("\n"), /canonical sha256:/);
    assert.match(okRun.lines.join("\n"), /torn_tail: no/);
    assert.match(okRun.lines.join("\n"), /expect: matches/);

    // a WRONG expect → non-zero
    const bad = await verifyCommand([lp, "--expect", "0".repeat(64)], {
      stdout: { write: () => {} },
    });
    assert.equal(bad.exitCode, 1);
    assert.match(bad.lines.join("\n"), /MISMATCH/);

    // a torn tail: append a broken line → torn_tail: yes, still exit 0 per
    // the read-only contract UNLESS --expect was given and the log no longer
    // parses to the SAME canonical form (torn lines are skipped, so a torn
    // line does NOT change the canonical sha — the recovery IS quiet).
    await appendFile(lp, '{"seq":9,"ts":1.5,"type":"turn.sta', "utf8");
    const tornRun = await verifyCommand([lp], { stdout: { write: () => {} } });
    assert.equal(tornRun.exitCode, 0, "a torn tail is a STATE, not an error");
    assert.match(tornRun.lines.join("\n"), /torn_tail: yes \(1 unparseable/);
    assert.equal(tornRun.sha, expected, "the canonical sha is unchanged (torn line skipped)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- S3: stats cost honesty ---------------------------------------------
test("S3: no pricing → the explicit n/a line; a profile with pricing computes and names its source", async () => {
  const { buildReport, formatReport, computeCostFromProfile } = await import("../src/stats.js");
  const report = buildReport([
    { seq: 0, ts: 1, type: "turn.provider.response", actor: "provider", data: { input_tokens: 250_000, cached_tokens: 0, output_tokens: 50_000 } },
  ]);

  // no pricing field → null → the n/a line
  assert.equal(computeCostFromProfile(report, { id: "p", pricing: null }), null);
  assert.equal(computeCostFromProfile(report, {}), null);
  assert.equal(computeCostFromProfile(report, null), null);
  const na = formatReport(report, { cost: null });
  assert.ok(na.includes("cost: n/a (no pricing table configured"), "the n/a line is explicit");
  assert.ok(!/\$[0-9]/.test(na), "no money figure without a profile");

  // a profile WITH pricing → money with unit + source
  const cost = computeCostFromProfile(report, {
    id: "my-provider",
    // v0.9.0: rate is in CURRENCY UNITS per Mtok (the human convention: $3/Mtok).
    // The v0.8.0 draft supplied 3_000_000 here while asserting the currency-unit
    // result below — inputs and expectations contradicted each other.
    pricing: { input_per_mtok: 3, output_per_mtok: 6 },
  });
  assert.equal(cost.input_micro_usd, 750_000);
  assert.equal(cost.output_micro_usd, 300_000);
  assert.equal(cost.total_micro_usd, 1_050_000);
  assert.equal(cost.source, "my-provider");
  const priced = formatReport(report, { cost });
  assert.match(priced, /cost: \$1\.0500/);
  assert.match(priced, /from provider profile "my-provider"/);
  assert.match(priced, /input \$3\/Mtok · output \$6\/Mtok/);
  // and the n/a line is GONE in the priced form
  assert.ok(!priced.includes("n/a"));
});

// ---------- S4: doctor ---------------------------------------------------------
test("S4: doctor exits 0 on this device; a faked low node version exits non-zero via the env seam", { timeout: 30_000 }, async () => {
  const { doctorCommand } = await import("../src/doctor-cli.js");
  // healthy: the real runtime
  const real = await doctorCommand({ stdout: { write: () => {} } });
  assert.equal(real.exitCode, 0, "usable install");
  assert.match(real.lines.join("\n"), /doctor: usable/);
  assert.ok(real.lines.filter((l) => /^(ok|warn|FAIL)/.test(l)).length === 6, "six checks, no more");

  // faked low node: the env seam ONLY (no runtime modification)
  const saved = process.version;
  process.env.AC_FAKE_NODE_VERSION = "v18.19.0";
  try {
    const faked = await doctorCommand({ stdout: { write: () => {} } });
    assert.equal(faked.exitCode, 1, "non-zero when node is below 24");
    assert.match(faked.lines.join("\n"), /FAIL\s+node: v18\.19\.0/);
    assert.match(faked.lines.join("\n"), /remediation: install Node >= 24/);
    assert.match(faked.lines.join("\n"), /node: v18/); // the detail names the version
  } finally {
    delete process.env.AC_FAKE_NODE_VERSION;
    void saved;
  }
  // a faked NEW node also passes (the seam parses versions, not strings)
  process.env.AC_FAKE_NODE_VERSION = "v26.1.0";
  try {
    const newer = await doctorCommand({ stdout: { write: () => {} } });
    assert.equal(newer.exitCode, 0);
    assert.match(newer.lines.join("\n"), /ok\s+node: v26\.1\.0/);
  } finally {
    delete process.env.AC_FAKE_NODE_VERSION;
  }
});

// ---------- end-to-end smokes through bin/ac-harness.js -----------------------
test("S4 smoke: bin doctor runs and exits 0 on this device", { timeout: 45_000 }, () => {
  const out = execFileSync(process.execPath, [join(ROOT, "bin", "ac-harness.js"), "doctor"], {
    encoding: "utf8",
    env: { ...process.env },
  });
  assert.match(out, /doctor: usable/);
});

test("S2 smoke: bin verify runs against a real log and prints the sha", { timeout: 45_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "v080sm-"));
  try {
    const { EventLog, canonicalize, sha256, readAll } = await import("../src/events.js");
    const lp = join(dir, "ev.jsonl");
    const log = await EventLog.open(lp);
    await log.appendEvent("session.start", "harness", { harness_version: "0", session: "s", config_sha: "0" });
    const want = sha256(canonicalize(await readAll(lp)));
    const out = execFileSync(process.execPath, [join(ROOT, "bin", "ac-harness.js"), "verify", lp, "--expect", want], {
      encoding: "utf8",
    });
    assert.match(out, /events: 1/);
    assert.match(out, /expect: matches/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S1 smoke: bin checkpoint list exits 0 on an empty store", { timeout: 45_000 }, () => {
  const out = execFileSync(
    process.execPath,
    [join(ROOT, "bin", "ac-harness.js"), "checkpoint", "list"],
    { encoding: "utf8", env: { ...process.env, AC_CHECKPOINT_ROOT: join(tmpdir(), "v080-empty-" + Date.now()) } },
  );
  assert.match(out, /no checkpoints/);
});
