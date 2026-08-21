#!/bin/sh

# Validates a curated catalogue of complete Zapret/Zapret2 profiles. It does
# not edit any installed configuration. The parent process has already stopped
# and verified Forkop/Tachyon/Podkop and standalone Zapret services.

set -u

STATE_PATH="${1:-}"
LOG_PATH="${2:-}"
DONE_PATH="${3:-}"
PROVIDER="${4:-}"
SCAN_LEVEL="${5:-standard}"
ENGINE="${6:-}"
ZAPRET_ROOT="${7:-}"
CATALOG="${8:-}"
TARGET_SPEC="${9:-}"
RESTORE_SERVICES="${10:-}"
MAX_SECONDS="${11:-1200}"
ENGINE_START_DELAY="${FORKOP_SC_ENGINE_START_DELAY:-1}"

ENGINE_PID=""
ACTIVE_PIDS=""
FINISHED=0
CANCELLED=0
TIMED_OUT=0
RC=1
RESTORE_FAILED=0
NFT_READY=0
NFT_TABLE="fkpsc_zapret_$$"
QNUM=$((300 + ($$ % 300)))
MARK="0x40000000"
STARTED="$(date +%s)"
TMP_DIR="${TMPDIR:-/tmp}/forkop-zapret-$$"

emit() {
    printf '%b\n' "$*" >> "$LOG_PATH"
}

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

stop_runtime() {
    for pid in $ACTIVE_PIDS; do
        kill "$pid" >/dev/null 2>&1 || true
    done
    ACTIVE_PIDS=""
    if [ -n "$ENGINE_PID" ]; then
        kill "$ENGINE_PID" >/dev/null 2>&1 || true
        wait "$ENGINE_PID" >/dev/null 2>&1 || true
        ENGINE_PID=""
    fi
    if [ "$NFT_READY" -eq 1 ]; then
        nft delete table inet "$NFT_TABLE" >/dev/null 2>&1 || true
        NFT_READY=0
    fi
}

finish() {
    [ "$FINISHED" -eq 1 ] && return
    FINISHED=1
    stop_runtime
    restore_services
    rm -rf "$TMP_DIR"
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

check_deadline() {
    now="$(date +%s)"
    if [ $((now - STARTED)) -ge "$MAX_SECONDS" ]; then
        TIMED_OUT=1
        RC=124
        return 1
    fi
    return 0
}

resolve_host() {
    host="$1"
    ip=""
    if command -v resolveip >/dev/null 2>&1; then
        ip="$(resolveip -4 -t 5 "$host" 2>/dev/null | sed -n '1p')"
    fi
    if [ -z "$ip" ] && command -v nslookup >/dev/null 2>&1; then
        ip="$(nslookup "$host" 2>/dev/null | awk '
            /^Name:[[:space:]]*/ { seen=1; next }
            seen && /^Address([[:space:]][0-9]+)?:[[:space:]]*/ {
                sub(/^Address([[:space:]][0-9]+)?:[[:space:]]*/, "")
                if ($0 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) { print; exit }
            }')"
    fi
    case "$ip" in
        *.*.*.*) printf '%s\n' "$ip" ;;
        *) return 1 ;;
    esac
}

check_endpoint() {
    role="$1"
    candidate_index="$2"
    candidate_id="$3"
    target_id="$4"
    service="$5"
    host="$6"
    ip="$7"
    began="$(date +%s)"
    ok=0
    reason="connect"
    if [ -z "$ip" ]; then
        reason="dns"
    elif curl --silent --show-error --output /dev/null --noproxy '*' --http1.1 \
        --connect-timeout 5 --max-time 10 --resolve "$host:443:$ip" "https://$host/" \
        >/dev/null 2>&1; then
        ok=1
        reason="ok"
    fi
    ended="$(date +%s)"
    emit "FKPSC\tendpoint\t$role\t$candidate_index\t$candidate_id\t$target_id\t$service\t$ok\t$((ended - began))\t$reason"
}

