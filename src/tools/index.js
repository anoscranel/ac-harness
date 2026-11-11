// src/tools/index.js — the built-in tool registry. Tool args are validated
// against each tool's inline JSON-Schema (the hand-rolled subset in
// src/internal/jsonschema.js) before execution.
import read from "./read.js";
import write from "./write.js";
import edit from "./edit.js";
import grep from "./grep.js";
import bash from "./bash.js";
import { validate } from "../internal/jsonschema.js";

export const builtinTools = Object.freeze({
  read,
  write,
  edit,
  grep,
  bash,
});

/**
 * Build a tool registry.
 * @param {object} [extra] additional namespaced tools, e.g. from plugins
 *   ("tools.<plugin>.<tool>") or MCP ("mcp.<server>.<tool>").
 */
export function createRegistry(extra = {}) {
  const registry = new Map(Object.entries(builtinTools));
  for (const [name, tool] of Object.entries(extra)) {
    if (registry.has(name)) throw new Error(`tool name collision: ${name}`);
    registry.set(name, tool);
  }
  return {
    names: () => [...registry.keys()],
    get: (name) => registry.get(name),
    schemas: () =>
      [...registry.values()].map((t) => ({
        name: t.name,
        description: t.description,
        argsSchema: t.argsSchema,
      })),
    /**
     * Validate args against the tool's inline schema, then run it.
     * @returns {Promise<{ok:boolean, output:string, error?:string, bytes?:number}>}
     */
    async run(name, args, ctx) {
      const tool = registry.get(name);
      if (!tool) return { ok: false, error: `unknown tool: ${name}`, output: "" };
      const check = validate(args ?? {}, tool.argsSchema, `${name}.args`);
      if (!check.ok) {
        return { ok: false, error: `invalid args: ${check.errors.join("; ")}`, output: "" };
      }
      try {
        return await tool.run(args, ctx);
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err), output: "" };
      }
    },
  };
}

export default createRegistry;
