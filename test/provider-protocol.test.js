// test/provider-protocol.test.js — v0.4.0 Ship 1: the request-body protocol
// CONTRACT (tools round-trip). Built through the REAL provider module with a
// fake fetchFn that captures the JSON it would POST. The loop/resume/compaction
// cases below reuse the same body-builder so every layer is pinned to ONE
// wire shape.
// REDACTOR HAZARD: no secret-shaped fixtures needed; control chars None.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenAICompatProvider } from "../src/providers/openai-compat.js";
import { EventLog } from "../src/events.js";
import { Policy } from "../src/policy.js";
import { defaultRules } from "../src/policy-defaults.js";
import { createRegistry } from "../src/tools/index.js";
import echo from "../src/providers/echo.js";
import { decide } from "../src/context.js";
import { createLoop } from "../src/loop.js";

/** Minimal committed SSE response for the injected fetchFn. */
function sseOk() {
  let done = false;
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          if (done) return { done: true, value: undefined };
          done = true;
          return {
            done: false,
            value: new TextEncoder().encode(
              "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1}}\n\ndata: [DONE]\n\n",
            ),
          };
        },
      }),
    },
  };
}

/**
 * Build the request body the provider WOULD POST for a message list and
 * return its parsed messages array (the wire shape under test).
 * @param {Array} messages harness-shape messages
 */
async function wireMessages(messages) {
  let captured = null;
  const provider = createOpenAICompatProvider({
    id: "probe",
    baseUrl: "https://probe.test/v1",
    model: "probe-model",
    fetchFn: async (_url, init) => {
      captured = JSON.parse(init.body);
      return sseOk();
    },
  });
  try {
    for await (const _chunk of provider.stream({ messages, tools: [] }, {})) {
      void _chunk;
      break; // first chunk is enough; the body was captured at fetch time
    }
  } catch {
    /* stream shape irrelevant — body is what we assert on */
  }
  assert.ok(captured !== null, "fetchFn captured the request body");
  return captured.messages;
}

test("1.1 serializer: assistant tool_calls round-trip the OpenAI wire shape", async () => {
  const messages = [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ call_id: "call-1", name: "read", args: { path: "x" } }],
    },
    { role: "tool", call_id: "call-1", content: "the file body" },
    { role: "user", content: "go on" },
  ];
  const wire = await wireMessages(messages);
  assert.equal(wire.length, 4);
  // assistant carrying tool_calls: content null when no text, id/type/function
  assert.deepEqual(wire[1], {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call-1",
        type: "function",
        function: { name: "read", arguments: "{\"path\":\"x\"}" }, // STRING
      },
    ],
  }, "assistant tool_calls emitted in the provider-native shape");
  // the following tool message references the SAME call id
  assert.equal(wire[2].tool_call_id, "call-1", "tool_call_id matches the assistant's call id");
  assert.equal(wire[2].role, "tool");
  assert.equal(wire[2].content, "the file body");
});

test("1.1 serializer: arguments stored as an object are stringified; a stored string passes through", async () => {
  const messages = [
    { role: "assistant", content: "", tool_calls: [{ call_id: "c2", name: "bash", args: { command: "ls" } }] },
    { role: "assistant", content: "", tool_calls: [{ call_id: "c3", name: "bash", args: "{\"command\":\"ls\"}" }] },
  ];
  const wire = await wireMessages(messages);
  assert.equal(wire[0].tool_calls[0].function.arguments, "{\"command\":\"ls\"}");
  assert.equal(wire[1].tool_calls[0].function.arguments, "{\"command\":\"ls\"}");
  assert.equal(wire[0].content, null);
  assert.equal(wire[1].content, null);
});

test("1.1 serializer: plain messages byte-identical to the historical shape (no regression)", async () => {
  const messages = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" }, // text-only: NO tool_calls key
    { role: "tool", call_id: "old-1", content: "data" }, // tool_call_id kept as-is
    { role: "user", content: "again" },
  ];
  const wire = await wireMessages(messages);
  assert.deepEqual(wire[0], { role: "user", content: "hello" });
  assert.deepEqual(wire[1], { role: "assistant", content: "hi there" });
  assert.ok(!("tool_calls" in wire[1]), "never emit tool_calls on a text-only assistant");
  assert.deepEqual(wire[2], { role: "tool", content: "data", tool_call_id: "old-1" });
  assert.deepEqual(wire[3], { role: "user", content: "again" });
});

