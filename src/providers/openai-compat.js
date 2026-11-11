// src/providers/openai-compat.js — OpenAI-compatible Chat Completions provider.
// Pure `fetch` global + AbortController + a minimal SSE parser (~no SDK).
// Sends stream_options.include_usage=true; when the endpoint still returns no
// usage, falls back to a chars/4 estimate flagged estimate:true (the loop then
// emits usage.estimated). Env proxies are NOT honoured by default (README §
// proxy caveat); pass a custom dispatcher via opts if you need one.
//
// review-r1 hardening:
//  F15 — 429/5xx admission: respect Retry-After, else bounded exponential
//        backoff with ±25% jitter; max 3 attempts, then throw (the loop logs
//        session.error — the "logged event").
//  F16 — finish_reason mapped faithfully: stop/length/content_filter/
//        tool_calls; anything else falls back to "stop".
//  F17 — a stream ending without [DONE] yields a final frame with
//        truncated:true (the loop records it in turn.provider.response).
//  F18 — per-chunk idle timeout (30s) aborts a stalled stream; multi-line
//        `data:` events are aggregated before JSON.parse (spec-legal SSE).
//
// Stream protocol: same as src/providers/echo.js.

const MAX_ATTEMPTS = 3;
const IDLE_TIMEOUT_MS = 30_000;

function sleep(ms, signal) {
  return new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      const e = new Error("aborted");
      e.name = "AbortError";
      rej(e);
    }, { once: true });
  });
}

/** Bounded exponential backoff with ±25% jitter; Retry-After wins. */
function retryDelayMs(attempt, retryAfterHeader) {
  const ra = Number(retryAfterHeader);
  if (Number.isFinite(ra) && ra >= 0) return Math.min(ra * 1000, 60_000);
  const base = 500 * 2 ** attempt;
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.min(base + jitter, 30_000);
}

function mapFinishReason(reason) {
  switch (reason) {
    case "stop":
    case "length":
    case "content_filter":
    case "tool_calls":
      return reason;
    default:
      return "stop"; // fallback only (F16)
  }
}

export function createOpenAICompatProvider({
  id = "openai",
  baseUrl,
  apiKey,
  model,
  dispatcher, // optional undici-style dispatcher seam; undefined = default
} = {}) {
  if (!baseUrl) throw new Error("openai-compat provider requires baseUrl");
  if (!model) throw new Error("openai-compat provider requires model");

  async function* stream(request, { signal } = {}) {
    const body = {
      model,
      messages: request.messages.map((m) => {
        const out = { role: m.role, content: m.content };
        if (m.role === "tool" && m.call_id) out.tool_call_id = m.call_id;
        return out;
      }),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (Array.isArray(request.tools) && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.argsSchema },
      }));
    }

    const headers = { "content-type": "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    // F15: bounded retry on 429/5xx.
    let res = null;
    let lastErr = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal,
          ...(dispatcher ? { dispatcher } : {}),
        });
        if (res.ok && res.body) break;
        if (res.status === 429 || res.status >= 500) {
          const delay = retryDelayMs(attempt, res.headers.get("retry-after"));
          if (attempt < MAX_ATTEMPTS - 1) await sleep(delay, signal);
          lastErr = new Error(`provider HTTP ${res.status}`);
          res = null;
          continue;
        }
        const tail = (await res.text().catch(() => "")).slice(0, 500);
        throw new Error(`provider HTTP ${res.status}: ${tail}`);
      } catch (err) {
        if (err?.name === "AbortError") throw err;
        lastErr = err;
        res = null;
        if (attempt < MAX_ATTEMPTS - 1) await sleep(retryDelayMs(attempt, null), signal);
      }
    }
    if (!res) throw lastErr ?? new Error("provider request failed after retries");

    // SSE parser (F18): events separated by blank lines; multiple data: lines
    // in one event are joined with "\n" before JSON.parse. Per-chunk idle
    // timeout aborts a stalled stream.
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8"); // U+FFFD replacement on bad bytes
    let buf = "";
    let usage = null;
    let finish = "stop";
    let sawDone = false; // F17
    const toolCalls = new Map(); // index -> { call_id, name, argsJson }
    let outChars = 0;

    const handleData = (data) => {
      if (data === "[DONE]") {
        sawDone = true;
        return null;
      }
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        return null; // tolerate keep-alives / partials
      }
      if (json.usage) usage = json.usage;
      const choice = json.choices?.[0];
      if (choice?.finish_reason) finish = mapFinishReason(choice.finish_reason); // F16
      const delta = choice?.delta;
      if (delta?.content) {
        outChars += delta.content.length;
        return delta.content;
      }
      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const acc = toolCalls.get(idx) ?? { call_id: tc.id ?? `call_${idx}`, name: "", argsJson: "" };
          if (tc.id) acc.call_id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (tc.function?.arguments) acc.argsJson += tc.function.arguments;
          toolCalls.set(idx, acc);
        }
      }
      return null;
    };

    // Read one SSE event (terminated by a blank line) with an idle timeout.
    const readEvent = async () => {
      for (;;) {
        const m = /\r?\n\r?\n/.exec(buf);
        if (m) {
          const rawEvent = buf.slice(0, m.index);
          buf = buf.slice(m.index + m[0].length);
          const dataLines = [];
          for (const line of rawEvent.split(/\r?\n/)) {
            if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          }
          return dataLines.length > 0 ? dataLines.join("\n") : null;
        }
        let idle;
        const idleTimeout = new Promise((_, rej) => {
          idle = setTimeout(() => {
            const e = new Error("provider stream idle timeout (30s)");
            e.name = "StreamIdleTimeout";
            rej(e);
          }, IDLE_TIMEOUT_MS);
        });
        try {
          const { done, value } = await Promise.race([reader.read(), idleTimeout]);
          if (done) return buf.length > 0 ? buf : undefined; // flush tail, then end
          buf += decoder.decode(value, { stream: true });
        } finally {
          clearTimeout(idle);
        }
      }
    };

    for (;;) {
      const data = await readEvent();
      if (data === undefined) break; // stream ended
      const text = handleData(data);
      if (text !== null) yield { delta: text, done: false };
      if (sawDone) break;
    }

    const tool_calls = [...toolCalls.values()]
      .filter((tc) => tc.name)
      .map((tc) => {
        let args = {};
        try {
          args = JSON.parse(tc.argsJson || "{}");
        } catch {
          args = { _unparseable: tc.argsJson };
        }
        return { call_id: tc.call_id, name: tc.name, args };
      });
    if (tool_calls.length > 0) finish = "tool_calls";

    const inChars = request.messages.reduce(
      (n, m) => n + (typeof m.content === "string" ? m.content.length : 0),
      0,
    );
    const truncated = !sawDone; // F17: no [DONE] = truncated stream
    const base = {
      done: true,
      finish,
      estimate: false,
      chars: inChars + outChars,
      ...(truncated ? { truncated: true } : {}),
      ...(tool_calls.length ? { tool_calls } : {}),
    };
    if (usage) {
      yield {
        ...base,
        usage: {
          input_tokens: usage.prompt_tokens ?? 0,
          cached_tokens: usage.prompt_tokens ?? 0,
          output_tokens: usage.completion_tokens ?? 0,
        },
      };
    } else {
      // Fallback estimate: chars/4, flagged. The loop emits usage.estimated.
      yield {
        ...base,
        estimate: true,
        usage: {
          input_tokens: Math.ceil(inChars / 4),
          cached_tokens: 0,
          output_tokens: Math.ceil(outChars / 4),
        },
      };
    }
  }

  return { id, model, stream };
}

export default createOpenAICompatProvider;
