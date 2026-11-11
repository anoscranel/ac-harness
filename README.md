# agent-harness

A production open-source AI agent **harness** — the loop, tools, providers,
policy, event log, plugins and MCP wiring around a model. It is not a
framework wrapper and never a model.

- **Node >= 24, pure ESM, ZERO npm dependencies.** Every import is a `node:*`
  builtin. The only runtime non-builtin is the `rg` binary (grep tool).
- **Event-sourced:** a single-writer append-only JSONL event log is the
  checkpoint, the replay source, and the observability surface.
- **Policy-gated:** rules-as-data; deny > ask > allow; zero matches = deny.

## Architecture

```
                 ┌──────────────────────────────────────────────┐
                 │                  EVENT LOG                    │
                 │  append-only JSONL · single writer · seq 0..N │
                 │  canonical form: strip ts + duration_ms       │
                 └───────────────▲───────────────┬──────────────┘
                                 │ append        │ replay (no exec)
        ┌────────────────────────┴─────────────────────────────┐
        │                        LOOP                           │
        │  reason ──▶ act ──▶ observe ──▶ reason ──▶ …          │
        │    │           │                                      │
        │    │           ▼                                      │
        │    │      POLICY GATE ── deny > ask > allow           │
        │    │           │            zero matches = DENY       │
        │    ▼           ▼                                      │
        │ PROVIDERS    TOOLS: read write edit grep(rg) bash     │
        │ echo (CI)    MCP client (stdio, spawn gated)          │
        │ openai-compat (fetch+SSE, AbortController)            │
        └────────────────────────┬─────────────────────────────┘
                                 │
        ┌────────────────────────┴─────────────────────────────┐
        │  CONTEXT (compaction seam)  ·  VERIFY-GATE after edits│
        │  decide() pure, v2 spec     ·  node --check + --test  │
        └───────────────────────────────────────────────────────┘
        ┌───────────────────────────────────────────────────────┐
        │  INTERFACES: JSON-RPC 2.0 NDJSON stdio server · REPL  │
        │  PLUGINS: manifest-declared capabilities, in-process  │
        └───────────────────────────────────────────────────────┘
```

## Spec conformance

| Seam | Spec | Implementation | Test |
|---|---|---|---|
| Event envelope, canonical form, single writer | `specs/invariants.md` §1, §4 | `src/events.js` | `test/events.conformance.test.js` |
| Replay = no execution | `specs/invariants.md` §3 | `src/cli.js replay` | `test/loop.smoke.test.js` (determinism) |
| Determinism fixture | `specs/invariants.md` §6 | `fixtures/events.v1.jsonl` | `test/events.conformance.test.js` |
| Compaction trigger (v2) | `specs/compaction-trigger.md` | `src/context.js` (`decide`, `PINNED_TAIL_TURNS=4`, ratio 0.80) | `test/context.test.js` |
| Plugin manifest + loader | `specs/plugin-manifest.md` + `schemas/plugin-manifest.schema.json` | `src/plugins/loader.js` | `test/manifests.conformance.test.js` |
| Policy semantics | PLAN area 7 | `src/policy.js`, `src/policy-defaults.js` | `test/loop.smoke.test.js` |
| Verify gate | PLAN area 6 | `src/verify.js` | wired into `src/loop.js` |
| Headless server | PLAN area 8 | `src/server.js` (JSON-RPC 2.0 NDJSON stdio) | — (smoke via `node src/server.js`) |
| MCP client | PLAN area 2 | `src/mcp-client.js` (initialize, tools/list, tools/call) | — |

## How to run

```sh
npm run check        # node --check every src/test/scripts file
npm test             # node --test (auto-discovery)
npm run chat         # interactive REPL (echo provider; /policy /resume /compact /replay)
npm run replay -- logs/<session>.jsonl   # canonical replay, prints sha256
node src/tui/main.js # alt-screen TUI (echo provider; needs a real tty)
sh bench/ship-gate.sh  # pre-push gate: check + tests + DC6 + name-guard + zero-dep
node src/server.js   # headless JSON-RPC 2.0 stdio server
```

The REPL's echo provider is deterministic and network-free. A tool call is
proposed by typing `tool:<name> <json-args>`, e.g.
`tool:read {"path":"README.md"}`.

