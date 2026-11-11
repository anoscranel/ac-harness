// src/tools/edit.js — exact string replacement in a file. Fails closed: no
// match = error; multiple matches without replaceAll = error.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const name = "edit";
export const description =
  "Replace an exact string in a file. Fails if the string is absent, or present more than once without replaceAll.";

export const argsSchema = {
  type: "object",
  required: ["path", "oldString", "newString"],
  additionalProperties: false,
  properties: {
    path: { type: "string", minLength: 1 },
    oldString: { type: "string", minLength: 1 },
    newString: { type: "string" },
    replaceAll: { type: "boolean" },
  },
};

export async function run(args, ctx = {}) {
  const path = resolve(ctx.cwd ?? process.cwd(), args.path);
  const original = (await readFile(path)).toString("utf8");
  const occurrences = original.split(args.oldString).length - 1;
  if (occurrences === 0) {
    return { ok: false, error: "oldString not found in file", output: "" };
  }
  if (occurrences > 1 && args.replaceAll !== true) {
    return {
      ok: false,
      error: `oldString found ${occurrences} times; pass replaceAll:true or a longer unique string`,
      output: "",
    };
  }
  const next = args.replaceAll === true
    ? original.split(args.oldString).join(args.newString)
    : original.replace(args.oldString, args.newString);
  await writeFile(path, next, "utf8");
  const bytes = Buffer.byteLength(next, "utf8");
  // `path` rides the result payload: the loop's verify-gate tracks edited
  // files from here (F19).
  return { ok: true, output: `edited ${path} (${occurrences} replacement(s))`, bytes, path };
}

export default { name, description, argsSchema, run };
