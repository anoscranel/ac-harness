# Milestones 003b + 004 — summary

Gate: `node --check` all files OK; `node --test` 23/23 green; DC6 grep clean;
server + REPL + replay smoke-tested end-to-end (node v24.18.0, rg 15.2.0).

003b files: `src/loop.js` (reason→act→observe, AbortController at top, mid-tool
child kill, checkpoint = event log, time-travel via `resume(seq)`, driver API
start/resume/abort/events/end), `src/policy-defaults.js` (pinned log deny id +
asks for bash/mcp), `src/providers/echo.js` (pure, deterministic, chunked, no
network), `src/providers/openai-compat.js` (fetch + AbortController + minimal
SSE, `stream_options.include_usage=true`, chars/4 fallback flagged
estimate:true), `src/tools/{read,write,edit,grep,bash}.js` + `index.js`
(inline JSON-Schema args, rg graceful-fail, bash gated ahead of spawn),
`src/context.js` (decide v2: 0.80 ratio, `PINNED_TAIL_TURNS=4`, half-open
ranges with event_log_span, pure), `src/internal/jsonschema.js` (shared
hand-rolled subset). Tests: `test/context.test.js`, `test/loop.smoke.test.js`
(incl. DC2 determinism: two echo runs → identical canonical sha256).

004 files: `src/server.js` (JSON-RPC 2.0 NDJSON stdio: session.create /
session.prompt / session.cancel / session.events; policy.ask resolved over the
wire, 30s deny-on-timeout), `src/cli.js` (REPL: /policy /resume /compact
/replay; serialized line handling), `src/plugins/loader.js` (lstat discovery,
symlink reject, schema validation, folder-name match, cap-vs-declared check,
compat grammar x.y.z|^x.y.z|>=x.y.z else compat-warn, chain vs single hooks
with lexicographic winner, tools.<plugin>.<tool> namespacing, lazy
pathToFileURL import), `src/mcp-client.js` (stdio JSON-RPC; initialize,
tools/list, tools/call only; spawn through the policy engine),
`src/verify.js` (default gate: node --check edited files, then node --test;
failure = loop pauses and asks), `test/manifests.conformance.test.js` (8
fixtures + compat + loader behaviour), `schemas/plugin-manifest.schema.json`
(byte-identical normative copy), `README.md` (architecture, conformance table,
zero-dep, threat model, proxy caveat, zero-cache, replay determinism +
volatile-key pinning, trifecta LIMITATION), `bench/grep-no-closed.sh` (DC6),
`src/types.d.ts` (documentation only).

Deviations: see `findings/deviations.md` (8 entries; the load-bearing ones:
MsgMeta event_span extension #2, compat schema-vs-loader resolution #3,
verify-gate logged via tool events #5).

Bug found and fixed during validation: the REPL processed lines concurrently,
so a fast `/quit` could kill an in-flight turn before its first append
(empty log). Fixed by serializing line handling through a promise queue and
guarding `rl.prompt()` against use-after-close.
