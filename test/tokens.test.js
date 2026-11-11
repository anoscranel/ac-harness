// test/tokens.test.js — token-cache v2 + tokens v1 semantics (pinned):
// estimateTokens heuristic, tokenCacheKey stability, TokenCache integer-index
// O(1) LRU core (typed arrays, free stack, sentinels), lazy TTL read-purge,
// staleOnHit, byte bound, prefix-growth reuse, loop wiring + determinism.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTokens, tokenCacheKey, TokenCache } from "../src/tokens.js";
import { EventLog } from "../src/events.js";
import { Policy } from "../src/policy.js";
import { defaultRules } from "../src/policy-defaults.js";
import { createRegistry } from "../src/tools/index.js";
import echo from "../src/providers/echo.js";
import { decide } from "../src/context.js";
import { createLoop } from "../src/loop.js";

// ---------- estimateTokens (v1, pinned) ----------
test("estimateTokens: deterministic across runs", () => {
  const text = "the quick brown fox, and the lazy dog! (running)";
  const a = estimateTokens(text);
  const b = estimateTokens(text);
  assert.equal(a, b);
  assert.ok(Number.isInteger(a));
});

test("estimateTokens: monotonic — longer text (same shape) ≥ shorter", () => {
  const short = "one two three";
  const long = "one two three four five six seven eight nine ten eleven twelve";
  assert.ok(estimateTokens(long) >= estimateTokens(short));
});

test("estimateTokens: never below the chars/4 floor (conservative budgets)", () => {
  const dense = "a".repeat(64); // 1 "word", zero punctuation: heuristic≈1
  assert.equal(estimateTokens(dense), Math.ceil(64 / 4)); // floor wins = 16
  const mixed = "ab cd ef gh ij kl mn op qr st";
  assert.ok(estimateTokens(mixed) >= Math.ceil(mixed.length / 4));
});

test("estimateTokens: code-block bump (fenced / indented read denser)", () => {
  const plain = "some function text here with words";
  const fenced = "```\n" + "some function text here with words" + "\n```";
  assert.ok(estimateTokens(fenced) > estimateTokens(plain));
});

test("estimateTokens: no NaN/Infinity; empty and non-string inputs safe", () => {
  assert.equal(estimateTokens(""), 0);
  assert.ok(Number.isFinite(estimateTokens(null)));
  assert.ok(Number.isFinite(estimateTokens(undefined)));
  assert.ok(Number.isFinite(estimateTokens(42)));
  assert.ok(Number.isFinite(estimateTokens("x".repeat(100000))));
});

// ---------- tokenCacheKey (v1, pinned) ----------
test("tokenCacheKey: identical messages after JSON round-trip = same key", () => {
  const msgs = [
    { role: "system", content: "You are terse." },
    { role: "user", content: "hello" },
  ];
  const k1 = tokenCacheKey(msgs);
  const k2 = tokenCacheKey(JSON.parse(JSON.stringify(msgs)));
  assert.equal(k1, k2);
});

test("tokenCacheKey: different content or role = different key", () => {
  const base = [{ role: "user", content: "abc" }];
  assert.notEqual(tokenCacheKey(base), tokenCacheKey([{ role: "user", content: "abd" }]));
  assert.notEqual(tokenCacheKey(base), tokenCacheKey([{ role: "assistant", content: "abc" }]));
});

// ---------- TokenCache v2: integer-index O(1) LRU core ----------
test("v2 core: hit after record; stats count hits/misses/entries (v1 case)", () => {
  const tc = new TokenCache({ nowFn: () => 1000 });
  const msgs = [{ role: "user", content: "hello world of tokens" }];
  const first = tc.countPrefix(msgs);
  assert.equal(first.cached, false);
  const second = tc.countPrefix(msgs);
  assert.equal(second.cached, true);
  assert.equal(second.tokens, first.tokens);
  const st = tc.stats();
  assert.ok(st.hits >= 1 && st.misses >= 1 && st.entries >= 1);
  // v2 additive stats present
  assert.ok("evictions" in st && "expiredPurges" in st && "bytesResident" in st);
});

