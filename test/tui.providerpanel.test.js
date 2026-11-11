// test/tui.providerpanel.test.js — provider-admin §5: panel state machine
// (pure, headless): open/list/add/remove/switch/close, add-form validation
// (bad URL, bad id, VALUE-looking key field refused), no-value-leak asserts.
// REDACTOR HAZARD: secret-shaped fixtures are assembled from fragments.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createProviderPanel,
  validateField,
  looksLikeSecretValue,
  PANEL_FOOTER,
  FORM_FIELDS,
} from "../src/tui/provider-panel.js";

const KEY_VALUE = ["sk", "abcdefgh12345678", "zz"].join("-");

function discovered() {
  return [
    { id: "local", baseUrl: "https://api.local.test/v1", model: "m-7", apiKeyEnv: "LOCAL_TEST_KEY", source: "env" },
    { id: "my-endpoint", baseUrl: "https://tui.test/v1", model: "m-8", source: "tui" },
  ];
}

test("open/list: echo first + discovered rows, active marker, footer contract", () => {
  const p = createProviderPanel({ providers: discovered(), activeId: "echo" });
  p.openPanel();
  assert.equal(p.isOpen, true);
  const rows = p.paintRows();
  assert.equal(rows.length, 3);
  assert.equal(rows[0].id, "echo"); // built-in first
  assert.equal(rows[0].source, "builtin");
  assert.equal(rows[0].active, true);
  assert.equal(rows[1].id, "local");
  assert.equal(rows[1].source, "env");
  assert.ok(PANEL_FOOTER.includes("enter=switch"));
  assert.ok(PANEL_FOOTER.includes("esc=close"));
});

test("esc closes; arrow keys move the cursor but never crash at the edges", () => {
  const p = createProviderPanel({ providers: discovered() });
  p.openPanel();
  const E = String.fromCharCode(0x1b);
  assert.equal(p.key("\x1b[B").action, "none"); // down to local
  assert.equal(p.rowSelIdx, 1);
  p.key("\x1b[B"); // down to my-endpoint
  assert.equal(p.rowSelIdx, 2);
  p.key("\x1b[B"); // clamped
  assert.equal(p.rowSelIdx, 2);
  p.key("\x1b[A"); p.key("\x1b[A"); p.key("\x1b[A"); // clamped at top
  assert.equal(p.rowSelIdx, 0);
  assert.equal(p.key(E).action, "close");
  assert.equal(p.isOpen, false);
});

test("enter on a row = switch action with the row's profile", () => {
  const p = createProviderPanel({ providers: discovered() });
  p.openPanel();
  p.key("\x1b[B"); // cursor on local
  const r = p.key("\r");
  assert.equal(r.action, "switch");
  assert.equal(r.profile.id, "local");
  // enter on the already-active row: no switch, a notice instead
  p.setActive("echo");
  const r2 = p.key("\r"); // cursor still on local → not active → switch
  assert.equal(r2.action, "switch");
  p.setActive("local");
  const r3 = p.key("\r");
  assert.equal(r3.action, "none");
  assert.match(p.noticeMessage, /already active/);
});

test("d removes only tui rows; env rows get the hint", () => {
  const p = createProviderPanel({ providers: discovered() });
  p.openPanel();
  p.key("\x1b[B"); // local (env)
  assert.equal(p.key("d").action, "none");
  assert.match(p.noticeMessage, /remove via env/);
  p.key("\x1b[B"); // my-endpoint (tui)
  const r = p.key("d");
  assert.equal(r.action, "removed");
  assert.equal(r.profile.id, "my-endpoint");
  assert.equal(r.wasActive, false);
  assert.equal(p.paintRows().length, 2); // echo + local remain
});

test("d on the ACTIVE tui row reports wasActive (caller falls back to echo)", () => {
  const p = createProviderPanel({ providers: discovered(), activeId: "my-endpoint" });
  p.openPanel();
  p.key("\x1b[B"); p.key("\x1b[B"); // cursor on my-endpoint
  const r = p.key("d");
  assert.equal(r.action, "removed");
  assert.equal(r.wasActive, true);
});

