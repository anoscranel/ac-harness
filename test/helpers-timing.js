// test/helpers-timing.js — v0.7.0 flake-class: ONE awaited-condition helper
// for every test that previously slept a fixed duration. Polls are fine;
// fixed sleeps as synchronisation are the flake class. This helper keeps the
// poll bounded, rejects with a legible message naming what never arrived,
// and unrefs its guard timer so it can never hold the event loop.
export async function waitFor(cond, { timeoutMs = 5_000, stepMs = 10, label = "condition" } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`waitFor: ${label} not reached within ${timeoutMs}ms`);
    }
    await new Promise((r) => {
      const t = setTimeout(r, stepMs);
      t.unref?.();
    });
  }
}

export default { waitFor };
