// test/tui.composer.test.js — keymap + history pure logic (no tty).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createComposer, parseSubmission, COMMANDS } from "../src/tui/composer.js";
import { createAsk } from "../src/tui/ask.js";

test("printable keys append; backspace deletes before caret", () => {
  const c = createComposer({ width: 40 });
  assert.equal(c.key("h").action, "edit");
  c.key("i");
  assert.equal(c.text, "hi");
  assert.equal(c.key("\x7f").action, "edit");
  assert.equal(c.text, "h");
});

test("enter submits the text and records history; empty enter is a noop", () => {
  const c = createComposer();
  assert.equal(c.key("\r").action, "noop");
  c.key("h"), c.key("i");
  const r = c.key("\r");
  assert.equal(r.action, "send");
  assert.equal(r.text, "hi");
  assert.equal(c.text, "");
  assert.equal(c.history.length, 1);
});

test("↑/↓ walk history and restore the draft after the newest", () => {
  const c = createComposer();
  for (const ch of "abc") c.key(ch);
  c.key("\r");
  for (const ch of "def") c.key(ch);
  c.key("\r");
  assert.equal(c.key("\x1b[A").action, "history");
  assert.equal(c.text, "def");
  c.key("\x1b[A");
  assert.equal(c.text, "abc");
  c.key("\x1b[B");
  assert.equal(c.text, "def");
  c.key("\x1b[B"); // past newest → empty draft (composer was empty)
  assert.equal(c.text, "");
});

test("ctrl+c/ctrl+d quit only on empty composer; else clear", () => {
  const c = createComposer();
  assert.equal(c.key("\x03").action, "quit");
  assert.equal(c.key("\x04").action, "quit");
  c.key("x");
  assert.equal(c.key("\x03").action, "clear");
  assert.equal(c.text, "");
  c.key("y");
  assert.equal(c.key("\x04").action, "clear");
});

test("pgup/pgdn map to viewport actions", () => {
  const c = createComposer();
  assert.deepEqual(c.key("\x1b[5~"), { action: "viewport", verb: "pageUp" });
  assert.deepEqual(c.key("\x1b[6~"), { action: "viewport", verb: "pageDown" });
});

test("home/end move within the composer line; tab is ignored", () => {
  const c = createComposer({ width: 40 });
  c.key("c");
  c.key("a");
  c.key("b");
  c.key("\x01"); // ctrl+a home
  assert.equal(c.caret, 0);
  c.key("\x05"); // ctrl+e end
  assert.equal(c.caret, 3);
  assert.equal(c.key("\t").action, "ignored");
});

test("unknown control bytes are ignored, never crash", () => {
  const c = createComposer();
  for (const k of ["\x1b[Z", "\x00", "\x1b[200~", ""]) {
    const r = c.key(k);
    assert.ok(["ignored", "edit", "history", "move", "viewport", "noop"].includes(r.action));
  }
  assert.equal(c.text, "");
});

test("long input scrolls horizontally via view()", () => {
  const c = createComposer({ width: 10 });
  for (const ch of "abcdefghijklmnopqrstuvwxyz") c.key(ch);
  const v = c.view();
  assert.ok(v.text.length <= 10);
  assert.ok(v.caretCol <= 10);
  assert.equal(c.text.length, 26);
});

test("parseSubmission splits /commands and args (REPL semantics)", () => {
  assert.deepEqual(parseSubmission("hello"), { input: "hello" });
  assert.deepEqual(parseSubmission("/resume 5"), { command: "/resume", args: ["5"] });
  assert.deepEqual(parseSubmission("/help"), { command: "/help", args: [] });
  assert.deepEqual(parseSubmission("/replay logs/x.jsonl"), { command: "/replay", args: ["logs/x.jsonl"] });
  assert.deepEqual(parseSubmission("/COMPACT"), { command: "/compact", args: [] });
});

test("known command surface matches the REPL commands", () => {
  for (const c of ["/help", "/policy", "/compact", "/resume", "/replay", "/quit"]) {
    assert.ok(COMMANDS.includes(c));
  }
});

test("ask resolver: y/n/a single-key semantics; ^C during ask = deny", async () => {
  const shown = [];
  let keyHandler = null;
  const ask = createAsk({
    showBanner: (a) => shown.push(a),
    clearBanner: () => shown.push("cleared"),
    setKeyHandler: (h) => {
      keyHandler = h;
    },
  });
  const p = ask.resolver({ call_id: "c1", tool: "bash", args: { command: "ls" } });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].tool, "bash");
  keyHandler("y");
  assert.equal(await p, "allow");

  const p2 = ask.resolver({ call_id: "c2", tool: "bash", args: {} });
  keyHandler("n");
  assert.equal(await p2, "deny");

  const p3 = ask.resolver({ call_id: "c3", tool: "bash", args: {} });
  keyHandler("a"); // v1: allow for THIS ask only (no session rule written)
  assert.equal(await p3, "allow");

  const p4 = ask.resolver({ call_id: "c4", tool: "bash", args: {} });
  keyHandler("\x03"); // ctrl+c during ask denies, never quits
  assert.equal(await p4, "deny");

  const p5 = ask.resolver({ call_id: "c5", tool: "bash", args: {} });
  keyHandler("Q"); // unknown key ignored
  assert.equal(ask.active, true);
  ask.abortPending(); // teardown path
  assert.equal(await p5, undefined);
  assert.equal(ask.active, false);
  assert.equal(shown.at(-1), "cleared");
});

