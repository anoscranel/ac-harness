// src/tools/write.js — write a UTF-8 text file. Gated `ask` by default policy;
// pinned-deny against the event-log path applies (src/policy.js).
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const name = "write";
export const description = "Write text to a file, replacing it if it exists.";

export const argsSchema = {
  type: "object",
  required: ["path", "content"],
  additionalProperties: false,
  properties: {
    path: { type: "string", minLength: 1 },
    content: { type: "string" },
  },
};

export async function run(args, ctx = {}) {
  const path = resolve(ctx.cwd ?? process.cwd(), args.path);
  const bytes = Buffer.byteLength(args.content, "utf8");
  await writeFile(path, args.content, "utf8");
  // `path` rides the result payload: the loop's verify-gate tracks edited
  // files from here (F19).
  return { ok: true, output: `wrote ${bytes} bytes to ${path}`, bytes, path };
}

export default { name, description, argsSchema, run };
