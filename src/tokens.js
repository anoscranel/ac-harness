// src/tokens.js — token cache v2: deterministic local token counting + a
// PREFIX TOKEN CACHE rebuilt on established OSS mechanisms (study-only, zero
// code copied): integer-index O(1) LRU in the design of isaacs/node-lru-cache
// v7 (fixed #keys/#vals arrays sized max, #next/#prev TYPED arrays —
// Uint16Array for max<=65535 else Uint32Array, free-index stack, head/tail
// sentinels), @isaacs/ttlcache-style LAZY TTL with read-purge (no timers, no
// background sweeps — matches the no-background-process posture), and
// lru-cache's maxSize idea as a byte bound. Pure-Node from scratch, zero
// npm deps. The hashlru two-generation structure was evaluated and SKIPPED —
// see deviations: the linked-list core already gives strict LRU at the same
// constant cost, so a second generation adds code without adding behavior.
//
// Why prefix-keyed (unchanged from v1): the hottest agent pattern is the
// same system prompt with a growing history. Blocks are hashed IN ORDER; a
// lookup with more trailing messages but identical leading blocks reuses
// the recorded prefix count and counts only the delta.
//
// staleOnHit policy — DEFAULT TRUE for this cache, deliberately: an expired
// entry is served ONCE (its token count still lower-bounds the true count —
// text does not shrink — so budgets stay conservative) while being
// rescheduled with a fresh expiry; the next read finds it alive again. If a
// caller wants strict freshness, { staleOnHit: false } turns reads into
// misses at expiry (slot freed).
//
// Interface is v1-compatible: same class TokenCache, same
// countPrefix/lookup/record/stats signatures; new ADDITIVE members peek(),
// clear(), options {maxEntries, ttlMs, maxTotalBytes, staleOnHit}, and
// stats() gains evictions/expiredPurges/bytesResident. estimateTokens and
// tokenCacheKey are UNCHANGED (v1 semantics pinned by tests).

import { createHash } from "node:crypto";

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MAX_TOTAL_BYTES = 4 * 1024 * 1024; // 4 MiB

/**
 * estimateTokens — deterministic approximation (v1, unchanged):
 *   ASCII-word heuristic: ceil(wordCount * 1.3) + punctuation * 0.8, bumped
 *   +30% on fenced-code/indent blocks; final value NEVER below ceil(chars/4)
 *   (the pre-existing chars/4 floor — budgeting stays conservative) and
 *   always a finite integer >= 0.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  const t = typeof text === "string" ? text : String(text ?? "");
  if (t === "") return 0;
  const words = t.split(/\s+/).filter(Boolean).length;
  const punct = (t.match(/[.,;:!?"'()[\]{}<>…\-–—/\\|@#$%^&*+=~`]/g) ?? []).length;
  let n = Math.ceil(words * 1.3) + punct * 0.8;
  // code-aware bump: fenced blocks or heavily indented lines read denser
  if (/```/.test(t) || /(^|\n)([ \t]{4,})\S/.test(t)) n *= 1.3;
  n = Math.ceil(n);
  const floor = Math.ceil(t.length / 4); // never below the chars/4 estimate
  if (n < floor) n = floor;
  if (!Number.isFinite(n) || n < 0) n = 0; // NaN/Infinity guard
  return n;
}

/**
 * tokenCacheKey — sha256 over the CONCATENATED serialized prefix blocks:
 * each block is role + "\x00" + content, blocks joined with "\x1f". Stable
 * under compaction re-expansion: identical text produces an identical key.
 * (v1, unchanged.)
 * @param {Array<{role:string, content:string}>} messages
 * @returns {string} hex sha256
 */
/**
 * tokenCacheKey — sha256 over the serialized prefix blocks (tokencache-r1
 * TC2-1/TC2-2): each message encodes as JSON.stringify([role ?? null,
 * content ?? null]) — or JSON.stringify(m ?? null) when the SLOT itself is
 * undefined/null — followed by a NUL terminator. JSON escapes every char
 * below 0x20, so content can never forge a block boundary (the separator
 * injection collision class); distinct JS types (null vs "" vs 42 vs "42"
 * vs {a:1} vs "[object Object]") stay distinct because no lossy String()
 * coercion runs first. Same text = same key — stable under resume/compaction
 * re-expansion. Key format changed in r1; in-memory entries orphan per
 * process (the cache is not persisted — no migration).
 * @param {Array<{role:string, content:string}>} messages
 * @returns {string} hex sha256
 */