test("a opens the add form; fields advance in order; submit emits a tui profile", () => {
  const p = createProviderPanel({ providers: discovered() });
  p.openPanel();
  assert.equal(p.key("a").action, "form");
  assert.equal(p.formField, "id");
  assert.deepEqual(FORM_FIELDS, ["id", "baseUrl", "model", "apiKeyEnv"]);
  assert.equal(p.formSubmit("my-new").action, "none"); // id ok
  assert.equal(p.formField, "baseUrl");
  p.formSubmit("https://new.test/v1");
  assert.equal(p.formField, "model");
  p.formSubmit("gpt-x");
  assert.equal(p.formField, "apiKeyEnv");
  const r = p.formSubmit("MY_KEY_NAME"); // optional — a NAME is fine
  assert.equal(r.action, "submit");
  assert.deepEqual(r.profile, {
    id: "my-new",
    baseUrl: "https://new.test/v1",
    model: "gpt-x",
    apiKeyEnv: "MY_KEY_NAME",
    source: "tui",
  });
  assert.equal(p.isOpen, true); // caller closes on success
});

test("empty apiKeyEnv submits a profile WITHOUT the field", () => {
  const p = createProviderPanel({ providers: [] });
  p.openPanel();
  p.key("a");
  p.formSubmit("plain");
  p.formSubmit("https://p.test/v1");
  p.formSubmit("m");
  const r = p.formSubmit("");
  assert.equal(r.action, "submit");
  assert.ok(!("apiKeyEnv" in r.profile));
});

test("validation: bad id (charset, built-in, collision) refused", () => {
  assert.match(validateField("id", "Bad_ID"), /lowercase/);
  assert.match(validateField("id", "echo"), /built-in/);
  assert.match(validateField("id", "local", { existingIds: ["local"] }), /already exists/);
  assert.equal(validateField("id", "ok-id"), null);
});

test("validation: bad URL refused (http/https shape, required)", () => {
  assert.match(validateField("baseUrl", ""), /http/);
  assert.match(validateField("baseUrl", "ftp://x.test"), /http/);
  assert.match(validateField("baseUrl", "https:/x"), /http/);
  assert.match(validateField("baseUrl", "https://a b.test/v1"), /http/);
  assert.equal(validateField("baseUrl", "https://api.test/v1"), null);
  assert.equal(validateField("baseUrl", "http://127.0.0.1:8080/v1"), null);
});

test("validation: model required", () => {
  assert.match(validateField("model", ""), /required/);
  assert.equal(validateField("model", "m-1"), null);
});

test("validation: the key field REFUSES value-looking strings (never stores a value)", () => {
  // fragment-assembled value fixture
  assert.ok(looksLikeSecretValue(KEY_VALUE));
  assert.ok(looksLikeSecretValue("Bearer " + "abcdef123456"));
  assert.ok(looksLikeSecretValue("A" + "=" + "x".repeat(5))); // KEY= assignments
  assert.ok(looksLikeSecretValue("n".repeat(41))); // >40 chars
  assert.ok(looksLikeSecretValue("has space"));
  assert.equal(looksLikeSecretValue("MY_KEY_NAME"), false);
  assert.equal(looksLikeSecretValue(""), false);
  const refusal = validateField("apiKeyEnv", KEY_VALUE);
  assert.ok(refusal, "value-looking key entry must be refused");
  assert.match(refusal, /env var NAME/);
  assert.match(refusal, /never stored/);
});

test("form error path: refusal keeps the form open on the same field", () => {
  const p = createProviderPanel({ providers: [] });
  p.openPanel();
  p.key("a");
  const bad = p.formSubmit("Not_Valid"); // uppercase + underscore
  assert.equal(bad.action, "none");
  assert.match(p.formError, /lowercase/);
  assert.equal(p.formField, "id"); // stayed
  p.formSubmit("valid-id"); // recovers
  assert.equal(p.formField, "baseUrl");
  assert.equal(p.formError, null);
});

test("no-value-leak: the panel surface never echoes a key VALUE", () => {
  const p = createProviderPanel({ providers: discovered(), activeId: "echo" });
  p.openPanel();
  // drive everything; then scan every renderable string for the value
  const surface = [
    PANEL_FOOTER,
    JSON.stringify(p.paintRows()),
    String(p.noticeMessage),
  ];
  p.key("a");
  surface.push(String(p.formError));
  for (const s of surface) assert.ok(!s.includes(KEY_VALUE), "a VALUE must never render");
});

