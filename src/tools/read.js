// src/tools/read.js — read a file as UTF-8 text (U+FFFD replacement on bad
// bytes, per specs/invariants.md §5). Read-only; default policy allows it.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const name = "read";
export const description = "Read a UTF-8 text file and return its contents.";

export const argsSchema = {
  type: "object",
  required: ["path"],
  additionalProperties: false,
  properties: {
    path: { type: "string", minLength: 1 },
  },
};

const MAX_READ = 256 << 10; // F25 (review-r1): 256 KiB cap — one huge read is
// a phone-class OOM; over the cap we return a bounded prefix + marker.

export async function run(args, ctx = {}) {
  const path = resolve(ctx.cwd ?? process.cwd(), args.path);
  const buf = await readFile(path); // Buffer
  if (buf.length <= MAX_READ) {
    return { ok: true, output: buf.toString("utf8"), bytes: buf.length };
  }
  const slice = buf.subarray(0, MAX_READ);
  return {
    ok: true,
    output: slice.toString("utf8") + `\n<truncated: bytes 0..${MAX_READ} of ${buf.length}>`,
    bytes: slice.length,
    truncated: true,
    range: { start: 0, end: MAX_READ, total: buf.length },
  };
}

export default { name, description, argsSchema, run };
