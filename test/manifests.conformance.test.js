// test/manifests.conformance.test.js — plugin-manifest conformance suite.
// 8 desk fixtures (4 valid, 4 invalid) validated against the normative schema
// (schemas/plugin-manifest.schema.json) with the hand-rolled subset checker.
// Plus: compat grammar, folder-name match, symlink rejection, single-hook
// lexicographic winner (specs/plugin-manifest.md).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, mkdir, writeFile, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../src/internal/jsonschema.js";
import { loadPlugins, parseCompat, compatCheck } from "../src/plugins/loader.js";
import { EventLog } from "../src/events.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(HERE, "..", "schemas", "plugin-manifest.schema.json");
const FIXTURES = join(HERE, "fixtures", "manifests");

async function loadSchema() {
  return JSON.parse(await readFile(SCHEMA_PATH, "utf8"));
}

test("4 valid manifests pass schema validation", async () => {
  const schema = await loadSchema();
  for (const f of ["manifests-valid-01.json", "manifests-valid-02.json", "manifests-valid-03.json", "manifests-valid-04.json"]) {
    const manifest = JSON.parse(await readFile(join(FIXTURES, f), "utf8"));
    const r = validate(manifest, schema);
    assert.ok(r.ok, `${f} should be valid: ${r.errors.join("; ")}`);
  }
});

test("4 invalid manifests fail schema validation", async () => {
  const schema = await loadSchema();
  const expected = {
    "manifests-invalid-01.json": /pattern/, // "Bad Name" fails manifest pattern
    "manifests-invalid-02.json": /required/, // missing version
    "manifests-invalid-03.json": /additionalProperty/, // side_effect not allowed
    "manifests-invalid-04.json": /enum/, // hook "run-away" not in enum
  };
  for (const [f, re] of Object.entries(expected)) {
    const manifest = JSON.parse(await readFile(join(FIXTURES, f), "utf8"));
    const r = validate(manifest, schema);
    assert.ok(!r.ok, `${f} should be invalid`);
    assert.ok(
      r.errors.some((e) => re.test(e)),
      `${f}: expected an error matching ${re}, got: ${r.errors.join("; ")}`,
    );
  }
});

test("compat grammar: x.y.z | ^x.y.z | >=x.y.z only", () => {
  assert.equal(parseCompat("0.1.0").op, "exact");
  assert.equal(parseCompat("^0.1.0").op, "caret");
  assert.equal(parseCompat(">=0.1.0").op, "gte");
  assert.equal(parseCompat("~0.1.0"), null); // tilde = compat-warn
  assert.equal(parseCompat("0.1"), null);
  assert.equal(parseCompat("latest"), null);
});

test("compatCheck semantics against harness 0.1.0", () => {
  assert.ok(compatCheck("0.1.0", "0.1.0").ok);
  assert.ok(!compatCheck("0.2.0", "0.1.0").ok);
  assert.ok(compatCheck("^0.1.0", "0.1.5").ok); // caret on 0.y: <0.2.0
  assert.ok(!compatCheck("^0.1.0", "0.2.0").ok);
  assert.ok(compatCheck("^1.2.3", "1.9.0").ok);
  assert.ok(!compatCheck("^1.2.3", "2.0.0").ok);
  assert.ok(compatCheck(">=0.1.0", "0.1.0").ok);
  assert.ok(!compatCheck(">=0.2.0", "0.1.0").ok);
  assert.ok(!compatCheck("latest", "0.1.0").ok); // unparsed grammar → warn
});

async function writePlugin(dir, name, manifest) {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, "manifest.json"), JSON.stringify(manifest), "utf8");
}

test("loader: symlink rejected, name-mismatch rejected, single-hook lexicographic winner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-plugins-"));
  const logDir = await mkdtemp(join(tmpdir(), "harness-log-"));
  try {
    const valid = (name, hooks) => ({
      manifest: name,
      version: "0.0.1",
      compat: "^0.1.0",
      capabilities: hooks ? { hooks } : {},
      description: "test plugin",
      licence: "MIT",
    });
    await writePlugin(dir, "aaa-first", valid("aaa-first", ["compaction-trigger"]));
    await writePlugin(dir, "zzz-second", valid("zzz-second", ["compaction-trigger"]));
    await writePlugin(dir, "mismatch", { ...valid("other-name"), manifest: "other-name" });
    await symlink(join(dir, "aaa-first"), join(dir, "linked"));

    const log = await EventLog.open(join(logDir, "events.jsonl"));
    const host = await loadPlugins({ dir, harnessVersion: "0.1.0", log });

    const names = host.plugins.map((p) => p.name);
    assert.deepEqual([...names].sort(), ["aaa-first", "zzz-second"]);
    assert.ok(!names.includes("mismatch"), "name-mismatch rejected");
    assert.ok(!names.includes("linked"), "symlink rejected");

    // single hook: lexicographic winner
    assert.equal(host.singleHooks["compaction-trigger"].plugin, "aaa-first");

    const types = log.events.map((e) => e.type);
    assert.ok(types.includes("plugin.rejected"));
    assert.ok(types.includes("plugin.loaded"));
    assert.ok(types.includes("policy.violation")); // single-hook conflict
    const rejected = log.events.filter((e) => e.type === "plugin.rejected").map((e) => e.data.reason);
    assert.ok(rejected.includes("symlink"));
    assert.ok(rejected.includes("name-mismatch"));
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(logDir, { recursive: true, force: true });
  }
});

test("loader: compat-warn loads with flagged status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-plugins-"));
  const logDir = await mkdtemp(join(tmpdir(), "harness-log-"));
  try {
    await writePlugin(dir, "odd-compat", {
      manifest: "odd-compat",
      version: "1.0.0",
      compat: "latest", // unparseable grammar → compat-warn, still loads
      capabilities: {},
      description: "compat-warn test",
      licence: "MIT",
    });
    const log = await EventLog.open(join(logDir, "events.jsonl"));
    const host = await loadPlugins({ dir, harnessVersion: "0.1.0", log });
    assert.equal(host.plugins.length, 1);
    assert.equal(host.plugins[0].status, "compat-warn");
    const loaded = log.events.find((e) => e.type === "plugin.loaded");
    assert.equal(loaded.data.status, "compat-warn");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(logDir, { recursive: true, force: true });
  }
});
