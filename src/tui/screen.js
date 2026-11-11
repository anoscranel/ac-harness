// src/tui/screen.js — ANSI primitives ONLY (no app logic).
// One owner per module (spec §5): this module owns the raw escape sequences:
// alt-screen enter/leave, caret save/restore/hide/show, line clearing,
// box-drawing borders, and the style tokens used by renderers.js.
// Pure strings: every export returns/joins strings; the only side-effecting
// members are explicit write helpers bound to a caller-supplied sink so the
// module stays unit-testable headless (spec §6).

/** Style tokens (SGR). Compose as strings; never invent ad-hoc escapes. */
export const style = Object.freeze({
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
});

/** Alt screen + caret control (spec §0/§1: enter on start, restore on every exit path). */
export const ansi = Object.freeze({
  enterAltScreen: "\x1b[?1049h",
  leaveAltScreen: "\x1b[?1049l",
  saveCaret: "\x1b7",
  restoreCaret: "\x1b8",
  hideCaret: "\x1b[?25l",
  showCaret: "\x1b[?12l\x1b[?25h", // blink-off + visible (xterm rmso/rmm family)
  clearScreen: "\x1b[2J",
  clearLineRight: "\x1b[K",
  clearEntireLine: "\x1b[2K",
  moveTo: (col, row) => `\x1b[${row};${col}H`, // 1-based like a terminal
  moveUp: (n = 1) => `\x1b[${n}A`,
  moveDown: (n = 1) => `\x1b[${n}B`,
  moveLeft: (n = 1) => `\x1b[${n}D`,
  moveRight: (n = 1) => `\x1b[${n}C`,
  scrollRegion: (top, bottom) => `\x1b[${top};${bottom}r`, // 1-based, inclusive
  reverseVideo: "\x1b[7m",
  normalVideo: "\x1b[27m",
});

/**
 * Create the write surface. All output flows through one sink (usually
 * process.stdout.write bound per call — NOT `write: stdout.write`, which
 * loses `this`). Batched string-join then one write per repaint keeps the
 * TUI atomic enough for chunk streams without a full alternative buffer.
 */
export function createScreen({ write, cols = 80, rows = 24 } = {}) {
  if (typeof write !== "function") throw new Error("createScreen requires a write fn");
  let active = false;

  function out(s) {
    if (typeof s === "string" && s.length > 0) write(s);
  }

  return {
    cols,
    rows,
    resize(c, r) {
      if (Number.isFinite(c) && c > 0) this.cols = c;
      if (Number.isFinite(r) && r > 0) this.rows = r;
      return this;
    },
    enter() {
      active = true;
      out(ansi.enterAltScreen);
      out(ansi.clearScreen);
      out(ansi.hideCaret);
    },
    leave() {
      if (!active) return;
      active = false;
      out(ansi.showCaret);
      out(ansi.leaveAltScreen);
    },
    get isActive() {
      return active;
    },
    /** Write a composed repaint chunk. Empty/never when inactive (test seam). */
    emit(chunk) {
      if (!active) return;
      out(chunk);
    },
    emitRaw: out,
  };
}

/** Horizontal rule built from box characters (borders only where they carry meaning). */
export function hline(width, char = "─") {
  return char.repeat(Math.max(0, width));
}

/**
 * Bordered box for the composer zone (3 lines: content row + top/bottom).
 * Content longer than inner width is truncated with '…' (never wraps here —
 * the composer owns wrapping).
 */
export function boxLine(width, content) {
  const inner = Math.max(0, width - 2);
  let text = content ?? "";
  if (text.length > inner) text = text.slice(0, Math.max(0, inner - 1)) + "…";
  const pad = Math.max(0, inner - text.length);
  return `┌${hline(inner, "─")}\n│${text}${" ".repeat(pad)}│\n└${hline(inner, "─")}`;
}

/** Strip ANSI escapes + control codes from a rendered string (test util per spec §6). */
export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b[0-9A-Za-z=><]/g, "") // ESC7 / ESC8 / ESC> / ESC= style one-shot codes
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

/**
 * sanitizeForTerminal (repair-4 D2): make any string safe to paint into the
 * alt-screen. Strips, in order: OSC sequences (ESC ] … BEL | ST), CSI
 * sequences (ESC [ … final byte @-~), two-byte ESC finals, any stray ESC;
 * then every C0 control byte EXCEPT \n (newlines are layout input for the
 * wrap layer, not a terminal hazard); then the C1 range 0x80–0x9F. Styled
 * rows are safe by construction once content passes through this first.
 */
export function sanitizeForTerminal(s) {
  let out = String(s ?? "");
  out = out
    // OSC … terminated by BEL or ST (unterminated swallows the tail — safe)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    // CSI: ESC [ params* intermediates* final byte in @-~
    .replace(/\x1b\[[0-9;?<=>!"'#$%&'()*+,\-./]*[@-~]/g, "")
    .replace(/\x1b/g, ""); // any leftover stray ESC (unterminated sequence)
  // C0 except \n (0x0a stays — wrapLayer owns line breaks)
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\x00-\x09\x0b\x0c\x0d\x0e-\x1f\x7f]/g, "");
  // C1 control range
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\x80-\x9f]/g, "");
  return out;
}

export default { style, ansi, createScreen, hline, boxLine, stripAnsi, sanitizeForTerminal };
