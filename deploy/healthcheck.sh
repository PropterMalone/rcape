#!/bin/sh
# pattern: Imperative Shell
# Dead-man's-switch for the RC Ape bot. The bot's poll loop catches-and-logs every
# error and never crashes, so a poll that throws forever leaves the process alive
# while doing no work — systemd's Restart=always never fires, and the stall is
# SILENT. Two signals are checked, because neither catches the other's outage:
#
#   1. AGE — the liveness heartbeat the bot stamps to data/heartbeat.json after
#      each SUCCESSFUL cycle. Catches total silence.
#   2. RATE — the pass/fail window the bot records to data/cycles.json on EVERY
#      cycle. Catches a partial failure, which age structurally cannot see: on
#      2026-09-20 the bot failed roughly half its cycles for a whole morning
#      (159 of them) while the surviving half kept the stamp well under the
#      threshold, so this script reported healthy throughout an effective outage.
#
# Install as a cron (NOT installed by this script — add it yourself):
#   */5 * * * * /opt/rcape/deploy/healthcheck.sh
#
# Exit 0 when healthy; non-zero when it alerted (so cron MAILTO / a wrapper can
# also notice). Staleness threshold defaults to 600s, override with
# RCAPE_HEARTBEAT_STALE_S; failure-rate threshold defaults to 30%, override with
# RCAPE_FAILRATE_PCT.
set -u

# Resolve the heartbeat path relative to THIS script so it works from /opt/rcape
# (or any checkout) regardless of the cron's working directory.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HEARTBEAT="$SCRIPT_DIR/../data/heartbeat.json"

STALE_S="${RCAPE_HEARTBEAT_STALE_S:-600}"

# Both thresholds are fed to `[ ... -gt ]`, which ABORTS the test on a
# non-numeric value ("[: Illegal number:") and leaves the script exiting 0
# without alerting — a malformed override silently disables the very check it
# was tuning. Fall back to the default instead. Matches cycleStats.parseWindow.
case "$STALE_S" in
  '' | *[!0-9]*) STALE_S=600 ;;
esac

alert() {
  # body is "$1"; notify.sh is best-effort and always exits 0 — a dead
  # notification channel must not wedge the cron.
  "$HOME/.claude/scripts/notify.sh" "rcape-bot" "$1" || true
}

if [ ! -f "$HEARTBEAT" ]; then
  alert "rcape-bot heartbeat MISSING ($HEARTBEAT) — bot may never have started a successful poll cycle."
  exit 1
fi

# Extract the ISO timestamp from {"at":"..."} without a JSON parser (POSIX sh).
LAST_SEEN=$(sed -n 's/.*"at"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$HEARTBEAT")
if [ -z "$LAST_SEEN" ]; then
  alert "rcape-bot heartbeat UNREADABLE ($HEARTBEAT) — no \"at\" timestamp found."
  exit 1
fi

# Age = now - heartbeat, in seconds. `date -d` parses the ISO-8601 stamp (GNU
# coreutils on Malone). If the parse fails, treat it as unreadable rather than
# silently passing.
LAST_EPOCH=$(date -d "$LAST_SEEN" +%s 2>/dev/null)
if [ -z "$LAST_EPOCH" ]; then
  alert "rcape-bot heartbeat timestamp UNPARSEABLE ($LAST_SEEN)."
  exit 1
fi
NOW_EPOCH=$(date +%s)
AGE=$((NOW_EPOCH - LAST_EPOCH))

if [ "$AGE" -gt "$STALE_S" ]; then
  alert "rcape-bot STALLED — no successful poll for ${AGE}s (threshold ${STALE_S}s). Last seen: $LAST_SEEN."
  exit 1
fi

# --- Signal 2: failure RATE ---------------------------------------------------
# Reaching here means a cycle succeeded recently, which is NOT the same as the
# bot being healthy. data/cycles.json carries the last N outcomes plus the
# derived counts, so this stays sed-parseable in POSIX sh.
#
# Deliberately SECONDARY: if the file is absent or unparseable — an older bot
# build, or a fresh start that hasn't filled a window — the check is SKIPPED, not
# alerted. Total silence is already covered above, and a deploy should not page.
CYCLES="$SCRIPT_DIR/../data/cycles.json"
FAIL_PCT="${RCAPE_FAILRATE_PCT:-30}"
case "$FAIL_PCT" in
  '' | *[!0-9]*) FAIL_PCT=30 ;;
esac

if [ -f "$CYCLES" ]; then
  TOTAL=$(sed -n 's/.*"total"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' "$CYCLES" | head -n 1)
  FAILURES=$(sed -n 's/.*"failures"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' "$CYCLES" | head -n 1)
  WINDOW=$(sed -n 's/.*"window"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' "$CYCLES" | head -n 1)

  # Every field must be present and the window FULL before judging: a bot that
  # just started has 2 samples, and 1 failure out of 2 is not a 50% outage.
  if [ -n "$TOTAL" ] && [ -n "$FAILURES" ] && [ -n "$WINDOW" ] &&
    [ "$TOTAL" -ge "$WINDOW" ] && [ "$TOTAL" -gt 0 ]; then
    PCT=$((FAILURES * 100 / TOTAL))
    if [ "$PCT" -ge "$FAIL_PCT" ]; then
      alert "rcape-bot DEGRADED — ${FAILURES} of the last ${TOTAL} poll cycles failed (${PCT}%, threshold ${FAIL_PCT}%). The heartbeat is FRESH, so this is a partial failure, not a stall."
      exit 1
    fi
  fi
fi

exit 0
