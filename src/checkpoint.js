// src/checkpoint.js — snapshot and restore file state before mutations.
//
// WHY THIS EXISTS
// write.js overwrites and edit.js rewrites in place with no backup. A harness
// whose own doctrine says "irreversible actions are a human gate" was shipping
// the most common irreversible action — destroying a file — with no way back.
// Feature parity target: Hermes' checkpoint_manager (MIT, design only; this is a
// original JS implementation with no code copied).
//
// DESIGN
// Content-addressed, not timestamp-based. Each snapshot stores a blob by sha256
// under <root>/objects/<aa>/<full>, and a manifest under <root>/manifests/<seq>.json
// lists path -> hash for every tracked file. Identical content across snapshots
// costs one blob, so a thousand snapshots of an unchanged tree cost a few KB.
// That matters here: the device runs at 97% disk.
//
// Storage lives OUTSIDE the project tree by default (~/.local/share/ac-harness/
// checkpoints) so it never pollutes a user's repo and never appears in their git.
//
// No dependency on git. No subprocess. Pure node:fs.

import { createHash } from "node:crypto";
import {
  mkdir, readFile, writeFile, readdir, stat, rm, rename, copyFile, rmdir,
} from "node:fs/promises";
import { dirname, join, resolve, relative, sep } from "node:path";
import { homedir } from "node:os";

export const DATA_HOME = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");

export const DEFAULT_ROOT = join(DATA_HOME, "ac-harness", "checkpoints");

/**
 * Resolve the store root for a working directory.
 *
 * Precedence: explicit root > AC_CHECKPOINT_ROOT env > default.
 * There is deliberately NO per-project override inside the project tree: a store
 * under the workdir is invisible to any other invocation (and gets snapshotted by
 * mistake). The agent and the human must resolve to the SAME place, or a
 * checkpoint the agent made can never be restored by the person who needs it
 * (found in end-to-end test, 2026-11-12).
 */
export function resolveRoot(explicit) {
  return explicit || process.env.AC_CHECKPOINT_ROOT || DEFAULT_ROOT;
}

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * Files this snapshot layer will never touch: the checkpoint store and VCS.
 * v0.7.0 A4 (audit-pending-v070): "logs" is EXCLUDED TOO — a snapshot of the
 * event log would let a RESTORE rewrite the audit trail (the one invariant
 * the log carries: append-only, single writer). Snapshot excludes; restore,
 * which only touches manifest paths, therefore can never list a log file.
 */
const EXCLUDED_DIRS = new Set([".git", "node_modules", ".hg", ".svn", "logs"]);
const MAX_BYTES = Number(process.env.AC_CHECKPOINT_MAX_BYTES || 5 * 1024 * 1024);

function inExcludedDir(relPath) {
  return relPath.split(/[\\/]/).some((seg) => EXCLUDED_DIRS.has(seg));
}

/**
 * True when `full` lives inside the checkpoint store itself. Snapshotting your
 * own store makes every snapshot capture the previous one: unbounded growth and
 * a store that doubles on each run. Caught by test, 2026-11-12.
 */
function insideStore(full, storeDir) {
  const r = relative(storeDir, full);
  return r === "" || (!r.startsWith("..") && !r.includes(".." + sep));
}

async function* walk(dir, base = dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    const rel = relative(base, full);
    if (inExcludedDir(rel)) continue;
    if (e.isDirectory()) {
      yield* walk(full, base);
    } else if (e.isFile()) {
      yield { full, rel };
    }
  }
}

export class CheckpointStore {
  constructor({ root = DEFAULT_ROOT, cwd = process.cwd() } = {}) {
    this.root = root;
    this.cwd = resolve(cwd);
    this.project = sha(Buffer.from(this.cwd)).slice(0, 16);
    this.dir = join(root, this.project);
    this.objects = join(this.dir, "objects");
    this.manifests = join(this.dir, "manifests");
  }

