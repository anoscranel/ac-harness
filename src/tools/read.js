// src/tools/read.js — read a file as UTF-8 text (U+FFFD replacement on bad
// bytes, per specs/invariants.md §5). Read-only; default policy allows it.
// v0.5.0 H3: line paging — offset (1-based line) + limit (default 2000, max
// 5000) slice by LINES before the byte cap; the output ends with
// <lines N..M of T>. The 256 KiB cap remains the outer bound.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const name = "read";
export const description = "Read a UTF-8 text file (with optional line paging).";

export const argsSchema = {
  type: "object",
  required: ["path"],
  additionalProperties: false,
  properties: {
    path: { type: "string", minLength: 1 },
    offset: { type: "integer", minimum: 1, description: "1-based starting line" },
    limit: { type: "integer", minimum: 1, maximum: 5000, description: "max lines (default 2000)" },
  },
};

const MAX_READ = 256 << 10; // F25: 256 KiB outer cap
const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 5000;

export async function run(args, ctx = {}) {
  const path = resolve(ctx.cwd ?? process.cwd(), args.path);
  const buf = await readFile(path); // Buffer
  const text = buf.toString("utf8");

  const hasPaging = args.offset !== undefined || args.limit !== undefined;
  if (hasPaging) {
    const lines = text.split("\n");
    // trailing empty string after a final newline is not a line
    const total = text === "" ? 0 : text.endsWith("\n") ? lines.length - 1 : lines.length;
    const offset = Math.max(1, Math.floor(args.offset ?? 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(args.limit ?? DEFAULT_LIMIT)));
    const startIdx = offset - 1; // 0-based slice start
    const endIdx = Math.min(total, startIdx + limit);
    const sliced = startIdx >= total ? [] : lines.slice(startIdx, endIdx);
    let out = sliced.join("\n");
    let truncated = false;
    // outer byte cap still binds
    if (Buffer.byteLength(out, "utf8") > MAX_READ) {
      out = Buffer.from(out, "utf8").subarray(0, MAX_READ).toString("utf8");
      truncated = true;
    }
    const from = offset;
    const to = Math.max(from - 1, from + sliced.length - 1);
    out += `\n<lines ${from}..${to} of ${total}>`;
    return {
      ok: true,
      output: out,
      bytes: Buffer.byteLength(out, "utf8"),
      ...(truncated ? { truncated: true } : {}),
      range: { offset: from, limit: sliced.length, total },
    };
  }

  // legacy no-args path: byte-identical to the pre-H3 behavior
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
