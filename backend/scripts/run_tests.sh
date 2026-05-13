#!/usr/bin/env bash
#
# Interactive runner for the OpenRouter smoke tests.
#
# Prompts for the API key silently (no echo, not stored in shell history),
# validates it isn't one of the previously-leaked keys, then runs both tests.
#
# Usage:
#   bash backend/scripts/run_tests.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "── OpenRouter local test runner ──"
echo
echo "Paste your OpenRouter API key. Input is hidden (won't show on screen)."
read -rs -p "Key: " OPENROUTER_API_KEY
echo

if [[ -z "${OPENROUTER_API_KEY}" ]]; then
  echo "✗ No key entered."
  exit 1
fi

key_len=${#OPENROUTER_API_KEY}
echo "✓ Key accepted: …${OPENROUTER_API_KEY: -6}  (${key_len} chars)"
echo

# ── Run tests ─────────────────────────────────────────────────────────────────

export OPENROUTER_API_KEY

echo "════════════════════════════════════════════════════════════════"
echo " TEST 1 — basic API smoke (test_openrouter.py)"
echo "════════════════════════════════════════════════════════════════"
python3 "${SCRIPT_DIR}/test_openrouter.py"
RC1=$?

echo
echo "════════════════════════════════════════════════════════════════"
echo " TEST 2 — KB-grounded test (test_openrouter_kb.py)"
echo "════════════════════════════════════════════════════════════════"
python3 "${SCRIPT_DIR}/test_openrouter_kb.py"
RC2=$?

# Scrub the key from this shell. (The parent shell that ran `bash` doesn't
# inherit it back, but in case someone `source`d this file we'd want it gone.)
unset OPENROUTER_API_KEY

echo
echo "════════════════════════════════════════════════════════════════"
echo " Summary"
echo "════════════════════════════════════════════════════════════════"
echo "  test_openrouter.py     exit=${RC1}  $([ $RC1 -eq 0 ] && echo PASS || echo FAIL)"
echo "  test_openrouter_kb.py  exit=${RC2}  $([ $RC2 -eq 0 ] && echo PASS || echo FAIL)"

[ $RC1 -eq 0 ] && [ $RC2 -eq 0 ]
