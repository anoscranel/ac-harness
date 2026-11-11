// src/policy.js — rules-as-data policy engine.
//
// Semantics (PLAN area 7):
//  - Overall evaluation = collect ALL matching rules; deny > ask > allow.
//  - Zero matches = DENY (fail closed).
//  - An unparseable rule file = startup refusal; the caller logs policy.error.
//  - A PINNED default deny, unoverridable, covers write/edit/bash against the
//    event-log path (and its directory). Attempts are surfaced as
//    violation:{kind:"log-path-write"} for the caller to log as
//    policy.violation (specs/invariants.md §4).
//  - `ask` unresolved in headless mode = deny, logged as policy.ask.resolved
//    with resolved_by:"headless-timeout" (timeout 30s).

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";

export const ASK_TIMEOUT_MS = 30_000;

export class PolicyError extends Error {
  constructor(message, source) {
    super(message);
    this.name = "PolicyError";
    this.source = source;
  }
}

/**
 * Load a rules file (JSON array of rules). Any parse/validation failure is a
 * PolicyError — the caller must refuse startup and log policy.error.
 *
 * Rule shape (data):
 *   { id: string,
 *     effect: "allow" | "ask" | "deny",
 *     match: { tool?: string|string[],   // exact, "*", or "prefix.*"
 *              path_prefix?: string,     // matched against resolved args.path
 *              command_includes?: string } } // matched against bash command
 */
export async function loadRulesFile(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new PolicyError(`cannot read rules file ${path}: ${err.message}`, path);
  }
  let rules;
  try {
    rules = JSON.parse(raw);
  } catch (err) {
    throw new PolicyError(`unparseable rules file ${path}: ${err.message}`, path);
  }
  if (!Array.isArray(rules)) {
    throw new PolicyError(`rules file ${path} must contain a JSON array`, path);
  }
  for (const [i, rule] of rules.entries()) {
    const ok =
      rule && typeof rule === "object" &&
      typeof rule.id === "string" && rule.id.length > 0 &&
      ["allow", "ask", "deny"].includes(rule.effect) &&
      rule.match && typeof rule.match === "object";
    if (!ok) throw new PolicyError(`rules file ${path}: rule #${i} is malformed`, path);
    // F6 (review-r1): match-field TYPES are validated at load, not discovered
    // as a crash inside evaluate().
    const m = rule.match;
    const typeOk =
      (m.tool === undefined || typeof m.tool === "string" ||
        (Array.isArray(m.tool) && m.tool.every((t) => typeof t === "string"))) &&
      (m.path_prefix === undefined || typeof m.path_prefix === "string") &&
      (m.command_includes === undefined || typeof m.command_includes === "string") &&
      (m.args_pattern === undefined || typeof m.args_pattern === "string");
    if (!typeOk) {
      throw new PolicyError(`rules file ${path}: rule #${i} ("${rule.id}") has a mistyped match field`, path);
    }
  }
  return rules;
}

function toolMatches(pattern, tool) {
  if (pattern === undefined) return true;
  const list = Array.isArray(pattern) ? pattern : [pattern];
  return list.some((p) => {
    if (p === "*") return true;
    if (p.endsWith(".*")) return tool.startsWith(p.slice(0, -1));
    return p === tool;
  });
}

function ruleMatches(rule, call) {
  const m = rule.match;
  if (!toolMatches(m.tool, call.tool)) return false;
  if (m.path_prefix !== undefined) {
    const p = call.args?.path;
    if (typeof p !== "string") return false;
    const resolved = resolve(p);
    const prefix = resolve(m.path_prefix);
    if (resolved !== prefix && !resolved.startsWith(prefix + "/")) return false;
  }
  if (m.command_includes !== undefined) {
    const c = call.args?.command;
    if (typeof c !== "string" || !c.includes(m.command_includes)) return false;
  }
  return true;
}

const EFFECT_RANK = { deny: 3, ask: 2, allow: 1 };

export class Policy {
  /**
   * @param {object} opts
   * @param {Array}  opts.rules   user + default rules (data)
   * @param {string} opts.logPath absolute path of the event log (pinned deny)
   * @param {string} [opts.cwd]   base for resolving bash path tokens
   */
  constructor({ rules = [], logPath, cwd }) {
    if (!logPath) throw new PolicyError("Policy requires logPath for the pinned deny rule");
    this.logPath = resolve(logPath);
    this.logDir = dirname(this.logPath);
    this.cwd = cwd ?? process.cwd();
    this.rules = rules;
  }

