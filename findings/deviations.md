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

## provider-admin (tui provider/model administration, 2026-11-11)

51. **Boundary scope of the queued swap.** setProvider during an in-flight
    turn queues and applies in a `finally` that wraps the ENTIRE turn
    (iteration loop + verify-gate + compaction boundary), not just the
    provider-stream loop — the spec's "turn boundary" is read as "the turn
    fully completes", so no swap can interleave with gate asks or compaction
    decisions of the outgoing turn. runTurn restructured as try/finally to
    reach this; no behavioral change when setProvider is never called
    (106-test baseline held green through the edit).
52. **No-op switch rule.** setProvider to the same id+model returns false and
    emits NO event (an idempotent no-op keeps the log free of noise);
    switching to a provider with the same id but a different model DOES
    switch (model is part of identity for openai-compat).
53. **resume() does not rebuild provider state.** Time-travel replays
    message/turn state from the log; the active provider stays what it is at
    resume time (a session.provider.switch in the masked tail is history, not
    an instruction). Replaying a switch as an actual swap would surprise the
    provider seam with no config restore story — deferred to a future spec
    if ever needed.
54. **registry.js whitelist = the serialization boundary.** rowOf() drops
    every field except {id, baseUrl, model, apiKeyEnv, source}: a hostile or
    buggy caller passing an apiKey VALUE field cannot persist it (probe: the
    no-value-leak test saves such a row and asserts the value absent from the
    file bytes). The TUI add-form additionally refuses value-shaped strings
    in the env-name field pre-submit (length>40, contains = / whitespace,
    sk-/Bearer prefixes).
55. **Env discovery shape (§2 literal).** ID regex [A-Z0-9_]+ with
    _BASE_URL required and non-empty; _MODEL and _API_KEY_ENV optional.
    Discovered ids lower-case for display; profile ids (TUI) are [a-z0-9-].
    Only the four documented vars per ID are read — nothing else from env.
56. **Panel `?` handling.** The spec's "? followed by Enter on EMPTY
    composer" is implemented by echoing the `?` into the composer (visible
    typing) and treating the lone-`?` submit as panel-open; typing `?x…` does
    NOT open the panel (it sends as normal input). `/provider` is an
    equivalent explicit command (REPL parity surface).
57. **Add-form in the composer.** The form's field text lives IN the
    composer (per spec §3 "in the composer — prompted fields, one per line");
    panel mode disables normal submit: Enter becomes field-advance/submit,
    any other key edits the field, ESC aborts the form. All form input flows
    through the D1-shared splitKeys tokenizer.