test("ask resolver: resolver-side timeout frees the keymap when no key arrives", async () => {
  let keyHandler = null;
  const ask = createAsk({
    showBanner: () => {},
    clearBanner: () => {},
    setKeyHandler: (h) => {
      keyHandler = h;
    },
    timeoutMs: 20, // short fuse for the test only
  });
  const p = ask.resolver({ call_id: "c1", tool: "bash", args: {} });
  assert.equal(ask.active, true);
  assert.equal(await p, undefined); // 20ms elapsed, no key
  assert.equal(ask.active, false);
  assert.equal(keyHandler, null); // composer re-enabled
  keyHandler?.("y"); // stale handler must be detached — no crash, no effect
});

test("ask resolver: second ask while one is pending settles the first, not a stack", async () => {
  let keyHandler = null;
  const ask = createAsk({
    showBanner: () => {},
    clearBanner: () => {},
    setKeyHandler: (h) => {
      keyHandler = h;
    },
  });
  const p1 = ask.resolver({ call_id: "c1", tool: "bash", args: {} });
  const p2 = ask.resolver({ call_id: "c2", tool: "bash", args: {} });
  keyHandler("y"); // answers the CURRENT ask (c2)
  assert.equal(await p2, "allow");
  assert.equal(await p1, undefined); // the superseded ask was swept, not orphaned
  assert.equal(ask.active, false);
});

test("banner is cleared exactly once per answered ask", async () => {
  let keyHandler = null;
  let clears = 0;
  const ask = createAsk({
    showBanner: () => {},
    clearBanner: () => {
      clears += 1;
    },
    setKeyHandler: (h) => {
      keyHandler = h;
    },
  });
  const p = ask.resolver({ call_id: "c1", tool: "bash", args: {} });
  keyHandler("x"); // ignored
  keyHandler("y");
  await p;
  assert.equal(clears, 1);
});

// --- repair-4 (tui): splitKeys + ask-mode escape assembly (D1/D6/D8) -------
// REDACTOR HAZARD: every escape-sequence fixture below is assembled from
// fragments — no full control-sequence literal is written in source.
import { splitKeys } from "../src/tui/composer.js";

const ESC = String.fromCharCode(0x1b);
const CSI_UP = ESC + "[A";
const CSI_DOWN = ESC + "[B";
const CSI_PGUP = ESC + "[5~";
const CSI_UNKNOWN = ESC + "[1;2A"; // shift-arrow: not in the v1 key list
const BEL = String.fromCharCode(0x07);

test("D1/D6: splitKeys consumes recognized escape sequences whole", () => {
  const tokens = splitKeys("x" + CSI_UP + "y");
  assert.deepEqual(tokens, ["x", CSI_UP, "y"]); // never ["x","\x1b","[","A","y"]
});

test("D6: unrecognized escape drops the entire rest of the chunk", () => {
  const tokens = splitKeys("ab" + CSI_UNKNOWN + "cd");
  assert.deepEqual(tokens, ["ab"]); // "cd" never reaches the composer
  assert.deepEqual(splitKeys(ESC), []); // lone ESC: nothing leaks
});

test("D8: newline-containing paste splits into ordered submit segments", () => {
  const paste = "one" + "\n" + "two" + "\n" + "three";
  const tokens = splitKeys(paste);
  assert.deepEqual(tokens, ["one", "\n", "two", "\n", "three"]);
  // replay through the composer: both submits land in history, in order
  const c = createComposer();
  const sends = [];
  for (const tok of tokens) {
    const r = c.key(tok);
    if (r.action === "send") sends.push(r.text);
  }
  assert.deepEqual(sends, ["one", "two"]);
  assert.equal(c.text, "three"); // trailing segment stays in the composer
  assert.deepEqual(c.history.items, ["one", "two"]);
});

test("D8: \r and \n both submit; control bytes stay single tokens", () => {
  assert.deepEqual(splitKeys("a\rb"), ["a", "\r", "b"]);
  const ctrlC = String.fromCharCode(0x03);
  assert.deepEqual(splitKeys("q" + ctrlC), ["q", ctrlC]);
});

test("D1: arrow-up during an ask never resolves as allow; y still answers", async () => {
  let keyHandler = null;
  const ask = createAsk({
    showBanner: () => {},
    clearBanner: () => {},
    setKeyHandler: (h) => {
      keyHandler = h;
    },
  });
  const p = ask.resolver({ call_id: "c1", tool: "bash", args: {} });
  // main.js ask-branch semantics: tokens from splitKeys; single-char keys and
  // whole esc tokens reach the handler, printable runs per char.
  const deliver = (chunk) => {
    for (const tok of splitKeys(chunk)) {
      if (tok.length === 1) keyHandler(tok);
      else if (tok.startsWith(ESC)) keyHandler(tok); // whole token, ignored by the handler
      else for (const ch of tok) keyHandler(ch);
    }
  };
  deliver(CSI_UP); // the D1 probe: was spread to ESC,"[","A" → "A" = allow
  assert.equal(ask.active, true); // no resolution, still pending
  deliver(CSI_DOWN);
  deliver(CSI_PGUP);
  assert.equal(ask.active, true);
  deliver(BEL); // stray control byte: ignored, ask stays pending
  assert.equal(ask.active, true);
  deliver("y");
  assert.equal(await p, "allow");
  assert.equal(ask.active, false);
});

test("D1: pasted answer text resolves on its first single-char key (paste parity)", async () => {
  let keyHandler = null;
  const ask = createAsk({
    showBanner: () => {},
    clearBanner: () => {},
    setKeyHandler: (h) => {
      keyHandler = h;
    },
  });
  const p = ask.resolver({ call_id: "c1", tool: "bash", args: {} });
  // ask-branch semantics: printable runs resolve per single-char key
  for (const tok of splitKeys("no")) {
    if (tok.length === 1) keyHandler?.(tok);
    else for (const ch of tok) keyHandler?.(ch);
  }
  assert.equal(await p, "deny");
});
