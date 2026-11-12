// src/verify-cli.js — v0.8.0 S2: is this log intact? A read-only projection
// of the canonicalize/sha256 machinery the determinism gates already use.
// events count, canonical sha256, optional --expect comparison (non-zero
// exit on mismatch), and the v0.4.0 TORN-TAIL state reported as a state,
// not an error.
//
// Read-only, always: no file is modified, no event appended (verifying must
// never change what is being verified).

import { readFile } from "node:fs/promises";
import { canonicalize, sha256 } from "./events.js";

/**
 * argv: [<log>, --expect <sha>]
 * @returns {Promise<{lines:string[], exitCode:number, sha:string|null, torn:boolean}>}
 */
export async function verifyCommand(argv, { stdout = process.stdout } = {}) {
  const lines = [];
  const out = (s) => {
    lines.push(s);
    if (stdout) stdout.write(s + "\n");
  };

  const log = argv[0];
  if (!log) {
    out("usage: ac-harness verify <log> [--expect <sha>]");
    return { lines, exitCode: 2, sha: null, torn: false };
  }
  const expectIdx = argv.indexOf("--expect");
  const expect = expectIdx >= 0 ? argv[expectIdx + 1] : null;

  let raw;
  try {
    raw = await readFile(log, "utf8");
  } catch (err) {
    out(`cannot read log ${log}: ${err.code ?? err.message}`);
    return { lines, exitCode: 2, sha: null, torn: false };
  }

  // parse with torn-tail tolerance (the same recovery the harness uses on open)
  const events = [];
  let tornLines = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      tornLines += 1;
    }
  }
  const torn = tornLines > 0;

  const canonical = canonicalize(events);
  const sha = sha256(canonical);
  out(`log: ${log}`);
  out(`events: ${events.length}`);
  out(`canonical sha256: ${sha}`);
  out(`torn_tail: ${torn ? `yes (${tornLines} unparseable line(s) skipped; the file is never rewritten)` : "no"}`);
  if (torn) {
    out("  remediation: the log is still loadable (open() skips the torn tail);");
    out("  re-run the session from the last good event or keep the log as-is.");
  }

  if (expect) {
    if (expect === sha) {
      out(`expect: matches (${expect})`);
      return { lines, exitCode: 0, sha, torn };
    }
    out(`expect: MISMATCH — expected ${expect}, got ${sha}`);
    return { lines, exitCode: 1, sha, torn };
  }
  return { lines, exitCode: 0, sha, torn };
}

export default verifyCommand;
