// test/loop.switch.test.js — provider-admin §1/§5: setProvider boundary
// discipline. setProvider persists across turns; a mid-turn switch defers to
// the boundary; the switch event carries correct from/to/model; abort during
// a queued switch is safe. All headless with synthetic providers (no echo
// coupling — the seam is provider-shape agnostic).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/events.js";
import { Policy } from "../src/policy.js";
import { defaultRules } from "../src/policy-defaults.js";
import { createRegistry } from "../src/tools/index.js";
import echo from "../src/providers/echo.js";
import { decide } from "../src/context.js";
import { createLoop } from "../src/loop.js";
import { waitFor } from "./helpers-timing.js";

/** Synthetic provider: pure, configurable id/model, slow stream for mid-turn probes. */
function makeProvider(id, model, { slowMs = 0 } = {}) {
  return {
    id,
    model,
    async *stream(request, { signal } = {}) {
      if (slowMs > 0) {
        await new Promise((resolvePromise) => {
          const t = setTimeout(resolvePromise, slowMs);
          signal?.addEventListener("abort", () => {
            clearTimeout(t);
            // settle the suspended await; the throw below handles the abort
            resolvePromise();
          }, { once: true });
        });
        if (signal?.aborted) {
          const e = new Error("aborted");
          e.name = "AbortError";
          throw e;
        }
      }
      const text = `${id}: ${request.messages.at(-1)?.content ?? ""}`;
      yield { delta: text, done: false };
      yield {
        done: true,
        finish: "stop",
        usage: { input_tokens: 1, cached_tokens: 0, output_tokens: 1 },
        estimate: false,
        chars: text.length,
      };
    },
  };
}

async function makeLoop(dir, { provider = makeProvider("p-a", "m-a") } = {}) {
  const logPath = join(dir, `events-${Math.random().toString(36).slice(2)}.jsonl`);
  const log = await EventLog.open(logPath);
  const policy = new Policy({ rules: defaultRules(), logPath });
  const loop = createLoop({
    provider,
    tools: createRegistry(),
    policy,
    log,
    decide,
    askResolver: async () => "allow",
    config: { session: "switch" },
  });
  return { loop, log };
}

