// src/tui/history.js — persistent input ring (last 500 inputs, spec §1).
// File persistence is OFF by default and the default is NO file (spec:
// "NOT a hidden file by default"); if a path is given, load is best-effort
// and save happens on the same directory the caller names.

export const HISTORY_CAP = 500;

/**
 * Create an input-history ring.
 * @param {object} [opts]
 * @param {number} [opts.cap] capacity (default 500)
 * @param {string} [opts.path] optional persistence path; absence = memory-only
 * @param {{readFile:Function, writeFile:Function}} [opts.io] injectable fs/promises
 */
export function createHistory({ cap = HISTORY_CAP, path, io } = {}) {
  let items = [];
  let caret = -1; // -1 = browsing new input; 0.. items.length-1 = browsing history
  let draft = ""; // the in-progress line saved when history browsing starts

  function push_(line) {
    const s = String(line);
    if (s.length === 0) return false;
    if (items.length > 0 && items[items.length - 1] === s) return false;
    items.push(s);
    if (items.length > cap) items = items.slice(-cap);
    return true;
  }

  const h = {
    get length() {
      return items.length;
    },
    get items() {
      return [...items];
    },

    /** Record a submitted input. Duplicates of the last entry collapse (ring hygiene). */
    add(line) {
      const changed = push_(line);
      caret = -1;
      draft = "";
      return changed;
    },

    /** Begin browsing: stash the current draft (call once before up()). */
    beginBrowse(current) {
      if (caret === -1) draft = String(current ?? "");
      return h;
    },

    /** ↑ — older entry; at the top it stays (no wraparound into the future). */
    up() {
      if (items.length === 0) return null;
      if (caret === -1) caret = items.length - 1;
      else if (caret > 0) caret -= 1;
      return items[caret];
    },

    /** ↓ — newer entry; past the newest returns the stashed draft (null = no draft). */
    down() {
      if (caret === -1) return null;
      if (caret < items.length - 1) {
        caret += 1;
        return items[caret];
      }
      caret = -1;
      return draft === "" ? null : draft;
    },

    get browsing() {
      return caret !== -1;
    },

    reset() {
      caret = -1;
      draft = "";
      return h;
    },

    /** Persist (only when a path was given). One JSON array, LF-terminated. */
    async save() {
      if (!path || !io?.writeFile) return false;
      await io.writeFile(path, JSON.stringify(items) + "\n", "utf8");
      return true;
    },

    /** Best-effort load; corrupt/absent = empty history (never crashes). */
    async load() {
      if (!path || !io?.readFile) return false;
      try {
        const raw = await io.readFile(path, "utf8");
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return false;
        items = [];
        for (const s of arr) if (typeof s === "string") push_(s);
        if (items.length > cap) items = items.slice(-cap);
        caret = -1;
        return true;
      } catch {
        return false;
      }
    },
  };
  return h;
}

export default { createHistory, HISTORY_CAP };
