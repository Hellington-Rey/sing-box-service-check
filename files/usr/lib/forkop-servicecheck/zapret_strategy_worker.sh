#!/bin/sh

# Runs the installed, upstream blockcheck without editing Zapret/Forkop configs.
# The parent ucode process has already stopped and verified conflicting services.

set -u

STATE_PATH="${1:-}"
LOG_PATH="${2:-}"
DONE_PATH="${3:-}"
PROVIDER="${4:-}"
SCAN_LEVEL="${5:-standard}"
BLOCKCHECK="${6:-}"
DOMAINS="${7:-}"
RESTORE_SERVICES="${8:-}"
MAX_SECONDS="${9:-1200}"

BC_PID=""
FINISHED=0
CANCELLED=0
TIMED_OUT=0
RC=1
RESTORE_FAILED=0

start_service() {
    binary=""
    case "$1" in
        zapret-service) name="zapret" ;;
        zapret2-service) name="zapret2" ;;
        tachyon) name="tachyon"; binary="${TACHYON_BIN:-/usr/bin/tachyon}" ;;
        forkop) name="forkop"; binary="${FORKOP_BIN:-/usr/bin/forkop}" ;;
        podkop) name="podkop"; binary="${PODKOP_BIN:-/usr/bin/podkop}" ;;
        *) return 0 ;;
    esac
    if [ -x "/etc/init.d/$name" ]; then
        "/etc/init.d/$name" start >/dev/null 2>&1
    elif [ -n "$binary" ] && [ -x "$binary" ]; then
        "$binary" start >/dev/null 2>&1
    else
        return 1
    fi
}

restore_services() {
    old_ifs="$IFS"
    IFS=','
    for service in $RESTORE_SERVICES; do
        if [ -n "$service" ] && ! start_service "$service"; then
            RESTORE_FAILED=1
        fi
    done
    IFS="$old_ifs"
}

kill_blockcheck() {
    if [ -n "$BC_PID" ]; then
        kill "$BC_PID" >/dev/null 2>&1 || true
        command -v pkill >/dev/null 2>&1 && pkill -TERM -P "$BC_PID" >/dev/null 2>&1 || true
        wait "$BC_PID" >/dev/null 2>&1 || true
        BC_PID=""
    fi
    if command -v nft >/dev/null 2>&1 && nft list tables 2>/dev/null | grep -q 'blockcheck'; then
        nft delete table inet blockcheck >/dev/null 2>&1 || true
    fi
}

finish() {
    [ "$FINISHED" -eq 1 ] && return
    FINISHED=1
    kill_blockcheck
    restore_services
    if [ "$CANCELLED" -eq 1 ]; then
        printf 'cancelled\t130\t%s\n' "$RESTORE_FAILED" > "$DONE_PATH"
    elif [ "$TIMED_OUT" -eq 1 ]; then
        printf 'timeout\t124\t%s\n' "$RESTORE_FAILED" > "$DONE_PATH"
    else
        printf 'complete\t%s\t%s\n' "$RC" "$RESTORE_FAILED" > "$DONE_PATH"
    fi
}

on_signal() {
    CANCELLED=1
    finish
    exit 130
}

trap on_signal INT TERM HUP
trap finish EXIT

: > "$LOG_PATH"
rm -f "$DONE_PATH"

if [ -z "$STATE_PATH" ] || [ -z "$LOG_PATH" ] || [ -z "$DONE_PATH" ] ||
   [ -z "$DOMAINS" ] || [ ! -f "$BLOCKCHECK" ]; then
    printf '%s\n' 'Invalid worker arguments or blockcheck path' >> "$LOG_PATH"
    RC=2
    exit "$RC"
fi

command -v conntrack >/dev/null 2>&1 && conntrack -F >/dev/null 2>&1 || true

DOMAINS="$DOMAINS" \
IPV=4 IPVS=4 SCANLEVEL="$SCAN_LEVEL" \
ENABLE_HTTP=0 ENABLE_HTTPS_TLS12=1 ENABLE_HTTPS_TLS13=1 ENABLE_HTTP3=1 \
CURL_TEST_HTTP=0 CURL_TEST_HTTPS_TLS12=1 CURL_TEST_HTTPS_TLS13=1 CURL_TEST_QUIC=1 \
BATCH=1 PARALLEL=0 REPEATS=1 \
sh "$BLOCKCHECK" > "$LOG_PATH" 2>&1 &
BC_PID=$!

started="$(date +%s)"
while kill -0 "$BC_PID" >/dev/null 2>&1; do
    now="$(date +%s)"
    elapsed=$((now - started))
    if [ "$elapsed" -ge "$MAX_SECONDS" ]; then
        TIMED_OUT=1
        kill_blockcheck
        RC=124
        exit "$RC"
    fi
    sleep 2
done

wait "$BC_PID"
RC=$?
BC_PID=""
exit "$RC"