test("unknown keys in panel mode are ignored (never crash)", () => {
  const p = createProviderPanel({ providers: discovered() });
  p.openPanel();
  for (const k of ["x", "1", "!", "\t", "\x7f"]) {
    assert.equal(p.key(k).action, "none");
  }
  assert.equal(p.isOpen, true);
});

// --- provider-edit §1/§5: `e` opens a PREFILLED form; id locked; edit submit
// --- emits {action:"edit"}; env/echo rows get notices; value-shaped key
// --- refused in edit mode too. ---------------------------------------------
import { updateProfile } from "../src/providers/registry.js";

test("e on a tui row opens the prefilled edit form (editingId set)", () => {
  const p = createProviderPanel({ providers: discovered(), activeId: "echo" });
  p.openPanel();
  p.key("\x1b[B"); p.key("\x1b[B"); // select my-endpoint (tui)
  const r = p.key("e");
  assert.equal(r.action, "form");
  assert.equal(r.editing, "my-endpoint");
  assert.equal(p.editingId, "my-endpoint");
  assert.equal(p.formField, "id");
});

test("edit submit: id locked (typed input ignored); emits {action:\"edit\"} with changed baseUrl/model", () => {
  const p = createProviderPanel({ providers: discovered(), activeId: "echo" });
  p.openPanel();
  p.key("\x1b[B"); p.key("\x1b[B");
  p.key("e");
  // id field: type garbage, Enter — must be ignored, id stays locked
  const step = p.formSubmit("!!cannot-change-me!!");
  assert.equal(step.action, "none"); // advanced past the locked id
  assert.equal(p.formField, "baseUrl");
  p.formSubmit("https://v2.test/api");
  p.formSubmit("model-nine");
  const res = p.formSubmit("MY_KEY_NAME");
  assert.equal(res.action, "edit");
  assert.deepEqual(res.profile, {
    id: "my-endpoint", // NEVER the typed garbage — the locked id survived
    baseUrl: "https://v2.test/api",
    model: "model-nine",
    apiKeyEnv: "MY_KEY_NAME",
    source: "tui",
  });
});

test("edit submit: no-change edit is fine and emits the same profile", () => {
  const p = createProviderPanel({ providers: discovered() });
  p.openPanel();
  p.key("\x1b[B"); p.key("\x1b[B");
  p.key("e");
  p.formSubmit(""); // skip locked id
  p.formSubmit("https://tui.test/v1"); // same baseUrl
  p.formSubmit("m-8"); // same model
  const res = p.formSubmit(""); // same (absent) apiKeyEnv
  assert.equal(res.action, "edit");
  assert.deepEqual(res.profile, {
    id: "my-endpoint",
    baseUrl: "https://tui.test/v1",
    model: "m-8",
    source: "tui",
  });
});

test("e on an env row shows the edit-via-env notice; on echo shows built-in notice", () => {
  const p = createProviderPanel({ providers: discovered() });
  p.openPanel();
  p.key("\x1b[B"); // local (env)
  assert.equal(p.key("e").action, "none");
  assert.match(p.noticeMessage, /edit via env vars/);
  p.key("\x1b[A"); // echo (builtin)
  assert.equal(p.key("e").action, "none");
  assert.match(p.noticeMessage, /echo is built-in/);
});

test("edit mode refuses value-looking apiKeyEnv at submission too", () => {
  const p = createProviderPanel({ providers: discovered() });
  p.openPanel();
  p.key("\x1b[B"); p.key("\x1b[B");
  p.key("e");
  p.formSubmit("");
  p.formSubmit("https://tui.test/v1");
  p.formSubmit("m-8");
  // fragment-assembled value fixture
  const bad = ["sk", "abcdefgh12345678", "qq"].join("-");
  const res = p.formSubmit(bad);
  assert.equal(res.action, "none");
  assert.match(res.error, /env var NAME/);
  assert.equal(p.formField, "apiKeyEnv"); // stayed on the field
});

