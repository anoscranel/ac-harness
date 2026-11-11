#!/bin/sh
# bench/ship-gate.sh — the single pre-push gate (spec §7):
#   1. node --check every src/test/scripts file (scripts/check.mjs)
#   2. bare node --test (full suite)
#   3. DC6: bench/grep-no-closed.sh (closed-product references)
#   4. S01-name-guard: the internal codename must NOT appear in README.md,
#      package.json, LICENSE, or NOTICE (it may live in src/ as the DISPLAY
#      string only; the publish pipeline applies the public name before ship)
#   5. zero-dep sweep: package.json declares no dependencies, no lockfiles
# Exit 0 = SHIP, 1 = a gate failed.
set -u
cd "$(dirname "$0")/.."

fail() {
  echo "ship-gate FAIL: $1"
  exit 1
}

# 1. syntax gate
if ! node scripts/check.mjs; then
  fail "node --check (scripts/check.mjs)"
fi

# 2. test gate
if ! node --test; then
  fail "node --test"
fi

# 3. DC6 closed-product grep
if ! sh bench/grep-no-closed.sh; then
  fail "DC6 grep (bench/grep-no-closed.sh)"
fi

# 4. internal-codename guard over the four published identity files
# N1 (repair-4): spec §7 says grep -ri — case-insensitive, so variants slip not.
# Name-guard: the internal codename must never ship in published files.
NAME_PAT="S01oDev"
NAME_HITS=$(grep -rin "$NAME_PAT" README.md package.json LICENSE NOTICE 2>/dev/null || true)
if [ -n "$NAME_HITS" ]; then
  echo "ship-gate FAIL: internal codename found in published identity files:"
  echo "$NAME_HITS"
  exit 1
fi
echo "name-guard OK: internal codename absent from README/package.json/LICENSE/NOTICE"

# 5. zero-dependency sweep (lock zero-dep)
if node -e '
  const p = JSON.parse(require("node:fs").readFileSync("package.json", "utf8"));
  process.exit(p.dependencies || p.devDependencies || p.peerDependencies || p.optionalDependencies ? 1 : 0);
'; then
  echo "zero-dep OK: package.json declares no dependencies"
else
  fail "package.json declares a dependency (zero-dep is a lock)"
fi
for lock in package-lock.json npm-shrinkwrap.json yarn.lock pnpm-lock.yaml; do
  if [ -e "$lock" ]; then
    fail "lockfile present: $lock (zero-dep tree must have no lockfile)"
  fi
done

echo "ship-gate PASS: check + tests + DC6 + name-guard + zero-dep"
exit 0
