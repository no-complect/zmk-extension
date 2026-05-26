#!/usr/bin/env bash
set -euo pipefail

MSG_FILE="${1:-}"
if [[ -z "${MSG_FILE}" || ! -f "${MSG_FILE}" ]]; then
  exit 0
fi

# Remove Cursor's co-author trailer if it was injected automatically.
# This keeps commit attribution clean for repos that require human-only attribution.
#
# macOS sed requires an extension argument for -i.
if [[ "$(uname -s)" == "Darwin" ]]; then
  sed -i '' '/^Co-authored-by: Cursor <cursoragent@cursor\.com>$/d' "${MSG_FILE}"
else
  sed -i '/^Co-authored-by: Cursor <cursoragent@cursor\.com>$/d' "${MSG_FILE}"
fi

