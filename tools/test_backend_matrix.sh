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
case "${1:-}" in
    -q)
        [ "${2:-}" = "get" ] || exit 1
        awk -v key="set ${3:-}=" 'index($0,key)==1 { value=substr($0,length(key)+1) } END { if (value != "") print value; else exit 1 }' "${UCI_LOG:-/dev/null}"
        ;;
    set|add_list|commit|delete)
        [ -z "${UCI_LOG:-}" ] || printf '%s\n' "$*" >> "$UCI_LOG"
        exit 0
        ;;
esac
exit 1
EOF
cat > "$TMP/bin/opkg" <<'EOF'
#!/bin/sh
exit 0
EOF
cat > "$TMP/bin/wg" <<'EOF'
#!/bin/sh
if [ "${1:-}" = "show" ] && [ "${3:-}" = "latest-handshakes" ]; then
    count="$(cat "${VPN_PROBE_STATE:-/dev/null}" 2>/dev/null || echo 0)"
    [ "$count" -gt 0 ] && printf '%s\t%s\n' 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=' '1234567890'
elif [ "${1:-}" = "show" ] && [ "${3:-}" = "transfer" ]; then
    count="$(cat "${VPN_PROBE_STATE:-/dev/null}" 2>/dev/null || echo 0)"
    printf '%s\t%s\t%s\n' 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=' "$((count * 32))" "$((count * 64))"
fi
exit 0
EOF
cp "$TMP/bin/wg" "$TMP/bin/awg"
cat > "$TMP/bin/ifup" <<'EOF'
#!/bin/sh
exit 0
EOF
cat > "$TMP/bin/ip" <<'EOF'
#!/bin/sh
if [ "${1:-}" = "-4" ]; then
    echo '2: br-lan    inet 192.168.50.1/24 brd 192.168.50.255 scope global br-lan'
fi
exit 0
EOF
cat > "$TMP/bin/ping" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "${VPN_PING_LOG:-/dev/null}"
count="$(cat "${VPN_PROBE_STATE:-/dev/null}" 2>/dev/null || echo 0)"
printf '%s\n' "$((count + 1))" > "${VPN_PROBE_STATE:-/dev/null}"
echo '1 packets transmitted, 1 packets received'
exit 0
EOF
cp "$TMP/bin/ping" "$TMP/bin/ping6"
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
mkdir -p "$TMP/proto"
: > "$TMP/proto/wireguard.sh"
echo 'proto_config_add_string "awg_i1"' > "$TMP/proto/amneziawg.sh"

