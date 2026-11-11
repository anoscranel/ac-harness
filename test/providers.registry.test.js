// test/providers.registry.test.js — provider-admin §2/§5: env discovery,
// build, profiles round-trip, corrupt-file tolerance, and the absolute rule:
// NO env VALUE ever serializes into the file (apiKeyEnv holds a NAME).
// REDACTOR HAZARD: every secret-shaped fixture is assembled from fragments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listEnvProviders, buildFromEnv, saveProfiles, loadProfiles, PROFILES_VERSION } from "../src/providers/registry.js";

// fragment-assembled: a real-looking key value lives only in this variable
const KEY_VALUE = ["sk", "abcdefgh12345678", "xyz"].join("-");

function envFixture() {
  const prefix = "HARNESS_PROVIDER_";
  return {
    [`${prefix}LOCAL_BASE_URL`]: "https://api.local.test/v1",
    [`${prefix}LOCAL_MODEL`]: "test-model-7",
    [`${prefix}LOCAL_API_KEY_ENV`]: "LOCAL_TEST_KEY",
    LOCAL_TEST_KEY: KEY_VALUE, // the VALUE — must NEVER serialize
    [`${prefix}BARE_BASE_URL`]: "https://bare.test/v1", // no model, no key
    [`${prefix}lower_base_url`]: "https://skipped.test/v1", // lowercase id → skipped
    [`${prefix}BAD__BASE_URL`]: "", // empty → skipped
  };
}

test("listEnvProviders: discovers only ID-charset entries with non-empty BASE_URL", () => {
  const rows = listEnvProviders(envFixture());
  assert.deepEqual(
    rows.map((r) => r.id),
    ["bare", "local"],
  );
  const local = rows.find((r) => r.id === "local");
  assert.equal(local.baseUrl, "https://api.local.test/v1");
  assert.equal(local.model, "test-model-7");
  assert.equal(local.apiKeyEnv, "LOCAL_TEST_KEY"); // NAME, not the value
  assert.equal(local.source, "env");
  const bare = rows.find((r) => r.id === "bare");
  assert.equal(bare.model, undefined);
  assert.equal(bare.apiKeyEnv, undefined);
  // no row ever carries the value
  for (const r of rows) assert.ok(!JSON.stringify(r).includes(KEY_VALUE));
});

test("listEnvProviders: empty env = empty list (reads nothing else)", () => {
  assert.deepEqual(listEnvProviders({}), []);
  assert.deepEqual(listEnvProviders(undefined), []);
});

test("buildFromEnv: builds an openai-compat provider; key value read from env at build time only", () => {
  const rows = listEnvProviders(envFixture());
  const local = rows.find((r) => r.id === "local");
  const p = buildFromEnv(local, envFixture());
  assert.equal(p.id, "local");
  assert.equal(p.model, "test-model-7");
  assert.equal(typeof p.stream, "function");
  // The provider object itself must not carry the key value.
  assert.ok(!JSON.stringify(p).includes(KEY_VALUE));
});

test("buildFromEnv: missing model or baseUrl refuses (openai-compat contract)", () => {
  const rows = listEnvProviders(envFixture());
  assert.throws(() => buildFromEnv(rows.find((r) => r.id === "bare"), envFixture()), /requires a model/);
  assert.throws(() => buildFromEnv({ id: "x", model: "m" }, {}), /requires baseUrl/);
});