  async #ensure() {
    await mkdir(this.objects, { recursive: true });
    await mkdir(this.manifests, { recursive: true });
  }

  async #seq() {
    try {
      const names = (await readdir(this.manifests)).filter((f) => f.endsWith(".json"));
      const n = names.reduce((m, f) => Math.max(m, parseInt(f, 10) || 0), 0);
      return n + 1;
    } catch {
      return 1;
    }
  }

  /** Store one file's bytes; returns its hash. Deduplicates by content. */
  async #put(buf) {    const h = sha(buf);
    const dest = join(this.objects, h.slice(0, 2), h);
    try {
      await stat(dest);
      return h; // already stored (content found in a prior snapshot)
    } catch {
      /* not stored yet */
    }
    await mkdir(dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    await writeFile(tmp, buf);
    await rename(tmp, dest); // atomic publish within the same filesystem
    return h;
  }

  /**
   * Snapshot the working tree. Cheap: unchanged files cost one stat, their
   * blob already exists.
   * @returns {Promise<{seq:number, files:number, bytes:number}>}
   */
  async snapshot({ label = "", paths = null } = {}) {
    await this.#ensure();
    const seq = await this.#seq();
    const manifest = { seq, label, cwd: this.cwd, at: new Date().toISOString(), files: {} };
    let bytes = 0;

    const targets = paths && paths.length
      ? paths.map((p) => ({ full: resolve(this.cwd, p), rel: p }))
      : walk(this.cwd);

    for await (const item of targets) {
      if (inExcludedDir(item.rel)) continue;
      if (insideStore(item.full, this.dir)) continue;
      let st;
      try {
        st = await stat(item.full);
      } catch {
        continue; // vanished between walk and stat
      }
      if (!st.isFile() || st.size > MAX_BYTES) continue;
      let buf;
      try {
        buf = await readFile(item.full);
      } catch {
        continue; // unreadable (permissions); skip rather than fail the snapshot
      }
      const h = await this.#put(buf);
      manifest.files[item.rel.split(sep).join("/")] = h;
      bytes += buf.length;
    }

    manifest.bytes = bytes;
    const dest = join(this.manifests, `${String(seq).padStart(6, "0")}.json`);
    await writeFile(dest, JSON.stringify(manifest, null, 2));
    return { seq, files: Object.keys(manifest.files).length, bytes };
  }

  async list() {
    try {
      const names = (await readdir(this.manifests)).filter((f) => f.endsWith(".json")).sort();
      const out = [];
      for (const n of names) {
        const m = JSON.parse(await readFile(join(this.manifests, n), "utf8"));
        out.push({ seq: m.seq, at: m.at, label: m.label, files: Object.keys(m.files).length, bytes: m.bytes });
      }
      return out;
    } catch {
      return [];
    }
  }

  async #manifest(seq) {
    const name = `${String(seq).padStart(6, "0")}.json`;
    return JSON.parse(await readFile(join(this.manifests, name), "utf8"));
  }

  /**
   * Restore files from a snapshot. Only paths in the manifest are touched; a
   * file created after the snapshot is NOT deleted unless `prune` is passed
   * explicitly (deleting is irreversible, so it is opt-in).
   * @returns {Promise<{restored:number, pruned:number, skipped:number}>}
   */
  async restore(seq, { prune = false } = {}) {
    const m = await this.#manifest(seq);
    let restored = 0, pruned = 0, skipped = 0;

    for (const [rel, h] of Object.entries(m.files)) {
      const blob = join(this.objects, h.slice(0, 2), h);
      const dest = resolve(this.cwd, rel);
      // never write outside the project root
      if (!dest.startsWith(this.cwd + sep) && dest !== this.cwd) { skipped++; continue; }
      await mkdir(dirname(dest), { recursive: true });
      try {
        await copyFile(blob, dest);
        restored++;
      } catch {
        skipped++;
      }
    }

    if (prune) {
      for await (const item of walk(this.cwd)) {
        if (!(item.rel.split(sep).join("/") in m.files)) {
          await rm(item.full, { force: true });
          pruned++;
        }
      }
    }
    return { restored, pruned, skipped };
  }

  /** Roll a single path back to its state in a snapshot. */
  async restorePath(seq, relPath) {
    const m = await this.#manifest(seq);
    const key = relPath.split(sep).join("/");
    const h = m.files[key];
    if (!h) return { ok: false, error: `not in snapshot ${seq}: ${key}` };
    const blob = join(this.objects, h.slice(0, 2), h);
    const dest = resolve(this.cwd, relPath);
    if (!dest.startsWith(this.cwd + sep) && dest !== this.cwd) {
      return { ok: false, error: "refusing to write outside the project root" };
    }
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(blob, dest);
    return { ok: true, path: dest };
  }

