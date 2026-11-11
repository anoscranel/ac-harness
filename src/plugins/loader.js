// src/plugins/loader.js — plugin discovery + manifest validation + capability
// registration, per specs/plugin-manifest.md (v2).
//
//  - Discovery: lstat each plugins/* entry; SYMLINKS ARE REJECTED; regular
//    directories only.
//  - Manifest validated against schemas/plugin-manifest.schema.json with the
//    hand-rolled subset (src/internal/jsonschema.js); failure → plugin.rejected.
//  - Folder name must equal manifest.manifest → else plugin.rejected.
//  - compat grammar: x.y.z | ^x.y.z | >=x.y.z; anything else or a range
//    mismatch = warn-load with status "compat-warn".
//  - Hooks: chain hooks (pre-tool, post-tool, on-event) all run in load order;
//    single hooks (compaction-trigger, verify-gate) — lexicographically-first
//    plugin wins, the rest are rejected with policy.violation logged.
//  - Namespacing: tools.<plugin>.<tool>, providers.<id>, hooks.<hook>.
//  - Load order = lexicographic on plugin name (deterministic).
//  - index.js is loaded LAZILY on first capability use via pathToFileURL.
//  - v1 THREAT MODEL: plugins run in-process, fully trusted. First-party only.

import { lstat, readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { validate } from "../internal/jsonschema.js";

const CHAIN_HOOKS = new Set(["pre-tool", "post-tool", "on-event"]);
const SINGLE_HOOKS = new Set(["compaction-trigger", "verify-gate"]);
const ALL_HOOKS = new Set([...CHAIN_HOOKS, ...SINGLE_HOOKS]);

const DEFAULT_SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schemas",
  "plugin-manifest.schema.json",
);

// Repo root (loader.js lives at src/plugins/loader.js). Handed to plugins via
// the registration ctx so gates can anchor on it instead of process.cwd()
// (audit-a2 6.6).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** compat grammar: x.y.z | ^x.y.z | >=x.y.z (anything else = compat-warn). */
export function parseCompat(compat) {
  const m = /^(\^|>=)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(compat ?? "");
  if (!m) return null;
  const op = m[1] === "^" ? "caret" : m[1] === ">=" ? "gte" : "exact";
  return { op, version: [Number(m[2]), Number(m[3]), Number(m[4])] };
}