test("edit of an active provider with a changed model triggers setProvider with the rebuilt profile (fake loop)", async () => {
  // main.js onProfileEdited semantics, asserted with a fake loop object.
  const calls = [];
  const fakeLoop = {
    async setProvider(p) {
      calls.push({ id: p.id, model: p.model });
      return true;
    },
  };
  const p = createProviderPanel({ providers: discovered(), activeId: "my-endpoint" });
  p.openPanel();
  p.key("\x1b[B"); p.key("\x1b[B");
  p.key("e");
  p.formSubmit("");
  p.formSubmit("https://tui.test/v1");
  p.formSubmit("m-8-new");
  const res = p.formSubmit("");
  assert.equal(res.action, "edit");
  // main.js rule: id === active → rebuild + setProvider
  if (p.activeId === res.profile.id) {
    await fakeLoop.setProvider({ id: res.profile.id, model: res.profile.model });
  }
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { id: "my-endpoint", model: "m-8-new" });
});

test("registry.updateProfile round-trip (provider-edit §2/§5)", async () => {
  const { mkdtemp, rm, readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "harness-edit-"));
  try {
    const file = join(dir, "providers.config.json");
    const KEY_VALUE = ["sk", "abcdefgh12345678", "zz"].join("-");
    await writeFile(file, JSON.stringify({
      version: 1,
      providers: [
        { id: "alpha", baseUrl: "https://a.test/v1", model: "m-1", source: "tui", apiKeyEnv: "ALPHA_KEY" },
        { id: "beta", baseUrl: "https://b.test/v1", model: "m-2", source: "env" },
      ],
    }) + "\n", "utf8");

    const row = await updateProfile(file, "alpha", {
      baseUrl: "https://a2.test/v2",
      model: "m-1x",
      apiKeyEnv: "ALPHA_KEY", // unchanged
    });
    assert.deepEqual(row, { id: "alpha", baseUrl: "https://a2.test/v2", model: "m-1x", source: "tui", apiKeyEnv: "ALPHA_KEY" });

    const raw = await readFile(file, "utf8");
    const data = JSON.parse(raw);
    assert.equal(data.providers.length, 2);
    assert.equal(data.providers[0].model, "m-1x");
    // apiKeyEnv unchanged, still a NAME
    assert.equal(data.providers[0].apiKeyEnv, "ALPHA_KEY");
    assert.ok(!raw.includes(KEY_VALUE), "no env VALUE in file");

    // unknown id → null; env-sourced id → null (env owns it)
    assert.equal(await updateProfile(file, "nope", { model: "x" }), null);
    assert.equal(await updateProfile(file, "beta", { model: "x" }), null);

    // whitelist drops injected VALUE fields on update
    await updateProfile(file, "alpha", { model: "m-1y", apiKey: KEY_VALUE });
    const raw2 = await readFile(file, "utf8");
    assert.ok(!raw2.includes(KEY_VALUE), "injected value field dropped at update");
    const data2 = JSON.parse(raw2);
    assert.equal(data2.providers[0].model, "m-1y");

    // id never changes even if the patch claims it
    const row3 = await updateProfile(file, "alpha", { id: "renamed" });
    assert.equal(row3.id, "alpha");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- no-default-provider A2/A3: no env-default row class; empty-list hint ---
test("empty provider list: echo row + the add-a-provider hint row", () => {
  const p = createProviderPanel({ providers: [], activeId: "echo" });
  p.openPanel();
  const rows = p.paintRows();
  assert.equal(rows[0].id, "echo");
  assert.equal(rows[0].source, "builtin");
  const hintRow = rows.find((r) => r.source === "empty-hint");
  assert.ok(hintRow, "empty list carries the hint row");
  assert.match(hintRow.hint, /press a to add one/);
  assert.ok(!JSON.stringify(rows).includes("env-default"), "no env-default class remains");
});

test("non-empty list: no hint row", () => {
  const p = createProviderPanel({ providers: discovered() });
  p.openPanel();
  const rows = p.paintRows();
  assert.ok(!rows.some((r) => r.source === "empty-hint"));
  assert.equal(rows.length, 3); // echo + local + my-endpoint
});

test("hint row is inert: e/d/enter on it never crash", () => {
  const p = createProviderPanel({ providers: [] });
  p.openPanel();
  p.key("\x1b[B"); // onto the hint row
  for (const k of ["e", "d", "\r", "a", "x"]) {
    const r = p.key(k);
    assert.ok(["none", "form"].includes(r.action));
    if (r.action === "form") break; // 'a' legitimately opens the add form
  }
});