run_endpoint_batch() {
    role="$1"
    candidate_index="$2"
    candidate_id="$3"
    ACTIVE_PIDS=""
    while IFS="$(printf '\t')" read -r target_id service host ip; do
        [ -n "$target_id" ] || continue
        check_endpoint "$role" "$candidate_index" "$candidate_id" "$target_id" "$service" "$host" "$ip" &
        ACTIVE_PIDS="$ACTIVE_PIDS $!"
    done < "$TMP_DIR/targets.tsv"
    for pid in $ACTIVE_PIDS; do
        wait "$pid" >/dev/null 2>&1 || true
    done
    ACTIVE_PIDS=""
}

setup_nft() {
    nft add table inet "$NFT_TABLE" >/dev/null 2>&1 || return 1
    NFT_READY=1
    nft add chain inet "$NFT_TABLE" output \
        '{ type filter hook output priority mangle; policy accept; }' >/dev/null 2>&1 || return 1
    while IFS="$(printf '\t')" read -r target_id service host ip; do
        [ -n "$ip" ] || continue
        nft add rule inet "$NFT_TABLE" output meta mark != "$MARK" ip daddr "$ip" \
            tcp dport 443 queue num "$QNUM" bypass >/dev/null 2>&1 || return 1
    done < "$TMP_DIR/targets.tsv"
    return 0
}

start_engine() {
    strategy="$1"
    : > "$TMP_DIR/engine.log"
    set -- "$ENGINE" "--qnum=$QNUM"
    if [ "$PROVIDER" = "zapret2" ]; then
        set -- "$@" "--fwmark=$MARK" \
            "--lua-init=@$ZAPRET_ROOT/lua/zapret-lib.lua" \
            "--lua-init=@$ZAPRET_ROOT/lua/zapret-antidpi.lua"
    else
        set -- "$@" "--dpi-desync-fwmark=$MARK"
    fi
    # Catalogue values deliberately contain no whitespace inside an individual
    # option. Splitting here produces exactly the argv expected by nfqws.
    set -- "$@" $strategy
    "$@" >> "$TMP_DIR/engine.log" 2>&1 &
    ENGINE_PID=$!
    sleep "$ENGINE_START_DELAY"
    kill -0 "$ENGINE_PID" >/dev/null 2>&1
}

if [ -z "$STATE_PATH" ] || [ -z "$LOG_PATH" ] || [ -z "$DONE_PATH" ] ||
   [ -z "$TARGET_SPEC" ] || [ ! -x "$ENGINE" ] || [ ! -f "$CATALOG" ]; then
    [ -n "$LOG_PATH" ] && printf '%b\n' 'FKPSC\terror\tinvalid worker arguments, engine or catalogue' > "$LOG_PATH"
    [ -n "$DONE_PATH" ] && printf 'complete\t2\t0\n' > "$DONE_PATH"
    exit 2
fi
case "$PROVIDER" in zapret|zapret2) ;; *) printf '%b\n' 'FKPSC\terror\tinvalid provider' > "$LOG_PATH"; exit 2 ;; esac
case "$SCAN_LEVEL" in quick|standard|force) ;; *) printf '%b\n' 'FKPSC\terror\tinvalid scan level' > "$LOG_PATH"; exit 2 ;; esac
case "$MAX_SECONDS" in ''|*[!0-9]*) MAX_SECONDS=1200 ;; esac

trap on_signal INT TERM HUP
trap finish EXIT

: > "$LOG_PATH"
rm -f "$DONE_PATH"
mkdir -p "$TMP_DIR"

printf '%s\n' "$TARGET_SPEC" | tr ';' '\n' | while IFS=',' read -r target_id service host; do
    [ -n "$target_id" ] && [ -n "$service" ] && [ -n "$host" ] || continue
    ip="$(resolve_host "$host" || true)"
    printf '%s\t%s\t%s\t%s\n' "$target_id" "$service" "$host" "$ip"
done > "$TMP_DIR/targets.tsv"

target_total="$(awk 'END { print NR + 0 }' "$TMP_DIR/targets.tsv")"
if [ "$target_total" -eq 0 ]; then
    emit "FKPSC\terror\tno valid targets"
    RC=2
    exit "$RC"