function cmp(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function parseVersion(v) {
  const m = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)/.exec(v ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Check plugin compat against the harness version.
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
export function compatCheck(compat, harnessVersion) {
  const c = parseCompat(compat);
  const h = parseVersion(harnessVersion);
  if (!c) return { ok: false, reason: `unparseable compat grammar: ${compat}` };
  if (!h) return { ok: false, reason: `unparseable harness version: ${harnessVersion}` };
  switch (c.op) {
    case "exact":
      return cmp(c.version, h) === 0
        ? { ok: true }
        : { ok: false, reason: `exact ${compat} != harness ${harnessVersion}` };
    case "gte":
      return cmp(h, c.version) >= 0
        ? { ok: true }
        : { ok: false, reason: `harness ${harnessVersion} < ${compat}` };
    case "caret": {
      // SemVer caret: ^x.y.z = >=x.y.z <(x+1).0.0; for 0.y.z = >=0.y.z <0.(y+1).0.
      const [x, y] = c.version;
      const upper = x > 0 ? [x + 1, 0, 0] : [0, y + 1, 0];
      return cmp(h, c.version) >= 0 && cmp(h, upper) < 0
        ? { ok: true }
        : { ok: false, reason: `harness ${harnessVersion} outside ${compat}` };
    }
  }
}

/**
 * Discover and register plugins.
 * @param {object} opts
 * @param {string} opts.dir plugins directory
 * @param {string} opts.harnessVersion e.g. "0.1.0"
 * @param {import("../events.js").EventLog} opts.log event log (rejections and
 *   violations are events, never crashes)
 * @param {string} [opts.schemaPath]
 */
export async function loadPlugins({ dir, harnessVersion, log, schemaPath = DEFAULT_SCHEMA_PATH }) {
  const rawSchema = JSON.parse(await readFile(schemaPath, "utf8"));
  // ⚠️ Spec tension (findings/deviations.md #3): the normative schema's compat
  // pattern rejects non-grammar values, but the loader contract (spec §loader
  // item 4) says unparsed grammar = warn-load, not rejection. Resolution:
  // compat is exempted from schema pattern validation here and governed by the
  // loader contract instead (grammar parse + range check → compat-warn).
  const schema = JSON.parse(JSON.stringify(rawSchema));
  if (schema.properties?.compat?.pattern) delete schema.properties.compat.pattern;
  const host = {
    plugins: [], // { name, version, status, manifest, dir, module? }
    chainHooks: { "pre-tool": [], "post-tool": [], "on-event": [] },
    singleHooks: { "compaction-trigger": null, "verify-gate": null },
    tools: new Map(), // "tools.<plugin>.<tool>" -> { plugin, toolName }
    providers: new Map(), // "providers.<id>" -> { plugin, id }
  };

  let entries;
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return host; // no plugins dir = no plugins
    throw err;
  }
  entries.sort(); // lexicographic load order (deterministic)

  for (const name of entries) {
    const p = join(dir, name);
    const st = await lstat(p);
    if (st.isSymbolicLink()) {
      await log.appendEvent("plugin.rejected", "harness", {
        plugin: name,
        reason: "symlink",
        detail: "symlinked plugin directories are rejected",
      });
      continue;
    }
    if (!st.isDirectory()) continue; // regular files are not plugins; skip silently

    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(p, "manifest.json"), "utf8"));
    } catch (err) {
      await log.appendEvent("plugin.rejected", "harness", {
        plugin: name,
        reason: "manifest-unparseable",
        detail: String(err.message),
      });
      continue;
    }

    const check = validate(manifest, schema, "manifest");
    if (!check.ok) {
      await log.appendEvent("plugin.rejected", "harness", {
        plugin: name,
        reason: "manifest-invalid",
        detail: check.errors[0] ?? "schema validation failed",
      });
      continue;
    }

    if (manifest.manifest !== name) {
      await log.appendEvent("plugin.rejected", "harness", {
        plugin: name,
        reason: "name-mismatch",
        detail: `folder "${name}" != manifest "${manifest.manifest}"`,
      });
      continue;
    }

    const compat = compatCheck(manifest.compat, harnessVersion);
    const status = compat.ok ? "ok" : "compat-warn";

    // Capability declarations (data). Runtime registration is checked against
    // these; anything undeclared is rejected as plugin.violation.
    const caps = manifest.capabilities ?? {};
    for (const toolName of caps.tools ?? []) {
      host.tools.set(`tools.${name}.${toolName}`, { plugin: name, toolName });
    }
    for (const providerId of caps.providers ?? []) {
      const key = `providers.${providerId}`;
      // F23 (review-r1): duplicate provider ids are rejected, never silently
      // overwritten (same posture as single-hook conflicts).
      if (host.providers.has(key)) {
        await log.appendEvent("policy.violation", "policy", {
          kind: "duplicate-provider",
          path: `plugins/${name}`,
          tool: key,
        });
        continue;
      }
      host.providers.set(key, { plugin: name, id: providerId });
    }
    for (const hook of caps.hooks ?? []) {
      if (!ALL_HOOKS.has(hook)) continue; // schema enum already rejects these
      if (CHAIN_HOOKS.has(hook)) {
        host.chainHooks[hook].push({ plugin: name, fn: null }); // fn bound lazily
      } else {
        // single hook: lexicographically-first plugin wins
        if (host.singleHooks[hook] === null) {
          host.singleHooks[hook] = { plugin: name, fn: null };
        } else {
          await log.appendEvent("policy.violation", "policy", {
            kind: "single-hook-conflict",
            path: `plugins/${name}`,
            tool: `hooks.${hook}`,
          });
        }
      }
    }

    host.plugins.push({ name, version: manifest.version, status, manifest, dir: p, module: null });
    await log.appendEvent("plugin.loaded", "harness", {
      plugin: name,
      version: manifest.version,
      status,
      compat: manifest.compat,
    });
  }

  return host;
}

/**
 * Lazily import a plugin's index.js (via pathToFileURL — never naive string
 * concat) and let it register capabilities. Any registration absent from the
 * manifest is rejected and logged as plugin.violation.
 * `config` = the per-plugin config object (harness passes it through; the
 * plugin validates its own keys — see the plugin's own spec).
 */
