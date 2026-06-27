#!/bin/sh
# pattern: Imperative Shell
# Dead-man's-switch for the RC Ape bot. The bot's poll loop catches-and-logs every
# error and never crashes, so a poll that throws forever leaves the process alive
# while doing no work — systemd's Restart=always never fires, and the stall is
# SILENT. The only outside-observable signal is the liveness heartbeat the bot
# stamps to data/heartbeat.json after each SUCCESSFUL cycle. This script ages that
# stamp and alerts Karl's fleet ntfy topic when it goes stale (or is missing).
#
# Install as a cron (NOT installed by this script — add it yourself):
#   */5 * * * * /opt/rcape/deploy/healthcheck.sh
#
# Exit 0 when healthy; non-zero when it alerted (so cron MAILTO / a wrapper can
# also notice). Staleness threshold defaults to 600s, override with
# RCAPE_HEARTBEAT_STALE_S.
set -u

# Resolve the heartbeat path relative to THIS script so it works from /opt/rcape
# (or any checkout) regardless of the cron's working directory.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HEARTBEAT="$SCRIPT_DIR/../data/heartbeat.json"

STALE_S="${RCAPE_HEARTBEAT_STALE_S:-600}"
NTFY_URL="https://ntfy.sh/malone-monitoring"

alert() {
  # body is "$1"; best-effort POST — a failed curl must not wedge the cron.
  curl -fsS \
    -H "Title: rcape-bot" \
    -H "Priority: high" \
    -H "Tags: warning" \
    -d "$1" \
    "$NTFY_URL" >/dev/null 2>&1 || true
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

exit 0
