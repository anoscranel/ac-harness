// test/endurance.test.js — provider-endurance §1/§4: the 24h window replaces
// F15's 3-attempt cap. Fake fetchFn/sleepFn drive real timers with a fake
// clock — no waits. REDACTOR HAZARD: no secret-shaped fixtures needed here.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createOpenAICompatProvider,
  retryDelayMs,
  isLocalhost,
} from "../src/providers/openai-compat.js";

/** Fake clock: collects requested sleeps, advances instantly. */
function fakeClock() {
  const slept = [];
  let now = 0;
  return {
    sleepFn: async (ms) => {
      slept.push(ms);
      now += ms;
    },
    nowFn: () => now,
    now: () => now,
    slept,
  };
}

/** SSE success frame factory: a committed stream that immediately ends. */
function sseOk() {
  let done = false;
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          if (done) return { done: true, value: undefined };
          done = true;
          return {
            done: false,
            value: new TextEncoder().encode(
              "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
            ),
          };
        },
      }),
    },
  };
}

function httpErr(status, { retryAfter = null, text = "nope" } = {}) {
  return {
    ok: false,
    status,
    headers: { get: (h) => (h === "retry-after" ? retryAfter : null) },
    text: async () => text,
  };
}

async function collect(gen, signal) {
  const out = [];
  for await (const c of gen({ messages: [{ role: "user", content: "x" }], tools: [] }, { signal })) {
    out.push(c);
  }
  return out;
}

test("429-streak then success: attempts continue PAST 3 (old cap gone), flat 5s sleeps", async () => {
  const clock = fakeClock();
  let n = 0;
  const p = createOpenAICompatProvider({
    id: "t",
    baseUrl: "https://api.test/v1",
    model: "m",
    sleepFn: clock.sleepFn,
    nowFn: clock.nowFn,
    fetchFn: async () => {
      n += 1;
      return n <= 5 ? httpErr(429) : sseOk();
    },
  });
  const out = await collect(p.stream);
  assert.equal(n, 6, "five 429s then success");
  assert.deepEqual(clock.slept, [5000, 5000, 5000, 5000, 5000]);
  assert.ok(out.at(-1).done);
  assert.equal(out.at(-1).truncated, undefined); // [DONE] saw — not truncated
});

test("24h endurance boundary: retries stop when the window elapses", async () => {
  const clock = fakeClock();
  let n = 0;
  const p = createOpenAICompatProvider({
    id: "t",
    baseUrl: "https://api.test/v1",
    model: "m",
    retryPolicy: { intervalMs: 1000, enduranceMs: 2500 },
    sleepFn: clock.sleepFn,
    nowFn: clock.nowFn,
    fetchFn: async () => {
      n += 1;
      return httpErr(503);
    },
  });
  await assert.rejects(() => collect(p.stream), /provider HTTP 503|endurance/);
  // window 2500ms, interval 1000: attempts at 0/1000/2000 → then boundary.
  assert.ok(n === 3 || n === 4, `attempts bounded by the window (n=${n})`);
  assert.ok(clock.slept.length === n || clock.slept.length === n - 1);
});

test("deterministic client errors fail fast: 400/401/403/404/422 — one attempt, no sleep", async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    const clock = fakeClock();
    let n = 0;
    const p = createOpenAICompatProvider({
      id: "t",
      baseUrl: "https://real.api.test/v1", // NOT localhost
      model: "m",
      sleepFn: clock.sleepFn,
    nowFn: clock.nowFn,
      fetchFn: async () => {
        n += 1;
        return httpErr(status);
      },
    });
    await assert.rejects(() => collect(p.stream), new RegExp(`provider HTTP ${status}`));
    assert.equal(n, 1, `${status} = single attempt`);
    assert.equal(clock.slept.length, 0, `${status} = no retry sleep`);
  }
});