export function tokenCacheKey(messages) {
  const h = createHash("sha256");
  for (const m of Array.isArray(messages) ? messages : []) {
    // TC2-2: an undefined/null message slot is its own shape (distinct from
    // a present-but-empty message); every field keeps its JS type.
    h.update(JSON.stringify(m === undefined || m === null ? null : [m?.role ?? null, m?.content ?? null]));
    h.update("\x00");
  }
  return h.digest("hex");
}

/** Byte cost of one cache line: key bytes + JSON value bytes (lru-cache
 *  maxSize idea). JSON-serializing a {tokens, at} object is 2 tiny numbers —
 *  deterministic, never large; keys are fixed-size 64-char hex. */
function lineBytes(key, tokens, at) {
  return Buffer.byteLength(key, "utf8") + Buffer.byteLength(JSON.stringify({ tokens, at }), "utf8");
}

/**
 * TokenCache v2 — integer-index O(1) LRU + lazy TTL + byte bound.
 *
 * Storage layout (lru-cache v7 design, our naming, ~40 lines of core):
 *   #keyToIdx   Map<key, idx>            — O(1) key → slot
 *   #keys[]     string[]  size max       — slot keys
 *   #vals[]     number[]  size max       — token counts
 *   #times[]    number[]  size max       — last-touch (lazy TTL clock)
 *   #next/#prev TYPED arrays size max+2  — intrusive doubly-linked list over
 *                slots with HEAD=old tail=NEW sentinels at [max], [max+1]
 *   #free       number[]                — free-slot stack
 *   HEAD ← ... → TAIL: recency order, head = least-recent (evict here).
 *
 * Core ops all O(1): alloc() pops the free stack or steals the list head;
 * unlink(i)/moveToHead(i) are two pointer writes each; no Map.delete in the
 * hit path and no per-hit object allocation.
 */
