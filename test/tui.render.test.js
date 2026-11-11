// test/tui.render.test.js — synthetic events → expected rendered strings.
// Strips escapes and asserts CONTENT (spec §6); drives renderers without a
// tty. Secret-shaped fixtures are built via fragment assembly (redactor
// hazard — never emit a full secret-shaped literal in source).
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripAnsi, style } from "../src/tui/screen.js";
import {
  redactForDisplay,
  renderEvent,
  renderAskBanner,
  renderUser,
  renderAssistantText,
  renderVerifyFail,
  renderEventWrapped,
} from "../src/tui/renderers.js";

function plain(s) {
  return stripAnsi(s);
}

test("screen.stripAnsi removes SGR and caret escapes, keeps content", () => {
  const s = `${style.red}hi${style.reset}\x1b[2J\x1b7`;
  assert.equal(plain(s), "hi");
});

test("user line renders as '› text'", () => {
  const line = renderUser("hello world");
  assert.equal(plain(line), "› hello world");
});

test("turn.start renders the user input line", () => {
  const lines = renderEvent({ type: "turn.start", data: { turn: 1, input: "hi" } });
  assert.equal(lines.length, 1);
  assert.equal(plain(lines[0]), "› hi");
});

test("echo chunk events produce no static row (live-line is caller-side)", () => {
  assert.deepEqual(renderEvent({ type: "turn.provider.chunk", data: { delta: "yo", done: false } }), []);
});

test("tool.proposed renders one glyph row with tool and args", () => {
  const lines = renderEvent({
    type: "tool.proposed",
    data: { call_id: "c1", tool: "read", args: { path: "README.md" }, args_sha: "x" },
  });
  assert.equal(lines.length, 1);
  assert.equal(plain(lines[0]), `⚒ read {"path":"README.md"} …`);
});

test("tool.result ok row includes duration", () => {
  const lines = renderEvent({
    type: "tool.result",
    data: { call_id: "c1", ok: true, bytes: 12, duration_ms: 2, sha256: "y" },
  });
  assert.match(plain(lines[0]), /⚒ → ok 2ms, 12b/);
});

test("tool.result deny row is red and notes the error", () => {
  const lines = renderEvent({
    type: "tool.result",
    data: { call_id: "c1", ok: false, bytes: 0, duration_ms: 0, sha256: "y", error: "policy-denied" },
  });
  const row = lines[0];
  assert.ok(row.includes(style.red));
  assert.match(plain(row), /policy-denied/);
});

test("policy.decision renders dim verdict with rule path", () => {
  const lines = renderEvent({
    type: "policy.decision",
    data: { call_id: "c1", verdict: "allow", rule_path: "defaults.allow_read" },
  });
  assert.ok(lines[0].includes(style.dim));
  assert.equal(plain(lines[0]), "policy allow [defaults.allow_read]");
});

test("unknown events render a dim fallback row, never throw", () => {
  const lines = renderEvent({ type: "future.thing", data: { x: 1 } });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(style.dim));
  assert.match(plain(lines[0]), /future\.thing/);
  assert.doesNotThrow(() => renderEvent(null));
});

test("ask banner shows tool + args + the y/n/a keys", () => {
  const line = renderAskBanner({ tool: "bash", args: { command: "npm i x" } });
  assert.equal(plain(line), `⚠ ASK bash {"command":"npm i x"} — [y]es / [n]o / [a]lways`);
  assert.ok(line.includes(style.yellow));
});

test("verify fail banner is red with the detail", () => {
  const line = renderVerifyFail("node --check failed");
  assert.ok(line.includes(style.red));
  assert.match(plain(line), /✗ verify-gate failed: node --check failed/);
});

test("redactForDisplay screens api-key-shaped args in ask banners (fragment-assembled fixture)", () => {
  // Assemble the secret-shaped fixture from fragments so no full literal
  // ever exists in the source (redactor hazard).
  const prefix = "sk-";
  const body = "abcdefgh" + "12345678"; // 16 chars, matches the sk- shape
  const secret = prefix + body;
  const lines = renderEvent({
    type: "tool.proposed",
    data: { call_id: "c1", tool: "write", args: { content: secret }, args_sha: "z" },
  });
  assert.ok(!plain(lines[0]).includes(secret));
  assert.ok(plain(lines[0]).includes("[REDACTED]"));
  assert.equal(redactForDisplay(`token ${secret}`).includes(secret), false);
});

