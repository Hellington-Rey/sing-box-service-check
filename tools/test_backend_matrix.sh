#!/bin/sh
set -eu

UCODE_BIN="$(command -v ucode || true)"
[ -n "$UCODE_BIN" ] || {
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
cat > "$TMP/bin/dig" <<'EOF'
#!/bin/sh
if [ "${BROKEN_DIG:-0}" = "1" ]; then
    echo 'Error relocating /usr/bin/dig: isc_assertion_failed: symbol not found' >&2
    exit 127
fi
if [ "${1:-}" = "-v" ]; then
    echo 'DiG 9.20.0-test'
    exit 0
fi
[ "${1:-}" = "-u" ] || { echo 'missing -u' >&2; exit 64; }
case "${2:-}" in
    +notcp|+https|+tls) ;;
    *) echo "invalid DNS protocol option: ${2:-}" >&2; exit 64 ;;
esac
[ "${3:-}" = "+tries=1" ] || { echo 'missing +tries=1' >&2; exit 64; }
case "${4:-}" in +time=*) ;; *) echo 'missing +time' >&2; exit 64 ;; esac
case "${5:-}" in @*) ;; *) echo 'missing resolver' >&2; exit 64 ;; esac
[ -n "${6:-}" ] && [ "${7:-}" = "A" ] || { echo 'invalid A query' >&2; exit 64; }
if [ "${5:-}" = "@9.9.9.9" ]; then
    echo ';; communications error to 9.9.9.9#53: connection refused' >&2
    exit 9
fi
case "${5:-}" in
    @1.1.1.1) query_us=5000 ;;
    @1.0.0.1) query_us=1000 ;;
    *) query_us=3000 ;;
esac
printf '%s.\t60\tIN\tA\t93.184.216.34\n' "$6"
echo ";; Query time: $query_us usec"
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
    BROKEN_DIG="${BROKEN_DIG:-0}" \
    "$UCODE_BIN" -L "$LIB" "$ENGINE" "$@"
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

output="$(run_engine dns example.com)"
JSON_DATA="$output" python3 - <<'PY'
import json, os
data = json.loads(os.environ["JSON_DATA"])
items = [item for group in data["groups"] for item in group["items"]]
assert data["progress"] == {"done": 61, "total": 61}, data["progress"]
assert len(items) == 61, items
assert sum(item["ok"] for item in items) == 58, items
assert {item["query_us"] for item in items if item["ok"]} == {1000, 3000, 5000}, items
assert {item["query_ms"] for item in items} == {None}, items
for group in data["groups"]:
    successful = [item for item in group["items"] if item["ok"]]
    failed = [item for item in group["items"] if not item["ok"]]
    assert group["items"] == successful + failed, group
    speeds = [item["query_us"] for item in successful]
    assert speeds == sorted(speeds), speeds
    assert [item["host"] for item in failed] == ["9.9.9.9"], failed
PY

output="$(BROKEN_DIG=1 run_engine capabilities)"
JSON_DATA="$output" python3 - <<'PY'
import json, os
data = json.loads(os.environ["JSON_DATA"])
assert data["dig"] is False, data
assert data["dig_status"]["available"] is True, data
assert data["dig_status"]["runnable"] is False, data
assert "bind-libs" in data["dig_status"]["message"], data
assert "isc_assertion_failed" in data["dig_status"]["message"], data
PY

if BROKEN_DIG=1 run_engine dns-start example.com >"$TMP/broken-dig.json" 2>/dev/null; then
    echo "broken dig was allowed to start a DNS job" >&2
    exit 1
fi
JSON_DATA="$(cat "$TMP/broken-dig.json")" python3 - <<'PY'
import json, os
data = json.loads(os.environ["JSON_DATA"])
assert data["success"] is False, data
assert "bind-libs" in data["message"], data
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