export class TokenCache {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxEntries=256]
   * @param {number} [opts.ttlMs=30min]
   * @param {number} [opts.maxTotalBytes=4MiB] entry cost = key + JSON val bytes
   * @param {boolean} [opts.staleOnHit=true] serve an expired entry ONCE while
   *        rescheduling (token counts lower-bound the true count — safe here)
   * @param {() => number} [opts.nowFn=Date.now]
   * @param {(messages:Array, tokens:number) => void} [opts.onCount]
   */
  constructor({
    maxEntries = DEFAULT_MAX_ENTRIES,
    ttlMs = DEFAULT_TTL_MS,
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
    staleOnHit = true,
    nowFn = Date.now,
    onCount = null,
  } = {}) {
    const max = Math.max(1, Math.floor(Number.isFinite(maxEntries) ? maxEntries : DEFAULT_MAX_ENTRIES));
    this.maxEntries = max;
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS;
    this.maxTotalBytes = Number.isFinite(maxTotalBytes) && maxTotalBytes > 0 ? maxTotalBytes : DEFAULT_MAX_TOTAL_BYTES;
    this.staleOnHit = staleOnHit !== false; // v2 default ON (see header note)
    this.nowFn = nowFn;
    this.onCount = typeof onCount === "function" ? onCount : null;

    // datas: max slots; links: max slots + 2 sentinels (HEAD=old, TAIL=new)
    this.#keys = new Array(max).fill(undefined);
    this.#vals = new Array(max).fill(0);
    this.#times = new Array(max).fill(0);
    this.#bytes = new Array(max).fill(0);
    // tokencache-r1 TC4-1: size the link arrays for the SENTINELS — TAIL
    // (max+1) is written into the array, so the Uint16 window must cover
    // max+2 slots; at max=65535 the old `max <= 65535` bound aliased TAIL
    // onto slot 0 and the sub-line-budget loop crashed (OOM via free-stack
    // runaway — worse than a RangeError).
    const LinkArr = max + 2 <= 65_536 ? Uint16Array : Uint32Array;
    this.#next = new LinkArr(max + 2);
    this.#prev = new LinkArr(max + 2);
    this.HEAD = max; // sentinel slot: least-recent side
    this.TAIL = max + 1; // sentinel slot: most-recent side
    // empty list: HEAD ↔ TAIL
    this.#next[this.HEAD] = this.TAIL;
    this.#prev[this.TAIL] = this.HEAD;
    this.#keyToIdx = new Map();
    this.#free = [];
    for (let i = max - 1; i >= 0; i--) {
      this.#next[i] = i; // self-link = "not in list" (prevents zero/zero
      this.#prev[i] = i; //  self-writes if unlink ever sees a free slot)
      this.#free.push(i); // LIFO alloc
    }

    this.hits = 0;
    this.misses = 0;
    this.#prefixReuses = 0; // TC6-1: prefix-reuse reads (separate from hits/misses)
    this.#evictions = 0;
    this.#expiredPurges = 0;
    this.#bytesResident = 0;
  }

  #keys;
  #vals;
  #times;
  #bytes;
  #next;
  #prev;
  #keyToIdx;
  #free;
  #prefixReuses;
  #evictions;
  #expiredPurges;
  #bytesResident;
  // HEAD/TAIL are public-const sentinels (defensive clarity, not secret)

  /** link(i): insert slot i at the MOST-recent end WITHOUT unlinking —
   *  for slots that are freshly allocated (never linked) or were just
   *  unlinked by their caller. Assumes i is NOT currently in the list. */
  #link(i) {
    const last = this.#prev[this.TAIL];
    this.#next[i] = this.TAIL;
    this.#prev[i] = last;
    this.#next[last] = i;
    this.#prev[this.TAIL] = i;
  }

  /** unlink(i): remove slot i from the recency list (two writes + ends).
   *  Called ONLY on slots that are linked (#link/record/refresh guarantee). */
  #unlink(i) {
    const n = this.#next[i];
    const p = this.#prev[i];
    this.#next[p] = n;
    this.#prev[n] = p;
    // defensive: clear the slot's own links so a stale unlink cannot
    // self-write through zero-initialized typed-array values (slot 0's
    // zero/zero pair would otherwise make next[p]=n with p===i===n===0).
    this.#next[i] = i;
    this.#prev[i] = i;
  }

  /** moveToTail(i): refresh recency — splice out (linked slots only), insert
   *  at the MOST-recent end. Every served entry (alive hit or a stale-on-hit
   *  serve) lands here: it was just used, so it is most recent. The eviction
   *  edge is the HEAD side (#next[HEAD]). */
  #moveToTail(i) {
    this.#unlink(i);
    this.#link(i);
  }

  /** alloc(): claim a slot — free stack first, else steal the HEAD side
   *  (#next[HEAD] = least-recent live slot).
   *  A number[] free stack pop + typed-array splice — zero Map churn. */
  #alloc() {
    if (this.#free.length > 0) {
      const i = this.#free.pop();
      return i;
    }
    const victim = this.#next[this.HEAD]; // least-recent live slot
    if (victim === this.TAIL) return -1; // impossible at max>0 with entries<=max
    this.#drop(victim, "evict");
    // #drop() recycled the victim's index onto the free stack — this steal
    // path USES the slot immediately, so reclaim it or the next alloc would
    // double-allocate a live slot (corruption: orphan keys, size > max).
    this.#free.pop();
    return victim;
  }

  /** drop(i, why): free slot i (list + map + free stack + byte ledger). */
  #drop(i, why) {
    const k = this.#keys[i];
    this.#unlink(i);
    this.#keyToIdx.delete(k);
    this.#keys[i] = undefined;
    this.#bytesResident -= this.#bytes[i];
    this.#bytes[i] = 0;
    this.#free.push(i);
    if (why === "evict") this.#evictions += 1;
    else if (why === "expired") this.#expiredPurges += 1;
  }

  /** Byte-budget guard: evict least-recent entries until the ledger fits. */
  #makeRoomFor(cost) {
    while (this.#bytesResident + cost > this.maxTotalBytes) {
      const victim = this.#next[this.HEAD];
      if (victim === this.TAIL) break; // nothing live: oversize goes in alone
      this.#drop(victim, "evict");
    }
  }

  /**
   * Raw get path (used by lookup/peek/countPrefix). Does NOT count stats.
   * Returns {tokens} and refreshes recency + TTL, or null.
   * staleOnHit=true: an expired entry is served ONCE and rescheduled.
   */
  #getFresh(key) {
    const i = this.#keyToIdx.get(key);
    if (i === undefined) return null;
    const now = this.nowFn();
    // tokencache-r1 TC3-1: a NEGATIVE age (rewound clock) must read as
    // expired, not resurrect freshness.
    const age = now - this.#times[i];
    if (age > this.ttlMs || age < 0) {
      if (this.staleOnHit) {
        this.#times[i] = now; // serve stale once + reschedule
        this.#moveToTail(i); // TC3-2: PROMOTE recency — it was just served
        return { tokens: this.#vals[i] };
      }
      this.#drop(i, "expired"); // strict freshness: read-purge, then miss
      return null;
    }
    this.#times[i] = now; // v1 semantics: a hit refreshes the TTL clock
    this.#moveToTail(i);
    return { tokens: this.#vals[i] };
  }

  /** Raw no-touch get (peek): expires-read-purge applies, age untouched. */
  #getPeek(key) {
    const i = this.#keyToIdx.get(key);
    if (i === undefined) return null;
    const age = this.nowFn() - this.#times[i];
    if (age > this.ttlMs || age < 0) { // TC3-1: rewind = expired
      this.#drop(i, "expired"); // lazy read-purge even on peek
      return null;
    }
    return { tokens: this.#vals[i] };
  }

  /**
   * lookup(messages) — exact-match read with hit/miss stats (v1 contract).
   * Refreshes recency + TTL on hit.
   * @returns {number|null}
   */
  lookup(messages) {
    const key = tokenCacheKey(Array.isArray(messages) ? messages : []);
    const got = this.#getFresh(key);
    if (got === null) {
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    return got.tokens;
  }

  /**
   * peek(messages) — NEW v2: read WITHOUT touching recency or age (and
   * without hit/miss stats). Expired entries are lazily purged on read.
   * @returns {number|null}
   */
  peek(messages) {
    const key = tokenCacheKey(Array.isArray(messages) ? messages : []);
    const got = this.#getPeek(key);
    return got === null ? null : got.tokens;
  }

  /**
   * Longest-match prefix read (internal for countPrefix): walks n from
   * list.length down to 1, returns the longest alive {tokens, n}.
   */
  #lookupLongestAlive(messages) {
    for (let n = messages.length; n > 0; n--) {
      const key = tokenCacheKey(messages.slice(0, n));
      const i = this.#keyToIdx.get(key);
      if (i === undefined) continue;
      const now = this.nowFn();
      const age = now - this.#times[i];
      if (age > this.ttlMs || age < 0) { // TC3-1: rewind = expired
        if (this.staleOnHit) {
          this.#times[i] = now;
          this.#moveToTail(i);
          this.#prefixReuses += 1;
          return { tokens: this.#vals[i], n };
        }
        this.#drop(i, "expired");
        continue; // strict: keep scanning shorter prefixes
      }
      this.#times[i] = now; // v1 semantics: a hit refreshes the TTL clock
      this.#moveToTail(i);
      this.#prefixReuses += 1;
      return { tokens: this.#vals[i], n };
    }
    return null;
  }

  /**
   * record(messages, tokens) — write/overwrite the FULL list's count.
   * O(1) core + byte-budget eviction of least-recent entries until fit.
   * An oversize single entry is stored ALONE (guard clears everything else).
   */
  record(messages, tokens) {
    const list = Array.isArray(messages) ? messages : [];
    const key = tokenCacheKey(list);
    const now = this.nowFn();
    const t = Number.isFinite(tokens) ? tokens : 0;
    const cost = lineBytes(key, t, now);

    const existing = this.#keyToIdx.get(key);
    if (existing !== undefined) {
      // overwrite in place: keep the slot, refresh value/age/recency
      this.#bytesResident -= this.#bytes[existing];
      this.#vals[existing] = t;
      this.#times[existing] = now;
      this.#bytes[existing] = cost;
      this.#bytesResident += cost;
      this.#moveToTail(existing);
      this.#makeRoomFor(0); // an overwrite can GROW the line → rebudget
      return t;
    }

    const i = this.#alloc();
    // alloc cannot fail at entries<=max (free stack or head steal) — but a
    // byte-budget edge could leave an empty list with an oversize line; the
    // slot is still claimable here because free was refilled by #drop.
    if (i === -1) return t; // unreachable in practice; safe no-op
    this.#makeRoomFor(cost);
    this.#keys[i] = key;
    this.#vals[i] = t;
    this.#times[i] = now;
    this.#bytes[i] = cost;
    this.#bytesResident += cost;
    this.#keyToIdx.set(key, i);
    this.#link(i);
    return t;
  }

  /**
   * countPrefix(messages) — the loop's entry point (v1 contract).
   * Full hit → reuse (cached:true). Prefix hit (same leading blocks, more
   * trailing) → reuse + count ONLY the delta. Miss → count all, record.
   * @returns {{tokens:number, cached:boolean}}
   */
  countPrefix(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const exact = this.#getFresh(tokenCacheKey(list));
    if (exact !== null) {
      this.hits += 1;
      return { tokens: exact.tokens, cached: true };
    }

    const longest = this.#lookupLongestAlive(list);
    if (longest !== null) {
      let delta = 0;
      for (let i = longest.n; i < list.length; i++) {
        delta += estimateTokens(list[i]?.content ?? "");
      }
      const total = longest.tokens + delta;
      if (this.onCount) {
        try {
          this.onCount(list, delta); // D5: diagnostic hook — contain throws
        } catch {
          /* swallowed; recording below is the real work */
        }
      }
      this.record(list, total);
      return { tokens: total, cached: true };
    }

    let all = 0;
    for (const m of list) all += estimateTokens(m?.content ?? "");
    this.misses += 1;
    if (this.onCount) {
      try {
        this.onCount(list, all); // D5: contain throws — record MUST still run
      } catch {
        /* swallowed; recording below is the real work */
      }
    }
    this.record(list, all);
    return { tokens: all, cached: false };
  }

  /** clear() — NEW v2: drop everything (ledger + list + free stack reset).
   *  Every slot's own links are set to the SELF state so a stray unlink on a
   *  free slot can never self-write through the sentinel pair. */
  clear() {
    this.#keyToIdx.clear();
    this.#keys.fill(undefined);
    this.#bytes.fill(0);
    this.#free.length = 0;
    for (let i = this.maxEntries - 1; i >= 0; i--) {
      this.#next[i] = i;
      this.#prev[i] = i;
      this.#free.push(i);
    }
    this.#next[this.HEAD] = this.TAIL;
    this.#prev[this.TAIL] = this.HEAD;
    this.#bytesResident = 0;
    // TC6-2: clear() resets the counters too ("stats reset" must mean stats).
    this.hits = 0;
    this.misses = 0;
    this.#prefixReuses = 0;
    this.#evictions = 0;
    this.#expiredPurges = 0;
  }

  /**
   * stats() — v1 {hits, misses, entries} + v2 additive:
   * evictions (LRU steals + byte-bound drops), expiredPurges (read-purges),
   * bytesResident (the byte ledger).
   */
  stats() {
    return {
      hits: this.hits,
      misses: this.misses,
      entries: this.#keyToIdx.size,
      prefixReuses: this.#prefixReuses, // TC6-1: a reuse hits NEITHER hits NOR misses
      evictions: this.#evictions,
      expiredPurges: this.#expiredPurges,
      bytesResident: this.#bytesResident,
    };
  }
}

export default { estimateTokens, tokenCacheKey, TokenCache };