test("setProvider between turns: applies immediately, event {from,to,model}, persists", { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-switch-"));
  try {
    const { loop, log } = await makeLoop(dir);
    const r1 = await loop.start("one");
    assert.ok(r1.text.startsWith("p-a:")); // built with the original provider

    const ok = await loop.setProvider(makeProvider("p-b", "m-b"));
    assert.equal(ok, true);
    assert.equal(loop.state.provider.id, "p-b");
    const sw = log.events.find((e) => e.type === "session.provider.switch");
    assert.equal(sw.data.from, "p-a");
    assert.equal(sw.data.to, "p-b");
    assert.equal(sw.data.model, "m-b");

    const r2 = await loop.start("two"); // persists across turns
    assert.ok(r2.text.startsWith("p-b:"));
    await loop.end();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setProvider to the already-active provider is a no-op (no event)", { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-switch-"));
  try {
    const { loop, log } = await makeLoop(dir);
    await loop.setProvider(makeProvider("p-b", "m-b"));
    const first = log.events.filter((e) => e.type === "session.provider.switch").length;
    const ok = await loop.setProvider(makeProvider("p-b", "m-b")); // same id+model
    assert.equal(ok, false);
    assert.equal(log.events.filter((e) => e.type === "session.provider.switch").length, first);
    await loop.end();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Gated provider: the turn stays in-flight until release() — deterministic
 *  mid-turn probing (no sleep-based races). */
function makeGatedProvider(id, model) {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  // v0.7.0 flake-class: a deterministic INSIDE-THE-STREAM signal. Callers
  // await p.streamStarted instead of sleeping "+10ms to reach the gate" —
  // under load that nap raced the generator.
  const p = {
    id,
    model,
    released: false,
    streamStarted: null,
    async *stream(request, { signal } = {}) {
      // abort-race safe (deviation 104): a listener on an ALREADY-aborted
      // signal never fires — under batch load the abort can land before the
      // generator starts; check aborted at entry like the real providers.
      if (signal?.aborted) {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      }
      const aborted = new Promise((_, rej) => {
        const fire = () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          rej(e);
        };
        if (signal?.aborted) fire();
        else signal?.addEventListener("abort", fire, { once: true });
      });
      p.resolveStreamStarted?.();
      await Promise.race([gate, aborted]);
      const text = `${id}: ${request.messages.at(-1)?.content ?? ""}`;
      yield { delta: text, done: false };
      yield {
        done: true,
        finish: "stop",
        usage: { input_tokens: 1, cached_tokens: 0, output_tokens: 1 },
        estimate: false,
        chars: text.length,
      };
    },
  };
  p.streamStarted = new Promise((r) => { p.resolveStreamStarted = r; });
  p.release = () => {
    p.released = true;
    release();
  };
  return p;
}

test("mid-turn setProvider queues; the in-flight turn completes on the OLD provider", { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-switch-"));
  try {
    const gateProvider = makeGatedProvider("p-a", "m-a");
    const { loop, log } = await makeLoop(dir, { provider: gateProvider });
    let turnDone = false;
    const turnPromise = (async () => {
      const res = await loop.start("gated");
      turnDone = true;
      return res;
    })();

    // v0.7.0 flake-class: an AWAITED in-stream signal, not a "+10ms" nap —
    // once the generator signals, the turn is provably parked at the gate.
    await waitFor(() => log.events.some((e) => e.type === "turn.start"), {
      timeoutMs: 5_000, stepMs: 5, label: "turn.start logged",
    });
    await gateProvider.streamStarted; // the generator IS inside the stream now
    const queued = await loop.setProvider(makeProvider("p-b", "m-b"));
    assert.equal(queued, true);
    // Not applied yet, not even logged — the boundary owns it.
    assert.equal(loop.state.provider.id, "p-a");
    assert.equal(log.events.filter((e) => e.type === "session.provider.switch").length, 0);

    const gated = loop.state.provider; // still p-a inside the turn
    gated.release();
    const res = await turnPromise;
    assert.ok(res.text.startsWith("p-a:"), "turn completes on the pre-switch provider");
    assert.ok(turnDone);
    // …and ONLY at the boundary does the queued swap land.
    assert.equal(loop.state.provider.id, "p-b");
    const events = log.events.map((e) => e.type);
    const swIdx = events.indexOf("session.provider.switch");
    const lastTurnIdx = events.lastIndexOf("turn.provider.response");
    assert.ok(swIdx > lastTurnIdx, "switch event lands after the turn's last provider event");
    const sw = log.events[swIdx];
    assert.deepEqual(sw.data, { from: "p-a", to: "p-b", model: "m-b" });
    await loop.end();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("abort during a queued switch: the turn aborts cleanly, the queued swap still lands at the boundary", { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-switch-"));
  try {
    const gateProvider = makeGatedProvider("p-a", "m-a");
    const { loop, log } = await makeLoop(dir, { provider: gateProvider });
    const turnPromise = loop.start("will-be-aborted");
    await waitFor(() => log.events.some((e) => e.type === "turn.start"), {
      timeoutMs: 5_000, stepMs: 5, label: "turn.start logged (abort path)",
    });
    await gateProvider.streamStarted; // generator IS parked at the gate
    await loop.setProvider(makeProvider("p-b", "m-b")); // queued mid-turn
    loop.abort();
    const res = await turnPromise;
    assert.equal(res.aborted, true);
    // Boundary finally ran: queued swap applied even on the abort path.
    assert.equal(loop.state.provider.id, "p-b");
    const sw = log.events.find((e) => e.type === "session.provider.switch");
    assert.deepEqual(sw.data, { from: "p-a", to: "p-b", model: "m-b" });
    // post-abort session is not bricked (F1): the next turn runs on the new provider
    const r2 = await loop.start("after-abort");
    assert.ok(r2.text.startsWith("p-b:"));
    await loop.end();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setProvider validates its argument shape", { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-switch-"));
  try {
    const { loop } = await makeLoop(dir);
    await assert.rejects(() => loop.setProvider(null), /requires a provider object/);
    await assert.rejects(() => loop.setProvider({ id: "x" }), /requires a provider object/);
    // echo object still passes shape validation
    await loop.setProvider(echo);
    assert.equal(loop.state.provider.id, "echo");
    await loop.end();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
