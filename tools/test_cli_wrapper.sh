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
DNS_DIAGNOSTICS_OUTPUT="$(run_wrapper dns-diagnostics example.com)"
[ "$(printf '%s\n' "$DNS_DIAGNOSTICS_OUTPUT" | tail -n 2 | head -n 1)" = "dns-diagnostics" ]
[ "$(printf '%s\n' "$DNS_DIAGNOSTICS_OUTPUT" | tail -n 1)" = "example.com" ]
DNS_OUTPUT="$(run_wrapper dns example.com)"
[ "$(printf '%s\n' "$DNS_OUTPUT" | tail -n 2 | head -n 1)" = "dns" ]
[ "$(printf '%s\n' "$DNS_OUTPUT" | tail -n 1)" = "example.com" ]
DNS_START_OUTPUT="$(run_wrapper dns-start example.org)"
[ "$(printf '%s\n' "$DNS_START_OUTPUT" | tail -n 2 | head -n 1)" = "dns-start" ]
[ "$(printf '%s\n' "$DNS_START_OUTPUT" | tail -n 1)" = "example.org" ]

[ "$(run_wrapper xhttp_patch | tail -n 1)" = "xhttp-patch" ]
[ "$(run_wrapper icmp_tproxy_patch | tail -n 1)" = "icmp-tproxy-patch" ]
[ "$(run_wrapper netns_teardown | tail -n 1)" = "netns-teardown" ]
[ "$(run_wrapper profiles-get | tail -n 1)" = "profiles-get" ]
[ "$(run_wrapper profiles-reset | tail -n 1)" = "profiles-reset" ]
[ "$(run_wrapper update-check | tail -n 1)" = "update-check" ]
UPDATE_START_OUTPUT="$(run_wrapper update-start --install-missing)"
[ "$(printf '%s\n' "$UPDATE_START_OUTPUT" | tail -n 2 | head -n 1)" = "update-start" ]
[ "$(printf '%s\n' "$UPDATE_START_OUTPUT" | tail -n 1)" = "install-missing" ]
UPDATE_SKIP_OUTPUT="$(run_wrapper update-start --skip-missing)"
[ "$(printf '%s\n' "$UPDATE_SKIP_OUTPUT" | tail -n 1)" = "skip-missing" ]
UPDATE_DEFAULT_OUTPUT="$(run_wrapper update-start 2>/dev/null)"
[ "$(printf '%s\n' "$UPDATE_DEFAULT_OUTPUT" | tail -n 1)" = "skip-missing" ]
if run_wrapper update-start --unknown >/dev/null 2>&1; then
    echo "ERROR: update-start must reject an unknown option" >&2
    exit 1
fi
[ "$(run_wrapper update-status | tail -n 1)" = "update-status" ]
[ "$(run_wrapper history | tail -n 1)" = "history" ]
[ "$(run_wrapper history-clear | tail -n 1)" = "history-clear" ]
[ "$(run_wrapper doctor | tail -n 1)" = "doctor" ]
[ "$(run_wrapper repair | tail -n 1)" = "repair" ]
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
PROFILES_VALIDATE_OUTPUT="$(run_wrapper profiles-validate "$PROFILES_JSON")"
[ "$(printf '%s\n' "$PROFILES_VALIDATE_OUTPUT" | tail -n 2 | head -n 1)" = "profiles-validate" ]
[ "$(printf '%s\n' "$PROFILES_VALIDATE_OUTPUT" | tail -n 1)" = "$PROFILES_JSON" ]
VPN_CONFIG='[Interface] PrivateKey = test [Peer] PublicKey = test'
[ "$(run_wrapper vpn-packages | tail -n 1)" = "vpn-packages" ]
[ "$(run_wrapper vpn-interfaces | tail -n 1)" = "vpn-interfaces" ]
[ "$(run_wrapper zapret-capabilities | tail -n 1)" = "zapret-capabilities" ]
ZAPRET_START_OUTPUT="$(run_wrapper zapret-start zapret2 force)"
[ "$(printf '%s\n' "$ZAPRET_START_OUTPUT" | tail -n 3 | head -n 1)" = "zapret-start" ]
[ "$(printf '%s\n' "$ZAPRET_START_OUTPUT" | tail -n 2 | head -n 1)" = "zapret2" ]
[ "$(printf '%s\n' "$ZAPRET_START_OUTPUT" | tail -n 1)" = "force" ]
ZAPRET_STATUS_OUTPUT="$(run_wrapper zapret-status zapret-123)"
[ "$(printf '%s\n' "$ZAPRET_STATUS_OUTPUT" | tail -n 2 | head -n 1)" = "zapret-status" ]
[ "$(printf '%s\n' "$ZAPRET_STATUS_OUTPUT" | tail -n 1)" = "zapret-123" ]
ZAPRET_CANCEL_OUTPUT="$(run_wrapper zapret-cancel zapret-123)"
[ "$(printf '%s\n' "$ZAPRET_CANCEL_OUTPUT" | tail -n 2 | head -n 1)" = "zapret-cancel" ]
[ "$(printf '%s\n' "$ZAPRET_CANCEL_OUTPUT" | tail -n 1)" = "zapret-123" ]
VPN_INSTALL_OUTPUT="$(run_wrapper vpn-install wireguard)"
[ "$(printf '%s\n' "$VPN_INSTALL_OUTPUT" | tail -n 2 | head -n 1)" = "vpn-install" ]
[ "$(printf '%s\n' "$VPN_INSTALL_OUTPUT" | tail -n 1)" = "wireguard" ]
VPN_CREATE_OUTPUT="$(run_wrapper vpn-create vpn0 amneziawg "$VPN_CONFIG")"
[ "$(printf '%s\n' "$VPN_CREATE_OUTPUT" | tail -n 5 | head -n 1)" = "vpn-create" ]
[ "$(printf '%s\n' "$VPN_CREATE_OUTPUT" | tail -n 4 | head -n 1)" = "vpn0" ]
[ "$(printf '%s\n' "$VPN_CREATE_OUTPUT" | tail -n 3 | head -n 1)" = "amneziawg" ]
[ "$(printf '%s\n' "$VPN_CREATE_OUTPUT" | tail -n 2 | head -n 1)" = "$VPN_CONFIG" ]
[ "$(printf '%s\n' "$VPN_CREATE_OUTPUT" | tail -n 1)" = "1.1.1.1" ]
VPN_CHECK_OUTPUT="$(run_wrapper vpn-check vpn0 9.9.9.9)"
[ "$(printf '%s\n' "$VPN_CHECK_OUTPUT" | tail -n 3 | head -n 1)" = "vpn-check" ]
[ "$(printf '%s\n' "$VPN_CHECK_OUTPUT" | tail -n 2 | head -n 1)" = "vpn0" ]
[ "$(printf '%s\n' "$VPN_CHECK_OUTPUT" | tail -n 1)" = "9.9.9.9" ]

if run_wrapper unknown >/dev/null 2>&1; then
    echo "ERROR: unknown command must fail" >&2
    exit 1
fi

echo "cli wrapper tests: OK"
