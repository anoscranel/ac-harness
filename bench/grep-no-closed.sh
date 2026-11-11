#!/bin/sh
# bench/grep-no-closed.sh — DC6 checker: the shipped tree must not name
# closed products or clean-room concepts. Exit 0 = clean, 1 = hits found.
set -u
cd "$(dirname "$0")/.."

REGEX='claude.?code|cursor|clean.?room|tier.?[ABC]|muse.?code|cortex.?code|kiro|terminus|copilot|windsurf|codeium|tabnine|antigravity|junie|replit.?agent|factory.?droid|reverse.?engineer|teak?down|leak'

HITS=$(grep -rniE "$REGEX" src README.md CONTRIBUTING.md SECURITY.md NOTICE LICENSE package.json 2>/dev/null || true)
if [ -n "$HITS" ]; then
  echo "DC6 FAIL: closed-product references found:"
  echo "$HITS"
  exit 1
fi
echo "DC6 OK: no closed-product references in shipped tree"
exit 0
