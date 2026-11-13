// src/logs-cli.js — v0.11.0 S3: session-log retention (`ac-harness logs`).
// list: size/age/newest-first/total. prune: --keep N (newest kept) or
// --older-than DAYS (mtime), refuses without --yes, prints exactly which
// files die BEFORE the flag. HONEST SEMANTICS (the card's self-pushback 1):
// prune selects by mtime; a live session's log has a fresh mtime so
// --older-than protects it by construction; --keep can still hit one — a
// deleted-but-open log keeps appending to the removed inode and those lines
// are lost on close. BOTH modes print that truth. No lock, by design.

import { readdir, stat, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const USAGE = "usage: ac-harness logs <list | prune --keep N | prune --older-than DAYS [--yes]>";

async function listLogs(dir) {
  const out = [];
  try {
    const names = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
    for (const name of names) {
      const full = join(dir, name);
      try {
        const st = await stat(full);
        out.push({ name, full, bytes: st.size, mtimeMs: st.mtimeMs, mtime: st.mtime });
      } catch { /* raced away */ }
    }
  } catch {
    return [];
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  return out;
}

function ageLabel(mtime, now = Date.now()) {
  const h = (now - mtime.getTime()) / 36e5;
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * @param {string[]} argv
 * @param {{stdout?:{write:(s:string)=>void}, logsDir?:string}} [opts]
 * @returns {Promise<{lines:string[], exitCode:number}>}
 */
export async function logsCommand(argv = [], { stdout = process.stdout, logsDir } = {}) {
  const dir = logsDir ?? resolve("logs");
  const lines = [];
  const out = (s) => {
    lines.push(s);
    if (stdout) stdout.write(s + "\n");
  };
  const [sub, ...rest] = argv;

  switch (sub) {
    case "list": {
      const files = await listLogs(dir);
      out(`${dir} — ${files.length} log(s)`);
      let total = 0;
      for (const f of files) {
        total += f.bytes;
        out(`${f.name}  ${String(f.bytes).padStart(9)} bytes  ${ageLabel(f.mtime)} old`);
      }
      out(`total: ${total} bytes`);
      return { lines, exitCode: 0 };
    }

    case "prune": {
      const yes = rest.includes("--yes");
      const keepIdx = rest.indexOf("--keep");
      const olderIdx = rest.indexOf("--older-than");
      if ((keepIdx < 0) === (olderIdx < 0)) { // neither or both
        out(USAGE);
        return { lines, exitCode: 2 };
      }
      const files = await listLogs(dir);
      let doomed;
      if (keepIdx >= 0) {
        const keep = Number(rest[keepIdx + 1]);
        if (!Number.isInteger(keep) || keep < 0) {
          out("--keep needs a non-negative integer");
          return { lines, exitCode: 2 };
        }
        doomed = files.slice(keep); // everything past the newest N
      } else {
        const days = Number(rest[olderIdx + 1]);
        if (!Number.isFinite(days) || days < 0) {
          out("--older-than needs a non-negative number of days");
          return { lines, exitCode: 2 };
        }
        const cutoff = Date.now() - days * 864e5;
        doomed = files.filter((f) => f.mtimeMs < cutoff);
      }
      const bytes = doomed.reduce((n, f) => n + f.bytes, 0);
      if (doomed.length === 0) {
        out("nothing to prune");
        return { lines, exitCode: 0 };
      }
      if (!yes) {
        out(`prune would delete ${doomed.length} log(s), ${bytes} bytes:`);
        for (const f of doomed) out(`  ${f.name}  (${f.bytes} bytes, ${ageLabel(f.mtime)} old)`);
        out("refusing: re-run with --yes to proceed");
        out("note: deleting a log that a LIVE session is still appending");
        out("sends that session's further lines to a removed inode (lost on");
        out("close). --older-than protects live sessions by mtime-recentness;");
        out("--keep does not. No lock is held; be sure before --yes.");
        return { lines, exitCode: 2 };
      }
      for (const f of doomed) await rm(f.full, { force: true });
      out(`pruned ${doomed.length} log(s), ${bytes} bytes reclaimed`);
      void keepIdx;
      return { lines, exitCode: 0 };
    }

    default:
      out(USAGE);
      return { lines, exitCode: 2 };
  }
}

export default logsCommand;
