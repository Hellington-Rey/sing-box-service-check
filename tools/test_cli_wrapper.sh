#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
WRAPPER="$ROOT/files/usr/bin/forkop-servicecheck"
TMP="$(mktemp -d)"

cleanup() {
    rm -rf "$TMP"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$TMP/bin" "$TMP/lib"
: > "$TMP/lib/probe.uc"

cat > "$TMP/bin/ucode" <<'EOF'
#!/bin/sh
printf '%s\n' "$@"
EOF
chmod +x "$TMP/bin/ucode"

run_wrapper() {
    PATH="$TMP/bin:$PATH" FORKOP_SC_LIB="$TMP/lib" sh "$WRAPPER" "$@"
}

CUSTOM_OUTPUT="$(run_wrapper custom example.com 443 netns 192.168.2.55)"
printf '%s\n' "$CUSTOM_OUTPUT" | grep -Fxq -- '-L'
printf '%s\n' "$CUSTOM_OUTPUT" | grep -Fxq -- "$TMP/lib"
printf '%s\n' "$CUSTOM_OUTPUT" | grep -Fxq -- "$TMP/lib/probe.uc"
printf '%s\n' "$CUSTOM_OUTPUT" | grep -Fxq -- 'custom'
printf '%s\n' "$CUSTOM_OUTPUT" | grep -Fxq -- 'example.com'
printf '%s\n' "$CUSTOM_OUTPUT" | grep -Fxq -- '443'
printf '%s\n' "$CUSTOM_OUTPUT" | grep -Fxq -- 'netns'
printf '%s\n' "$CUSTOM_OUTPUT" | grep -Fxq -- '192.168.2.55'

[ "$(run_wrapper xhttp_patch | tail -n 1)" = "xhttp-patch" ]
[ "$(run_wrapper icmp_tproxy_patch | tail -n 1)" = "icmp-tproxy-patch" ]
[ "$(run_wrapper netns_teardown | tail -n 1)" = "netns-teardown" ]
[ "$(run_wrapper profiles-get | tail -n 1)" = "profiles-get" ]
[ "$(run_wrapper profiles-reset | tail -n 1)" = "profiles-reset" ]
[ "$(run_wrapper update-check | tail -n 1)" = "update-check" ]
[ "$(run_wrapper update-start | tail -n 1)" = "update-start" ]
[ "$(run_wrapper update-status | tail -n 1)" = "update-status" ]
[ "$(run_wrapper history | tail -n 1)" = "history" ]
[ "$(run_wrapper history-clear | tail -n 1)" = "history-clear" ]
[ "$(run_wrapper cancel sc-123-456 | tail -n 2 | head -n 1)" = "cancel" ]
[ "$(run_wrapper cancel sc-123-456 | tail -n 1)" = "sc-123-456" ]
[ "$(run_wrapper gemini_key_reset | tail -n 1)" = "gemini-key-reset" ]
[ "$(run_wrapper gemini_key_status | tail -n 1)" = "gemini-key-status" ]
GEMINI_KEY='test_gemini_key_1234567890'
GEMINI_OUTPUT="$(run_wrapper gemini_key_set "$GEMINI_KEY")"
[ "$(printf '%s\n' "$GEMINI_OUTPUT" | tail -n 2 | head -n 1)" = "gemini-key-set" ]
[ "$(printf '%s\n' "$GEMINI_OUTPUT" | tail -n 1)" = "$GEMINI_KEY" ]
PROFILES_JSON='{"profiles":[{"id":"test","title":"Test","targets":[{"kind":"https","host":"example.com"}]}]}'
PROFILES_OUTPUT="$(run_wrapper profiles-save "$PROFILES_JSON")"
[ "$(printf '%s\n' "$PROFILES_OUTPUT" | tail -n 2 | head -n 1)" = "profiles-save" ]
[ "$(printf '%s\n' "$PROFILES_OUTPUT" | tail -n 1)" = "$PROFILES_JSON" ]

if run_wrapper unknown >/dev/null 2>&1; then
    echo "ERROR: unknown command must fail" >&2
    exit 1
fi

echo "cli wrapper tests: OK"
