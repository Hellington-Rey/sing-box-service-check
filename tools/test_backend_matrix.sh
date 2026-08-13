#!/bin/sh
set -eu

command -v ucode >/dev/null 2>&1 || {
    echo "ucode is required for backend matrix tests" >&2
    exit 1
}

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
ENGINE="$ROOT/files/usr/lib/forkop-servicecheck/probe.uc"
LIB="$ROOT/files/usr/lib/forkop-servicecheck"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -p "$TMP/bin" "$TMP/state"

cat > "$TMP/config.json" <<'EOF'
{"dns":{"servers":[{"type":"fakeip","tag":"fakeip","inet4_range":"198.18.0.0/15"}]},"experimental":{"clash_api":{"external_controller":"127.0.0.1:9090"}}}
EOF

cat > "$TMP/backend" <<'EOF'
#!/bin/sh
case "${1:-}" in
    show_version) echo "test-backend 1.0" ;;
    get_status|get_sing_box_status)
        [ "${MALFORMED_STATUS:-0}" = "1" ] && echo broken || echo '{"running":true}'
        ;;
    clash_api)
        [ "${MALFORMED_CLASH:-0}" = "1" ] && echo broken || echo '{"connections":[]}'
        ;;
    *) exit 1 ;;
esac
EOF

cat > "$TMP/bin/uci" <<'EOF'
#!/bin/sh
exit 1
EOF
cat > "$TMP/bin/ip" <<'EOF'
#!/bin/sh
if [ "${1:-}" = "-4" ]; then
    echo '2: br-lan    inet 192.168.50.1/24 brd 192.168.50.255 scope global br-lan'
fi
exit 0
EOF
cat > "$TMP/bin/pgrep" <<'EOF'
#!/bin/sh
exit 0
EOF
cat > "$TMP/bin/nc" <<'EOF'
#!/bin/sh
exit 1
EOF
cat > "$TMP/bin/curl" <<'EOF'
#!/bin/sh
[ "${MALFORMED_CLASH:-0}" = "1" ] && echo broken || echo '{"connections":[]}'
EOF
chmod +x "$TMP/backend" "$TMP/bin/"*

run_engine() {
    PATH="$TMP/bin:/usr/bin:/bin" \
    FORKOP_SC_LIB="$LIB" \
    FORKOP_SC_STATE_DIR="$TMP/state" \
    FORKOP_SC_SING_BOX_CONFIG="$TMP/config.json" \
    TACHYON_BIN="$TMP/tachyon" \
    FORKOP_BIN="$TMP/forkop" \
    PODKOP_BIN="$TMP/podkop" \
    MALFORMED_CLASH="${MALFORMED_CLASH:-0}" \
    MALFORMED_STATUS="${MALFORMED_STATUS:-0}" \
    ucode -L "$LIB" "$ENGINE" "$@"
}

assert_caps() {
    expected="$1"
    output="$(run_engine capabilities)"
    JSON_DATA="$output" EXPECTED="$expected" python3 - <<'PY'
import json, os
data = json.loads(os.environ["JSON_DATA"])
assert data["backend"] == os.environ["EXPECTED"], data
assert data["dns"]["config_readable"] is True, data
assert data["dns"]["fakeip_enabled"] is True, data
assert data["backend_running"] is True, data
assert data["clash_api"]["reachable"] is True, data
PY
}

cp "$TMP/backend" "$TMP/tachyon"
cp "$TMP/backend" "$TMP/forkop"
cp "$TMP/backend" "$TMP/podkop"
assert_caps tachyon

rm "$TMP/tachyon"
assert_caps forkop

rm "$TMP/forkop"
assert_caps podkop

cp "$TMP/backend" "$TMP/tachyon"
cp "$TMP/backend" "$TMP/forkop"
export FORKOP_SC_BACKEND=podkop
output="$(run_engine capabilities)"
unset FORKOP_SC_BACKEND
JSON_DATA="$output" python3 - <<'PY'
import json, os
assert json.loads(os.environ["JSON_DATA"])["backend"] == "podkop"
PY

output="$(MALFORMED_CLASH=1 run_engine capabilities)"
JSON_DATA="$output" python3 - <<'PY'
import json, os
data = json.loads(os.environ["JSON_DATA"])
assert data["clash_api"]["reachable"] is False, data
assert data["clash_api"]["connections"] == 0, data
PY

valid='{"profiles":[{"id":"route_test","title":"Route test","targets":[{"kind":"https","host":"example.com","expected_route":"direct"}]},{"id":"gemini","title":"Gemini","targets":[{"kind":"gemini_geo","host":"generativelanguage.googleapis.com"}]}]}'
output="$(run_engine profiles-validate "$valid")"
JSON_DATA="$output" python3 - <<'PY'
import json, os
assert json.loads(os.environ["JSON_DATA"])["success"] is True
PY

invalid='{"profiles":[{"id":"bad","title":"Bad","targets":[{"kind":"https","host":"example.com","expected_route":"tunnel"}]}]}'
if run_engine profiles-validate "$invalid" >"$TMP/invalid.json" 2>/dev/null; then
    echo "invalid expected_route was accepted" >&2
    exit 1
fi
JSON_DATA="$(cat "$TMP/invalid.json")" python3 - <<'PY'
import json, os
data = json.loads(os.environ["JSON_DATA"])
assert data["success"] is False and "expected_route" in data["message"], data
PY

if run_engine custom '2001:db8::1' 443 router >"$TMP/ipv6.json" 2>/dev/null; then
    echo "raw IPv6 must be rejected deterministically until IPv6 probing is implemented" >&2
    exit 1
fi
JSON_DATA="$(cat "$TMP/ipv6.json")" python3 - <<'PY'
import json, os
assert json.loads(os.environ["JSON_DATA"])["success"] is False
PY

echo "backend runtime matrix: OK"