test("1.1 serializer: never emit an EMPTY tool_calls array", async () => {
  const messages = [{ role: "assistant", content: "plain", tool_calls: [] }];
  const wire = await wireMessages(messages);
  assert.ok(!("tool_calls" in wire[0]), "empty tool_calls suppressed");
  assert.equal(wire[0].content, "plain");
});

test("1.3+1.5 loop: echo tool-call turn stores + resumes tool_calls (round trip)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-proto-"));
  try {
    const target = join(dir, "data.txt");
    await writeFile(target, "payload bytes", "utf8");
    const logPath = join(dir, "events.jsonl");
    const log = await EventLog.open(logPath);
    const policy = new Policy({ rules: defaultRules(), logPath });
    const loop = createLoop({
      provider: echo,
      tools: createRegistry(),
      policy,
      log,
      decide,
      askResolver: async () => "allow",
      config: { session: "proto" },
    });
    const res = await loop.start(`tool:read {"path":${JSON.stringify(target)}}`);
    await loop.end();
    // the turn completed (tool ran, then echo answered with its content)
    assert.ok(res.text.includes("payload bytes"), "sanity: the tool round tripped");

    // live message list passes the 1.1 wire shape (assistant with tool_calls
    // followed by a tool message with the matching id)
    const assistant = loop.state.messages.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0);
    assert.ok(assistant, "assistant message stores tool_calls (1.3)");
    assert.ok(assistant.tool_calls[0].call_id, "provider-native call objects kept");
    const wire = await wireMessages(loop.state.messages).catch(async (err) => {
      // tool:read marks assistant content "" → serialize works; a probe error
      // means the shape broke — rethrow
      throw err;
    });
    const wireAssistant = wire.find((m) => m.tool_calls?.length > 0);
    assert.ok(wireAssistant, "wire has the tool_calls assistant");
    const wireTool = wire.filter((m) => m.role === "tool");
    assert.ok(wireTool.length >= 1, "wire has the tool result");
    assert.equal(wireTool[0].tool_call_id, wireAssistant.tool_calls[0].id, "ids pair");

    // 1.5: resume rebuilds the SAME message list (tool_calls included)
    const log2 = await EventLog.open(logPath);
    const loop2 = createLoop({
      provider: echo,
      tools: createRegistry(),
      policy: new Policy({ rules: defaultRules(), logPath }),
      log: log2,
      decide,
      askResolver: async () => "allow",
      config: { session: "proto" },
    });
    await loop2.resume(Number.MAX_SAFE_INTEGER);
    const resumedAssistant = loop2.state.messages.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0);
    assert.ok(resumedAssistant, "resume rebuilds tool_calls (1.5)");
    assert.equal(resumedAssistant.tool_calls[0].call_id, assistant.tool_calls[0].call_id, "ids preserved on resume");
    const wire2 = await wireMessages(loop2.state.messages);
    const wa2 = wire2.find((m) => m.tool_calls?.length > 0);
    const wt2 = wire2.filter((m) => m.role === "tool");
    assert.equal(wt2[0].tool_call_id, wa2.tool_calls[0].id, "resumed list is protocol-valid");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("1.4 cap: max_iterations exhaustion closes each dangling call with a tool message + turn.cap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-proto-"));
  try {
    const logPath = join(dir, "events.jsonl");
    const log = await EventLog.open(logPath);
    const policy = new Policy({ rules: defaultRules(), logPath });
    // ONE loop, two phases (state.messages is per-loop — the dangling pair
    // from turn 1 must be closed by turn 2's cap in the SAME transcript).
    let phase = 1;
    const provider = {
      id: "two-phase",
      model: "two-phase",
      async *stream(request) {
        yield { delta: "", done: false };
        if (phase === 1) {
          yield {
            done: true, finish: "tool_calls",
            usage: { input_tokens: 1, cached_tokens: 0, output_tokens: 1 },
            estimate: false, chars: 1,
            tool_calls: [{ call_id: "call-dangling-1", name: "read", args: { path: "whatever" } }], // PHASE-1-ONLY id
          };
          return; // phase 1 proposes ONLY this frame (a second done-frame would overwrite `final`)
        }
        // phase 2: propose a fresh call every iteration (never converges);
        // ids distinct from phase 1's (a shared id would answer the dangling
        // pair collaterally — the test wants the CAP to close it)
        yield {
          done: true, finish: "tool_calls",
          usage: { input_tokens: 1, cached_tokens: 0, output_tokens: 1 },
          estimate: false, chars: 1,
          tool_calls: [{ call_id: `call-spin-${request.messages.length}-${request.messages.length}`, name: "read", args: { path: "missing" } }],
        };
      },
    };
    const throwingTools = {
      schemas: () => [],
      run: async (name) => {
        if (name === "read" && phase === 1) throw new Error("simulated tool runner failure");
        return { ok: false, output: "ENOENT", error: "missing path" };
      },
    };
    const loop = createLoop({
      provider,
      tools: throwingTools,
      policy,
      log,
      decide,
      askResolver: async () => "allow",
      config: { session: "cap", max_iterations: 2 },
    });
    // Phase 1: the tool runner throws BEFORE a result message can be pushed —
    // a genuine dangling pair arises, and Ship 2's finalizeTurn (every exit
    // path closes dangling calls) must close it AT THE ERROR TURN with
    // reason "error". (Pre-Ship-2 the pair stayed dangling; that premise
    // became historical once finalizeTurn landed.)
    await loop.start("phase one").catch(() => {});
    const assistantA = loop.state.messages.find((m) => m.role === "assistant" && m.tool_calls?.length);
    assert.ok(assistantA, "assistant carries tool_calls");
    const closerAtError = loop.state.messages.find((m) => m.role === "tool" && m.call_id === "call-dangling-1");
    assert.ok(closerAtError, "finalize closed the pair at the error turn (Ship 2.1)");
    assert.match(closerAtError.content, /turn ended/);
    const end1 = log.events.filter((e) => e.type === "turn.end").at(-1);
    assert.ok(end1, "error turn emitted turn.end");
    assert.equal(end1.data.reason, "error");
    assert.ok(end1.data.closed_calls.includes("call-dangling-1"), "closed_calls recorded at the error turn");
    // Phase 2: same loop; the turn proposes + "runs" a call per iteration
    // (the runner answers with an error result — answered), then caps out.
    // The dangling pair from phase 1 was ALREADY closed by finalizeTurn at
    // the error turn (Ship 2.1), so the cap's job here is the turn.cap event
    // and the cap-reason turn.end with closed_calls reflecting nothing NEW.
    phase = 2;
    await loop.start("phase two");
    await loop.end();
    const capEv = log.events.find((e) => e.type === "turn.cap");
    assert.ok(capEv, "turn.cap logged");
    assert.equal(capEv.data.max_iterations, 2);
    assert.ok(Array.isArray(capEv.data.closed_calls), "closed_calls recorded");
    const capEnd = log.events.filter((e) => e.type === "turn.end").at(-1);
    assert.equal(capEnd.data.reason, "cap", "capped turn ends with reason cap");
    const closer = loop.state.messages.find((m) => m.role === "tool" && m.call_id === "call-dangling-1");
    assert.ok(closer, "dangling call has its tool message (closed at the error turn)");
    // the closed transcript serializes protocol-valid: every id answered
    const wire = await wireMessages(loop.state.messages);
    for (const m of wire.filter((x) => x.tool_calls?.length)) {
      for (const c of m.tool_calls) {
        assert.ok(wire.some((t) => t.role === "tool" && t.tool_call_id === c.id), `wire: ${c.id} answered`);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("1.6 compaction: every remaining tool_calls id keeps a matching tool message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-proto-"));
  try {
    const logPath = join(dir, "events.jsonl");
    const log = await EventLog.open(logPath);
    const policy = new Policy({ rules: defaultRules(), logPath });
    // First: a 2-call conversation (two tool turns), then force compaction of
    // the older range via a decide stub that compacts everything not pinned.
    const target = join(dir, "f.txt");
    await writeFile(target, "x".repeat(4096), "utf8"); // beefy tool outputs
    const loop = createLoop({
      provider: echo,
      tools: createRegistry(),
      policy,
      log,
      decide,
      askResolver: async () => "allow",
      config: { session: "compact-pair" },
    });
    await loop.start(`tool:read {"path":${JSON.stringify(target)}}`);
    await loop.start(`tool:read {"path":${JSON.stringify(target)}}`);
    await loop.end();
    const assistantsWithCalls = loop.state.messages.filter((m) => m.role === "assistant" && m.tool_calls?.length);
    assert.equal(assistantsWithCalls.length, 2, "two tool calls happened");

    // Apply the module-level applier with a range covering the FIRST assistant
    // and its tool results (the harness's real applier, invoked directly):
    const { default: loopModule } = await import("../src/loop.js");
    void loopModule;
    // Locate indices: user,assistant(tool_calls),tool,assistant(tool_calls? echo answers text) —
    // apply over the prefix [0..3) (everything before the 2nd turn's tool result):
    const msgs = loop.state.messages;
    const range = { start: 0, end: Math.min(3, msgs.length), event_log_span: { first: 0, last: 0 } };
    // use the exported applier path the loop itself uses — replicate via the
    // public surface: re-run the apply on a resumed loop instead:
    const log2 = await EventLog.open(logPath);
    const compaction = { version: 1, ranges: [range], strategy: "summarise" };
    await log2.appendEvent("compaction.applied", "compaction", {
      version: 1,
      ranges: compaction.ranges,
      strategy: compaction.strategy,
      freed_events: 0,
    });
    void compaction;
    const loop2 = createLoop({
      provider: echo,
      tools: createRegistry(),
      policy: new Policy({ rules: defaultRules(), logPath }),
      log: log2,
      decide,
      askResolver: async () => "allow",
      config: { session: "compact-pair2" },
    });
    await loop2.resume(Number.MAX_SAFE_INTEGER);
    // resume replays the compaction.applied event through the SAME applier
    const remaining = loop2.state.messages;
    for (const m of remaining) {
      for (const c of m.tool_calls ?? []) {
        assert.ok(
          remaining.some((t) => t.role === "tool" && t.call_id === c.call_id) || /compacted|dropped/.test(m.content ?? ""),
          `tool_calls ${c.call_id} still paired post-compaction (1.6)`,
        );
      }
    }
    // and the compacted list serializes protocol-valid
    const wire = await wireMessages(remaining);
    for (const m of wire.filter((x) => x.tool_calls?.length)) {
      for (const c of m.tool_calls) {
        assert.ok(wire.some((t) => t.role === "tool" && t.tool_call_id === c.id), `wire: ${c.id} answered post-compaction`);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("serializer accepts BOTH stored shapes and never emits an undefined name", async () => {
  // Desk probe regression (v0.4.0 ship 1): the harness stores {call_id,name,args},
  // but a log or plugin may carry provider-native {id,function:{name,arguments}}.
  // The native shape silently produced name:undefined + arguments:"{}" — a
  // protocol-invalid transcript no test caught.
  const cases = [
    { label: "internal", call: { call_id: "c1", name: "read", args: { path: "a.txt" } } },
    { label: "native", call: { id: "c2", type: "function", function: { name: "read", arguments: '{"path":"b"}' } } },
  ];
  for (const { label, call } of cases) {
    const wire = await wireMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [call] },
    ]);
    const tc = wire[1].tool_calls[0];
    assert.equal(tc.function.name, "read", `${label}: name must survive`);
    assert.equal(typeof tc.function.arguments, "string", `${label}: arguments must be a string`);
    assert.match(tc.function.arguments, /path/, `${label}: args payload must survive`);
    assert.ok(tc.id, `${label}: id must be present`);
  }
  // a call with no resolvable name must throw rather than emit an invalid body.
  // The body is built lazily inside the stream() generator, so the throw surfaces
  // on iteration — asserting on stream() alone would pass vacuously.
  const nameless = createOpenAICompatProvider({
    id: "t", baseUrl: "http://x/v1", model: "m",
    fetchFn: async () => { throw new Error("should not reach fetch"); },
  });
  await assert.rejects(
    async () => {
      for await (const _c of nameless.stream({
        messages: [{ role: "assistant", content: null, tool_calls: [{ id: "x" }] }], tools: [],
      }, {})) void _c;
    },
    /missing a function name/,
  );
});
