// src/tui/composer.js — input line handling, history ring, /-commands, keymap
// dispatch (spec §1/§2/§5). Pure state machine: no tty, no timers; tests drive
// it with synthetic keys and observe the returned actions/out string.
//
// Key contract (v1, deliberately small — spec §2):
//   printable      → append at caret
//   \r / \n         → submit
//   \x7f (backspace) → delete before caret
//   \x1b[A / \x1b[B  → history up/down (↑/↓)
//   \x1b[5~ / \x1b[6~ → viewport page up/down
//   \x1b[1~ / \x1b[4~ / \x1b[H / \x1b[F → home/end in composer (line nav)
//   \x03 / \x04     → ctrl+c/ctrl+d: quit on EMPTY composer; else CLEAR

import { createHistory } from "./history.js";

export const COMMANDS = ["/help", "/policy", "/compact", "/resume", "/replay", "/quit"];

/** Escape sequences the TUI understands as ONE key (repair-4 D1/D6: the ask
 *  branch and the composer branch share this list via splitKeys). */
export const KEY_SEQUENCES = [
  "\x1b[A", // up
  "\x1b[B", // down
  "\x1b[5~", // pgup
  "\x1b[6~", // pgdn
  "\x1b[H", // home
  "\x1b[F", // end
  "\x1b[1~", // home (legacy)
  "\x1b[4~", // end (legacy)
];

/**
 * Tokenize one raw stdin chunk into key tokens (repair-4 D1/D6/D8):
 *  - recognized escape sequences become ONE whole token (an arrow can never
 *    decompose into a spurious "A" reaching an ask prompt or the composer);
 *  - printable runs become one insert token (newlines excluded — they are
 *    submit keys, so a paste submits segment by segment, in order);
 *  - other control bytes become single-char tokens;
 *  - an UNRECOGNIZED escape stops the stream: the entire rest of the chunk is
 *    dropped (D6 — unknown CSI tails never fall through as printables).
 */
export function splitKeys(chunk) {
  const s = String(chunk ?? "");
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const seq = KEY_SEQUENCES.find((q) => s.startsWith(q, i));
      if (seq) {
        tokens.push(seq);
        i += seq.length;
        continue;
      }
      return tokens; // unrecognized escape: drop the rest of the chunk (D6)
    }
    if (s[i] >= " " && s[i] !== "\x7f") {
      let j = i;
      while (j < s.length && s[j] >= " " && s[j] !== "\x7f") j++;
      tokens.push(s.slice(i, j)); // printable run (\r/\n are < " " so they break it)
      i = j;
      continue;
    }
    tokens.push(s[i]); // single control byte (\r submit, \n submit, \x03, \t, \x7f…)
    i += 1;
  }
  return tokens;
}

/**
 * Create the composer state machine.
 * @param {object} [opts]
 * @param {number} [opts.width] display width for wrap/scroll windows
 */
export function createComposer({ width = 78 } = {}) {
  let buf = "";
  let caret = 0; // 0..buf.length
  let history = createHistory();
  let lineOffset = 0; // visual scroll of a long composer line (columns)

  function clampVisual() {
    const w = Math.max(1, width);
    if (caret - lineOffset > w - 1) lineOffset = caret - (w - 1);
    if (caret < lineOffset) lineOffset = Math.max(0, caret);
  }

  return {
    get text() {
      return buf;
    },
    get caret() {
      return caret;
    },
    get lineOffset() {
      return lineOffset;
    },

    /** Result of one keypress: an action for the host (send/scroll/quit/…) plus
     *  the composer state. Unknown escape sequences → {action:"ignored"}. */
    key(input) {
      // Multi-char escape sequences first (arrow/function keys arrive as one chunk).
      if (input === "\x1b[A") {
        history.beginBrowse(buf);
        const prev = history.up();
        if (prev !== null) {
          buf = prev;
          caret = buf.length;
        }
        return { action: "history" };
      }
      if (input === "\x1b[B") {
        const next = history.down();
        if (next !== null) {
          buf = next;
        } else if (next === null && history.browsing === false) {
          buf = ""; // past the newest → restore the empty draft
        } else if (next === null) {
          // browsing but no newer items: exit browse, keep draft empty
          history.reset();
        }
        caret = buf.length;
        return { action: "history" };
      }
      if (input === "\x1b[5~") return { action: "viewport", verb: "pageUp" };
      if (input === "\x1b[6~") return { action: "viewport", verb: "pageDown" };
      if (input === "\x1b[1~" || input === "\x1b[H") {
        caret = 0;
        clampVisual();
        return { action: "move" };
      }
      if (input === "\x1b[4~" || input === "\x1b[F") {
        caret = buf.length;
        clampVisual();
        return { action: "move" };
      }
      switch (input) {
        case "\r":
        case "\n": {
          if (buf.length === 0) return { action: "noop" };
          const text = buf;
          history.add(text);
          buf = "";
          caret = 0;
          lineOffset = 0;
          return { action: "send", text };
        }
        case "\x7f":
        case "\b": {
          if (caret === 0) return { action: "ignored" };
          buf = buf.slice(0, caret - 1) + buf.slice(caret);
          caret -= 1;
          clampVisual();
          return { action: "edit" };
        }
        case "\x03": // ctrl+c
        case "\x04": // ctrl+d
          if (buf.length === 0) return { action: "quit" };
          buf = "";
          caret = 0;
          lineOffset = 0;
          return { action: "clear" };
        case "\x01": // ctrl+a → home
          caret = 0;
          clampVisual();
          return { action: "move" };
        case "\x05": // ctrl+e → end
          caret = buf.length;
          clampVisual();
          return { action: "move" };
        case "\t":
          return { action: "ignored" }; // tabs are not composer input in v1
        default: {
          // Printable single char or pasted run (D8: splitKeys guarantees runs
          // contain no \r/\n — those arrive as separate submit tokens).
          if (input === "" || [...input].some((c) => c < " " || c === "\x7f")) {
            return { action: "ignored" };
          }
          buf = buf.slice(0, caret) + input + buf.slice(caret);
          caret += input.length;
          clampVisual();
          return { action: "edit" };
        }
      }
    },

    /** Clear programmatically (e.g. after a command executes). */
    clear() {
      buf = "";
      caret = 0;
      lineOffset = 0;
      history.reset();
      return this;
    },

    /** Visible slice for rendering (composer scrolls horizontally, no wrap). */
    view() {
      const w = Math.max(1, width);
      const start = Math.min(lineOffset, Math.max(0, buf.length - w));
      return { text: buf.slice(start, start + w), caretCol: caret - start, offset: start };
    },

    setWidth(w) {
      if (Number.isFinite(w) && w > 0) width = Math.floor(w);
      clampVisual();
      return this;
    },

    get history() {
      return history;
    },
  };
}

/**
 * Parse a submitted line into a command or plain input (REPL semantics).
 * Returns {command, args} for "/..." lines, else {input}.
 */
export function parseSubmission(line) {
  const s = String(line ?? "");
  if (!s.startsWith("/")) return { input: s };
  const parts = s.trim().split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);
  return { command, args };
}

export default { createComposer, parseSubmission, COMMANDS, KEY_SEQUENCES, splitKeys };