fi

case "$SCAN_LEVEL" in
    quick) candidate_limit=4 ;;
    standard) candidate_limit=8 ;;
    force) candidate_limit=999 ;;
esac

tab="$(printf '\t')"
candidate_total=0
: > "$TMP_DIR/candidates.tsv"
while IFS="$tab" read -r row_provider candidate_id title source quic strategy; do
    case "$row_provider" in ''|'#'*) continue ;; esac
    [ "$row_provider" = "$PROVIDER" ] || continue
    [ -n "$candidate_id" ] && [ -n "$strategy" ] || continue
    [ "$candidate_total" -lt "$candidate_limit" ] || continue
    strategy="$(printf '%s\n' "$strategy" | sed "s|@BASE@|$ZAPRET_ROOT|g")"
    printf '%s\t%s\t%s\t%s\t%s\n' "$candidate_id" "$title" "$source" "$quic" "$strategy" >> "$TMP_DIR/candidates.tsv"
    candidate_total=$((candidate_total + 1))
done < "$CATALOG"

if [ "$candidate_total" -eq 0 ]; then
    emit "FKPSC\terror\tno ready profiles for $PROVIDER"
    RC=2
    exit "$RC"
fi

check_total=$(((candidate_total + 1) * target_total))
emit "FKPSC\tmeta\t$PROVIDER\t$candidate_total\t$target_total\t$check_total\t$ENGINE\t$ZAPRET_ROOT"
emit "FKPSC\tphase\tresolve\tDNS: $target_total целей подготовлено"
while IFS="$tab" read -r target_id service host ip; do
    if [ -n "$ip" ]; then result=ok; else result=failed; fi
    emit "FKPSC\tresolve\t$target_id\t$service\t$host\t$ip\t$result"
done < "$TMP_DIR/targets.tsv"

emit "FKPSC\tphase\tbaseline\tПроверка без обхода"
run_endpoint_batch direct 0 direct
check_deadline || exit "$RC"

if ! setup_nft; then
    emit "FKPSC\terror\tfailed to create isolated nftables queue"
    RC=3
    exit "$RC"
fi

candidate_index=0
while IFS="$tab" read -r candidate_id title source quic strategy; do
    check_deadline || exit "$RC"
    candidate_index=$((candidate_index + 1))
    emit "FKPSC\tphase\tstrategy\tГотовый профиль $candidate_index из $candidate_total"
    emit "FKPSC\tstrategy_start\t$candidate_index\t$candidate_total\t$candidate_id\t$title\t$source\t$quic\t$strategy"
    if start_engine "$strategy"; then
        command -v conntrack >/dev/null 2>&1 && conntrack -F >/dev/null 2>&1 || true
        run_endpoint_batch strategy "$candidate_index" "$candidate_id"
    else
        engine_error="$(tail -n 1 "$TMP_DIR/engine.log" 2>/dev/null | tr '\t\r\n' '   ')"
        emit "FKPSC\tengine_error\t$candidate_index\t$candidate_id\t$engine_error"
        while IFS="$tab" read -r target_id service host ip; do
            emit "FKPSC\tendpoint\tstrategy\t$candidate_index\t$candidate_id\t$target_id\t$service\t0\t0\tengine"
        done < "$TMP_DIR/targets.tsv"
    fi
    if [ -n "$ENGINE_PID" ]; then
        kill "$ENGINE_PID" >/dev/null 2>&1 || true
        wait "$ENGINE_PID" >/dev/null 2>&1 || true
        ENGINE_PID=""
    fi
    score="$(awk -F '\t' -v id="$candidate_id" '$1=="FKPSC" && $2=="endpoint" && $3=="strategy" && $5==id && $8==1 { n++ } END { print n + 0 }' "$LOG_PATH")"
    emit "FKPSC\tstrategy_done\t$candidate_index\t$candidate_total\t$candidate_id\t$score\t$target_total"
done < "$TMP_DIR/candidates.tsv"

emit "FKPSC\tphase\tcomplete\tПроверка готовых профилей завершена"
RC=0
exit 0
