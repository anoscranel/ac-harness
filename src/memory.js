// src/memory.js — durable, file-backed recall across sessions.
//
// WHY THIS EXISTS
// The harness has an event log per session and nothing across sessions. Every
// run starts blank: the same facts are re-derived, the same mistakes repeated.
// Feature parity target: Hermes' memory plugin (MIT, design only; original JS).
//
// DESIGN — deliberately not a vector store.
// The doctrine's own evidence (LongMemEval, cited in REPORT-agent-desk-doctrine
// §4 row 22) finds long-context retrieval drops 30-60% on knowledge-update
// questions, and that files + git beat vector/KG memory at desk scale. So this
// is an append-only JSONL of atomic observations with a scope, a timestamp and
// a supersede pointer — greppable, diffable, and correct under update.
//
// Atomicity is the rule: one fact per record. A record that contradicts an
// older one supersedes it rather than living beside it, because stale memory is
// worse than none.

import { mkdir, readFile, appendFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { redact } from "./events.js"; // v0.7.0 A3: same redaction as the event log

export const DEFAULT_PATH = join(
  process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
  "ac-harness",
  "memory.jsonl",
);

const id = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);

// v0.7.0 A2/A3 (audit-pending-v070): documented growth bounds.
// MAX_RECORDS: the live file keeps at most this many records; past it the
// OLDEST tail ROTATES into <path>.1 (moved aside, never silently deleted).
// MAX_RECORD_BYTES caps ONE record's text on RECALL (A5): an oversized
// observation cannot become an unbounded provider payload (explicit marker).
export const MAX_RECORDS = 5_000;
export const MAX_RECORD_BYTES = 4_096;
const TRUNCATION_MARKER = " \u2026[record truncated at 4096 bytes; re-read from the memory file if needed]";

export class Memory {
  constructor({ path = DEFAULT_PATH, scope = "global" } = {}) {
    this.path = path;
    this.scope = scope;
    this._cache = null;
  }

  async #read() {
    if (this._cache) return this._cache;
    let raw = "";
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      this._cache = [];
      return this._cache;
    }
    const out = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        // a torn final line from a killed write is skipped, not fatal
      }
    }
    this._cache = out;
    return out;
  }

  /**
   * Record one atomic fact.
   * @param {string} text  one fact, present tense, no conjunctions
   * @param {{scope?:string, supersedes?:string|string[], tags?:string[]}} [opts]
   * @returns {Promise<{id:string, superseded:string[]}>}
   */
  async remember(text, { scope = this.scope, supersedes = null, tags = [] } = {}) {
    const rec = {
      id: id(`${Date.now()}:${text}:${Math.random()}`),
      at: new Date().toISOString(),
      scope,
      text,
      tags,
      supersedes: supersedes ? [].concat(supersedes) : [],
    };
    await mkdir(dirname(this.path), { recursive: true });
    // one line, one write: append is atomic enough at this size and never
    // rewrites history (the file is the audit trail)
    // v0.7.0 A2 (audit-pending-v070): memory persists ACROSS sessions and
    // outlives the event log — the same redact() the event log uses runs
    // over the record BEFORE the append (one implementation, never a copy).
    const safe = redact(rec);
    await appendFile(this.path, JSON.stringify(safe) + "\n", "utf8");
    // v0.7.0 A3: cap + rotate — the oldest tail moves to <path>.1 (a
    // rotated sibling file, never deleted); the live file keeps the newest.
    await this.#rotateIfNeeded();
    this._cache = null;
    return { id: safe.id, superseded: safe.superseded };
  }

  /** Live records: everything not superseded by a later record. */
  async all() {
    const recs = await this.#read();
    const dead = new Set();
    for (const r of recs) for (const s of r.supersedes || []) dead.add(s);
    return recs.filter((r) => !dead.has(r.id));
  }

  /**
   * Recall by substring, scope and tag. Deliberately dumb: substring beats
   * embedding search for a corpus that fits in memory and must stay auditable.
   * @returns {Promise<Array<{id:string, at:string, text:string, scope:string}>>}
   */
  async recall(query = "", { scope = null, tag = null, limit = 20, includeSuperseded = false } = {}) {
    const recs = includeSuperseded ? await this.#read() : await this.all();
    const q = query.toLowerCase();
    const hits = recs
      .filter((r) => (scope ? r.scope === scope : true))
      .filter((r) => (tag ? (r.tags || []).includes(tag) : true))
      .filter((r) => (q ? r.text.toLowerCase().includes(q) : true))
      .slice(-limit);
    // v0.7.0 A5 (audit-pending-v070): per-record byte cap on the way OUT —
    // one oversized observation cannot become an unbounded provider payload.
    return hits.map((r) => {
      const b = Buffer.byteLength(r.text ?? "", "utf8");
      if (b <= MAX_RECORD_BYTES) return r;
      const cut = Buffer.from(r.text, "utf8").subarray(0, MAX_RECORD_BYTES).toString("utf8").replace(/\uFFFD+$/, "");
      return { ...r, text: cut + TRUNCATION_MARKER, truncated: true };
    });
  }

  /**
   * v0.7.0 A3: rotation. Over the cap the OLDEST records move to
   * `<path>.1` (the rotated file: a documented, never-silently-deleted
   * archive slab; the live file keeps only the newest MAX_RECORDS).
   * Returns the number rotated out (0 = under the cap).
   */
  async #rotateIfNeeded() {
    let recs;
    try {
      recs = await this.#readRaw();
    } catch {
      return 0; // unreadable → nothing to rotate
    }
    if (recs.length <= MAX_RECORDS) return 0;
    const keep = recs.slice(-MAX_RECORDS);
    const rotated = recs.slice(0, recs.length - MAX_RECORDS);
    await writeFile(this.path, keep.map((r) => JSON.stringify(r)).join("\n") + (keep.length ? "\n" : ""), "utf8");
    await appendFile(this.path + ".1", rotated.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    this._cache = null;
    return rotated.length;
  }

  async #readRaw() {
    // cache-invalidating read for rotation decisions: #read populates the
    // cache; rotation then nulls it after correcting the file. Both are
    // inside the class, so private access is legal here.
    const v = await this.#read();
    return v;
  }

  /** Count without loading a view. */
  async stats() {
    const recs = await this.#read();
    const live = await this.all();
    return { total: recs.length, live: live.length, superseded: recs.length - live.length, path: this.path };
  }
}

export default Memory;
