#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# build.sh — TypeScript build with error logging
# Output: src/tests/.results/build.log
# ──────────────────────────────────────────────────────────────

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RESULTS_DIR="$PROJECT_DIR/src/tests/.results"
LOG_FILE="$RESULTS_DIR/build.log"

mkdir -p "$RESULTS_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

# Run tsc and capture output
TSC_OUTPUT=$(cd "$PROJECT_DIR" && bunx tsc --noEmit 2>&1)
TSC_EXIT=$?

# Write log
{
  echo "TYPESCRIPT BUILD LOG"
  echo "===================="
  echo "Date: $(date '+%Y-%m-%d %H:%M:%S')"
  echo ""
  if [ $TSC_EXIT -eq 0 ]; then
    echo "Build: SUCCESS (0 errors)"
  else
    ERROR_COUNT=$(echo "$TSC_OUTPUT" | grep -c ": error TS" || echo "0")
    echo "Build: FAILED ($ERROR_COUNT errors)"
    echo ""
    echo "$TSC_OUTPUT"
  fi
  echo ""
  echo "===================="
} > "$LOG_FILE"

# Terminal output
echo ""
if [ $TSC_EXIT -eq 0 ]; then
  echo -e "${GREEN}Build succeeded${NC}"
else
  ERROR_COUNT=$(echo "$TSC_OUTPUT" | grep -c ": error TS" || echo "0")
  echo -e "${RED}Build failed: $ERROR_COUNT errors${NC}"
  echo "$TSC_OUTPUT"
  echo ""
  echo -e "Full log: ${CYAN}$LOG_FILE${NC}"
fi

echo ""
exit $TSC_EXIT