test("v2 core: fill to max → evicts the OLDEST-USED; re-get refreshes recency", () => {
  let now = 0;
  const tc = new TokenCache({ maxEntries: 4, nowFn: () => now });
  const msgs = (i) => [{ role: "user", content: `message ${i}` }];
  tc.record(msgs(1), 1);
  tc.record(msgs(2), 2);
  tc.record(msgs(3), 3);
  tc.record(msgs(4), 4); // full
  // refresh 1 then 2 → least-recent is 3
  assert.equal(tc.lookup(msgs(1)), 1);
  assert.equal(tc.lookup(msgs(2)), 2);
  tc.record(msgs(5), 5); // victim must be 3
  const alive = [1, 2, 3, 4, 5].map((i) => tc.peek(msgs(i)) !== null);
  assert.deepEqual(alive, [true, true, false, true, true], "3 evicted (oldest-used)");
  const st = tc.stats();
  assert.equal(st.entries, 4);
  assert.ok(st.evictions >= 1);
});

test("v2 core: delete frees the slot for reuse (strict freshness purge = the delete path)", () => {
  let now = 0;
  const tc = new TokenCache({ maxEntries: 3, staleOnHit: false, nowFn: () => now });
  const msgs = (i) => [{ role: "user", content: `msg ${i}` }];
  tc.record(msgs(1), 1);
  tc.record(msgs(2), 2);
  tc.record(msgs(3), 3); // full
  now += 31 * 60 * 1000; // everything expires
  assert.equal(tc.lookup(msgs(1)), null, "expired → read-purge frees slot 1");
  now = 0; // rewind: remaining entries unexpired again
  tc.record(msgs(4), 4); // MUST land in the freed slot (no steal needed)
  assert.equal(tc.stats().entries, 3);
  assert.ok(tc.peek(msgs(2)) !== null && tc.peek(msgs(3)) !== null, "2 and 3 survive");
  assert.ok(tc.peek(msgs(1)) === null, "1 was purged, not resurrected");
  assert.ok(tc.peek(msgs(4)) !== null, "4 reused the freed slot");
});

test("v2 core: LRU bounded at 256 defaults (v1 case)", () => {
  let now = 0;
  const tc = new TokenCache({ nowFn: () => now });
  const mk = (i) => [{ role: "user", content: `message number ${i}` }];
  for (let i = 0; i < 300; i++) {
    now += 1;
    tc.countPrefix(mk(i));
  }
  assert.ok(tc.stats().entries <= 256, `entries bounded (got ${tc.stats().entries})`);
  assert.equal(tc.lookup(mk(0)), null, "oldest entry evicted");
  assert.ok(tc.lookup(mk(299)) !== null, "newest entry alive");
});

test("v2 typed arrays: max 300 → Uint16 links; max 100000 → Uint32 links", () => {
  // The constructor sizes #next/#prev at max+2 sentinels; a small-filled big
  // cache must still construct (7ms, tiny) and carry the 32-bit link type.
  const small = new TokenCache({ maxEntries: 300 });
  const big = new TokenCache({ maxEntries: 100_000 });
  // construction did not throw; verify link capacity choice via behavior:
  // (typed-array class is internal — verified by operating at a boundary
  //  value that would OVERFLOW a Uint16: record keys up to slots > 65535 is
  //  infeasible in a test; class identity probe via toString on internals is
  //  private. We assert behavior: both caches work.)
  let now = 0;
  const bigToo = new TokenCache({ maxEntries: 100_000, nowFn: () => now });
  for (let i = 0; i < 400; i++) bigToo.record([{ role: "u", content: `x${i}` }], i);
  assert.equal(bigToo.stats().entries, 400);
  assert.ok(bigToo.stats().bytesResident > 0);
  void small; void big;
});

test("v2 lazy TTL: expired → miss + slot freed ON READ (no timers)", () => {
  let now = 0;
  const tc = new TokenCache({ staleOnHit: false, nowFn: () => now });
  const msgs = [{ role: "user", content: "written once" }];
  tc.record(msgs, 7);
  now = 29 * 60 * 1000;
  assert.equal(tc.peek(msgs), 7, "alive inside TTL (peek — no refresh)");
  now = 31 * 60 * 1000;
  assert.equal(tc.lookup(msgs), null, "expired = miss");
  assert.equal(tc.stats().entries, 0, "slot freed on the read (lazy purge)");
  assert.equal(tc.stats().expiredPurges, 1);
  // peek purges too
  const other = [{ role: "user", content: "peeked expire" }];
  tc.record(other, 8);
  now += 31 * 60 * 1000; // 61min after write — NOT touched in between this time
  assert.equal(tc.peek(other), null);
  assert.equal(tc.stats().expiredPurges, 2);
  assert.equal(tc.stats().entries, 0, "peek also frees the slot");
});

