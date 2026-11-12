// src/checkpoint-cli.js — v0.8.0 S1: the user-facing checkpoint surface.
// The store (src/checkpoint.js) implements everything; this file only
// PROJECTS it: list / show / restore / prune. No mechanism lives here.
//
// DESTRUCTIVE-ACT CONTRACT (card S1, the card's own self-pushback):
// `restore` OVERWRITES files — it prints exactly what it will write and
// REFUSES without `--yes`. `--prune` (deleting files created after the
// snapshot) stays opt-in TWICE over: it requires --yes as well. Preview,
// then explicit flag. Never prunes unless asked.

import { CheckpointStore, resolveRoot } from "./checkpoint.js";
import { access, constants } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * argv: [sub, ...rest] — sub ∈ list|show|restore|prune.
 * Output is plain text lines (returned AND printed by the caller per the
 * existing cli plumbing; this returns {lines, exitCode} so both the bin and
 * tests can consume it headlessly).
 * @returns {Promise<{lines:string[], exitCode:number}>}
 */
export async function checkpointCommand(argv, { cwd = process.cwd(), stdout = process.stdout, root = undefined } = {}) {
  const [sub, ...rest] = argv;
  const store = new CheckpointStore({ root: resolveRoot(root), cwd });

  const out = (s) => {
    lines.push(s);
    if (stdout) stdout.write(s + "\n");
  };
  const lines = [];

  switch (sub) {
    case "list": {
      const rows = await store.list();
      if (rows.length === 0) {
        out("no checkpoints (they appear automatically on write/edit)");
        return { lines, exitCode: 0 };
      }
      rows.sort((a, b) => b.seq - a.seq);
      out("seq  at                     files  bytes  label");
      for (const r of rows) {
        out(
          String(r.seq).padEnd(5) +
          String(r.at).padEnd(24) +
          String(r.files).padEnd(7) +
          String(bytesOf(r)).padEnd(7) +
          (r.label ?? ""),
        );
      }
      return { lines, exitCode: 0 };
    }

    case "show": {
      const seq = Number(rest[0]);
      if (!Number.isInteger(seq) || seq < 1) return usage(out);
      const rows = await store.list();
      const row = rows.find((r) => r.seq === seq);
      if (!row) {
        out(`no checkpoint ${seq} (have: ${rows.map((r) => r.seq).join(", ") || "none"})`);
        return { lines, exitCode: 2 };
      }
      out(`checkpoint ${seq}: ${row.label ?? ""} at ${row.at}`);
      out(`files: ${row.files ?? "??"} · bytes: ${bytesOf(row) ?? "??"}`);
      // diff against the previous snapshot when one exists
      const prev = rows.filter((r) => r.seq < seq).sort((a, b) => b.seq - a.seq)[0];
      if (prev) {
        const d = await store.diff(prev.seq, seq);
        out(`diff vs ${prev.seq}: +${d.added.length} added · ~${d.modified.length} modified · -${d.removed.length} removed`);
        for (const p of d.added) out(`  + ${p}`);
        for (const p of d.modified) out(`  ~ ${p}`);
        for (const p of d.removed) out(`  - ${p}`);
      } else {
        out("diff: (first snapshot — nothing to compare against)");
      }
      return { lines, exitCode: 0 };
    }

    case "restore": {
      const seq = Number(rest[0]);
      if (!Number.isInteger(seq) || seq < 1) return usage(out);
      const yes = rest.includes("--yes");
      const prune = rest.includes("--prune");
      if (!yes) {
        // REFUSAL PATH (DC2): print exactly what would be overwritten.
        const rows = await store.list();
        const row = rows.find((r) => r.seq === seq);
        if (!row) {
          out(`no checkpoint ${seq}`);
          return { lines, exitCode: 2 };
        }
        out(`restore ${seq} would OVERWRITE ${row.files} file(s) in ${cwd}`);
        if (prune) out("and --prune would DELETE every file created after that snapshot");
        out("refusing: re-run with --yes to proceed");
        return { lines, exitCode: 2 };
      }
      const r = await store.restore(seq, { prune });
      out(`restored ${r.restored} file(s) from checkpoint ${seq}` + (r.skipped ? ` (${r.skipped} skipped)` : ""));
      if (prune) out(`pruned ${r.pruned} file(s) created after the snapshot`);
      return { lines, exitCode: 0 };
    }

    case "prune": {
      const keepIdx = rest.indexOf("--keep");
      const keep = keepIdx >= 0 ? Number(rest[keepIdx + 1]) : 50;
      const r = await store.prune({ keep: Number.isFinite(keep) ? keep : 50 });
      out(
        `kept ${r.kept} · removed ${r.removed_manifests} snapshot(s), ${r.removed_blobs} blob(s) · freed ${r.bytes_freed} bytes`,
      );
      return { lines, exitCode: 0 };
    }

    default:
      out("usage: ac-harness checkpoint <list|show|restore|prune>");
      return { lines, exitCode: 2 };
  }
}

function usage(out) {
  out("usage: ac-harness checkpoint <list|show <seq>|restore <seq> [--yes] [--prune]|prune --keep N>");
  return { lines: [], exitCode: 2 };
}

function bytesOf(row) {
  return row.bytes ?? 0;
}

export default checkpointCommand;
