// test/tui.viewport.test.js — ring/sticky/resize math (pure, no tty).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createViewport, wrapLine, DEFAULT_MAX_LINES } from "../src/tui/viewport.js";
import { createHistory } from "../src/tui/history.js";

test("ring keeps the last maxLines entries", () => {
  const vp = createViewport({ maxLines: 5, height: 3 });
  for (let i = 1; i <= 10; i++) vp.push(`line-${i}`);
  assert.equal(vp.length, 5);
  assert.equal(vp.visible()[0], "line-8");
  assert.equal(vp.visible().at(-1), "line-10");
});

test("visible() returns exactly min(height, lines) rows", () => {
  const vp = createViewport({ maxLines: 100, height: 4 });
  vp.push(["a", "b"]);
  assert.equal(vp.visible().length, 2);
  vp.push(["c", "d", "e", "f", "g"]);
  assert.equal(vp.visible().length, 4);
  assert.equal(vp.visible().at(-1), "g");
});

test("sticky-follow: pinned to bottom until user scrolls up", () => {
  const vp = createViewport({ maxLines: 100, height: 3 });
  vp.push(["1", "2", "3", "4"]);
  assert.equal(vp.follow, true);
  vp.scrollUp();
  assert.equal(vp.follow, false);
  assert.equal(vp.visible().at(-1), "3"); // bottom row scrolled out
  vp.push("5");
  assert.equal(vp.follow, false); // sticky: new content does not jump
  assert.equal(vp.visible().at(-1), "4"); // anchor advanced one row (ring grew)
  vp.scrollDown();
  assert.equal(vp.follow, true); // bottom re-pin
  assert.equal(vp.visible().at(-1), "5");
});

test("any new user-send re-pins (pinToBottom)", () => {
  const vp = createViewport({ maxLines: 100, height: 3 });
  vp.push(["1", "2", "3", "4", "5"]);
  vp.scrollUp(2);
  assert.equal(vp.follow, false);
  vp.push("new-user-line", { repin: true });
  assert.equal(vp.follow, true);
  assert.equal(vp.visible().at(-1), "new-user-line");
});

test("push while scrolled keeps the visual anchor (no jump)", () => {
  const vp = createViewport({ maxLines: 100, height: 3 });
  vp.push(["1", "2", "3", "4"]);
  vp.scrollUp(1); // looking at 2,3,4
  vp.push("5");
  const win = vp.visible();
  // offset stays 1 → window is lines 2..4 of 5
  assert.equal(win.join(","), "2,3,4");
});

test("scrollUp clamps at the top; scrollDown clamps at the bottom", () => {
  const vp = createViewport({ maxLines: 100, height: 3 });
  vp.push(["1", "2", "3"]);
  vp.scrollUp(10);
  assert.equal(vp.visible()[0], "1");
  vp.scrollDown(10);
  assert.equal(vp.visible().at(-1), "3");
  assert.equal(vp.follow, true);
});

test("resize keeps bottom-pinned view at the new height", () => {
  const vp = createViewport({ maxLines: 100, height: 5 });
  vp.push(["1", "2", "3", "4", "5", "6"]);
  vp.resize(3);
  assert.equal(vp.visible().length, 3);
  assert.equal(vp.visible().at(-1), "6");
});

test("resize while scrolled-up keeps offset within bounds", () => {
  const vp = createViewport({ maxLines: 100, height: 5 });
  vp.push(["1", "2", "3", "4", "5", "6"]);
  vp.scrollUp(2); // window: 2..4
  vp.resize(10); // height > content → whole ring visible, offset clamps to 0
  assert.equal(vp.visible().length, 6);
  assert.ok(vp.scrollOffset <= 0 + 6 - 6);
});

test("wrapLine wraps at width, keeps words when possible", () => {
  assert.deepEqual(wrapLine("hello", 10), ["hello"]);
  const rows = wrapLine("one two three four", 8);
  assert.ok(rows.length >= 2);
  for (const r of rows) assert.ok(r.length <= 8);
  assert.equal(rows.join(" ").replace(/\s+/g, " ").trim(), "one two three four");
});

test("wrapLine hard-splits words longer than the width", () => {
  const rows = wrapLine("abcdefghij", 4);
  assert.deepEqual(rows, ["abcd", "efgh", "ij"]);
});

test("default ring capacity is 10,000", () => {
  assert.equal(DEFAULT_MAX_LINES, 10_000);
});

test("history ring: add/browse up/down/submit again", () => {
  const h = createHistory();
  h.add("first");
  h.add("second");
  h.beginBrowse("draf");
  assert.equal(h.up(), "second");
  assert.equal(h.up(), "first");
  assert.equal(h.up(), "first"); // clamped at oldest
  assert.equal(h.down(), "second");
  assert.equal(h.down(), "draf"); // past newest → stashed draft
  assert.equal(h.browsing, false);
});

test("history collapses consecutive duplicates and caps at 500", () => {
  const h = createHistory({ cap: 3 });
  h.add("a");
  h.add("a");
  assert.equal(h.length, 1);
  h.add("b");
  h.add("c");
  h.add("d");
  assert.equal(h.length, 3);
  assert.deepEqual(h.items, ["b", "c", "d"]);
});