export async function activatePlugin(host, pluginRecord, log, config = {}) {
  if (pluginRecord.module) return pluginRecord.module;
  const entryUrl = pathToFileURL(join(pluginRecord.dir, "index.js")).href;
  const mod = await import(entryUrl);
  const declared = pluginRecord.manifest.capabilities ?? {};
  const ctx = {
    config,
    repoRoot: REPO_ROOT, // 6.6: anchor for gates (never process.cwd())
    // 6.7: warn channel — unknown config keys etc. warn, never reject.
    // Logged as plugin.violation kind "config-warning" (least-change fit:
    // reuses the existing event type; see findings/deviations.md entry 26).
    warn: (msg) =>
      log.appendEvent("plugin.violation", "harness", {
        plugin: pluginRecord.name,
        kind: "config-warning",
        name: "config",
        detail: String(msg),
      }),
    registerTool: (toolName, tool) => {
      if (!(declared.tools ?? []).includes(toolName)) {
        return log.appendEvent("plugin.violation", "harness", {
          plugin: pluginRecord.name,
          kind: "undeclared-runtime-reg",
          name: `tools.${toolName}`,
        });
      }
      host.tools.set(`tools.${pluginRecord.name}.${toolName}`, {
        plugin: pluginRecord.name,
        toolName,
        tool,
      });
    },
    registerProvider: (id, provider) => {
      if (!(declared.providers ?? []).includes(id)) {
        return log.appendEvent("plugin.violation", "harness", {
          plugin: pluginRecord.name,
          kind: "undeclared-runtime-reg",
          name: `providers.${id}`,
        });
      }
      const key = `providers.${id}`;
      // F23: a second registration for the same id is rejected, not silent.
      const existing = host.providers.get(key);
      if (existing && (existing.provider || existing.plugin !== pluginRecord.name)) {
        return log.appendEvent("policy.violation", "policy", {
          kind: "duplicate-provider",
          path: `plugins/${pluginRecord.name}`,
          tool: key,
        });
      }
      host.providers.set(key, { plugin: pluginRecord.name, id, provider });
    },
    registerHook: (hook, fn) => {
      if (!(declared.hooks ?? []).includes(hook)) {
        return log.appendEvent("plugin.violation", "harness", {
          plugin: pluginRecord.name,
          kind: "undeclared-runtime-reg",
          name: `hooks.${hook}`,
        });
      }
      if (CHAIN_HOOKS.has(hook)) {
        const slot = host.chainHooks[hook].find((h) => h.plugin === pluginRecord.name);
        if (slot) slot.fn = fn;
      } else {
        const slot = host.singleHooks[hook];
        if (slot && slot.plugin === pluginRecord.name) slot.fn = fn;
      }
    },
  };
  if (typeof mod.register === "function") await mod.register(ctx);
  pluginRecord.module = mod;
  return mod;
}

/**
 * TB0 wiring helper: activate every plugin that declared hooks (load order =
 * lexicographic, deterministic) and return the loop-ready hook surface.
 * Chain hooks: all registered fns in load order. Single hooks: the
 * lexicographic winner's fn (its plugin is activated to bind it).
 * The verify-gate winner is adapted to the loop's gate shape
 * ({ok, summary, results}); a plugin returning {pass, summary} is honoured.
 *
 * @returns {Promise<{preTool:Array, postTool:Array, onEvent:Array,
 *   decide:Function|undefined, verifyGate:Function|undefined}>}
 */
export async function wirePluginHooks(host, log, { config = {} } = {}) {
  const out = { preTool: [], postTool: [], onEvent: [], decide: undefined, verifyGate: undefined };
  const declaresHooks = (p) => (p.manifest.capabilities?.hooks ?? []).length > 0;
  for (const pluginRecord of host.plugins) {
    if (!declaresHooks(pluginRecord)) continue;
    try {
      await activatePlugin(host, pluginRecord, log, config[pluginRecord.name] ?? {});
    } catch (err) {
      await log.appendEvent("plugin.violation", "harness", {
        plugin: pluginRecord.name,
        kind: "activation-failed",
        name: "index.js",
        detail: String(err?.message ?? err),
      });
    }
  }
  for (const h of host.chainHooks["pre-tool"]) if (h.fn) out.preTool.push(h);
  for (const h of host.chainHooks["post-tool"]) if (h.fn) out.postTool.push(h);
  for (const h of host.chainHooks["on-event"]) if (h.fn) out.onEvent.push(h);

  const decideSlot = host.singleHooks["compaction-trigger"];
  if (decideSlot?.fn) {
    out.decide = decideSlot.fn;
    out.decidePlugin = decideSlot.plugin; // 6.1: owner name for containment
  }

  const verifySlot = host.singleHooks["verify-gate"];
  if (verifySlot?.fn) {
    const fn = verifySlot.fn;
    out.verifyGatePlugin = verifySlot.plugin; // 6.1
    out.verifyGate = async (args) => {
      const r = await fn(args);
      // Adapt the plugin's {pass, summary} to the loop's {ok, summary, results}.
      return { ok: r.ok ?? r.pass === true, summary: r.summary ?? "", results: r.results ?? [] };
    };
  }
  return out;
}

export default { loadPlugins, activatePlugin, wirePluginHooks, parseCompat, compatCheck };
