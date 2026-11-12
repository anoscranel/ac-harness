// src/providers/registry.js — provider-admin §2: PURE provider registry.
//  - listEnvProviders(env): discovery from HARNESS_PROVIDER_<ID>_BASE_URL vars
//    (ID = [A-Z0-9_]+). Reads NOTHING else — the caller owns process.env.
//  - buildFromEnv(entry, env): createOpenAICompatProvider from an entry.
//  - saveProfiles/loadProfiles: providers.config.json — a PER-USER local file
//    (gitignored, like plugins.config.json). baseUrl + model are stored PLAIN
//    (not secret); an api key is referenced by ENV VAR NAME ONLY. No env VALUE
//    ever serializes. Absent/corrupt file = empty list + warn (never throws).
//  - echo is built-in and non-configurable; every registry entry is openai-compat.
//
// ZERO values, only names: this module never exposes a secret because it never
// holds one — buildFromEnv reads env[name] only at BUILD time and never
// serializes it.

import { readFile, writeFile } from "node:fs/promises";
import { createOpenAICompatProvider } from "./openai-compat.js";

export const PROFILES_VERSION = 1;
const ENV_PREFIX = "HARNESS_PROVIDER_";
const ENV_SUFFIX_BASE_URL = "_BASE_URL";
const ENV_SUFFIX_MODEL = "_MODEL";
const ENV_SUFFIX_API_KEY = "_API_KEY_ENV"; // names the ENV VAR that holds the key

/**
 * no-default-provider A2: the harness NEVER silently selects a network
 * provider. defaultProviderFor returns the FIRST user-configured profile
 * (providers.config.json row or env entry) - or null (callers fall back to
 * echo). No healthz probing, no env-default rows, no network in ANY path.
 * @returns {Promise<object|null>} a profile row (source "tui"|"env") or null
 */
export async function defaultProviderFor(env, { profiles = [] } = {}) {
  const e = env ?? {};
  const configured = [
    ...(Array.isArray(profiles) ? profiles : []),
    ...listEnvProviders(e),
  ].filter((r) => r && typeof r === "object");
  if (configured.length === 0) return null;
  const first = configured[0];
  return { ...first };
}

/** id charset for env discovery (spec: ID [A-Z0-9_]+). */
const ENV_ID_RE = /^[A-Z0-9_]+$/;
/** TUI-profile id charset (spec §3: lowercase [a-z0-9-]). */
export const TUI_ID_RE = /^[a-z0-9-]+$/;

/**
 * Discover env-declared providers. Env shape:
 *   HARNESS_PROVIDER_<ID>_BASE_URL   = https://…        (required — defines the entry)
 *   HARNESS_PROVIDER_<ID>_MODEL      = model name       (optional; openai-compat requires one at build)
 *   HARNESS_PROVIDER_<ID>_API_KEY_ENV= ENV VAR NAME     (optional; NAME, never a value)
 * Deterministic order: sorted by id.
 * @param {object|string[]} env the env object (or entries pairs) to read
 * @returns {Array<{id:string, baseUrl:string, model?:string, apiKeyEnv?:string, source:"env"}>}
 */
export function listEnvProviders(env) {
  const e = env ?? {};
  const ids = new Set();
  for (const [k, v] of Object.entries(e)) {
    if (!k.startsWith(ENV_PREFIX) || !k.endsWith(ENV_SUFFIX_BASE_URL)) continue;
    const id = k.slice(ENV_PREFIX.length, -ENV_SUFFIX_BASE_URL.length);
    if (!ENV_ID_RE.test(id)) continue;
    if (typeof v !== "string" || v === "") continue;
    ids.add(id);
  }
  return [...ids].sort().map((id) => {
    const entry = {
      id: id.toLowerCase(),
      baseUrl: e[`${ENV_PREFIX}${id}${ENV_SUFFIX_BASE_URL}`],
      source: "env",
    };
    const model = e[`${ENV_PREFIX}${id}${ENV_SUFFIX_MODEL}`];
    if (typeof model === "string" && model !== "") entry.model = model;
    const apiKeyEnv = e[`${ENV_PREFIX}${id}${ENV_SUFFIX_API_KEY}`];
    if (typeof apiKeyEnv === "string" && apiKeyEnv !== "") entry.apiKeyEnv = apiKeyEnv;
    const ctxLimit = Number(e[`${ENV_PREFIX}${id}_CONTEXT_LIMIT`]);
    if (Number.isFinite(ctxLimit) && ctxLimit > 0) entry.contextLimit = Math.floor(ctxLimit);
    return entry;
  });
}

