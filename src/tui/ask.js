// src/tui/ask.js — the TUI askResolver (spec §3): a REAL single-key prompt in
// the viewport, y/n/a key semantics, 30s timeout = deny (same resolution
// semantics as the REPL's askResolver via the shared resolveAsk contract).
//
// Mirror of cli.js's resolver API: askFn({call_id, tool, args}) →
// Promise<"allow"|"deny"|undefined>. The loop's resolveAsk races our promise
// against ASK_TIMEOUT_MS and records policy.ask.resolved — the event shape
// stays IDENTICAL to the REPL. "a" answers allow for the CURRENT ask only
// (v1 has no session-scoped always-rule API; spec §3.5 defers it).
//
// The resolver carries its OWN 30s timer as well: if the loop-side race
// settles first (or the resolver is never answered), the banner and the
// single-key handler are still cleared, so the composer can never be left
// disabled by a stale ask (the REPL's rl.question has the same property —
// its readline just keeps collecting input harmlessly).

import { ASK_TIMEOUT_MS } from "../policy.js";

/**
 * Create the TUI ask channel.
 * @param {object} opts
 * @param {(banner:string)=>void} opts.showBanner render the ask-banner row
 * @param {()=>void} [opts.clearBanner]
 * @param {(keyHandler:((key:string)=>void)|null)=>void} opts.setKeyHandler
 *   installs a temporary single-key handler; null restores normal composer keys
 * @param {number} [opts.timeoutMs] default ASK_TIMEOUT_MS (30s, matches the loop)
 */
export function createAsk({
  showBanner,
  clearBanner,
  setKeyHandler,
  timeoutMs = ASK_TIMEOUT_MS,
  onAlways = null, // v0.6.0 SR1: optional (ask:{tool,args}) => void — the surface persists the session rule
} = {}) {
  if (typeof showBanner !== "function" || typeof setKeyHandler !== "function") {
    throw new Error("createAsk requires showBanner and setKeyHandler");
  }
  let pending = null; // {resolve, timer}
  let active = false;

  function finish(answer) {
    if (!pending) return;
    const { resolve, timer } = pending;
    clearTimeout(timer);
    pending = null;
    active = false;
    setKeyHandler(null);
    if (typeof clearBanner === "function") clearBanner();
    resolve(answer);
  }

  return {
    get active() {
      return active;
    },

    /** The askResolver handed to createLoop — SAME contract as cli.js. */
    resolver(ask) {
      return new Promise((resolvePromise) => {
        // Never stack a second ask while one is pending: the first wins
        // (the loop serializes tool calls, but fail safe).
        if (pending) finish(undefined);
        const timer = setTimeout(() => finish(undefined), timeoutMs);
        pending = { resolve: resolvePromise, timer, ask }; // ask kept for the onAlways hook (SR1)
        active = true;
        showBanner(ask);
        setKeyHandler((key) => {
          if (key === "y" || key === "Y") finish("allow");
          else if (key === "n" || key === "N") finish("deny");
          // "a"/"always": v0.6.0 SR1 — the surface's onAlways hook (if
          // wired) persists the in-memory session rule; the answer stays
          // allow for THIS ask. Without the hook the v1 behavior holds.
          else if (key === "a" || key === "A") {
            if (typeof onAlways === "function") {
              try {
                onAlways(pending.ask);
              } catch {
                /* a throwing persistence hook must not lose the answer */
              }
            }
            finish("allow");
          }
          else if (key === "\x03" || key === "\x04") finish("deny"); // ^C/^D during ask = deny, not quit (§3.4)
          // Other keys are ignored while an ask is pending (never crash, never quit).
        });
      });
    },

    /** Externally-forced resolution (teardown or a loop-side timeout win):
     *  deny-answer a pending ask and free the keymap. */
    abortPending() {
      finish(undefined);
    },

    get timeoutMs() {
      return timeoutMs;
    },
  };
}

export default { createAsk };
