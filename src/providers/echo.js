// src/providers/echo.js — deterministic, network-free provider for CI.
// A PURE function of the full request: same request in → same stream out,
// always. This is what makes golden replay byte-deterministic (DC2).
//
// Stream protocol (shared by all providers):
//   yields { delta:string, done:false } zero or more times
//   final yield: { done:true, finish:"stop"|"tool_calls",
//                  usage:{ input_tokens, cached_tokens, output_tokens },
//                  estimate:boolean, chars:int, tool_calls?:[{call_id,name,args}] }
//
// Echo "tokens" are exact character counts — deterministic by construction,
// so estimate is always false.
//
// Tool-call convention (deterministic, documented): if the last user message
// starts with `tool:<name> <json-args>`, echo proposes that tool call instead
// of answering. After a tool result arrives, echo answers with its content.

import { createHash } from "node:crypto";

export const id = "echo";
export const model = "echo";

const CHUNK_SIZE = 8;

function lastOf(messages, role) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === role) return messages[i];
  }
  return null;
}

function totalChars(messages) {
  let n = 0;
  for (const m of messages) n += typeof m.content === "string" ? m.content.length : 0;
  return n;
}

function parseToolCall(text) {
  const m = /^tool:([A-Za-z0-9_.-]+)\s+([\s\S]*)$/.exec(text.trim());
  if (!m) return null;
  let args;
  try {
    args = JSON.parse(m[2]);
  } catch {
    return null; // malformed args → treat as plain text
  }
  const call_id = "call-" + createHash("sha256").update(m[1] + m[2]).digest("hex").slice(0, 12);
  return { call_id, name: m[1], args };
}

export async function* stream(request, { signal } = {}) {
  const messages = request?.messages ?? [];
  const lastUser = lastOf(messages, "user");
  const lastTool = lastOf(messages, "tool");

  let text;
  let tool_calls;
  let finish = "stop";

  const lastMsg = messages[messages.length - 1];
  if (lastMsg && lastMsg.role === "user" && typeof lastMsg.content === "string") {
    const call = parseToolCall(lastMsg.content);
    if (call) {
      tool_calls = [call];
      finish = "tool_calls";
      text = "";
    }
  }
  if (tool_calls === undefined) {
    if (lastMsg && lastMsg.role === "tool") {
      text = `tool said: ${lastMsg.content}`;
    } else {
      text = `echo: ${lastUser?.content ?? ""}`;
    }
  }

  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    if (signal?.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    yield { delta: text.slice(i, i + CHUNK_SIZE), done: false };
  }

  yield {
    done: true,
    finish,
    usage: {
      input_tokens: totalChars(messages),
      cached_tokens: 0,
      output_tokens: text.length,
    },
    estimate: false,
    chars: totalChars(messages) + text.length,
    ...(tool_calls ? { tool_calls } : {}),
  };
}

export default { id, model, stream };