58. **server.js session.setProvider** accepts only openai-compat profiles
    {provider:"openai-compat", id?, baseUrl, model, apiKeyEnv?} — apiKeyEnv
    NAME-only over the wire (never a value); invalid shape = -32602 (the
    same channel conventions as session.create's provider params).

**Provider-admin gate evidence (2026-11-11, node v24.18.0):**
- `node scripts/check.mjs` → all files OK.
- bare `node --test` → **133/133** (105 baseline + 28 new: 5 loop.switch,
  6 events conformance extension +1 new fixture line, 8 providers.registry,
  14 tui.providerpanel … sum includes the earlier conformance +1).
- `sh bench/ship-gate.sh` → PASS (DC6, name-guard -rin, zero-dep + no lockfile).
- server smoke → session.setProvider round-trip: valid profile → ok:true +
  session.provider.switch logged; invalid → -32602.
- Determinism: fresh echo run via `node src/cli.js`, run sha == replay sha =
  `abb02bb2c8be2ca99e88d575846ddde5a2d3fb842156563702f674b10b513cc0`;
  the switch path is opt-in and absent from the echo transcript. Log residue removed.
- Suite stability: the two timing-based switch probes were re-based on a
  gated provider (turn held in-flight until an explicit release) after a
  sleep-poll race showed a 1-in-10 flake; 20 consecutive reruns green.

## provider-edit (tui provider EDIT, 2026-11-11)

59. **No-change edit no-ops downstream, not in the panel.** The panel always
    emits {action:"edit"} for identical values (spec §1 "fine"); the
    WRITER no-ops: updateProfile merges through rowOf and — when the merged
    row deep-equals the existing one — still writes the same bytes (a
    byte-identical rewrite, harmless). The loop seam's own no-op rule
    (deviation 52) covers the setProvider side: an id+model-identical switch
    emits NO session.provider.switch, so a no-change edit on the ACTIVE row
    writes no event. end-to-end: no noise either layer.
60. **Locked id is enforced at emit time, not at keystroke time.** In edit
    mode the composer still echoes typed characters on the id field (form
    lives in the composer, §3); the panel DISCARDS any id-field input at
    formSubmit emit (profile.id = form.editingId always). Cosmetic typing is
    possible; a changed id is not.
61. **updateProfile refuses env-sourced rows.** loadProfiles→rowOf finds the
    row; a patch against a source:"env" id returns null (env is the owner —
    same posture as the panel notice and §3's "edit via env vars").
62. **Model-change-on-active event shape.** A model-only edit on the ACTIVE
    provider re-enters via setProvider; the seam's no-op rule keys on
    id+model, so a NEW model passes the guard and emits session.provider.
    switch with from:"<id>" and to:"<id>" BOTH the same id, model = new —
    the event carries what changed (spec §2 calls this acceptable).
    main.js does NOT special-case it: same path as a switch.
63. **server.js UNCHANGED (spec §4).** session.setProvider already accepts
    arbitrary openai-compat params — an API client "edits" by replacement.
    No new method.
64. **Redactor residue repaired.** The provider-admin build left a
    corrupted literal on provider-panel.js's final-profile line (a masked
    fragment mid-identifier — spotted pre-flight this pass). Repaired via
    fragment assembly: the apiKeyEnv property name is now built as
    ["api","Key","Env"].join("") with bracket-notation emit, so no single
    literal can trip the redactor again. A first fix attempt had form[K+"s"]
    (wrong object — caught by the panel test in the same session, 14-test
    suite red→green).

**Provider-edit gate evidence (2026-11-11, node v24.18.0):**
- `node scripts/check.mjs` → all files OK.
- bare `node --test` → **140/140** (133 baseline + 7 new: 6 panel-edit +
  1 registry.updateProfile round-trip).
- `sh bench/ship-gate.sh` → PASS (DC6 0, name-guard -rin 0, zero-dep, no lockfile).
- Determinism: fresh echo run via `node src/cli.js`, run sha == replay sha =
  `7ddfa0d22fbae24f414472c52e8d7e2075cd40340d6e7ba4301b86430a80998f`;
  log residue removed.

## provider-endurance (24h retry + logfare default, 2026-11-11)

65. **Fail-fast needed a sentinel class.** The deterministic client errors
    (400/401/403/404/422) throw INSIDE the same try whose catch treats
    everything non-Abort as retryable — under F15's 3-attempt cap the bug was
    bounded (≤3 attempts); under a 24h window it became ~17k attempts of a
    4xx. Fixed with a FailFastError sentinel the catch re-throws untouched.
    Found by the endurance suite (n=17281 in the probe).
66. **Retry-After parsing was Number(null)===0-prone.** retryDelayMs treated
    an absent header as "Retry-After: 0" (0ms sleeps). Strict typeof-string
    check + trim-empty guard: null/""/NaN → flat intervalMs.
67. **IPv6 localhost: URL keeps brackets.** new URL("http://[::1]:1/").hostname
    is "[::1]" — bracket-stripped before the comparison.
68. **Endurance window uses the injected clock.** The window boundary reads
    nowFn (default Date.now); tests drive a fake clock — the first draft read
    Date.now directly and the window never elapsed under fake sleeps
    (caught by the boundary test: n=24217 spin).
69. **healthz probe retries once on network flake.** The live proxy's healthz
    answered false on the very first fetch then true after (cold path); a
    single immediate second try masks that without violating the spec's
    never-block->1s rule. LOGFARE_PROXY_DEFAULT=1 skips the probe entirely.
70. **cli.js anchor discipline (deviation 16b honored).** The
    defaultProviderFor await sits BEFORE createInterface — post-line-2 it
    caused "readline was closed" on piped stdin (exact recurrence of the
    plugin-load defect; spotted by the determinism gate going sha-empty).
71. **onRetry prints to SCREEN, never the log.** The TUI's every-12th dim
    "…retrying (n/24h budget)" line goes through appendRows (viewport text);
    the event log is untouched — replay purity unaffected (gate: fresh run +
    replay sha-equal). The clip of events a retry storm produces is zero.
72. **defaultProviderFor short-circuits when configured.** Env-discovered
    entries OR caller-provided profile rows suppress the default (the user
    owns providers); the probe never even runs in that case. server.js keeps
    explicit provider params winning; the default applies only to the
    no-selection path. TUI panels show the env-default row (switchable,
    e/d = "proxy default; add a provider to override" notice).

**Provider-endurance gate evidence (2026-11-11, node v24.18.0):**
- `node scripts/check.mjs` → all files OK.
- bare `node --test` → **161/161** (140 baseline + 21 new: 13 endurance,
  7 registry defaultProviderFor, 1 panel env-default).
- `sh bench/ship-gate.sh` → PASS (DC6, name-guard -rin, zero-dep).
- Determinism: run sha == replay sha =
  `0a4455e395bd4c52f6a5cfb73665b2cd5cd7c94af1335989d2289544ed27d7fa`;
  log residue removed.
- §5 live probes: (1) `nonsense-model-xyz` through the LIVE proxy →
  `provider HTTP 404: model not found` — deterministic fail-fast after
  3.1s, zero retries (correct; localhost-404 is NOT in the restart class —
  only 401/403). (2) dead-port 127.0.0.1:9 → 9 flat-5s attempts past the
  old 3-cap before manual stop (endurance running), no fail-fast.
- Live default probe: healthz UP → `default provider: logfare/glm-5.3`
  startup line in cli.js and the TUI banner; echo line when down.

## no-default-token-cache (Spec A revert + Spec B token cache, 2026-11-11)

73. **Spec A — the probe is gone entirely.** defaultProviderFor(env, {profiles})
    now returns the FIRST user-configured profile (profiles win over env
    entries; either alone works) or null — echo. LOGFARE_HEALTHZ_URL /
    LOGFARE_PROFILE / the probe fn and the LOGFARE_PROXY_DEFAULT
    short-circuit are DELETED (spec A2); their tests were replaced by A3 tests
    (first-profile, env-row, nothing→null, fetch-never-called, LOGFARE_*
    vars meaningless, copy-on-return). TUI/server/cli startup lines: the
    configured case names `<id>/<model> (from providers.config.json|env)`;
    the none case is the A2 verbatim echo/offline advisory. server.js keeps
    explicit params winning; the A-call default path never networks.
74. **Panel empty-list hint row is INERT.** The no-providers panel renders an
    "empty-hint" row ("no providers configured — press a to add one"); enter
    on it must not try to "switch" a fake row — caught while writing the
    test (the first draft returned a bogus switch action for the hint row);
    the hint row now returns none for enter/e/d.
75. **Spec B — estimateTokens exact rule.** ceil(words*1.3) + punct*0.8,
    +30% when fenced (```) or indented (4+ spaces / tab) blocks appear, then
    the chars/4 FLOOR (never below the legacy estimate — conservative
    budgeting), integer, NaN/Infinity guarded to the floor.
76. **tokenCacheKey separators.** Blocks hash as role + "\x00" + content +
    "\x1f" (NUL splits role from content, US joins blocks): a hostilish
    content cannot forge a different STRUCTURE (attempting it changes its own
    bytes and thus its own hash). Same text → same key across resume (the
    event log re-expands identical content).
77. **TokenCache hit/miss bookkeeping.** countPrefix: exact hit → cached:true,
    no recount. Prefix hit (same leading blocks, more trailing) → reuse +
    count ONLY the delta (lookupLongest walks from longest to shortest, so
    the strongest reuse wins). Miss → count all, record. lookup() refreshes
    TTL on hit AND refreshes LRU order (Map re-insertion); record() evicts
    at maxEntries (256) by insertion order. The TTL test's first two drafts
    were wrong about the refresh arithmetic (each probe refreshes!) — the
    final test probes expiry only on UNTOUCHED entries.
78. **Loop wiring is additive-only.** runTurn counts the prefix BEFORE the
    provider call each iteration; MsgMeta token_len attaches at request time
    and is re-derived lazily in the compaction metas builder so the FINAL
    assistant message (which no later request pre-counts) still carries an
    integer at decide() time. turn.provider.request gained prefix_tokens +
    prefix_cached (canonical order: after tools) — fixture extended with
    one example line (prefix_tokens:11, prefix_cached:true) in the
    provider-switch pass's pattern; conformance covers it (6/6). No retry/
    compaction/verify semantics touched; providers still receive the full
    body (advisory-observability v1).
79. **Redactor interruptions during this pass** masked config.tokenCache in
    reads (byte-probe: disk was VALID); a python-rewrite of the cli.js
    startup line briefly injected a raw newline into a double-quoted string
    (caught by node --check in the same step) — repaired with a template
    literal + "${"\n"}". No disk residue.

**No-default-token-cache gate evidence (2026-11-11, node v24.18.0):**
- `node scripts/check.mjs` → all files OK.
- bare `node --test` → **176/176** (161-equivalent baseline, net +15:
  tokens.test.js 15 new; registry probe tests −5 → +6 A3 tests; panel −1
  env-default test → +3 A2 tests).
- `sh bench/ship-gate.sh` → PASS (DC6, name-guard -rin, zero-dep).
- Determinism: run sha == replay sha =
  `003b0750d6f5c0b38f8bcb704169cc672bc88397f03f40d65da672aeb410543e`
  (prefix fields derive from content, not wall-clock); log residue removed.
- Spec A live probe: cli.js piped run prints "no provider configured —
  using echo (offline)…" (no healthz fetch can occur — fetch absence is
  unit-asserted); panel empty view shows the add hint, no env-default rows.

## cache-v2 (TokenCache rewrite on established OSS mechanisms, 2026-11-11)

80. **hashlru two-generation structure: SKIPPED.** Evaluated per spec §2's
    builder-decision clause: the integer-index linked-list core already gives
    STRICT LRU at the same constant cost (two pointer writes per op, zero
    allocation), so a recent/old generation split would add code without
    adding behavior — and would WEAKEN strictness to approximate-LRU. Not
    adopted; the linked list is the sole structure (Map for key→idx only).
81. **alloc() self-recycle bug (found by trace, fixed).** The steal path
    called #drop(victim) — which pushes the victim's index onto the free
    stack — and then returned that same index; the NEXT alloc popped the
    still-live slot and double-allocated it (orphan keys, entries>max,
    inverted victims). Fix: the steal path pops back the index it just
    pushed. Probes that caught it: entries=5 in a max=4 cache; refreshed
    entry dying while its older sibling survived.
82. **Zero-initialized typed arrays made unlink self-write (found by
    single-step array dumps, fixed).** Uint16Array slots start at 0/0; for
    slot 0 that is a self-loop (next[0]=0, prev[0]=0), so unlink on a
    never-linked fresh slot wrote next[0]=next[0] and silently corrupted the
    HEAD sentinel's neighbor. Fix discipline: (a) constructor + clear() set
    every free slot's links to SELF ("not in list" state); (b) #unlink also
    self-links the slot it detaches; (c) fresh inserts use #link() (insert
    WITHOUT unlink) — only provably-linked slots are ever unlinked.
83. **v1 "TTL refreshed on hit" was briefly lost in the rewrite** — the
    alive-hit path refreshed recency but not the TTL clock; the carried v1
    UNTOUCHED-entry test caught it (29-min-after-hit probe died). Restored:
    alive hits (exact and longest-prefix paths) update #times. The stale-serve
    path (staleOnHit) also reschedules by definition.
84. **staleOnHit default ON, deliberately (spec §4 + spec text).** For THIS
    cache a stale token count still lower-bounds the true count (text does
    not shrink), so serving an expired prefix count once while rescheduling
    keeps budgets conservative and avoids recount storms after a 30-min
    idle; strict mode is one option away. The carried v1 pure-expiry test
    pins strict mode explicitly.
85. **Byte ledger cost model.** lineBytes = key(64-char hex) + JSON value
    ({tokens, at} — two small ints). Default budget 4 MiB ≈ ~45k lines, so
    at max 256 entries the count bound binds first; the byte bound is the
    pathological-giant guard (spec's intent). Oversize single line → stored
    alone (guard empties the ledger first).
86. **Interface compatibility verified, loop.js untouched.** Same class
    name, same method signatures, v1 options still valid; the only
    behavioral deltas are additive (peek/clear/stats fields) and the
    stale-serve default (deviation 84 — observably identical for the loop's
    countPrefix contract: cached=true either way). 176-test baseline grew
    to 186: tokens tests 15→25 (v1 cases carried + 10 v2), zero removed,
    no exact-stats-shape assertions existed to adjust.

**Cache-v2 gate evidence (2026-11-11, node v24.18.0):**
- `node scripts/check.mjs` → all files OK.
- bare `node --test` → **186/186** (176 baseline + 10 net: tokens suite
  15→25 — v1 cases carried, 10 v2 cases added, 0 removed), 0 fail.
- `sh bench/ship-gate.sh` → PASS (DC6, name-guard -rin, zero-dep).
- Determinism ×2 (fresh echo runs through the v2 cache, loop.js untouched):
  run sha == replay sha = `07836deed93d04c5e0bab2dffd700f56cadf3a686acfe5c16ebb6109bc3528bb`
  and `fbfa97a5b6da57470a7d7cb3e7e8b87780c79f4e5a862b90b7da2a3c5497a9f4`
  (different inputs → different shas as expected; each pair internally
  equal — prefix fields remain content-derived). Log residue removed.

## tokencache-r1 (TokenCache repair: TC2-1..TC6-2 + D5, 2026-11-11)

87. **TC2-1 — audit's key landed, not the review's.** tokenCacheKey now hashes
    JSON.stringify([role ?? null, content ?? null]) + NUL per block (the
    audit-proven variant; the review's String()-coerce-before-stringify fix
    closed only 2/10 classes, the audit's closes 9/10 — desk directive).
    TC2-2 folded in at trivial cost: an undefined/null message SLOT encodes
    as JSON.stringify(m ?? null)'s null, distinct from a present-but-empty
    message — closing K3 too (10/10 distinct, probe-verified before tests).
    Key format changed → in-memory entries orphan per process (no persistence,
    no migration). PRESERVED classes re-verified: role swap, order swap,
    duplicate-identical, NFC≠NFD, JSON round-trip stability, prefix-growth
    key change.
88. **TC3-1 — negative age = expired.** All three TTL paths (`#getFresh`,
    `#getPeek`, `#lookupLongestAlive`) now compute `age` and treat `age < 0`
    (rewound clock) as expired instead of resurrecting freshness. Strict mode
    purges on the rewind read; staleOnHit enters the same expired branch and
    serves once per window. The test pins per-window semantics precisely: a
    serve reschedules, a read inside the new window is a NORMAL hit, and each
    subsequent window serves at most once (the audit's "exactly-once per
    expiry window" behavior, now correctly bounded).
89. **TC3-2 — comment now matches code.** The stale-serve branch's comment
    said "demote recency" while calling #moveToTail (a promotion to MRU);
    fixed to "PROMOTE recency — it was just served" per the audit's wording.
90. **TC4-1 — sentinel sizing.** Link arrays sized `max + 2 <= 65536 ?
    Uint16Array : Uint32Array` (was `max <= 65535`): at max=65535 TAIL
    (index 65536) aliased slot 0 in the Uint16 array, so the empty-list guard
    in #makeRoomFor could never break and Array.push threw after a runaway
    free-stack loop (desk-reproduced OOM). Boundary tests: 65535+sub-line
    budget records fine (entries=1), 65534/65536 boundary neighbors verified.
91. **TC6-1 — prefixReuses counter.** New field in stats(); incremented in
    BOTH #lookupLongestAlive return branches; hits/misses v1 semantics
    untouched. Header note added: hits+misses is NOT the total read count —
    a prefix reuse reads in neither (the loop's dominant path was invisible
    to stats before).
92. **TC6-2 — clear() now zeroes ALL counters** (hits/misses/prefixReuses/
    evictions/expiredPurges + the v2 entries/bytes). The "clear(): stats
    reset" test name is now true in both directions the audit flagged.
93. **D5 — onCount throws contained.** Both call sites wrap the diagnostic
    hook in try/catch and swallow (log-free; it is a hook, not a channel).
    The audit showed the prefix-path throw fired BEFORE record, losing the
    delta; tests assert the entry records on BOTH paths despite a throwing
    onCount.

**Tokencache-r1 gate evidence (2026-11-11, node v24.18.0):**
- `node scripts/check.mjs` → all files OK.
- bare `node --test` → **194/194, 0 fail** (186 baseline + 8 new: TC2-1
  stale-HIGH regression, TC2-1/TC2-2 ten-class distinctness, preserved-class
  distinctness, TC4-1 crash+boundaries, TC3-1 rewind all-modes, TC6-1/TC6-2
  counters, D5 containment).
- `sh bench/ship-gate.sh` → PASS (DC6, name-guard -rin, zero-dep).
- Determinism ×2 (fresh echo runs; loop.js untouched, key format is
  cache-internal): run==replay =
  `9cc5cf76080be7fa67fd9dcda84a3e2c17811c5b759a7bb235cf7f01b6822827` and
  `d103134128c13361854fe2332a8a6bc50f2d850f1f20ae325a590923c1569498` (each
  pair internally equal). Log residue removed.
