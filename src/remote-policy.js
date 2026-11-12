// src/remote-policy.js — ship-3: the SHARED remote-caller policy shaping
// (spec §0 threat model). Both remote surfaces (mcp-server, acp) route every
// call through this module so the two can never drift:
//
//  - REMOTE_HIDDEN_TOOLS: delegate + memory_remember are NOT exposed to any
//    remote caller (filtered out of tools/list entirely — a client cannot
//    even see them). A remote caller spawning child agents or writing
//    durable memory is a privilege escalation surface with no v1
//    justification.
//  - remoteDecide: `ask` resolves to DENY for a remote caller. A remote
//    caller that could answer its own permission prompt would be granting
//    itself permission, so it never gets the question. The session-rule
//    `always` mechanism is NOT available to remote callers.
//  - The pinned log-path deny is untouched: it lives in Policy.evaluate
//    before any of this and applies identically to remote calls.
//
// Pure module: no I/O, no clock. Unit-tested first (spec build order 1).

import { Policy } from "./policy.js";

/** Tools a remote caller may never see or call (spec §0). */
export const REMOTE_HIDDEN_TOOLS = Object.freeze(["delegate", "memory_remember"]);

/**
 * Decide a call for a remote caller. Same Policy engine, same rules, one
 * difference: `ask` can never be answered here — it maps to deny with a
 * legible reason. `allow` runs; `deny` denies (with the rule path).
 * @param {Policy} policy
 * @param {{tool:string, args?:object}} call
 * @returns {{verdict:"allow"|"deny", rule_path:string, reason?:string}}
 */
export function remoteDecide(policy, call) {
  const decision = policy.evaluate(call);
  if (decision.verdict === "allow") {
    return { verdict: "allow", rule_path: decision.rule_path };
  }
  if (decision.verdict === "deny") {
    return {
      verdict: "deny",
      rule_path: decision.rule_path,
      reason: `denied by policy (${decision.rule_path})`,
      ...(decision.violation ? { violation: decision.violation } : {}),
    };
  }
  // ask → deny: the remote caller cannot answer a permission prompt.
  return {
    verdict: "deny",
    rule_path: decision.rule_path,
    reason: "remote callers cannot answer permission prompts; ask resolves to deny",
  };
}

/**
 * Project the registry's tool list for a remote caller: one
 * {name, description, inputSchema} per exposed tool, hidden tools REMOVED.
 * @param {{schemas: () => Array<{name, description, argsSchema}>}} registry
 * @returns {Array<{name: string, description: string, inputSchema: object}>}
 */
export function remoteToolList(registry) {
  return registry
    .schemas()
    .filter((t) => !REMOTE_HIDDEN_TOOLS.includes(t.name))
    .map((t) => ({ name: t.name, description: t.description, inputSchema: t.argsSchema }));
}

/**
 * Reject calls to hidden tools BEFORE any policy evaluation is logged —
 * hidden means not- callable, not just not-listed.
 * @param {string} toolName
 * @returns {boolean}
 */
export function isHiddenFromRemote(toolName) {
  return REMOTE_HIDDEN_TOOLS.includes(toolName);
}

export default { REMOTE_HIDDEN_TOOLS, remoteDecide, remoteToolList, isHiddenFromRemote };
