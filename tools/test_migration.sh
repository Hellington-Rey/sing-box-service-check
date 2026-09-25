#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT HUP INT TERM
mkdir -p "$WORK/etc/forkop-servicecheck" "$WORK/etc/sing-box-service-check"
printf '%s\n' 'old profile' > "$WORK/etc/forkop-servicecheck/profiles.json"
printf '%s\n' 'old key' > "$WORK/etc/forkop-servicecheck/gemini_api_key"
printf '%s\n' 'old result' > "$WORK/etc/forkop-servicecheck/zapret_strategy_results.json"
printf '%s\n' 'new profile' > "$WORK/etc/sing-box-service-check/profiles.json"
SBSC_MIGRATE_ROOT="$WORK" sh "$ROOT/files/usr/lib/sing-box-service-check/migrate.sh"
[ "$(cat "$WORK/etc/sing-box-service-check/profiles.json")" = "new profile" ]
[ "$(cat "$WORK/etc/forkop-servicecheck/profiles.json")" = "old profile" ]
[ "$(cat "$WORK/etc/sing-box-service-check/zapret_strategy_results.json")" = "old result" ]
[ "$(cat "$WORK/etc/sing-box-service-check/gemini_api_key")" = "old key" ]
[ "$(cat "$WORK/etc/forkop-servicecheck/gemini_api_key")" = "old key" ]
[ "$(stat -c %a "$WORK/etc/sing-box-service-check/gemini_api_key")" = "600" ]
SBSC_MIGRATE_ROOT="$WORK" sh "$ROOT/files/usr/lib/sing-box-service-check/migrate.sh"
[ "$(cat "$WORK/etc/sing-box-service-check/profiles.json")" = "new profile" ]
echo "config migration OK"
