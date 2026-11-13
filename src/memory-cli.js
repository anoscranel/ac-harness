// src/memory-cli.js — v0.11.0 S2: the durable-memory surface (`ac-harness
// memory`). Reuses the store (src/memory.js) and its search — never a fork.
// Contract: {lines, exitCode} (the checkpoint-cli.js command contract).
//
// DESTRUCTIVE COMMAND (forget): prints the exact record it would remove and
// REFUSES without --yes (the checkpoint-restore discipline). Removal
// goes through a full read→drop→write-back of the store file with the
// store's OWN redaction path (events.redact) — the file is rewritten, not
// appended with a tombstone (the store has no tombstone design).

import { Memory, DEFAULT_PATH } from "./memory.js";
import { redact } from "./events.js";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Surrogate env seam for tests: AC_MEMORY_PATH points the store at a temp file. */
function storePath() {
  return process.env.AC_MEMORY_PATH ? resolve(process.env.AC_MEMORY_PATH) : DEFAULT_PATH;
}

const USAGE = "usage: ac-harness memory <list [--scope S] | recall <query> | forget <id> [--yes]>";

/**
 * @param {string[]} argv
 * @param {{stdout?:{write:(s:string)=>void}}} [opts]
 * @returns {Promise<{lines:string[], exitCode:number}>}
 */
export async function memoryCommand(argv = [], { stdout = process.stdout } = {}) {
  const lines = [];
  const out = (s) => {
    lines.push(s);
    if (stdout) stdout.write(s + "\n");
  };
  const [sub, ...rest] = argv;
  const m = new Memory({ path: storePath() });

  switch (sub) {
    case "list": {
      const scopeIdx = rest.indexOf("--scope");
      const scope = scopeIdx >= 0 ? rest[scopeIdx + 1] : null;
      const recs = scope ? (await m.all()).filter((r) => r.scope === scope) : await m.all();
      out(`store: ${storePath()} (${recs.length} live record(s))`);
      if (recs.length === 0) {
        out("(no records)");
        return { lines, exitCode: 0 };
      }
      // newest first
      for (const r of [...recs].reverse()) {
        const text = redact(String(r.text ?? "")).slice(0, 120);
        const end = String(r.text ?? "").length > 120 ? "…" : "";
        out(`${r.id}  ${r.scope}  ${r.at?.slice(0, 10) ?? "?"}  ${text}${end}`);
      }
      return { lines, exitCode: 0 };
    }

    case "recall": {
      const query = rest[0];
      if (query === undefined) {
        out(USAGE);
        return { lines, exitCode: 2 };
      }
      // the SAME search the memory_recall tool uses — the store's own recall()
      const hits = await m.recall(query, { limit: 50 });
      out(`${hits.length} match(es) for "${query}"`);
      for (const r of [...hits].reverse()) {
        out(`${r.id}  ${r.scope}  ${r.at?.slice(0, 10) ?? "?"}  ${redact(String(r.text ?? ""))}`);
      }
      return { lines, exitCode: 0 };
    }

    case "forget": {
      const id = rest.find((a) => !a.startsWith("--"));
      const yes = rest.includes("--yes");
      if (id === undefined) {
        out(USAGE);
        return { lines, exitCode: 2 };
      }
      const recs = await m.all();
      const target = recs.find((r) => r.id === id)
        ?? [...(await m.recall("", { limit: 5000 * 2, includeSuperseded: true }))].find((r) => r.id === id);
      if (!target) {
        out(`no record ${id} in ${storePath()}`);
        return { lines, exitCode: 2 };
      }
      const text = redact(String(target.text ?? "")).slice(0, 200);
      if (!yes) {
        out(`forget ${id} would remove:`);
        out(`  ${target.id}  ${target.scope}  ${target.at?.slice(0, 10) ?? "?"}  ${text}`);
        out("refusing: re-run with --yes to proceed");
        return { lines, exitCode: 2 };
      }
      const all = await m.recall("", { limit: Number.MAX_SAFE_INTEGER, includeSuperseded: true });
      const kept = all.filter((r) => r.id !== id);
      if (kept.length === all.length) {
        out(`no record ${id} in ${storePath()}`);
        return { lines, exitCode: 2 };
      }
      // write-back through the store's OWN redaction path (read all, drop,
      // rewrite; the store re-reads its cache invalidly afterwards — we
      // construct a fresh store to reflect the new state).
      const safeKept = kept.map((r) => redact(r));
      const { mkdir } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(storePath()), { recursive: true });
      await writeFile(storePath(), safeKept.map((r) => JSON.stringify(r)).join("\n") + (safeKept.length ? "\n" : ""), "utf8");
      out(`removed ${id} (${kept.length} record(s) remain)`);
      return { lines, exitCode: 0 };
    }

    default:
      out(USAGE);
      return { lines, exitCode: 2 };
  }
}

export default memoryCommand;