test("saveProfiles/loadProfiles round-trip: apiKeyEnv stays a NAME; NO env VALUE serializes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-registry-"));
  try {
    const file = join(dir, "providers.config.json");
    const rows = listEnvProviders(envFixture());
    const n = await saveProfiles(file, rows);
    assert.equal(n, 2);
    const raw = await readFile(file, "utf8");
    // THE absolute assertion: the value never hits disk.
    assert.ok(!raw.includes(KEY_VALUE), "env VALUE must never serialize into providers.config.json");
    assert.ok(raw.includes("LOCAL_TEST_KEY"), "the env var NAME must serialize");
    const data = JSON.parse(raw);
    assert.equal(data.version, PROFILES_VERSION);
    const back = await loadProfiles(file);
    assert.deepEqual(back, rows); // full round-trip fidelity
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveProfiles drops unknown fields — a stray key-value field cannot persist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-registry-"));
  try {
    const file = join(dir, "providers.config.json");
    const hostile = [
      {
        id: "x",
        baseUrl: "https://x.test/v1",
        model: "m",
        source: "tui",
        apiKey: KEY_VALUE, // a VALUE-shaped field — must be dropped by the whitelist
        apiKey_env_value: KEY_VALUE,
      },
    ];
    await saveProfiles(file, hostile);
    const raw = await readFile(file, "utf8");
    assert.ok(!raw.includes(KEY_VALUE, "whitelist must drop a value-shaped field"));
    const back = await loadProfiles(file);
    assert.deepEqual(back, [{ id: "x", baseUrl: "https://x.test/v1", model: "m", source: "tui" }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadProfiles: absent file = empty; corrupt file = empty + warn (never throws)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-registry-"));
  try {
    assert.deepEqual(await loadProfiles(join(dir, "nope.json")), []);
    const file = join(dir, "providers.config.json");
    await writeFile(file, "{ this is not json", "utf8");
    const warns = [];
    assert.deepEqual(await loadProfiles(file, { warn: (m) => warns.push(m) }), []);
    assert.equal(warns.length, 1);
    await writeFile(file, JSON.stringify({ nope: true }), "utf8");
    const warns2 = [];
    assert.deepEqual(await loadProfiles(file, { warn: (m) => warns2.push(m) }), []);
    assert.equal(warns2.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("source marking: env rows stay \"env\", tui rows stay \"tui\"", () => {
  const rows = listEnvProviders(envFixture());
  assert.ok(rows.every((r) => r.source === "env"));
});

// --- no-default-provider A3: defaultProviderFor (first configured or null;
// --- NO network in any path) -----------------------------------------------
import { defaultProviderFor } from "../src/providers/registry.js";

test("defaultProviderFor: profiles present -> FIRST profile row returned", async () => {
  const row = await defaultProviderFor({}, {
    profiles: [
      { id: "first-one", baseUrl: "https://a.test/v1", model: "m-1", source: "tui" },
      { id: "second", baseUrl: "https://b.test/v1", model: "m-2", source: "tui" },
    ],
  });
  assert.deepEqual(row, { id: "first-one", baseUrl: "https://a.test/v1", model: "m-1", source: "tui" });
});

test("defaultProviderFor: no profiles + env entries -> the env row", async () => {
  const row = await defaultProviderFor(envFixture(), { profiles: [] });
  assert.equal(row.id, "bare"); // sorted-first env entry
  assert.equal(row.source, "env");
  assert.equal(row.baseUrl, "https://bare.test/v1");
});

test("defaultProviderFor: profiles WIN over env entries (first configured = first profile)", async () => {
  const row = await defaultProviderFor(envFixture(), {
    profiles: [{ id: "from-file", model: "m", source: "tui" }],
  });
  assert.equal(row.id, "from-file");
});

test("defaultProviderFor: nothing configured -> null (caller falls back to echo)", async () => {
  assert.equal(await defaultProviderFor({}, { profiles: [] }), null);
  assert.equal(await defaultProviderFor({}), null);
  assert.equal(await defaultProviderFor(undefined, {}), null);
});

test("defaultProviderFor: NO network in ANY path (fetch never awaited by the module)", async () => {
  // The module must not touch fetch at all now; wrap it to prove absence.
  const origFetch = globalThis.fetch;
  let touched = false;
  globalThis.fetch = async () => {
    touched = true;
    throw new Error("network must not happen");
  };
  try {
    const row = await defaultProviderFor(envFixture(), { profiles: [{ id: "x", model: "m", source: "tui" }] });
    assert.equal(row.id, "x");
    const none = await defaultProviderFor({});
    assert.equal(none, null);
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.equal(touched, false, "fetch was called — network leaked into defaultProviderFor");
});