  /** Containment test: resolved p is the log file or inside the log dir. */
  #inLogDir(p) {
    return p === this.logPath || p.startsWith(this.logDir + "/");
  }

  /**
   * F4 (review-r1): bash commands are scanned as RESOLVED paths, not
   * substrings. Each token that looks like a path (contains "/") is stripped
   * of redirection operators/quotes and resolved against cwd; containment in
   * the log dir = violation. Best-effort against crafted command shapes
   * (env vars, command substitution) — residual documented in SECURITY.md.
   */
  #bashTouchesLog(command) {
    for (let tok of command.split(/\s+/)) {
      tok = tok.replace(/^(?:[0-9]*>>?|<<?)/, "").replace(/^["']|["']$/g, "");
      if (!tok.includes("/")) continue;
      let resolved;
      try {
        resolved = resolve(this.cwd, tok);
      } catch {
        continue;
      }
      if (this.#inLogDir(resolved)) return true;
    }
    return false;
  }

  /** F5 (review-r1): deep-walk MCP args for path-like strings into the log dir. */
  #argsTouchLog(value) {
    if (typeof value === "string") {
      if (!value.includes("/")) return false;
      try {
        return this.#inLogDir(resolve(this.cwd, value));
      } catch {
        return false;
      }
    }
    if (Array.isArray(value)) return value.some((v) => this.#argsTouchLog(v));
    if (value !== null && typeof value === "object") {
      return Object.values(value).some((v) => this.#argsTouchLog(v));
    }
    return false;
  }

  /**
   * The pinned, unoverridable deny: write/edit/bash against the event-log
   * path or its directory (F4), and mcp.* calls whose args resolve into it
   * (F5). Evaluated in code (not data) so no rules file can remove it; deny
   * precedence makes it unoverridable in effect.
   */
  #pinnedViolation(call) {
    const { tool, args } = call;
    if (tool === "write" || tool === "edit") {
      const p = typeof args?.path === "string" ? resolve(this.cwd, args.path) : null;
      if (p && this.#inLogDir(p)) {
        return { kind: "log-path-write", path: args.path, tool };
      }
    }
    if (tool === "bash") {
      const c = typeof args?.command === "string" ? args.command : "";
      if (c && this.#bashTouchesLog(c)) {
        return { kind: "log-path-write", path: this.logPath, tool };
      }
    }
    if (tool.startsWith("mcp.") && this.#argsTouchLog(args)) {
      return { kind: "log-path-write", path: this.logPath, tool };
    }
    return null;
  }

  /**
   * Evaluate one proposed call.
   * @param {{tool:string, args?:object}} call
   * @returns {{verdict:"allow"|"ask"|"deny", rule_path:string, violation?:object}}
   */
  evaluate(call) {
    const violation = this.#pinnedViolation(call);
    if (violation) {
      return { verdict: "deny", rule_path: "pinned.deny_log_path", violation };
    }
    const matches = this.rules.filter((r) => ruleMatches(r, call));
    if (matches.length === 0) {
      return { verdict: "deny", rule_path: "default.deny_no_match" };
    }
    matches.sort((a, b) => EFFECT_RANK[b.effect] - EFFECT_RANK[a.effect]);
    const winner = matches[0];
    return { verdict: winner.effect, rule_path: winner.id };
  }
}

/**
 * Resolve an `ask` verdict through the environment's ask channel.
 * Headless/unresolved after `timeoutMs` (default 30s) = deny, recorded as
 * resolved_by:"headless-timeout" (specs/invariants.md fixture shape).
 *
 * @param {object} o
 * @param {string} o.call_id
 * @param {(ask:{call_id:string,tool:string,args:object}) => Promise<"allow"|"deny"|undefined>} o.askFn
 * @param {string} o.tool
 * @param {object} o.args
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{verdict:"allow"|"deny", resolved_by:string, timeout_ms:number}>}
 */
export async function resolveAsk({ call_id, tool, args, askFn, timeoutMs = ASK_TIMEOUT_MS }) {
  if (typeof askFn !== "function") {
    return { verdict: "deny", resolved_by: "headless-timeout", timeout_ms: timeoutMs };
  }
  let timer;
  try {
    const answer = await Promise.race([
      Promise.resolve(askFn({ call_id, tool, args })),
      new Promise((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(undefined), timeoutMs);
      }),
    ]);
    if (answer === "allow" || answer === "deny") {
      return { verdict: answer, resolved_by: "client", timeout_ms: timeoutMs };
    }
    return { verdict: "deny", resolved_by: "headless-timeout", timeout_ms: timeoutMs };
  } catch {
    // F7 (review-r1): a throwing resolver is distinct from a timeout.
    return { verdict: "deny", resolved_by: "resolver-error", timeout_ms: timeoutMs };
  } finally {
    clearTimeout(timer);
  }
}
