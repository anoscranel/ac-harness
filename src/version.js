// src/version.js — v0.4.0 Ship 3: the SINGLE version source. Read once at
// import from package.json (the file this module ships next to) — no deps,
// node:* builtins only. Every entrypoint (cli.js, server.js, tui/main.js,
// loop.js) imports HARNESS_VERSION from here; the four literals are GONE.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(here, "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const require_ = createRequire(import.meta.url);
void require_;

/** The harness version — sourced from package.json, single origin. */
export const HARNESS_VERSION = pkg.version;
export default HARNESS_VERSION;
