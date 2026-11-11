// scripts/check.mjs — `node --check` every .js under src/, test/, scripts/.
// Zero-dep type-check-lite gate (PLAN stack decision).
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) yield p;
  }
}

let failed = 0;
for (const root of ["src", "test", "scripts"]) {
  for await (const file of walk(root)) {
    const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (r.status !== 0) {
      failed++;
      process.stderr.write(`FAIL ${file}\n${r.stderr}`);
    }
  }
}
if (failed > 0) {
  process.stderr.write(`${failed} file(s) failed node --check\n`);
  process.exit(1);
}
process.stdout.write("node --check: all files OK\n");