run_engine() {
    PATH="$TMP/bin:/usr/bin:/bin" \
    FORKOP_SC_LIB="$LIB" \
    FORKOP_SC_STATE_DIR="$TMP/state" \
    FORKOP_SC_SING_BOX_CONFIG="$TMP/config.json" \
    FORKOP_SC_NETIFD_PROTO_DIR="$TMP/proto" \
    UCI_LOG="$TMP/uci.log" \
    VPN_PROBE_STATE="$TMP/vpn-probe-count" \
    VPN_PING_LOG="$TMP/vpn-ping.log" \
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

private_key='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
public_key='BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='
assert_uci() {
    expected="$1"
    if ! grep -Fxq "$expected" "$TMP/uci.log"; then
        echo "missing UCI command: $expected" >&2
        echo "recorded UCI commands:" >&2
        sed 's/private_key=.*/private_key=<redacted>/' "$TMP/uci.log" >&2
        exit 1
    fi
}
assert_no_uci() {
    forbidden="$1"
    if grep -Fq "$forbidden" "$TMP/uci.log"; then
        echo "unsafe UCI command detected: $forbidden" >&2
        sed 's/private_key=.*/private_key=<redacted>/' "$TMP/uci.log" >&2
        exit 1
    fi
}
assert_vpn_ping() {
    expected="$1"
    if ! grep -Fq -- "$expected" "$TMP/vpn-ping.log"; then
        echo "expected VPN probe was not sent: $expected" >&2
        [ ! -f "$TMP/vpn-ping.log" ] || sed -n '1,80p' "$TMP/vpn-ping.log" >&2
        exit 1
    fi
}
wireguard_config="[Interface]
PrivateKey = $private_key
Address = 10.0.0.2/8
Address = fd00::2/64
DNS = 1.1.1.1
DNS = 2606:4700:4700::1111
ListenPort = 51820
FwMark = 0xca6c

[Peer]
PublicKey = $public_key
AllowedIPs = 0.0.0.0/1
AllowedIPs = 128.0.0.0/1, ::/0
Endpoint = 162.159.195.1:500
PersistentKeepalive = 25"
: > "$TMP/uci.log"
if ! output="$(run_engine vpn-create vpn0 auto "$wireguard_config")"; then
    echo "WireGuard VPN creation failed: $output" >&2
    exit 1
fi
JSON_DATA="$output" python3 - <<'PY'
import json, os
data = json.loads(os.environ["JSON_DATA"])
assert data["success"] is True, data
assert data["protocol"] == data["detected"] == "wireguard", data
assert data["link_up"] is True and data["handshake"] is True, data
assert data["test_packet_sent"] is True and data["tunnel_ok"] is True, data
assert data["probe_target"] == "1.1.1.1", data
assert data["safe_mode"] is True, data
assert data["dns_applied"] is False and data["ignored_dns"] == 2, data
assert data["routes_enabled"] is False, data
assert data["fwmark_applied"] is False and data["ignored_fwmark"] is True, data
assert data["listen_port_applied"] is False and data["ignored_listen_port"] is True, data
assert data["addresses_host_only"] is True, data
PY
assert_uci 'set network.wireguard_vpn0_1=wireguard_vpn0'
assert_uci 'set network.wireguard_vpn0_1.route_allowed_ips=0'
assert_uci 'add_list network.vpn0.addresses=10.0.0.2/32'
assert_uci 'add_list network.vpn0.addresses=fd00::2/128'
assert_no_uci 'network.vpn0.dns='
assert_no_uci 'network.vpn0.fwmark='
assert_no_uci 'network.vpn0.listen_port='
assert_no_uci 'network.vpn0.addresses=10.0.0.2/8'
assert_no_uci 'network.vpn0.addresses=fd00::2/64'
assert_no_uci 'route_allowed_ips=1'
assert_uci 'add_list network.wireguard_vpn0_1.allowed_ips=0.0.0.0/1'
assert_uci 'add_list network.wireguard_vpn0_1.allowed_ips=128.0.0.0/1'
assert_uci 'add_list network.wireguard_vpn0_1.allowed_ips=::/0'
assert_vpn_ping '-I vpn0 -c 1 -W 3 1.1.1.1'

amneziawg_config="[Interface]
PrivateKey = $private_key
Address = 172.16.0.2, 2606:4700:110:8b64:9e1c:6ef7:1063:2d84
DNS = 1.1.1.1, 1.0.0.1, 2606:4700:4700::1111, 2606:4700:4700::1001
MTU = 1280
Jc = 5
Jmin = 50
Jmax = 90
S1 = 0
S2 = 0
H1 = 1
H2 = 2
H3 = 3
H4 = 4
I1 = <b 0x0123456789abcdef0123456789abcdef>

[Peer]
PublicKey = $public_key
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = vpn.example.com:51820"
: > "$TMP/uci.log"
if ! output="$(run_engine vpn-create awg0 auto "$amneziawg_config")"; then
    echo "AmneziaWG VPN creation failed: $output" >&2
    exit 1
fi
JSON_DATA="$output" python3 - <<'PY'
import json, os
data = json.loads(os.environ["JSON_DATA"])
assert data["success"] is True, data
assert data["protocol"] == data["detected"] == "amneziawg", data
assert data["awg_version"] == "1.5", data
assert data["safe_mode"] is True, data
assert data["dns_applied"] is False and data["ignored_dns"] == 4, data
assert data["routes_enabled"] is False, data
assert data["fwmark_applied"] is False and data["ignored_fwmark"] is False, data
assert data["listen_port_applied"] is False and data["ignored_listen_port"] is False, data
assert data["addresses_host_only"] is True, data
PY
assert_uci 'set network.amneziawg_awg0_1=amneziawg_awg0'
assert_uci 'set network.amneziawg_awg0_1.route_allowed_ips=0'
assert_uci 'add_list network.awg0.addresses=172.16.0.2/32'
assert_uci 'add_list network.awg0.addresses=2606:4700:110:8b64:9e1c:6ef7:1063:2d84/128'
assert_no_uci 'network.awg0.dns='
assert_no_uci 'network.awg0.fwmark='
assert_no_uci 'network.awg0.listen_port='
assert_no_uci 'route_allowed_ips=1'
assert_uci 'set network.awg0.awg_i1=<b 0x0123456789abcdef0123456789abcdef>'
assert_vpn_ping '-I awg0 -c 1 -W 3 1.1.1.1'

if ! output="$(run_engine vpn-check awg0 9.9.9.9)"; then
    echo "Manual AWG check failed: $output" >&2
    exit 1
fi
JSON_DATA="$output" python3 - <<'PY'
import json, os
data = json.loads(os.environ["JSON_DATA"])
assert data["success"] is True and data["tunnel_ok"] is True, data
assert data["interface"] == "awg0" and data["protocol"] == "amneziawg", data
assert data["target"] == "9.9.9.9", data
assert data["link_up"] is True and data["packet_sent"] is True, data
assert data["ping_ok"] is True and data["handshake"] is True, data
assert data["tx_bytes"] > 0 and data["rx_bytes"] > 0, data
PY
assert_vpn_ping '-I awg0 -c 1 -W 3 9.9.9.9'

if run_engine vpn-check unmanaged0 1.1.1.1 >"$TMP/unmanaged-vpn.json" 2>/dev/null; then
    echo "ERROR: unmanaged VPN interface must be rejected" >&2
    exit 1
fi
JSON_DATA="$(cat "$TMP/unmanaged-vpn.json")" python3 - <<'PY'
import json, os
data = json.loads(os.environ["JSON_DATA"])
assert data["success"] is False and "созданного этим модулем" in data["message"], data
PY

if run_engine vpn-check awg0 example.com >"$TMP/invalid-vpn-target.json" 2>/dev/null; then
    echo "ERROR: VPN check must reject a domain target" >&2
    exit 1
fi
JSON_DATA="$(cat "$TMP/invalid-vpn-target.json")" python3 - <<'PY'
import json, os
data = json.loads(os.environ["JSON_DATA"])
assert data["success"] is False and "IP" in data["message"], data
PY

duplicate_config="[Interface]
PrivateKey = $private_key
PrivateKey = $private_key
Address = 10.0.0.4/32

[Peer]
PublicKey = $public_key
AllowedIPs = 0.0.0.0/0"
if run_engine vpn-create duplicate0 auto "$duplicate_config" >"$TMP/duplicate.json" 2>/dev/null; then
    echo "duplicate scalar VPN parameter was accepted" >&2
    exit 1
fi
JSON_DATA="$(cat "$TMP/duplicate.json")" python3 - <<'PY'
import json, os
data = json.loads(os.environ["JSON_DATA"])
assert data["success"] is False, data
assert "повторный параметр [Interface]: PrivateKey" in data["message"], data
PY

invalid_address_config="[Interface]
PrivateKey = $private_key
Address = 999.1.1.1/99

[Peer]
PublicKey = $public_key
AllowedIPs = 0.0.0.0/0"
if run_engine vpn-create invalid0 auto "$invalid_address_config" >"$TMP/invalid-address.json" 2>/dev/null; then
    echo "invalid VPN address was accepted" >&2
    exit 1
fi
JSON_DATA="$(cat "$TMP/invalid-address.json")" python3 - <<'PY'
import json, os
data = json.loads(os.environ["JSON_DATA"])
assert data["success"] is False, data
assert data["message"] == "некорректный Address", data
PY

invalid_mtu_config="[Interface]
PrivateKey = $private_key
Address = 10.0.0.5/32
MTU = 70000

[Peer]
PublicKey = $public_key
AllowedIPs = 0.0.0.0/0"
if run_engine vpn-create invalidmtu0 auto "$invalid_mtu_config" >"$TMP/invalid-mtu.json" 2>/dev/null; then
    echo "out-of-range VPN MTU was accepted" >&2
    exit 1
fi
JSON_DATA="$(cat "$TMP/invalid-mtu.json")" python3 - <<'PY'
import json, os
data = json.loads(os.environ["JSON_DATA"])
assert data["success"] is False, data
assert data["message"] == "MTU должен быть от 576 до 65535", data
PY

invalid_port_config="[Interface]
PrivateKey = $private_key
Address = 10.0.0.6/32
ListenPort = 65536

[Peer]
PublicKey = $public_key
AllowedIPs = 0.0.0.0/0"
if run_engine vpn-create invalidport0 auto "$invalid_port_config" >"$TMP/invalid-port.json" 2>/dev/null; then
    echo "out-of-range VPN ListenPort was accepted" >&2
    exit 1
fi
JSON_DATA="$(cat "$TMP/invalid-port.json")" python3 - <<'PY'
import json, os
data = json.loads(os.environ["JSON_DATA"])
assert data["success"] is False, data
assert data["message"] == "некорректный ListenPort", data
PY

echo "backend runtime matrix: OK"
