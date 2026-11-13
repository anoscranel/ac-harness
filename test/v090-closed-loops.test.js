// test/v090-closed-loops.test.js — S1 (pricing survives the whitelist),
// S2 (session.end real cost + priced flag, stats agreement), S3 (bash
// auto-snapshot + opt-out + guard). Neutral paths only (mkdtemp); pricing is
// not a secret and appears as plain numbers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------- S1: pricing survives rowOf + round-trips + env ------------------
test("S1: saveProfiles/loadProfiles round-trip a well-formed pricing block", async () => {
  const { saveProfiles, loadProfiles } = await import("../src/providers/registry.js");
  const dir = await mkdtemp(join(tmpdir(), "v090s1-"));
  try {
    const f = join(dir, "providers.config.json");
    const warns = [];
    await saveProfiles(f, [
      {
        id: "priced-prov",
        baseUrl: "https://p.test/v1",
        model: "m",
        source: "tui",
        pricing: { input_per_mtok: 3_000_000, output_per_mtok: 6_000_000 },
      },
    ], { warn: (m) => warns.push(m) });
    const raw = await readFile(f, "utf8");
    assert.ok(raw.includes("3"), "pricing persisted");
    const back = await loadProfiles(f);
    assert.deepEqual(back[0].pricing, { input_per_mtok: 3_000_000, output_per_mtok: 6_000_000 }, "round-tripped");
    assert.equal(warns.length, 0, "no warn for well-formed pricing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S1: malformed pricing is DROPPED (not half-kept) and warned, both paths", async () => {
  const { saveProfiles, loadProfiles } = await import("../src/providers/registry.js");
  const dir = await mkdtemp(join(tmpdir(), "v090s1b-"));
  try {
    const f = join(dir, "providers.config.json");
    // one-sided (input only), negative, and string pricing: all malformed
    await writeFile(f, JSON.stringify({
      version: 1,
      providers: [
        { id: "one-sided", baseUrl: "https://a.test", model: "m", source: "tui",
          pricing: { input_per_mtok: 100 } },
        { id: "negative", baseUrl: "https://b.test", model: "m", source: "tui",
          pricing: { input_per_mtok: -5, output_per_mtok: 10 } },
        { id: "stringy", baseUrl: "https://c.test", model: "m", source: "tui",
          pricing: { input_per_mtok: "100", output_per_mtok: 200 } },
      ],
    }) + "\n", "utf8");
    const warns = [];
    const rows = await loadProfiles(f, { warn: (m) => warns.push(m) });
    assert.equal(rows.length, 3, "the rows survive; only pricing drops");
    for (const r of rows) assert.equal(r.pricing, undefined, `${r.id}: no half-formed pricing`);
    assert.equal(warns.length, 1, "one drop warning");
    assert.match(warns[0], /one-sided, negative, stringy/);
    assert.match(warns[0], /both fields must be finite numbers >= 0/);
    // and saveProfiles warns the same way when handed malformed input directly
    const warns2 = [];
    await saveProfiles(f, [
      { id: "half", baseUrl: "https://x.test", model: "m", source: "tui",
        pricing: { output_per_mtok: 5 } },
    ], { warn: (m) => warns2.push(m) });
    assert.match(warns2[0] ?? "", /half/);
    const after = await loadProfiles(f);
    assert.equal(after[0].pricing, undefined, "not stored after save either");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S1: env discovery reads the two pricing vars (both or none)", async () => {
  const { listEnvProviders } = await import("../src/providers/registry.js");
  const rows = listEnvProviders({
    HARNESS_PROVIDER_CHEAP_BASE_URL: "https://cheap.test/v1",
    HARNESS_PROVIDER_CHEAP_MODEL: "m",
    HARNESS_PROVIDER_CHEAP_INPUT_PER_MTOK: "300",
    HARNESS_PROVIDER_CHEAP_OUTPUT_PER_MTOK: "600",
  });
  assert.deepEqual(rows[0].pricing, { input_per_mtok: 300, output_per_mtok: 600 });
  // one-sided env → no pricing at all
  const rows2 = listEnvProviders({
    HARNESS_PROVIDER_HALF_BASE_URL: "https://h.test/v1",
    HARNESS_PROVIDER_HALF_INPUT_PER_MTOK: "300",
  });
  assert.equal(rows2[0].pricing, undefined, "one-sided env pricing dropped");
});

test("S1: TUI form round-trips pricing (both fields → pricing; one-sided refused)", async () => {
  const { createProviderPanel } = await import("../src/tui/provider-panel.js");
  const p = createProviderPanel({ providers: [] });
  p.openPanel();
  p.key("a");
  // one-sided walk: fill through inputPerMtok=250, leave outputPerMtok blank
  const vals = ["prov2", "https://p.test/v1", "m2", "", "", "250", ""];
  let last = null;
  for (const v of vals) last = p.formSubmit(v);
  assert.equal(last.action, "none", "one-sided pricing refused at emit");
  assert.match(last.error, /both input AND output/);
  // complete and valid on a fresh walk → emits pricing
  const p2 = createProviderPanel({ providers: [] });
  p2.openPanel();
  p2.key("a");
  const full = ["prov3", "https://p.test/v1", "m3", "", "", "250", "500"];
  let done = null;
  for (const v of full) done = p2.formSubmit(v);
  assert.equal(done.action, "submit");
  assert.deepEqual(done.profile.pricing, { input_per_mtok: 250, output_per_mtok: 500 });
});

// ---------- S2: session.end real money when priced --------------------------
test("S2: priced session.end carries real money; unpriced carries priced:false + 0", async () => {
  const dir = await mkdtemp(join(tmpdir(), "v090s2-"));
  try {
    const { EventLog } = await import("../src/events.js");
    const { Policy } = await import("../src/policy.js");
    const { defaultRules } = await import("../src/policy-defaults.js");
    const { createRegistry } = await import("../src/tools/index.js");
    const echo = (await import("../src/providers/echo.js")).default;
    const { decide } = await import("../src/context.js");
    const { createLoop } = await import("../src/loop.js");

    const pricedProvider = { ...echo, pricing: { input_per_mtok: 200, output_per_mtok: 400 } };

    const lp = join(dir, "priced.jsonl");
    const log = await EventLog.open(lp);
    const loopA = createLoop({
      provider: pricedProvider,
      tools: createRegistry(),
      policy: new Policy({ rules: defaultRules(), logPath: lp }),
      log,
      decide,
      askResolver: async () => "allow",
      config: { session: "s2a" },
    });
    await loopA.start("hi");
    await loopA.end();
    const endA = log.events.find((e) => e.type === "session.end");
    // echo usage per "hi"-turn: input 2, output 5 (parse at the end from the record)
    assert.equal(endA.data.priced, true, "the priced flag is true");
    // v0.9.0 desk fix: micro-USD = tokens * rate-per-Mtok (the earlier formula
    // divided by 1e6 and then labelled the currency units "micro", losing 1e6).
    const expectMicro = Math.round(endA.data.total_input_tokens * 200) + Math.round(endA.data.total_output_tokens * 400);
    assert.equal(endA.data.total_cost_micro_usd, expectMicro, "real money, matches the arithmetic");

    // stats agrees, same log
    const { buildReport, computeCostFromProfile } = await import("../src/stats.js");
    const events = log.events;
    const report = buildReport(events);
    const cost = computeCostFromProfile(report, pricedProvider);
    assert.equal(cost.total_micro_usd, endA.data.total_cost_micro_usd, "stats==session.end on the SAME log");
    assert.equal(cost.input_micro_usd + cost.output_micro_usd, cost.total_micro_usd);

    // unpriced: priced false, cost 0
    const lp2 = join(dir, "unpriced.jsonl");
    const log2 = await EventLog.open(lp2);
    const loopB = createLoop({
      provider: echo,
      tools: createRegistry(),
      policy: new Policy({ rules: defaultRules(), logPath: lp2 }),
      log: log2,
      decide,
      askResolver: async () => "allow",
      config: { session: "s2b" },
    });
    await loopB.start("hi");
    await loopB.end();
    const endB = log2.events.find((e) => e.type === "session.end");
    assert.equal(endB.data.priced, false, "unpriced sessions say priced:false");
    assert.equal(endB.data.total_cost_micro_usd, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- S3: bash auto-snapshot -------------------------------------------
test("S3: a bash-rewritten file is restorable from the auto-snapshot", { timeout: 45_000 }, async () => {
  process.env.AC_CHECKPOINT_ROOT = join(tmpdir(), "v090-s3-store-" + Date.now());
  try {
    const dir = await mkdtemp(join(tmpdir(), "v090s3-"));
    const { run } = await import("../src/tools/bash.js");
    const { CheckpointStore } = await import("../src/checkpoint.js");
    const work = join(dir, "work");
    await mkdir(work, { recursive: true });
    await writeFile(join(work, "data.txt"), "original-content", "utf8");

    const res = await run({ command: `echo overwritten > ${join(work, "data.txt")}` }, {
      allowed: true,
      cwd: work,
    });
    assert.equal(res.ok, true);
    assert.ok(Number.isInteger(res.checkpoint), `snapshot taken (seq ${res.checkpoint})`);
    assert.notEqual(await readFile(join(work, "data.txt"), "utf8"), "original-content", "the command ran");

    // restore from THAT snapshot: content returns
    const store = new CheckpointStore({ root: process.env.AC_CHECKPOINT_ROOT, cwd: work });
    await store.restore(res.checkpoint);
    assert.equal(await readFile(join(work, "data.txt"), "utf8"), "original-content", "bash is now undoable");
  } finally {
    delete process.env.AC_CHECKPOINT_ROOT;
  }
});

test("S3: --no-snapshot opts out and reports; the byte guard reports a skip", { timeout: 45_000 }, async () => {
  process.env.AC_CHECKPOINT_ROOT = join(tmpdir(), "v090-s3b-store-" + Date.now());
  try {
    const dir = await mkdtemp(join(tmpdir(), "v090s3b-"));
    const { run } = await import("../src/tools/bash.js");
    const work = join(dir, "work");
    await mkdir(work, { recursive: true });

    // opt-out
    const skipped = await run({ command: "echo x", no_snapshot: true }, { allowed: true, cwd: work });
    assert.equal(skipped.ok, true);
    assert.deepEqual(skipped.checkpoint, { skipped: "no_snapshot: requested" }, "reports the opt-out");

    // guard: the budget compares the STORE's CURRENT SIZE; an empty store is
    // UNDER any budget (snapshot runs — correct). Trip the guard by seeding
    // the store first, then setting a budget smaller than what it holds.
    // The store is PROJECT-SCOPED (keyed by the cwd hash): the seed must
    // use the SAME work cwd as the guarded run, or it lands in a different
    // project dir and work's store sees 0 bytes (probe-proven).
    const { CheckpointStore } = await import("../src/checkpoint.js");
    await writeFile(join(work, "seed.txt"), "x".repeat(500), "utf8");
    const store = new CheckpointStore({ root: process.env.AC_CHECKPOINT_ROOT, cwd: work });
    await store.snapshot({ label: "seed" }); // THIS project's store now >0 bytes
    process.env.AC_BASH_SNAPSHOT_MAX_BYTES = "1"; // 1-byte budget: exceeded
    const guarded = await run({ command: "echo y" }, { allowed: true, cwd: work });
    assert.equal(guarded.ok, true, "the run proceeds WITHOUT the snapshot");
    assert.match(guarded.checkpoint.skipped, /snapshot budget/);
    delete process.env.AC_BASH_SNAPSHOT_MAX_BYTES;
  } finally {
    delete process.env.AC_CHECKPOINT_ROOT;
    delete process.env.AC_BASH_SNAPSHOT_MAX_BYTES;
  }
});

// v0.9.0 desk fix (regression): money arithmetic was off by 1e6 — the formula
// (tokens/1e6)*rate yields CURRENCY units, but the field is micro-USD, so a
// $18.00 session was recorded as 18 micro-USD ($0.000018). stats and
// session.end were identically wrong, which is why the equality test passed.
test("S2 money: 1M tokens at 3/15 per Mtok is $18.00 — 18,000,000 micro-USD", { timeout: 30_000 }, async () => {
  const { buildReport, computeCostFromProfile } = await import("../src/stats.js");
  const events = [
    { seq: 0, ts: 1, type: "turn.start", actor: "harness", data: {} },
    { seq: 1, ts: 2, type: "turn.provider.response", actor: "provider",
      data: { input_tokens: 1_000_000, output_tokens: 1_000_000, cached_tokens: 0 } },
  ];
  const rep = buildReport(events);
  const cost = computeCostFromProfile(rep, { id: "p", pricing: { input_per_mtok: 3, output_per_mtok: 15 } });
  // 1M in @ $3/Mtok = $3.00 = 3,000,000 micro; 1M out @ $15/Mtok = $15.00
  assert.equal(cost.input_micro_usd, 3_000_000, "input micro-USD");
  assert.equal(cost.output_micro_usd, 15_000_000, "output micro-USD");
  assert.equal(cost.total_micro_usd, 18_000_000, "total micro-USD = $18.00");
  // a sub-dollar session must NOT round to zero
  const small = buildReport([{ seq: 0, ts: 1, type: "turn.provider.response", actor: "provider",
    data: { input_tokens: 1_000, output_tokens: 500 } }]);
  const c2 = computeCostFromProfile(small, { id: "p", pricing: { input_per_mtok: 3, output_per_mtok: 15 } });
  assert.equal(c2.total_micro_usd, 1_0500, "10500 micro = $0.0105");
});
