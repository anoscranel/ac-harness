// src/tools/write.js — write a UTF-8 text file. Gated `ask` by default policy;
// pinned-deny against the event-log path applies (src/policy.js).
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CheckpointStore, resolveRoot } from "../checkpoint.js";

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
  const cwd = ctx.cwd ?? process.cwd();
  const path = resolve(cwd, args.path);

  // Snapshot the file before replacing it. A write is the most common
  // irreversible action a harness performs; without this it is unrecoverable.
  // Best-effort: a checkpoint failure must not block the write, but it is
  // reported in the result so the caller knows the safety net was absent.
  let checkpoint = null;
  try {
    const store = new CheckpointStore({ root: resolveRoot(ctx.checkpointRoot), cwd });
    const { seq } = await store.snapshot({ label: `pre-write ${args.path}`, paths: [args.path] });
    checkpoint = seq;
  } catch (e) {
    checkpoint = { error: String(e && e.message || e) };
  }
  const bytes = Buffer.byteLength(args.content, "utf8");
  await writeFile(path, args.content, "utf8");
  // `path` rides the result payload: the loop's verify-gate tracks edited
  // files from here (F19).
  return { ok: true, output: `wrote ${bytes} bytes to ${path}`, bytes, path, checkpoint };
}

export default { name, description, argsSchema, run };
