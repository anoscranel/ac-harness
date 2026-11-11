// src/types.d.ts — DOCUMENTATION ONLY (nothing compiles this; the gates are
// `node --check` + `node --test`). The normative interface contract is the
// fixture: fixtures/events.v1.jsonl + test/events.conformance.test.js.

/** Event envelope — fixed key order is part of the canonical form. */
export interface HarnessEvent {
  seq: number; // 0-based, gapless, assigned by the single writer
  ts: number; // seconds, ms precision — VOLATILE, stripped from canonical form
  type: string; // see EVENT_TYPES in src/events.js (exhaustive v1 set)
  actor: "harness" | "tool" | "provider" | "policy" | "plugin" | "compaction";
  data: Record<string, unknown>; // per-type canonical key order in events.js
}

/** Provider stream protocol (echo + openai-compat). */
export type ProviderFrame =
  | { delta: string; done: false }
  | {
      done: true;
      finish: "stop" | "tool_calls";
      usage: { input_tokens: number; cached_tokens: number; output_tokens: number };
      estimate: boolean;
      chars: number;
      tool_calls?: { call_id: string; name: string; args: Record<string, unknown> }[];
    };

export interface Provider {
  id: string;
  model?: string;
  stream(
    request: { model?: string; messages: Message[]; tools: ToolSchema[] },
    opts: { signal?: AbortSignal },
  ): AsyncGenerator<ProviderFrame>;
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  kind: "system" | "user" | "assistant" | "tool-result";
  turn_index: number;
  pinned: boolean;
  call_id?: string;
  event_span?: { first: number; last: number };
}

export interface ToolSchema {
  name: string;
  description: string;
  argsSchema: Record<string, unknown>; // JSON-Schema subset (src/internal/jsonschema.js)
}

export interface ToolResult {
  ok: boolean;
  output: string;
  error?: string;
  bytes?: number;
}

/** Policy */
export interface Rule {
  id: string;
  effect: "allow" | "ask" | "deny";
  match: { tool?: string | string[]; path_prefix?: string; command_includes?: string };
}
export interface PolicyDecision {
  verdict: "allow" | "ask" | "deny";
  rule_path: string;
  violation?: { kind: string; path?: string; tool?: string };
}

/** Compaction (specs/compaction-trigger.md v2) */
export interface UsageSnapshot {
  input_tokens: number;
  cached_tokens: number;
  output_reserve: number;
  context_limit: number;
  estimate: boolean;
}
export type Decision =
  | { version: 1; verdict: "none" }
  | {
      version: 1;
      verdict: "compact";
      ranges: { start: number; end: number; event_log_span: { first: number; last: number } }[];
      strategy: "summarise" | "drop" | "offload";
      reason: string;
    }
  | { version: 1; verdict: "block"; reason: string };
