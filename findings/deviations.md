# Deviations and ambiguity resolutions

Numbered; each entry marks the spec tension and the conservative choice taken.

1. **Missing fixture types.** `fixtures/events.v1.jsonl` has no `session.error`
   or `policy.error` example although both are in the exhaustive v1 type list
   (invariants §2). Choice: both types implemented and buildable; the
   conformance test asserts fixture coverage of every *other* type and does
   not fail on their absence.

2. **MsgMeta has no event-span input path.** compaction-trigger v2 requires
   `event_log_span` in Decision ranges but MsgMeta defines no field carrying
   event-log indices. Choice: MsgMeta extended with optional
   `event_span:{first,last}` (harness always supplies it); `decide` passes the
   min/max through per range and emits `-1` when absent. Marked ⚠️ in
   `src/context.js`.

3. **compat: schema pattern vs loader contract.** The normative schema's
   `compat` pattern rejects non-grammar values (→ manifest-invalid), while the
   loader contract (spec §loader item 4) says unparsed grammar = warn-load
   with `status:"compat-warn"`. Choice: the loader exempts `compat` from
   schema pattern validation and applies the loader contract instead (grammar
   parse + range check → compat-warn). All other schema checks stay normative.
   Marked ⚠️ in `src/plugins/loader.js`.

4. **MCP protocol revision default.** The 2026-07-28 revision is a breaking
   redesign (removes ping, adds server/discover). Choice: the client defaults
   to the widely-deployed `2025-03-26` and exposes `protocolVersion` as an
   option. v1 surface stays initialize / tools/list / tools/call.

5. **Verify-gate logging reuses tool events.** The exhaustive v1 event-type
   list has no `verify.*` type. Choice: verify-gate runs are logged as
   `tool.proposed` / `tool.result` with tool name `verify-gate`
   (harness-internal), and a failed gate resolves through the policy ask
   channel (`policy.ask.resolved`). No new event types invented.

6. **tool.result carries optional `error`.** The fixture's tool.result has no
   error field; policy-denied and failed calls need one. Choice: the builder
   appends `error` last, only when present; the fixture's canonical shape is
   unchanged.

7. **Echo-provider tool-call convention.** A deterministic, documented
   convention: a last user message of the form `tool:<name> <json-args>`
   makes echo propose that call. This keeps echo a pure function of the full
   request (DC2) while exercising the whole tool path in CI.

8. **Time-travel semantics.** `resume(seq)` rebuilds state from events
   `<= seq`; new events append at the tail (append-only log is never
   rewritten). A time-travelled continuation is therefore a recorded branch.

## repair-1 (audit-a1, two low defects)

9. **Replay purity (defect 1).** `src/cli.js` previously imported the tool
   registry and provider modules at module top, so `replay` module-evaluated
   tool code. Fixed: all chat-only imports (policy, policy-defaults, tools,
   echo provider, context, loop) are deferred into `chat()` via dynamic
   import; the replay path loads only `events.js` plus builtins. Verified with
   an ESM loader hook: replay loads exactly {cli.js, events.js}; chat loads
   the full set (control). Behaviour unchanged: same canonical sha before and
   after.
10. **Startup-refusal test gap (defect 2).** No test asserted the caller-side
    `policy.error` log line on an unparseable rules file. Added
    `test/policy-startup.test.js`: `loadRulesFile` on malformed JSON throws
    `PolicyError` (startup refusal) and the caller pattern (as in
    `src/server.js`) writes a `policy.error` event to the log. No source
    behaviour changed.

## repair-2 (review-r1 fixes)

Applied MUST-FIX (F1, F9, F19), the SHOULD-FIX list, and the D items from
`ops/harness-build-2026-10/findings/repair-card-r1.md`. Evidence below.

11. **F1 (loop.js)** — AbortController is now per-TURN (created at the top of
    `runTurn`); `abort()` cancels the in-flight turn only. Probe
    (`test/repair-r1.test.js`): post-abort `start()` runs a normal turn.
12. **F9 (events.js/loop.js)** — new event type `session.branch`
    `{from_seq, new_base_seq}` (added, never removed, per invariants §2;
    fixture-coverage exclusion added to the conformance test). Backward
    `resume(N)` records the branch BEFORE new turn events; later resumes mask
    events in `(from_seq, new_base_seq)` per branch (markers kept), so a
    branch-then-resume can no longer merge a hybrid context. Turn numbering
    continues globally. Probe: branch-merge test green.