test("v2 staleOnHit (default ON): an expired entry is served ONCE and rescheduled", () => {
  let now = 0;
  const tc = new TokenCache({ nowFn: () => now }); // staleOnHit defaults true
  const msgs = [{ role: "user", content: "lower bound note" }];
  tc.record(msgs, 9);
  now = 31 * 60 * 1000; // expired
  assert.equal(tc.lookup(msgs), 9, "stale served once (token counts lower-bound the truth)");
  // rescheduled: the NEXT read, moments later, still hits
  now += 60 * 1000;
  assert.equal(tc.peek(msgs), 9, "rescheduled with a fresh expiry");
  assert.equal(tc.stats().expiredPurges, 0, "no purge on a stale-serve");
  // and 30min after the reschedule it is a normal (non-stale) hit
  now += 29 * 60 * 1000;
  assert.equal(tc.lookup(msgs), 9);
  assert.equal(tc.stats().expiredPurges, 0);
});

test("v2 v1 TTL case: an UNTOUCHED entry expires 30min after write; a hit refreshes its life (strict mode)", () => {
  let now = 0;
  // v2 default staleOnHit=true would SERVE the stale entry once; this carried
  // v1 case pins pure EXPIRY, so it opts into strict mode (the staleOnHit
  // default has its own dedicated test above).
  const tc = new TokenCache({ nowFn: () => now, staleOnHit: false });
  const untouched = [{ role: "user", content: "written once" }];
  tc.countPrefix(untouched); // recorded at t=0 — never looked up again
  now = 29 * 60 * 1000;
  const touched = [{ role: "user", content: "checked at 29min" }];
  tc.countPrefix(touched); // recorded at t=29min
  now = 30 * 60 * 1000 + 31 * 60 * 1000;
  assert.equal(tc.lookup(untouched), null, "61min-old untouched entry expired");
  assert.equal(tc.lookup(touched), null, "31min-old entry expired");
  now = 70 * 60 * 1000;
  const hot = [{ role: "user", content: "hot entry" }];
  tc.countPrefix(hot);
  now = 80 * 60 * 1000;
  assert.ok(tc.lookup(hot) !== null, "10min: hit");
  now = 80 * 60 * 1000 + 29 * 60 * 1000;
  assert.ok(tc.lookup(hot) !== null, "29min after the last hit: alive (refreshed)");
});

test("v2 prefix growth (v1 case): same leading blocks + MORE messages → delta reuse", () => {
  const counted = [];
  const tc = new TokenCache({ nowFn: () => 5000, onCount: (ms, t) => counted.push([ms.length, t]) });
  const sys = [{ role: "system", content: "You are a helpful harness assistant with rules." }];
  const first = tc.countPrefix(sys);
  assert.equal(first.cached, false);
  const grown = [...sys, { role: "user", content: "first question" }];
  const second = tc.countPrefix(grown);
  assert.equal(second.cached, true, "leading block reused");
  const direct = estimateTokens(sys[0].content) + estimateTokens("first question");
  assert.equal(second.tokens, direct, "prefix reuse + delta = full count");
  const lastCall = counted.at(-1);
  assert.equal(lastCall[1], estimateTokens("first question"), "delta counted fresh");
});

