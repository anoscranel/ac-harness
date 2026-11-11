// test/redaction-sync.test.js — repair-4 N3: the TUI's display-side redaction
// pattern list must stay deep-equal to the event-log's pre-log list. One
// exported list per module; this test makes silent divergence impossible.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SECRET_PATTERNS as logPatterns } from "../src/events.js";
import { SECRET_PATTERNS as viewPatterns } from "../src/tui/renderers.js";

test("redaction pattern lists: events.js and renderers.js are deep-equal", () => {
  assert.equal(logPatterns.length, 12);
  assert.deepEqual(viewPatterns, logPatterns);
});

test("every pattern is a global regex (replace loop depends on the g flag)", () => {
  for (const re of logPatterns) {
    assert.ok(re instanceof RegExp, `${re} is a RegExp`);
    assert.equal(re.global, true, `${re} must be global`);
  }
});

test("lists are not the same object identity (independent copies, equal content)", () => {
  assert.notEqual(viewPatterns, logPatterns);
  assert.deepEqual(viewPatterns.map(String), logPatterns.map(String));
});