test("localhost 401/403 RETRY (proxy restart window); localhost 400 still fails fast", async () => {
  for (const status of [401, 403]) {
    const clock = fakeClock();
    let n = 0;
    const p = createOpenAICompatProvider({
      id: "t",
      baseUrl: "http://127.0.0.1:17330/v1",
      model: "m",
      sleepFn: clock.sleepFn,
    nowFn: clock.nowFn,
      fetchFn: async () => {
        n += 1;
        return n < 3 ? httpErr(status) : sseOk();
      },
    });
    const out = await collect(p.stream);
    assert.equal(n, 3, `${status} from localhost retried to success`);
    assert.ok(out.at(-1).done);
  }
  // 400 from localhost is still deterministic — fail fast.
  const clock = fakeClock();
  let n = 0;
  const p = createOpenAICompatProvider({
    id: "t",
    baseUrl: "http://localhost:17330/v1",
    model: "m",
    sleepFn: clock.sleepFn,
    nowFn: clock.nowFn,
    fetchFn: async () => {
      n += 1;
      return httpErr(400);
    },
  });
  await assert.rejects(() => collect(p.stream), /provider HTTP 400/);
  assert.equal(n, 1);
});

test("rate-limit TEXT body retries even with a non-retryable status", async () => {
  const clock = fakeClock();
  let n = 0;
  const p = createOpenAICompatProvider({
    id: "t",
    baseUrl: "https://api.test/v1",
    model: "m",
    sleepFn: clock.sleepFn,
    nowFn: clock.nowFn,
    fetchFn: async () => {
      n += 1;
      return n < 2 ? httpErr(502, { text: "upstream overloaded, try again" }) : sseOk();
    },
  });
  const out = await collect(p.stream);
  assert.equal(n, 2);
  assert.ok(out.at(-1).done);
});

test("200-with-error-payload retries within the window", async () => {
  const clock = fakeClock();
  let n = 0;
  let readerOpened = false;
  const p = createOpenAICompatProvider({
    id: "t",
    baseUrl: "https://api.test/v1",
    model: "m",
    sleepFn: clock.sleepFn,
    nowFn: clock.nowFn,
    fetchFn: async () => {
      n += 1;
      if (n === 1) {
        // 200 but a JSON error body — no body.getReader (the text() branch runs)
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => '{"error":{"message":"rate limit exceeded"}}',
          get body() {
            readerOpened = true;
            return undefined; // force the non-committed path
          },
        };
      }
      return sseOk();
    },
  });
  const out = await collect(p.stream);
  assert.equal(n, 2, "200-with-error retried once then succeeded");
  assert.ok(out.at(-1).done);
  void readerOpened;
});

test("AbortError mid-backoff exits instantly — no further attempts", async () => {
  const clock = fakeClock();
  const c = new AbortController();
  let n = 0;
  const p = createOpenAICompatProvider({
    id: "t",
    baseUrl: "https://api.test/v1",
    model: "m",
    nowFn: clock.nowFn,
    sleepFn: async (ms, signal) => {
      n += 0;
      clock.slept.push(ms);
      // abort DURING the backoff sleep (as ^C would)
      c.abort();
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    },
    fetchFn: async () => {
      n += 1;
      return httpErr(429);
    },
  });
  await assert.rejects(() => collect(p.stream, c.signal), (err) => err.name === "AbortError");
  assert.equal(n, 1, "aborted inside the FIRST backoff — no second fetch");
});

test("committed SSE stream is NEVER re-attempted (post-200 breakage = F17's business)", async () => {
  const clock = fakeClock();
  let n = 0;
  const p = createOpenAICompatProvider({
    id: "t",
    baseUrl: "https://api.test/v1",
    model: "m",
    sleepFn: clock.sleepFn,
    nowFn: clock.nowFn,
    fetchFn: async () => {
      n += 1;
      if (n > 1) throw new Error("fetch called twice — committed stream re-attempted!");
      // commit with a reader that DIES after one chunk without [DONE]
      let done = false;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: {
          getReader: () => ({
            read: async () => {
              if (done) return { done: true, value: undefined };
              done = true;
              return {
                done: false,
                value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"par"}}]}\n\n'),
              };
            },
          }),
        },
      };
    },
  });
  const out = await collect(p.stream);
  assert.equal(n, 1, "exactly one fetch — no re-attempt on mid-stream break");
  assert.equal(out.at(-1).truncated, true, "F17: no [DONE] = truncated");
});

