// src/providers/openai-compat.js — OpenAI-compatible Chat Completions provider.
// Pure `fetch` global + AbortController + a minimal SSE parser (~no SDK).
// Sends stream_options.include_usage=true; when the endpoint still returns no
// usage, falls back to a chars/4 estimate flagged estimate:true (the loop then
// emits usage.estimated). Env proxies are NOT honoured by default (README §
// proxy caveat); pass a custom dispatcher via opts if you need one.
//
// review-r1 hardening (F16/F17/F18 kept; F15 REPLACED — see below):
//  F16 — finish_reason mapped faithfully: stop/length/content_filter/
//        tool_calls; anything else falls back to "stop".
//  F17 — a stream ending without [DONE] yields a final frame with
//        truncated:true (the loop records it in turn.provider.response).
//  F18 — per-chunk idle timeout (30s) aborts a stalled stream; multi-line
//        `data:` events are aggregated before JSON.parse (spec-legal SSE).
//
// provider-endurance (2026-11-11): F15's 3-attempt loop is REPLACED by one
// 24h endurance window PER REQUEST (specs/tui/provider-endurance.md §1):
//  - retry every flat 5s (Retry-After wins when present, capped at 60s);
//  - RETRY-FOREVER classes: 429, 408, 5xx, network errors, rate-limit-text
//    bodies, 200-with-error-payload, missing-[DONE] streams;
//  - deterministic 400/401/403/404/422 fail fast EXCEPT 401/403 from a
//    localhost upstream (local-proxy restart window — transient);
//  - AbortError always exits instantly; SSE-committed streams never re-attempted;
//  - every 12th retry surfaces via the optional onRetry(attempt, status)
//    callback so a 24h wait is never silent (events stay unchanged).
// Tests inject sleepFn/fetchFn (real timers, fake clock) via these module-level
// seams — production defaults are untouched.
//
// Stream protocol: same as src/providers/echo.js.

const DEFAULT_RETRY_INTERVAL_MS = 5_000;
const DEFAULT_ENDURANCE_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_CAP_MS = 60_000;
const ON_RETRY_EVERY = 12; // dim "…retrying" cadence
const IDLE_TIMEOUT_MS = 30_000;

/** Rate-limit-shaped body text (case-insensitive) — retry-forever class. */
export const RATE_LIMIT_RE =
  /rate limit|too many requests|quota|429|overloaded|capacity|per.minute|per.hour/i;

function defaultSleep(ms, signal) {
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

/** Retry-After header wins (seconds → ms, capped at 60s); flat intervalMs
 *  otherwise. Pure — exported for tests. Strict on the header: null/""/NaN
 *  never parse as a 0s Retry-After (Number(null) === 0 — the flat-5s path
 *  must win when the header is absent). */
export function retryDelayMs(retryAfterHeader, { intervalMs = DEFAULT_RETRY_INTERVAL_MS } = {}) {
  if (typeof retryAfterHeader === "string") {
    const ra = Number(retryAfterHeader.trim());
    if (retryAfterHeader.trim() !== "" && Number.isFinite(ra) && ra >= 0) {
      return Math.min(ra * 1000, RETRY_AFTER_CAP_MS);
    }
  }
  return intervalMs;
}

/** Localhost upstream? (127.0.0.1 / localhost / [::1]) — its 401/403 may be the
 *  local proxy's own restart window, so those retry (real endpoints stay
 *  fail-fast). Pure — exported for tests. */
export function isLocalhost(baseUrl) {
  try {
    const u = new URL(baseUrl);
    const h = u.hostname.replace(/^\[|\]$/g, ""); // URL keeps IPv6 brackets
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  } catch {
    return false;
  }
}

/** Sentinel: deterministic client errors fail FAST — the throw must escape the
 *  network-error catch below, so it is tagged and re-thrown untouched. */
class FailFastError extends Error {}

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
  retryPolicy, // {intervalMs?, enduranceMs?} — endurance window tuning (§1)
  onRetry, // optional (attempt, status) => void — every ON_RETRY_EVERY'th retry
  sleepFn = defaultSleep, // injection seam for tests (fake clock)
  fetchFn = fetch, // injection seam for tests (fake endpoints)
  nowFn = Date.now, // injection seam for tests (fake window clock)
} = {}) {
  if (!baseUrl) throw new Error("openai-compat provider requires baseUrl");
  if (!model) throw new Error("openai-compat provider requires model");
  const intervalMs = retryPolicy?.intervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
  const enduranceMs = retryPolicy?.enduranceMs ?? DEFAULT_ENDURANCE_MS;
  const localhost = isLocalhost(baseUrl);

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

    // provider-endurance §1: ONE 24h window per request. The window opens at
    // the first failed attempt; every RETRY-FOREVER class retries at the flat
    // interval (Retry-After wins, capped); deterministic client errors fail
    // fast — except 401/403 from a localhost upstream (proxy restart window).
    // AbortError exits instantly; a stream that COMMITTED (status ok, body
    // open) is never re-attempted — post-code-200 breakage is F17's business.
    let res = null;
    let lastErr = null;
    const windowStart = nowFn();
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0 && nowFn() - windowStart > enduranceMs) {
        throw lastErr ?? new Error("provider endurance window exhausted (24h)");
      }
      if (attempt > 0 && attempt % ON_RETRY_EVERY === 0 && typeof onRetry === "function") {
        try {
          onRetry(attempt, lastErr?.status ?? null);
        } catch {
          /* an onRetry throw must never break the retry loop */
        }
      }
      try {
        res = await fetchFn(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal,
          ...(dispatcher ? { dispatcher } : {}),
        });
        if (res.ok && res.body) break; // COMMITTED — never re-attempted past here
        const status = res.status;
        const retryAfterHeader = res.headers?.get?.("retry-after") ?? null;
        const tail = (await res.text().catch(() => "")).slice(0, 500); // consumed once

        const retryableStatus =
          status === 429 || status === 408 || status >= 500 ||
          ((status === 401 || status === 403) && localhost);
        const rateText = !retryableStatus && RATE_LIMIT_RE.test(tail);
        const json200Err =
          status === 200 && /^\s*\{/.test(tail) && /"error"/i.test(tail);

        if (retryableStatus || rateText || json200Err) {
          const err = new Error(
            json200Err ? `provider 200-with-error: ${tail}` : `provider HTTP ${status}`,
          );
          err.status = status;
          lastErr = err;
          res = null;
          await sleepFn(retryDelayMs(retryAfterHeader, { intervalMs }), signal);
          continue;
        }
        throw new FailFastError(`provider HTTP ${status}: ${tail}`); // fail-fast class
      } catch (err) {
        if (err?.name === "AbortError") throw err; // abort ALWAYS exits (§1)
        if (err instanceof FailFastError) throw err; // deterministic — no retry
        lastErr = err;
        res = null;
        // Network errors (ECONNREFUSED/ETIMEDOUT/EAI_AGAIN/socket hang up…)
        // are retry-forever — only the endurance window bounds them.
        await sleepFn(retryDelayMs(null, { intervalMs }), signal);
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