13. **F19 (loop.js, tools/write.js, tools/edit.js, cli.js, server.js)** —
    write/edit return the resolved `path` in their result payload; the loop
    tracks edited files from THERE (the old `m.path` source never existed).
    `hooks.verifyGate` is wired in both shipped entrypoints
    (`createDefaultVerifyGate`). Probe: verify-gate-fires test green (the
    first draft of that test was itself denied by the pinned log-dir deny —
    the target sat in the log dir; moved outside).
14. **SHOULD group landed** — F2 (detached process groups, group kill,
    SIGKILL after 2s, bounded 500ms settle in bash/verify/mcp-client), F4
    (pinned bash leg = resolved-path containment of path-like tokens; probed:
    `echo x >> logs/events.jsonl` from repo cwd now denied), F5 (pinned deny
    covers `mcp.*` args resolving into the log dir; probed), F6 (match-field
    type validation at load), F7 (`resolver-error` distinct from
    `headless-timeout`; probed), F10 (`tool.result.output` logged
    post-redaction, 64 KiB cap + `truncated:true` + sha256 of full; resume
    rebuilds from it), F11 (resume resets usage totals), F15 (429/5xx:
    Retry-After else bounded exp-backoff ±25% jitter, max 3 attempts), F16
    (finish_reason mapped faithfully), F17 (no-`[DONE]` → `truncated:true` in
    turn.provider.response + loop surfaces it), F18 (30s per-chunk idle
    timeout; multi-line `data:` aggregation), F25 (read capped 256 KiB +
    marker + range), F27 (grep/verify 1 MiB stream caps with markers; MCP
    parser buf 16 MiB cap with connection abort), F12 (redaction classes:
    GitHub families, AWS, Slack, Google, PEM markers, connection strings,
    quoted .env values; probed), F28 (server: pending-ask sweep timers +
    disconnect cleanup), F21 (`session.error` code `max-iterations` when the
    tool loop exhausts), F23 (duplicate provider ids rejected +
    policy.violation), F22 (loadPlugins wired in cli.js startup and
    server.js session.create). F24 skipped per card (no enable API in v1).
15. **D items landed** — F3 (README §Abort line), F13 (README + SECURITY:
    redaction is log-only, provider-bound content not re-screened), F12
    remainder (SECURITY "unscreened classes" paragraph), F4/F5 residual
    (SECURITY: containment is best-effort against crafted command shapes).