test("Retry-After wins over the flat interval and caps at 60s", async () => {
  assert.equal(retryDelayMs("3"), 3000);
  assert.equal(retryDelayMs("0"), 0);
  assert.equal(retryDelayMs("99999"), 60_000); // cap
  assert.equal(retryDelayMs(null), 5000); // flat default
  assert.equal(retryDelayMs(""), 5000); // absent header → flat (not 0!)
  assert.equal(retryDelayMs(null, { intervalMs: 123 }), 123); // custom interval wins when no header
  const clock = fakeClock();
  let n = 0;
  const p = createOpenAICompatProvider({
    id: "t",
    baseUrl: "https://api.test/v1",
    model: "m",
    sleepFn: clock.sleepFn,
    nowFn: clock.nowFn,
    fetchFn: async () => {
      n += 1;
      return n === 1 ? httpErr(429, { retryAfter: "7" }) : sseOk();
    },
  });
  await collect(p.stream);
  assert.deepEqual(clock.slept, [7000], "header seconds beat the flat 5s");
});

test("onRetry: fires on the 12th/24th… retry with the attempt count", async () => {
  const clock = fakeClock();
  const seen = [];
  let n = 0;
  const p = createOpenAICompatProvider({
    id: "t",
    baseUrl: "https://api.test/v1",
    model: "m",
    sleepFn: clock.sleepFn,
    nowFn: clock.nowFn,
    fetchFn: async () => {
      n += 1;
      return n <= 26 ? httpErr(429) : sseOk();
    },
    onRetry: (attempt, status) => seen.push([attempt, status]),
  });
  await collect(p.stream);
  assert.deepEqual(seen, [[12, 429], [24, 429]], "every 12th retry surfaces");
});

test("network errors retry within the window (ECONNREFUSED class)", async () => {
  const clock = fakeClock();
  let n = 0;
  const p = createOpenAICompatProvider({
    id: "t",
    baseUrl: "https://dead.test/v1",
    model: "m",
    sleepFn: clock.sleepFn,
    nowFn: clock.nowFn,
    fetchFn: async () => {
      n += 1;
      if (n < 3) {
        const e = new Error("connect ECONNREFUSED 127.0.0.1:1");
        e.code = "ECONNREFUSED";
        throw e;
      }
      return sseOk();
    },
  });
  const out = await collect(p.stream);
  assert.equal(n, 3);
  assert.deepEqual(clock.slept, [5000, 5000]);
  assert.ok(out.at(-1).done);
});

test("isLocalhost: 127.0.0.1/localhost/::1 true; real hosts false; garbage false", () => {
  assert.ok(isLocalhost("http://127.0.0.1:17330/v1"));
  assert.ok(isLocalhost("http://localhost:17330/v1"));
  assert.ok(isLocalhost("http://[::1]:17330/v1"));
  assert.ok(!isLocalhost("https://api.real.test/v1"));
  assert.ok(!isLocalhost("not a url"));
});

test("defaults unchanged: no retryPolicy = flat 5000/24h window (constants)", async () => {
  const clock = fakeClock();
  let n = 0;
  const p = createOpenAICompatProvider({
    id: "t",
    baseUrl: "https://api.test/v1",
    model: "m",
    sleepFn: clock.sleepFn,
    nowFn: clock.nowFn,
    fetchFn: async () => {
      n += 1;
      return n <= 2 ? httpErr(429) : sseOk();
    },
    // NO retryPolicy — production defaults
  });
  await collect(p.stream);
  assert.deepEqual(clock.slept, [5000, 5000]);
});