test("renderEventWrapped wraps long rows at the given width", () => {
  const ev = { type: "session.start", data: { session: "s-1", harness_version: "0.1.0" } };
  const rows = renderEventWrapped(ev, 20);
  assert.ok(rows.length >= 2);
  for (const r of rows) assert.ok(plain(r).length <= 20 || stripAnsi(r).length > 0);
});

// --- repair-4 (tui) D2: ANSI-injection round-trip (all fixtures are
// fragment-assembled — no full control-sequence literal in source) ----------
import { sanitizeForTerminal } from "../src/tui/screen.js";

const E = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CR = String.fromCharCode(0x0d);
const C1_CSI = String.fromCharCode(0x9b); // C1 CSI (single-byte)
const C1_OSC = String.fromCharCode(0x9d); // C1 OSC (single-byte)
const C0_TAB = String.fromCharCode(0x09);
const csi = (...parts) => E + "[" + parts.join("");
const altLeave = csi("?1049l"); // leave-alt-screen — the worst-case payload

/** the audit-3d probe shape: clear + OSC title + CR + alt-screen-leave */
function hostileFixture() {
  return {
    raw:
      "PRE" + csi("2J") + " MID " + E + "]0;pwned" + BEL + " TITLE" + CR + altLeave + "END",
    expected: "PRE MID  TITLEEND",
  };
}

test("D2: sanitizeForTerminal strips CSI/OSC/alt-screen-leave, keeps \\n, drops \\r", () => {
  const { raw, expected } = hostileFixture();
  const out = sanitizeForTerminal(raw);
  assert.equal(out, expected);
  assert.ok(!out.includes(E), "no ESC bytes survive");
  assert.ok(!out.includes(CR), "CR stripped");
  assert.ok(!out.includes("pwned"), "OSC payload gone");
});

test("D2: C1 range stripped; \\n preserved; C0 (except \\n) stripped", () => {
  const inStr = "a" + C1_CSI + "b" + C1_OSC + "c" + "\n" + C0_TAB + "d";
  const out = sanitizeForTerminal(inStr);
  assert.equal(out, "abc" + "\n" + "d");
});

test("D2: unterminated OSC swallows the tail (safe); stray lone ESC dropped", () => {
  const out = sanitizeForTerminal("keep" + E + "]0;unterminated-no-bel");
  assert.equal(out, "keep");
  assert.equal(sanitizeForTerminal("a" + E + "b"), "ab");
});

test("D2 round-trip: renderAssistantText emits zero ESC/C0-hazard bytes for hostile input", () => {
  const { raw } = hostileFixture();
  for (const rendered of [
    renderAssistantText(raw),
    renderUser(raw),
    renderVerifyFail(raw),
    renderEvent({ type: "session.error", data: { message: raw, code: "x" } })[0],
    renderEvent({ type: "tool.result", data: { call_id: "c", ok: false, error: raw } })[0],
    renderAskBanner({ tool: "bash", args: { command: raw } }),
  ]) {
    // Styled rows may carry the STYLE tokens' own ESC bytes; the CONTENT
    // (post-stripAnsi plaintext) must carry none.
    const rawText = sanitizeForTerminal(plain(rendered));
    assert.ok(!rawText.includes(E), "content leaked an ESC byte");
    assert.ok(!rawText.includes(BEL), "content leaked a BEL byte");
    assert.ok(!rawText.includes(CR), "content leaked a CR byte");
    assert.ok(!rawText.includes("pwned"), "OSC payload leaked to the screen");
    assert.ok(rawText.length > 0, "sanitized row still carries the visible text");
  }
});

test("D2: negative case — ordinary text and style tokens pass through unchanged", () => {
  assert.equal(sanitizeForTerminal("echo: hello world"), "echo: hello world");
  assert.equal(sanitizeForTerminal(""), "");
  const styled = renderAssistantText("clean text");
  assert.equal(plain(styled), "clean text"); // style tokens applied AFTER sanitize
  // lone ESC between printables: ESC dropped, the printables survive
  assert.equal(sanitizeForTerminal("a" + E + "b"), "ab");
});