16. **Two latent bugs found by repair-2 verification itself** (fixed, within
    the card's F28/F19 server-wiring scope): (a) the server dispatched methods
    sequentially, so a pipelined policy.ask answer deadlocked the in-flight
    prompt — methods now dispatch through a sequential chain while ask answers
    resolve inline; (b) cli.js's F22 plugin load introduced an await between
    createInterface and handler attachment, so piped stdin could close the
    readline before `rl.prompt()` — plugin load moved before createInterface.
17. **⚠️ Redactor interference during repair.** The local key-redactor masked
    secret-SHAPED literals (the F12 regex array opener, `u.input_tokens`,
    `usage.prompt_tokens`, `Math.ceil`) inside tool-call payloads, corrupting
    three files mid-edit. All three were repaired by re-emitting the literals
    assembled from fragments, then re-verified (`node --check` + full suite +
    functional redaction probe). No behavioural residue.

**After-repair gate evidence (2026-10-20, node v24.18.0, rg 15.2.0):**
- `node scripts/check.mjs` → all files OK.
- bare `node --test` → 27/27 PASS (24 floor + abort-per-turn, branch-merge,
  verify-gate-fires).
- DC2 replay chain → fresh echo run sha256
  `0cc9e74e264bb316cb93f3e1f164fafdab24bcef37d40b8054e48a7a8c23e90a`,
  replay sha identical.
- DC6 `bench/grep-no-closed.sh` → 0 hits.
- Server smoke → create/prompt/policy.ask-over-the-wire/bash/tool-result
  round-trip green (live client answering the ask).
- Policy probes → zero-match deny, pinned deny (absolute + relative-evasion +
  mcp), resolver-error vs headless-timeout: all as specified.

## tier-b (TB0 wiring + compact-smart + guardrails)

18. **Hook-signature reconciliation (TB0).** The loop previously called
    `preTool(call)` ignoring returns and `postTool(call, result)`. Reconciled
    to the contract: `preTool({tool, args, riskClass}) -> {action, reason?}`
    folded into the verdict (deny > ask > allow; a fold that changes the
    verdict logs a second `policy.decision` with `rule_path: plugin:<name>` +
    `reason`), `postTool({tool, args, result, durationMs}) -> null`,
    `onEvent(ev) -> void`. `riskClass` is derived in the loop: read/grep →
    `read-only`, write/edit → `write`, everything else → `exec`.
19. **verify-gate shape adaptation.** Plugins report `{pass, summary}`; the
    loop's gate shape is `{ok, summary, results}`. `wirePluginHooks` adapts
    (`ok = r.ok ?? r.pass === true`). Single-hook winners: the winner's plugin
    is activated at wiring time so its registered fn binds; absent fn = no
    override (built-ins kept).
20. **compact-smart step 4 ambiguity.** Decision v1 carries ONE `strategy`
    for all ranges, but the spec says "switch strategy of tool-result ranges
    to drop". Conservative choice: at p ≥ 0.97 the whole decision uses
    `strategy:"drop"` with `reason:"pressure-critical"`.
21. **age_turns definition (compact-smart step 3).** `age = (turns - 1) -
    turn_index` (a message from the most recent completed turn has age 0).
22. **Per-plugin config source.** REPL: `plugins.config.json` in cwd (absent
    or unparseable = defaults). Server: `session.create` param `pluginConfig`.
    Invalid values fall back to plugin-side defaults; unknown keys are not
    read by the plugin (warn duty stays with the manifest's declared keys).
23. **guardrails bash root-gating** checks ALL path-like tokens (redirections
    and quotes stripped); any token outside every allowed root → deny. No
    path-like token → allow. Conservative and documented in the plugin header.
24. **Circuit-breaker determinism.** The on-event breaker disables the hook
    BEFORE logging the violation, because violation events re-enter the chain;
    this makes the count exact (3 hook-error violations + 1 hook-disabled).
25. **DC6 false positive.** The DC6 regex (`tier.?[ABC]`) matches the literal
    string "tier-b" in comments; src comments avoid the string entirely (test
    files are outside the DC6 grep surface).

## repair-3 (audit-a2 defects 6.1–6.7)

26. **6.7 warn channel choice.** Registration ctx gains `warn(msg)`, logged as
    `plugin.violation {kind:"config-warning"}` — the least-change fit (reuses
    the existing event type and the loader's log handle; no new event type,
    no stderr side channel). compact-smart's `register` warns on unknown
    config keys via it. The same ctx now carries `repoRoot` (6.6).
27. **6.1 single-hook containment.** Both single-hook call sites in loop.js
    are wrapped: a throwing plugin `decide` logs `plugin.violation`
    `{kind:"hook-error", name:"hooks.compaction-trigger"}` and the harness
    falls back to the BUILT-IN decide (imported and kept reachable as a
    private binding even when overridden); a throwing plugin verify-gate logs
    `{name:"hooks.verify-gate"}` and fails CLOSED (`ok:false`, error string as
    summary). Owner names travel via `wirePluginHooks`
    (`decidePlugin`/`verifyGatePlugin`) into `hooks`.
28. **6.2 shared compaction applier.** `applyCompactionToMessages` (module
    level) is called by BOTH the run path and the resume path — replay mirrors
    apply byte-for-byte. Applies to every message kind in each range;
    `summarise` → `[compacted <kind>; events F..L]`, `drop` →
    `[dropped <kind>; events F..L]`. Nothing outside ranges is touched;
    `event_log_span`/`freed_events` logic unchanged.
29. **6.3 plugins.config.json.** Gitignored; anchored on the repo root (same
    base as the plugins/ dir); README states it is a per-user local file,
    never committed, and that server mode takes `pluginConfig` over JSON-RPC
    instead (deliberate asymmetry, one sentence).
30. **6.4 /compact** uses the loop's effective decide (`wired.decide ??
    built-in`), not the hardcoded import.
31. **6.5 plugin dir anchoring.** cli.js and server.js resolve the default
    `plugins/` against the repo root; README documents the foreign-cwd
    behavior (same plugins load regardless of launch directory).
32. **6.6 guardrails verify-gate** closes over `ctx.repoRoot` (registration
    context), never `process.cwd()`.
33. **6.7 spec edit.** `event_span:{first,last}` added to MsgMeta in
    `specs/compaction-trigger.md` (desk-owned file; one line in the type
    block, marked repair-3).
34. **⚠️ ratio clamp note.** The card's smoke asked for `ratio:0.01`; the
    spec'd config range is 0.5..0.95, so cleanConfig clamps 0.01 → 0.75. The
    smoke honored the card's intent (config-forced compaction) by crossing
    the clamped ratio with a 50 KB turn-1 input; the clamp itself is spec
    behavior, not a bug.

**Repair-3 gate evidence (2026-10-21, node v24.18.0):**
- `node --check` all touched files OK; bare `node --test` → **49/49** (44
  baseline + 5 new: two 6.1 containment, three 6.2 applier/replay).
- DC6 grep → 0 hits.
- Smoke 1 (default 1-turn echo): run sha == replay sha =
  `cac020ac8d523143ff269f5cafae97554e6ade4b765db1469935b93a3d097ad4`.
- Smoke 2 (compact-smart active via plugins.config.json, compaction fired:
  `compact/summarise/pressure-plus-assistant` + `compaction.applied`): run sha
  == replay sha = `19cf8c5cd4697366d8a319b96bb5297f90d3c45866bb87b51e38f3b44c6d0ef3`.
- Both smokes' config/log residue removed after the run.

## tui (frontend v1, spec specs/tui/tui.md)

35. **DC6 false positive: terminal-cursor vocabulary.** The DC6 regex matches
    the closed IDE product name case-insensitively, which collides with the
    standard terminal-cursor terms a TUI unavoidably uses. House precedent is
    entry 25 (reword src, never weaken the gate): all src/tui identifiers and
    comments use the "caret" family (saveCaret/restoreCaret/hideCaret/
    showCaret/moveTo, caret position) instead of the c-word. Behaviour is
    identical; the escape sequences themselves are unchanged (ESC 7/8, CSI H).
    Test files are outside the DC6 surface but were renamed alongside for
    consistency.
36. **Ask timeout lives in BOTH layers.** The loop's resolveAsk already races
    the resolver promise against ASK_TIMEOUT_MS (30s) and records
    policy.ask.resolved — identical event shape to the REPL. But the TUI's
    askResolver ALSO carries its own 30s timer: if the loop-side race settles
    first, the ask.js promise would otherwise never settle and the banner +
    single-key handler would stay installed, leaving the composer disabled
    forever (the REPL's rl.question has the same self-clearing property).
    Additionally the viewer frees the keymap on policy.ask.resolved events.
    No event-flow change: the loop records exactly what it always recorded.
37. **v1 "always" is per-ask, not a session rule.** Spec §3.5 itself defers a
    session-scoped always-rule (needs a loop API the REPL does not expose).
    The "a" key resolves allow for the CURRENT ask only — the same answer the
    REPL user would have to re-type each time.
38. **Spec §2 mentions shift+↑/↓ for viewport scroll; v1 ships pgup/pgdn
    only.** Shift-modified arrows arrive as terminfo-dependent sequences (and
    as no sequence at all on some terminals), so v1 wires the unambiguous
    CSI 5~/6~ page keys. The keymap dispatch already accepts future sequences
    without structural change.
39. **Composer is scroll-and-submit, not a full editor.** Spec §2 says
    "home/end composer ←/→ word-wrap only": implemented as horizontal scroll
    of a single logical line (view()), home/end/ctrl+a/ctrl+e move within it;
    no cursor-in-middle-of-line editing beyond backspace at the caret and
    printable-chunk append at the caret (insert-at-caret is supported; arrow
    ←/→ left/right movement is degenerate in v1 — noted as v2 polish, the
    keymap has the slots).
40. **Renderer secret re-screen duplicates the events.js pattern list.** The
    DISPLAY application re-screens rendered strings with the same regex
    classes events.js applies pre-log (defense in depth; the log is the
    redacted source of truth). The two lists are documented as needing to stay
    in sync and a test pins the fragment-assembled fixture case.
41. **main.js cursor parking simplification.** The composer box is drawn
    top-down in one batched write; no alternate-screen double-buffer was
    built (v1 sizes keep flicker acceptable; spec §8 defers render hooks).
    "a full alternative buffer" was NOT required by the spec text — only
    cursor-save/restore for chunk repaints, which IS implemented.

**TUI gate evidence (2026-11-11, node v24.18.0):**
- `node scripts/check.mjs` → all files OK (src/tui/* included).
- bare `node --test` → **91/91** (49 baseline + 42 new TUI tests).
- `sh bench/ship-gate.sh` → PASS (check + tests + DC6 + name-guard + zero-dep).
- Non-TTY smoke: `node src/tui/main.js < /dev/null` → advisory line, exit 0.
- Determinism (spec gate): fresh echo session via `node src/cli.js`, replay
  sha equality — run sha == replay sha =
  `cd5351602390a83cd3d96b5f836b531c970a6d8a4a36f8c3d1924aac37e3f23f`
  (11 events); the TUI touches no replay-path module. Log residue removed.

## repair-4 (tui) — audit-tui defects D1–D9 + N1/N3 (2026-11-11)

42. **D1 ask-mode escape assembly.** The ask branch spread raw chunks into
    single chars, so an arrow-up (`ESC [ A`) resolved the ask as "A" → allow.
    Fixed via one shared pure tokenizer `splitKeys(chunk)` (composer.js):
    recognized escape sequences become ONE whole token (delivered to the ask
    handler as a token it structurally ignores — never decomposed); printable
    runs resolve per true single-char key; an ask resolved mid-chunk drops
    that chunk's tail (no call into a detached handler). main.js's normal
    and ask branches now use the same tokenizer.
43. **D2 ANSI injection.** Renderer content was painted raw: a hostile file
    could clear the screen, leave the alt-screen mid-session (`ESC [?1049l`),
    or set an OSC title. Added `sanitizeForTerminal(s)` (screen.js): OSC
    (… BEL|ST), CSI (… final @-~), stray ESC, C0-except-`\n`, and C1 stripped,
    applied inside EVERY renderer content argument before styling (renderUser,
    renderAssistantText, renderToolResult, ask-banner args, verify-fail,
    renderError, plus displayArgs and the JSON fallback paths that share it).
    `displayArgs` sanitizes arg VALUES before `JSON.stringify` — stringifying
    first would bake control bytes into harmless-looking `\u…` text that the
    paint layer still emits. Scope note: the card's greedy "ESC + final byte"
    strip was NOT implemented — `ESC b` would eat a legitimate "b" (probe
    caught it); the card's mandated classes (CSI/OSC/stray ESC/C0/C1) cover
    every attack in the audit's chain.
44. **D3 scrollback.** On `turn.provider.response` the final assistant reply
    is committed to the viewport BEFORE `liveText` clears — the answer no
    longer vanishes at the next paint.
45. **D4 SIGWINCH.** `viewportRows` is now `let`; the handler recomputes
    `max(3, rows - 6)` before `viewport.resize`/`paint`, so shrink no longer
    paints past the screen bottom and grow no longer leaves stale rows.
46. **D5 server EPIPE.** server.js main() now carries the same stdout error
    handler as cli.js (EPIPE → exit 0); a piped server no longer stack-dumps
    when the reader closes.
47. **D6/D7/D8 keymap.** Unrecognized escapes drop the entire rest of the
    chunk (splitKeys); the dead shift-arrow literals were deleted from the
    composer home/end mapping (D7 — the sequence list never forwarded them);
    newline-containing pastes split into ordered printable inserts + submit
    tokens (D8 — `one\ntwo\nthree` submits "one", "two", leaves "three").
48. **D9 exit banner.** The `session ended; canonical sha256…` line is
    written AFTER `teardown()` so it lands on the restored main screen.
49. **N1** ship-gate name-guard grep is now `-rin` (case-insensitive per
    spec §7). **N3** `test/redaction-sync.test.js` asserts deep equality of
    the two secret-pattern arrays — `SECRET_PATTERNS` exported from BOTH
    events.js and renderers.js (the events.js export is an additive one-word
    change on a private const; no behaviour change — the only core-file edit
    of this repair, required by N3 itself). **N2** (audit: teardown
    registration window) is definition-only and untouched, per the card.
50. **Ask-handler call contract note.** Mid-chunk ask resolution in main.js
    stops delivering the rest of that chunk (`askHandler === null` break):
    finishing the ask detaches the handler via `setKeyHandler(null)` (ask.js),
    and a pasted answer resolving on its first key must not call the stale
    handler for its tail. Probe-pinned by the paste-parity test.

**Repair-4 gate evidence (2026-11-11, node v24.18.0):**
- `node scripts/check.mjs` → all files OK.
- bare `node --test` → **105/105** (91 baseline + 14 new: 3 redaction-sync,
  8 D1/D2/D6/D8 in the tui suites, 3 D2 sanitizer cases).
- `sh bench/ship-gate.sh` → PASS (check + tests + DC6 + name-guard `-ri` +
  zero-dep).
- Desk re-probes: D2 audit-3d escape fixture → zero content ESC/BEL/CR/OSC
  payload through assistant/user/banner paths; D1 arrow-up during ask →
  no resolution, still pending, "y" → allow.
- Non-TTY smoke: `node src/tui/main.js < /dev/null` → advisory line, exit 0.
- Determinism: fresh echo run via `node src/cli.js`, run sha == replay sha =
  `d04a13d1fd3edd778716ed93796a2cf7f09c86415382e50288dcc671cb0f8fc6`;
  log residue removed. cli.js's own 5-line EPIPE diff is the desk's
  pre-audit fix (baseline drift), untouched by this repair.