Plugins: the REPL loads `plugins/` and the per-user local
`plugins.config.json` — both anchored on the repository root, so launching
from a foreign cwd loads the same plugins (the config file is gitignored and
never committed). Server mode instead takes `pluginConfig` over JSON-RPC in
`session.create` — it does not read the local file; that asymmetry is
deliberate (a headless server's config arrives with the session request).

## Zero-dependency statement

The npm dependency tree is EMPTY. There is no transpiler and no build step;
type-check-lite is `node --check` plus `node --test`. The single external
runtime dependency is the `ripgrep` binary (`rg`), spawned as a subprocess by
the grep tool; the tool warns and fails gracefully when `rg` is absent, and
the env preflight asserts `rg --version` and `node --version >= 24`.

## Event log durability (CVE-class note)

Appends are single awaited writes **without fsync**. A crash can lose the tail
of the log. This is an accepted, documented v1 risk (specs/invariants.md §4):
the log is the checkpoint, so a lost tail means the last events may be absent
on resume. Attestations quote sha256 hashes of canonical transcripts, never
log contents; the log path is gitignored.

### Abort

`abort()` cancels the in-flight turn only (a fresh controller is created per
turn, so the session is never bricked). An in-flight provider chunk write may
land after the abort — the log is append-only, so the record stays consistent.

## Replay determinism guarantee (and its volatile-key pinning)

`replay` reproduces the **canonical form** of a run: per event, `ts` is
dropped and every `duration_ms` key is stripped recursively, then the event is
re-serialized in the fixed envelope key order `{seq, type, actor, data}` and
LF-terminated. Those two volatile keys are pinned as the ONLY clock-dependent
fields; everything else in a transcript is deterministic given the same input
(the echo provider is a pure function of the request). Tools and providers are
NEVER re-executed during replay; `policy.ask.resolved` reproduces the recorded
answer. Attestation = two sha256s (source canonical, replayed canonical).

## Provider proxy caveat

The OpenAI-compatible provider uses the bare `fetch` global. Environment proxy
variables (`HTTP_PROXY`, `HTTPS_PROXY`, …) are **NOT honoured by default**.
If your deployment needs an egress proxy, pass an explicit `dispatcher` when
constructing the provider — and say so in your policy rules, because egress is
otherwise assumed to be direct.

## Zero-cache note

The harness keeps no response cache and no prompt cache. `cached_tokens` is
reported by providers (0 for echo) but the harness itself never replays a
provider answer from memory: every turn is a fresh provider call, and the only
"memory" is the event log.

## v1 threat model

See SECURITY.md. Short version: **first-party plugins only**. v1 plugins run
in-process, fully trusted; the manifest is a declaration surface, not an
enforcement boundary. The policy engine gates tool CALLS, not module
behaviour. Secret redaction is best-effort pattern matching, not a guarantee.
Secret redaction applies to the event log only; provider-bound message content
is NOT re-screened — do not point the agent at credential stores.

## Limitations (stated plainly)

- **The trifecta limit.** An agent with simultaneous access to (1) private
  data, (2) untrusted content, and (3) an egress channel can be induced to
  exfiltrate. v1 does NOT claim to solve this. v1's mitigations are partial:
  no web-fetch tool (egress only via bash/MCP, both gated `ask` by default),
  policy-gated tool calls, and a pinned log-path deny. That is risk reduction,
  not a proof. Treat any run combining all three as unsafe.
- **Compaction `summarise` is a stub.** The default policy emits
  `strategy:"summarise"`; the v1 applier replaces ranged tool-result messages
  with a marker that preserves the `event_log_span` so replay can re-expand
  originals. Real summarisation lives behind the `compaction-trigger` plugin
  hook (a `single` hook).
- **MCP client is stdio-only** and speaks the widely-deployed protocol
  revision by default (`2025-03-26`); the 2026-07-28 redesign (breaking) is
  behind the `protocolVersion` option.
- **Time-travel branches, never rewrites.** `resume(seq)` rebuilds state from
  events `<= seq`; new events append at the tail of the append-only log.

## Licence

Apache-2.0 (see LICENSE). Contributions under DCO 1.1 (see CONTRIBUTING.md).