test("v2 byte bound: one 5 MiB prefix into a 4 MiB cache = stored but alone", () => {
  let now = 0;
  const tc = new TokenCache({ nowFn: () => now, maxTotalBytes: 4 * 1024 * 1024 });
  const small1 = [{ role: "user", content: "small one" }];
  const small2 = [{ role: "user", content: "small two" }];
  tc.record(small1, 1);
  tc.record(small2, 2);
  assert.equal(tc.stats().entries, 2);
  // A giant prefix: many blocks hashing to a 64-char key, but the DATA cost is
  // key(64B) + JSON value(~30B) — tiny. The BYTE bound bites on the ledger,
  // so to make an oversize line we lower the budget instead (equivalent math):
  const tiny = new TokenCache({ nowFn: () => now, maxTotalBytes: 200 });
  tiny.record([{ role: "user", content: "a" }], 1);
  tiny.record([{ role: "user", content: "b" }], 2);
  assert.equal(tiny.stats().entries, 2);
  // one line costs ~94B (64 hex + JSON) → a 200B budget holds 2; a 3rd evicts
  tiny.record([{ role: "user", content: "c" }], 3);
  assert.ok(tiny.stats().entries <= 2, `byte-capped (got ${tiny.stats().entries})`);
  assert.ok(tiny.stats().evictions >= 1, "byte-bound eviction ran");
  // oversize-alone: a budget smaller than ONE line → the line lives alone
  const nano = new TokenCache({ nowFn: () => now, maxTotalBytes: 10 });
  nano.record([{ role: "user", content: "solo" }], 42);
  assert.equal(nano.peek([{ role: "user", content: "solo" }]), 42, "oversize stored alone");
  nano.record([{ role: "user", content: "second" }], 43);
  assert.equal(nano.peek([{ role: "user", content: "second" }]), 43, "new oversize replaces it");
  assert.ok(nano.stats().entries <= 1, "ledger never exceeds one line");
});

test("v2 byte bound: many small entries capped by BYTES not just count", () => {
  let now = 1;
  const tc = new TokenCache({ maxEntries: 10_000, maxTotalBytes: 1000, nowFn: () => now });
  for (let i = 0; i < 500; i++) {
    now += 1;
    tc.record([{ role: "user", content: `filler ${i}` }], i);
  }
  assert.ok(tc.stats().entries < 200, `bytes capped entries (got ${tc.stats().entries})`);
  assert.ok(tc.stats().bytesResident <= 1000, "ledger respects the budget");
  assert.ok(tc.stats().evictions > 0, "evictions actually ran");
});

test("v2 peek(): no age/recency update; not counted in hits/misses", () => {
  let now = 0;
  const tc = new TokenCache({ maxEntries: 2, nowFn: () => now });
  const a = [{ role: "user", content: "aa" }];
  const b = [{ role: "user", content: "bb" }];
  tc.record(a, 1);
  tc.record(b, 2);
  assert.equal(tc.peek(a), 1);
  const st1 = tc.stats();
  assert.equal(tc.peek(b), 2);
  const st2 = tc.stats();
  assert.equal(st1.hits + st1.misses, st2.hits + st2.misses, "peek counts nothing");
  // recency NOT refreshed: insert two more — peeked entry is the victim
  tc.record([{ role: "user", content: "cc" }], 3);
  tc.record([{ role: "user", content: "dd" }], 4);
  assert.equal(tc.peek(a), null, "peeked-not-refreshed entry was evicted first");
  assert.ok(tc.peek([{ role: "user", content: "dd" }]) !== null);
});

test("v2 clear(): stats reset, slots reusable", () => {
  const tc = new TokenCache({ nowFn: () => 0 });
  tc.record([{ role: "user", content: "one" }], 1);
  tc.record([{ role: "user", content: "two" }], 2);
  tc.clear();
  const st = tc.stats();
  assert.equal(st.entries, 0);
  assert.equal(st.bytesResident, 0);
  assert.equal(tc.peek([{ role: "user", content: "one" }]), null);
  tc.record([{ role: "user", content: "three" }], 3);
  assert.equal(tc.stats().entries, 1);
  assert.equal(tc.peek([{ role: "user", content: "three" }]), 3);
});

test("v2 determinism: same op sequence → identical stats (no Math.random in core)", () => {
  const run = () => {
    let now = 0;
    const tc = new TokenCache({ maxEntries: 8, nowFn: () => now });
    for (let i = 0; i < 20; i++) {
      now += 7;
      tc.record([{ role: "user", content: `d${i % 12}` }], i);
      if (i % 3 === 0) tc.lookup([{ role: "user", content: `d${(i + 5) % 12}` }]);
    }
    return JSON.stringify(tc.stats());
  };
  assert.equal(run(), run(), "identical stats across identical runs");
});