/**
   * Prune to the newest `keep` snapshots and delete blobs no longer referenced.
   * Round-3 GC: round-1's store grew unboundedly (a defect on a 97%-full
   * disk). Deleting manifests is safe — the snapshots on either side still
   * exist; deleting unreferenced blobs is safe by construction.
   * @returns {Promise<{removed_manifests:number, removed_blobs:number, kept:number, bytes_freed:number}>}
   */
  async prune({ keep = 50 } = {}) {
    const rows = await this.list();
    if (rows.length <= keep) {
      return { removed_manifests: 0, removed_blobs: 0, kept: rows.length, bytes_freed: 0 };
    }
    const doomed = rows.slice(0, rows.length - keep).map((r) => r.seq);
    const keptRows = rows.slice(-keep);

    // referenced = every hash in every kept manifest
    const referenced = new Set();
    for (const r of keptRows) {
      const m = await this.#manifest(r.seq).catch(() => null);
      if (!m) continue;
      for (const h of Object.values(m.files)) referenced.add(h);
    }

    let removed_manifests = 0;
    for (const seq of doomed) {
      const name = `${String(seq).padStart(6, "0")}.json`;
      const p = join(this.manifests, name);
      try {
        await rm(p, { force: true });
        removed_manifests++;
      } catch { /* absent = already gone */ }
    }

    // sweep blobs: delete any object not referenced by a kept manifest
    let removed_blobs = 0, bytes_freed = 0;
    try {
      for (const shard of await readdir(this.objects)) {
        const shardDir = join(this.objects, shard);
        let entries;
        try {
          entries = await readdir(shardDir);
        } catch {
          continue;
        }
        for (const f of entries) {
          if (!/^[0-9a-f]{64}$/.test(f)) continue;
          if (referenced.has(f)) continue;
          const full = join(shardDir, f);
          try {
            const st = await stat(full);
            await rm(full, { force: true });
            removed_blobs++;
            bytes_freed += st.size;
          } catch { /* raced */ }
        }
        // drop empty shard dirs
        try {
          const rest = await readdir(shardDir);
          if (rest.length === 0) await rmdir(shardDir);
        } catch { /* already gone */ }
      }
    } catch { /* objects dir absent = nothing to sweep */ }

    return { removed_manifests, removed_blobs, kept: keptRows.length, bytes_freed };
  }

  /**
   * What changed between two snapshots: added / removed / modified files.
   * The blast-radius surface: `write`/`edit` snapshot per call, so
   * `diff seq-of-before seq-of-after` shows exactly what a tool touched.
   * @returns {Promise<{added:string[], removed:string[], modified:string[]}>}
   */
  async diff(fromSeq, toSeq) {
    const a = await this.#manifest(fromSeq);
    const b = await this.#manifest(toSeq);
    const added = [], removed = [], modified = [];
    const bPaths = new Set(Object.keys(b.files));
    const aPaths = new Set(Object.keys(a.files));
    for (const p of Object.keys(b.files)) {
      if (!aPaths.has(p)) added.push(p);
      else if (a.files[p] !== b.files[p]) modified.push(p);
    }
    for (const p of Object.keys(a.files)) {
      if (!bPaths.has(p)) removed.push(p);
    }
    return { added: added.sort(), removed: removed.sort(), modified: modified.sort() };
  }

  /** Total bytes on disk for this project's snapshots.
 */
  async size() {
    let total = 0;
    try {
      for await (const item of walk(this.dir)) {
        try { total += (await stat(item.full)).size; } catch { /* raced */ }
      }
    } catch { /* absent */ }
    return total;
  }
}

export default CheckpointStore;