/**
 * Build a live provider from an entry + env. The api KEY VALUE is read from
 * env[apiKeyEnv] here and here only — it never leaves this call.
 * @param {{id?:string, baseUrl:string, model:string, apiKeyEnv?:string}} entry
 * @param {object} env
 */
export function buildFromEnv(entry, env) {
  const e = env ?? {};
  if (!entry?.baseUrl) throw new Error("registry entry requires baseUrl");
  if (!entry?.model) throw new Error("openai-compat provider requires a model");
  const apiKey = entry.apiKeyEnv ? e[entry.apiKeyEnv] : undefined;
  const provider = createOpenAICompatProvider({
    id: entry.id ?? "openai",
    baseUrl: entry.baseUrl,
    model: entry.model,
    apiKey,
  });
  // v0.5.0 H5: threads the row's context limit into the provider object
  // (read by the loop's compaction snapshot; absent → the DEFAULTS value).
  if (Number.isFinite(entry.contextLimit) && entry.contextLimit > 0) {
    provider.contextLimit = Math.floor(entry.contextLimit);
  }
  return provider;
}

/**
 * Normalize one profile row (whitelist fields; drop everything else, so no
 * stray key-VALUE field can ever persist even if a caller passes one).
 * @returns {{id:string, baseUrl:string, model:string, apiKeyEnv?:string, source:"env"|"tui"}}
 */
function rowOf(p) {
  if (!p || typeof p !== "object") return null;
  const row = {
    id: String(p.id),
    baseUrl: String(p.baseUrl ?? ""),
    model: String(p.model ?? ""),
    source: p.source === "env" ? "env" : "tui",
  };
  // v0.5.0 H5: per-provider context limit (NOT a secret — stored plainly).
  if (Number.isFinite(p.contextLimit) && p.contextLimit > 0) {
    row.contextLimit = Math.floor(p.contextLimit);
  }
  if (row.model === "") delete row.model; // env rows may be model-less
  if (typeof p.apiKeyEnv === "string" && p.apiKeyEnv !== "") row.apiKeyEnv = p.apiKeyEnv;
  return row;
}

/** Serialize profiles to disk. FILTERED SHAPE ONLY {version, providers} — the
 *  whitelist above is the serialization boundary for secrets: apiKey values
 *  never enter a row, so they never reach the file. */
export async function saveProfiles(file, list) {
  const providers = (Array.isArray(list) ? list : []).map(rowOf).filter(Boolean);
  const payload = { version: PROFILES_VERSION, providers };
  await writeFile(file, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return providers.length;
}

/**
 * Load profiles. Absent or corrupt file = empty list + warn (a warn function
 * is optional; the caller may log it — a corrupt file never blocks startup).
 * @returns {Promise<Array>} normalized rows (empty on any read/parse failure)
 */
export async function loadProfiles(file, { warn = null } = {}) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return []; // absent = empty; not worth a warn
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    if (typeof warn === "function") warn(`providers.config.json unparseable: ${err.message} (using empty list)`);
    return [];
  }
  if (data === null || typeof data !== "object" || !Array.isArray(data.providers)) {
    if (typeof warn === "function") warn("providers.config.json has wrong shape (using empty list)");
    return [];
  }
  return data.providers.map(rowOf).filter(Boolean);
}

/**
 * provider-edit §2: update one tui-sourced profile by id. Load → patch the
 * matching source:"tui" row through the rowOf whitelist (value fields are
 * dropped at the serialization boundary, same as save) → save.
 * The id itself NEVER changes (it is the stable key mappings reference).
 * @returns {Promise<object|null>} the new row, or null if id not found /
 *   not a tui row (env rows are owned by env; edit-through is refused here).
 */
export async function updateProfile(file, id, patch) {
  const rows = await loadProfiles(file);
  const idx = rows.findIndex((r) => r.id === id && r.source === "tui");
  if (idx === -1) return null;
  const merged = rowOf({
    ...rows[idx],
    ...Object.fromEntries(Object.entries(patch ?? {}).filter(([, v]) => v !== undefined)),
    id: rows[idx].id, // id is immutable even if the patch claims otherwise
  });
  rows[idx] = merged;
  await saveProfiles(file, rows);
  return merged;
}

export default { listEnvProviders, buildFromEnv, saveProfiles, loadProfiles, updateProfile, defaultProviderFor, PROFILES_VERSION };