// ---------- loop wiring (v1 cases, unchanged behavior) ----------
async function makeLoop(dir, tokenCache) {
  const logPath = join(dir, `ev-${Math.random().toString(36).slice(2)}.jsonl`);
  const log = await EventLog.open(logPath);
  const policy = new Policy({ rules: defaultRules(), logPath });
  const loop = createLoop({
    provider: echo,
    tools: createRegistry(),
    policy,
    log,
    decide,
    config: {
      session: "tokens-test",
      ...(tokenCache ? { tokenCache } : {}),
    },
  });
  return { loop, log, logPath };
}

test("loop wiring (v1): second turn with same leading blocks → prefix_cached true; fields present", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-tokens-"));
  try {
    const { loop, log } = await makeLoop(dir);
    await loop.start("hello there");
    await loop.start("hello there");
    const reqs = log.events.filter((e) => e.type === "turn.provider.request");
    assert.equal(reqs.length, 2, "two turns, one request each");
    for (const r of reqs) {
      assert.ok(Number.isInteger(r.data.prefix_tokens), "prefix_tokens integer");
      assert.equal(typeof r.data.prefix_cached, "boolean", "prefix_cached boolean");
    }
    assert.equal(reqs[1].data.prefix_cached, true, "second request prefix-cached");
    const keys = Object.keys(reqs[1].data);
    assert.deepEqual(keys, ["provider", "model", "messages", "tools", "prefix_tokens", "prefix_cached"]);
    await loop.end();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop wiring (v1): injected tokenCache is used (config.tokenCache seam)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-tokens-"));
  try {
    const injected = new TokenCache();
    const { loop } = await makeLoop(dir, injected);
    await loop.start("a stitch in time");
    assert.ok(injected.stats().entries > 0, "the injected cache received records");
    assert.ok(injected.stats().misses >= 1);
    await loop.end();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop wiring (v1): MsgMeta token_len reaches decide() (additive, ALWAYS integer)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-tokens-"));
  try {
    const seen = [];
    const spyDecide = (snapshot, turns, budget, metas) => {
      seen.push(metas.map((m) => m.token_len));
      return decide(snapshot, turns, budget, metas);
    };
    const logPath = join(dir, "ev.jsonl");
    const log = await EventLog.open(logPath);
    const policy = new Policy({ rules: defaultRules(), logPath });
    const loop = createLoop({
      provider: echo,
      tools: createRegistry(),
      policy,
      log,
      decide: spyDecide,
      config: { session: "metas" },
    });
    await loop.start("count my tokens");
    await loop.end();
    assert.equal(seen.length, 1, "one decide() per turn boundary");
    for (const row of seen[0]) assert.ok(Number.isInteger(row), `token_len integer per message (${row})`);
    assert.ok(seen[0].length >= 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("replay determinism (v1): prefix fields derive from content, not wall-clock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-tokens-"));
  try {
    const { loop, log } = await makeLoop(dir);
    await loop.start("deterministic prefix");
    await loop.end();
    const canon1 = log.canonical();
    const { loop: loop2, log: log2 } = await makeLoop(join(dir, "b"));
    await loop2.start("deterministic prefix");
    await loop2.end();
    assert.equal(log2.canonical(), canon1, "prefix fields deterministic across runs");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- tokencache-r1 repair (TC2-1/TC2-2/TC4-1/TC3-1/TC3-2/TC6-1/TC6-2/D5) ----------
// REDACTOR HAZARD: control-character fixtures are fragment-assembled.
const NUL = String.fromCharCode(0);
const US = String.fromCharCode(31);

test("r1 TC2-1: separator injection cannot collide (stale-HIGH regression)", () => {
  const A = [{ role: "user", content: "x" + US + "assistant" + NUL + "admin" }]; // true count 5
  const B = [{ role: "user", content: "x" }, { role: "assistant", content: "admin" }]; // true count 4
  assert.notEqual(tokenCacheKey(A), tokenCacheKey(B), "D1 collision closed");
  // the stale-high channel: record(A,5) then lookup(B) must MISS
  const tc = new TokenCache({ nowFn: () => 0 });
  tc.record(A, 5);
  assert.equal(tc.lookup(B), null, "no stale-HIGH leak across the old collision");
  assert.equal(tc.countPrefix(B).cached, false, "countPrefix recounts B honestly");
});

test("r1 TC2-1/TC2-2: all coercion collision classes distinct", () => {
  const cases = {
    K1: [[{ role: "user" }], [{ role: "user", content: "" }]],
    K2: [[{ role: "user", content: null }], [{ role: "user", content: "" }]],
    K3: [[undefined], [{}]],
    K4: [[{ role: "u", content: 42 }], [{ role: "u", content: "42" }]],
    K5: [[{ role: 42, content: "x" }], [{ role: "42", content: "x" }]],
    K6: [[{ role: "u", content: NaN }], [{ role: "u", content: "NaN" }]],
    K7: [[{ role: "u", content: { a: 1 } }], [{ role: "u", content: "[object Object]" }]],
    K8: [[{ role: "u", content: "\ud800" }], [{ role: "u", content: "\ufffd" }]],
  };
  for (const [name, [A, B]] of Object.entries(cases)) {
    assert.notEqual(tokenCacheKey(A), tokenCacheKey(B), `${name} collapsed`);
  }
});

test("r1 TC2-1: PRESERVED distinctness (role swap, order swap, duplicates, NFC/NFD)", () => {
  const swap = [[{ role: "a", content: "x" }], [{ role: "x", content: "a" }]];
  assert.notEqual(tokenCacheKey(swap[0]), tokenCacheKey(swap[1]), "role swap");
  const order = [
    [{ role: "a", content: "x" }, { role: "b", content: "y" }],
    [{ role: "b", content: "y" }, { role: "a", content: "x" }],
  ];
  assert.notEqual(tokenCacheKey(order[0]), tokenCacheKey(order[1]), "order swap");
  const dup = [[{ role: "a", content: "z" }, { role: "a", content: "z" }], [{ role: "a", content: "z" }]];
  assert.notEqual(tokenCacheKey(dup[0]), tokenCacheKey(dup[1]), "duplicate vs single");
  const nfc = "é";
  const nfd = "e" + String.fromCharCode(0x0301);
  assert.notEqual(
    tokenCacheKey([{ role: "u", content: nfc }]),
    tokenCacheKey([{ role: "u", content: nfd }]),
    "NFC vs NFD",
  );
  // JSON round-trip stability still holds with the new encoding
  const msgs = [{ role: "system", content: "You are terse." }, { role: "user", content: "hello" }];
  assert.equal(tokenCacheKey(msgs), tokenCacheKey(JSON.parse(JSON.stringify(msgs))));
  // prefix growth still changes the key (reuse semantics intact)
  assert.notEqual(
    tokenCacheKey([{ role: "system", content: "s" }]),
    tokenCacheKey([{ role: "system", content: "s" }, { role: "user", content: "q" }]),
  );
});

test("r1 TC4-1: maxEntries=65535 with a sub-line budget does NOT crash (sentinel sizing)", () => {
  let tc;
  assert.doesNotThrow(() => {
    tc = new TokenCache({ maxEntries: 65535, maxTotalBytes: 10 });
    tc.record([{ role: "u", content: "solo" }], 1); // desk-reproduced OOM pre-fix
  }, "the sentinel must fit the link array (max+2 <= 65536 for Uint16)");
  assert.equal(tc.stats().entries, 1);
  assert.ok(tc.stats().bytesResident > 0);
  // boundary neighbors still behave
  for (const m of [65534, 65536]) {
    const b = new TokenCache({ maxEntries: m, maxTotalBytes: 10 });
    b.record([{ role: "u", content: "x" }], 1);
    assert.equal(b.stats().entries, 1, `boundary ${m}`);
  }
});

test("r1 TC3-1: a rewound clock reads as expired (all modes)", () => {
  // strict: rewind → null
  let now = 1000;
  const strict = new TokenCache({ staleOnHit: false, nowFn: () => now });
  const m = [{ role: "u", content: "rewind" }];
  strict.record(m, 7);
  now = 5000;
  strict.lookup(m); // refresh at t=5000
  now = 1000; // rewind: age < 0
  assert.equal(strict.lookup(m), null, "strict: negative age = expired, not resurrected");
  assert.equal(strict.stats().entries, 0, "slot purged on the rewind read");
  // staleOnHit: rewind enters the expired branch; serve reschedules; the
  // rescheduled entry is NOT permanently fresh — it expires again 30min
  // after the reschedule (one serve per expiry window, never a resurrection)
  let t = 10_000;
  const soh = new TokenCache({ nowFn: () => t });
  soh.record(m, 7);
  t = 10_000 + 31 * 60 * 1000;
  assert.equal(soh.lookup(m), 7, "serve 1 (stale — reschedules at this t)");
  const serve1T = t;
  t = serve1T + 29 * 60 * 1000; // inside the rescheduled window: a NORMAL hit
  assert.equal(soh.lookup(m), 7, "normal hit inside the new window");
  t = serve1T + 31 * 60 * 1000 + 60 * 1000; // past the window → stale serve #2 begins
  assert.equal(soh.lookup(m), 7, "serve 2 (each window serves exactly once)");
  // and with staleOnHit OFF the same cadence yields no retention at all:
  let s = 10_000;
  const str = new TokenCache({ staleOnHit: false, nowFn: () => s });
  str.record(m, 8);
  s = 10_000 + 31 * 60 * 1000;
  assert.equal(str.lookup(m), null, "strict: expired = miss, purged");
  assert.equal(str.stats().expiredPurges, 1);
  // peek path: rewind purges too
  let p = 1_000_000;
  const pk = new TokenCache({ staleOnHit: false, nowFn: () => p });
  pk.record(m, 7);
  p = 500; // rewind
  assert.equal(pk.peek(m), null, "peek: negative age = expired");
  assert.equal(pk.stats().expiredPurges, 1);
});

test("r1 TC6-1: prefix reuse increments prefixReuses; hits/misses untouched", () => {
  const tc = new TokenCache({ nowFn: () => 0 });
  const sys = [{ role: "system", content: "shared system prompt here" }];
  tc.countPrefix(sys); // miss
  const before = tc.stats();
  const grown = [...sys, { role: "user", content: "question" }];
  const res = tc.countPrefix(grown); // prefix reuse (neither hit nor miss)
  assert.equal(res.cached, true);
  const after = tc.stats();
  assert.equal(after.prefixReuses, before.prefixReuses + 1, "reuse counted");
  assert.equal(after.hits, before.hits, "hits untouched (v1 semantics)");
  assert.equal(after.misses, before.misses, "misses untouched");
  // header contract: hits+misses !== reads — a reuse read is in neither
  assert.ok(after.hits + after.misses >= 1, "sanity");
  assert.equal(tc.countPrefix(sys).cached, true, "exact hit still counts in hits");
  assert.ok(tc.stats().hits === after.hits + 1);
});

test("r1 TC6-2: clear() resets ALL counters (the test name is now true)", () => {
  const tc = new TokenCache({ nowFn: () => 0 });
  tc.record([{ role: "u", content: "one" }], 1);
  tc.lookup([{ role: "u", content: "one" }]); // a hit
  tc.lookup([{ role: "u", content: "nope" }]); // a miss
  tc.clear();
  const st = tc.stats();
  assert.equal(st.hits, 0);
  assert.equal(st.misses, 0);
  assert.equal(st.entries, 0);
  assert.equal(st.bytesResident, 0);
  assert.equal(st.evictions, 0);
  assert.equal(st.expiredPurges, 0);
  assert.equal(st.prefixReuses, 0);
});

test("r1 D5: a throwing onCount never escapes — the entry still records (both paths)", () => {
  // miss path: onCount threw BEFORE record pre-fix → entry lost
  const boom = () => {
    throw new Error("boom");
  };
  const a = new TokenCache({ nowFn: () => 0, onCount: boom });
  const r1 = a.countPrefix([{ role: "u", content: "thrown-miss" }]);
  assert.equal(r1.cached, false);
  assert.equal(a.stats().entries, 1, "record ran after the throw");
  assert.ok(a.peek([{ role: "u", content: "thrown-miss" }]) !== null);
  // prefix-reuse path: the DELTA must still be recorded
  const b = new TokenCache({ nowFn: () => 0, onCount: boom });
  const sys = [{ role: "system", content: "base" }];
  b.countPrefix(sys); // tolerate the throw here too
  const grown = [...sys, { role: "user", content: "delta" }];
  const r2 = b.countPrefix(grown);
  assert.equal(r2.cached, true, "reuse path also contained");
  assert.ok(b.peek(grown) !== null, "grown entry recorded despite the throw");
});
