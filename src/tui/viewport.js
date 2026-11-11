// src/tui/viewport.js — bounded ring of rendered lines + sticky-follow scroll
// + SIGWINCH reflow (spec §1/§4/§5). Pure: no tty, no timers; callers drive
// push/scroll/resize. The viewport is a VIEWER over the event stream — the
// event log stays the source of truth; lines dropped here are still in the log.

export const DEFAULT_MAX_LINES = 10_000;

/**
 * Create a viewport ring.
 * @param {object} [opts]
 * @param {number} [opts.maxLines] ring capacity (default 10,000 rendered lines)
 * @param {number} [opts.height] visible viewport height in rows (default 20)
 */
export function createViewport({ maxLines = DEFAULT_MAX_LINES, height = 20 } = {}) {
  let lines = [];
  let follow = true; // sticky-follow: pinned to bottom until the user scrolls up
  let scrollOffset = 0; // rows above the bottom edge (0 = pinned)

  function clampOffset() {
    const maxOffset = Math.max(0, lines.length - height);
    if (scrollOffset > maxOffset) scrollOffset = maxOffset;
    if (scrollOffset <= 0 || lines.length <= height) {
      if (scrollOffset < 0) scrollOffset = 0;
      follow = scrollOffset === 0 && follow;
    }
  }

  return {
    get length() {
      return lines.length;
    },
    get follow() {
      return follow;
    },
    get scrollOffset() {
      return scrollOffset;
    },
    get height() {
      return height;
    },

    /** Append one or more rendered lines (strings). New content while
     *  scrolled-up keeps the offset (sticky); a caller may force re-pin. */
    push(itemOrList, { repin = false } = {}) {
      const list = Array.isArray(itemOrList) ? itemOrList : [itemOrList];
      for (const l of list) lines.push(String(l));
      if (lines.length > maxLines) lines = lines.slice(-maxLines);
      if (repin) follow = true;
      if (follow) scrollOffset = 0;
      clampOffset();
      return this;
    },

    /** User scrolled up: leave follow mode. */
    scrollUp(rows = 1) {
      const maxOffset = Math.max(0, lines.length - height);
      const clamped = Math.min(maxOffset, scrollOffset + rows);
      if (clamped > 0) follow = false; // at the very bottom + zero offset: stay following
      scrollOffset = clamped;
      return this;
    },

    /** User scrolled down: re-pins (follow) when the bottom is reached. */
    scrollDown(rows = 1) {
      scrollOffset = Math.max(0, scrollOffset - rows);
      if (scrollOffset === 0) follow = true;
      return this;
    },

    /** Any new user-send re-pins to bottom (spec §2 sticky-follow). */
    pinToBottom() {
      follow = true;
      scrollOffset = 0;
      return this;
    },

    /** Reflow after SIGWINCH: change height, keep the visual anchor at the
     *  same logical position (bottom-pinned stays bottom-pinned). */
    resize(newHeight) {
      if (!Number.isFinite(newHeight) || newHeight < 1) return this;
      height = Math.floor(newHeight);
      clampOffset();
      return this;
    },

    /** Currently visible window: exactly `min(height, lines)` strings. */
    visible() {
      const h = Math.min(height, lines.length);
      if (h === 0) return [];
      const end = lines.length - scrollOffset;
      return lines.slice(end - h, end);
    },
  };
}

/** Wrap one logical line to a display width (word-wrap; long words hard-split). */
export function wrapLine(text, width) {
  const w = Math.max(1, Math.floor(width));
  const t = String(text ?? "");
  if (t.length <= w) return [t];
  const out = [];
  let start = 0;
  while (start < t.length) {
    if (t.length - start <= w) {
      out.push(t.slice(start));
      break;
    }
    const window = t.slice(start, start + w + 1);
    const lastSpace = window.lastIndexOf(" ");
    let breakAt;
    let takeWidth = w;
    if (lastSpace > 0) {
      breakAt = start + lastSpace;
    } else {
      breakAt = start + w; // long word: hard split at exact width
      takeWidth = w;
    }
    out.push(t.slice(start, breakAt));
    start = breakAt + (t[breakAt] === " " ? 1 : 0);
    if (breakAt <= start - 1 && out.length > 0 && start < t.length && t[breakAt] !== " ") {
      // no space consumed and nothing advanced (all-space window) → force ahead
      if (start <= breakAt) start = breakAt + 1;
    }
  }
  return out.length > 0 ? out : [t.slice(0, w)];
}

export default { createViewport, wrapLine, DEFAULT_MAX_LINES };
