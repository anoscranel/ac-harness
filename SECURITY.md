# Security policy

## v1 threat model

The v1 threat model is deliberately narrow. Read it before deploying anything.

**In scope / trusted:**

- **First-party plugins only.** v1 plugins run in-process with full trust. The
  plugin manifest is a *declaration surface*, not an enforcement boundary: the
  policy engine gates tool CALLS, not module behaviour. Do NOT load third-party
  plugins. Sandboxing is out of scope and unmitigated in v1.
- The harness process is the single writer of the event log. The default policy
  pins an unoverridable `deny` for write/edit/bash against the log path.
- The policy engine (rules-as-data, deny > ask > allow, zero matches = deny)
  gates every tool call and every MCP subprocess spawn before it happens.

**Out of scope / explicitly not mitigated in v1:**

- Malicious or compromised plugins (see above).
- Prompt-injection-driven tool use beyond what the policy rules deny. The
  policy engine is the boundary; tune rules for your deployment.
- Secret redaction is best-effort pattern matching. It is not a guarantee;
  treat every event log as potentially sensitive. Secret redaction applies to
  the event log only; provider-bound message content is NOT re-screened — do
  not point the agent at credential stores.
- The pinned log-path deny scans bash commands and MCP args as resolved paths.
  This containment check is best-effort against crafted command shapes (env
  vars, command substitution, obfuscated quoting can evade it); it is a
  guardrail, not a sandbox.

### Redaction: screened and unscreened classes

Screened (pre-log, pattern-matched): generic `sk-…` API keys, JWTs, `Bearer`
tokens, `KEY=value` assignments (quoted or bare), GitHub token families
(`ghp_`, `github_pat_`, `ghs_`, `gho_`, `ghu_`, `ghr_`), AWS access key ids
(`AKIA…`), Slack tokens (`xox[baprs]-…`), Google API keys (`AIza…`), PEM block
markers, and connection strings with embedded credentials
(`scheme://user:pass@host`).

**Unscreened classes** (documented, not handled): base64/hex blobs without a
known prefix, JSON-shaped secrets, lowercase key names, non-`KEY|TOKEN|SECRET`
suffixes, and any provider-specific format not listed above. If a secret class
matters to your deployment, treat the log as sensitive regardless.
- The "trifecta" limit: an agent with simultaneous access to private data,
  untrusted content, and an egress channel cannot be made safe by this harness
  in v1. v1 states this limit plainly (see README § Limitations); it does not
  claim to solve it.
- The event log is append-only but written without fsync: a crash can lose the
  tail. See README § Event log durability.

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Email the maintainers (see
NOTICE / repository metadata) with a description, a reproduction, and the
affected version. We aim to acknowledge within 7 days.

## Supported versions

Only the latest minor release line receives security fixes.
