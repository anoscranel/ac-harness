# Milestone 003a — summary

Gate: `node --test` green (5/5) on 2026-10-20, node v24.18.0, including
`test/events.conformance.test.js` against the byte-identical fixture copy
(sha256 28b4b6ae…039a, matches the board fixture).

Files:
- `package.json` — type:module, engines node>=24, scripts check/test/replay/chat.
- `LICENSE` (Apache-2.0 full text), `NOTICE`, `CONTRIBUTING.md` (DCO 1.1 sign-off),
  `SECURITY.md` (v1 threat model: first-party plugins only).
- `.gitignore` — `logs/` and `*.jsonl` ignored; the checked-in fixture excepted.
- `src/events.js` — single-writer append-only JSONL log: `EventLog` (awaited,
  promise-chain-serialized appends; gapless seq; resume via `EventLog.open`),
  `buildEvent` (per-type canonical data key order), `canonicalize` (strips `ts`
  and recursive `duration_ms`), `readAll`, `sha256`. Best-effort pre-log secret
  redaction included (honesty limit stated in README/SECURITY).
- `src/policy.js` — rules-as-data engine: collect all matches, deny>ask>allow,
  zero matches = deny; `loadRulesFile` throws `PolicyError` on unparseable input
  (startup refusal; caller logs `policy.error`); pinned unoverridable log-path
  deny evaluated in code; `resolveAsk` with 30s headless-timeout deny.
- `test/events.conformance.test.js` — fixture conformance + volatile-strip +
  gapless concurrent append + resume + unknown-type/actor rejection.
- `scripts/check.mjs` — `node --check` sweep for the `check` script.
- `fixtures/events.v1.jsonl` — byte-identical copy of the board fixture.

Deviations:
1. ⚠️ The fixture contains no `session.error` / `policy.error` example although
   both are in the v1 type list (invariants §2). Conservative choice: both types
   are implemented and buildable; the conformance test asserts fixture coverage
   of every *other* type and does not fail on their absence. Recorded in
   `findings/deviations.md`.
2. `tool.result` builder carries an optional trailing `error` key (omitted when
   absent) so policy-denied calls can record a reason without breaking the
   fixture's canonical shape.
