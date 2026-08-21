#!/bin/sh

# Dry strategy selector for Zapret/Zapret2. Two modes are supported:
#   ready - validate curated complete profiles from the bundled catalogue;
#   auto  - discover TLS 1.3, TLS 1.2 and QUIC fragments with the installed
#           stock blockcheck, compose several complete profiles and validate
#           every profile against all configured HTTPS targets.
#
# The parent process has already stopped and verified Forkop/Tachyon/Podkop
# and standalone Zapret services. This worker never edits their configuration.

set -u

STATE_PATH="${1:-}"
LOG_PATH="${2:-}"
DONE_PATH="${3:-}"
PROVIDER="${4:-}"
SELECTION_MODE="${5:-ready}"
SCAN_LEVEL="${6:-standard}"
ENGINE="${7:-}"
ZAPRET_ROOT="${8:-}"
BLOCKCHECK="${9:-}"
CATALOG="${10:-}"
TARGET_SPEC="${11:-}"
RESTORE_SERVICES="${12:-}"
MAX_SECONDS="${13:-1800}"
ENGINE_START_DELAY="${FORKOP_SC_ENGINE_START_DELAY:-1}"
SCAN_POLL_SECONDS="${FORKOP_SC_SCAN_POLL_SECONDS:-2}"

ENGINE_PID=""
BLOCKCHECK_PID=""
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
tab="$(printf '\t')"

emit() {
    printf '%b\n' "$*" >> "$LOG_PATH"
}

safe_text() {
    printf '%s' "$1" | tr '\t\r\n' '   ' | sed 's/[[:space:]][[:space:]]*/ /g; s/^ //; s/ $//'
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

cleanup_blockcheck_nft() {
    if nft list table inet blockcheck >/dev/null 2>&1; then
        nft delete table inet blockcheck >/dev/null 2>&1 || true
    fi
}

stop_blockcheck() {
    [ -n "$BLOCKCHECK_PID" ] || return 0
    kill "$BLOCKCHECK_PID" >/dev/null 2>&1 || true
    if command -v pkill >/dev/null 2>&1; then
        pkill -TERM -P "$BLOCKCHECK_PID" >/dev/null 2>&1 || true
    fi
    wait "$BLOCKCHECK_PID" >/dev/null 2>&1 || true
    BLOCKCHECK_PID=""
    cleanup_blockcheck_nft
}

stop_runtime() {
    stop_blockcheck
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
    while IFS="$tab" read -r target_id service host ip; do
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
    while IFS="$tab" read -r target_id service host ip; do
        [ -n "$ip" ] || continue
        nft add rule inet "$NFT_TABLE" output meta mark != "$MARK" ip daddr "$ip" \
            tcp dport 443 queue num "$QNUM" bypass >/dev/null 2>&1 || return 1
    done < "$TMP_DIR/targets.tsv"
    return 0
}

voice_profile() {
    if [ "$PROVIDER" = "zapret2" ]; then
        printf '%s' '--new --filter-udp=50000-50099,19294-19344 --filter-l7=discord,stun --payload=discord_ip_discovery,stun --lua-desync=fake:blob=0x00000000000000000000000000000000:repeats=2'
    else
        printf '%s' '--new --filter-udp=50000-50099,19294-19344 --filter-l7=discord,stun --dpi-desync=fake --dpi-desync-repeats=2'
    fi
}

ensure_voice_profile() {
    strategy="$1"
    case "$strategy" in
        *discord_ip_discovery*|*--filter-l7=discord,stun*) printf '%s\n' "$strategy" ;;
        *) printf '%s %s\n' "$strategy" "$(voice_profile)" ;;
    esac
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
    # Candidate values deliberately contain no whitespace inside an option.
    # Splitting here produces the argv expected by nfqws/nfqws2.
    set -- "$@" $strategy
    "$@" >> "$TMP_DIR/engine.log" 2>&1 &
    ENGINE_PID=$!
    sleep "$ENGINE_START_DELAY"
    kill -0 "$ENGINE_PID" >/dev/null 2>&1
}

extract_available() {
    tag="$1"
    logfile="$2"
    awk -v tag="$tag" -v engine="$ENGINE_NAME" '
        index($0, engine " ") && index($0, tag) {
            pos=index($0, engine " ")
            cand=substr($0, pos + length(engine) + 1)
            next
        }
        /UNAVAILABLE/ { cand=""; next }
        /!!!!! AVAILABLE !!!!!/ {
            if (cand != "") { print cand; cand="" }
            next
        }
    ' "$logfile"
}

sanitize_fragment() {
    awk '
        {
            out=""; skip=0
            for (i=1; i<=NF; i++) {
                token=$i
                if (skip) { skip=0; continue }
                base=token; sub(/=.*/, "", base)
                if (base == "--payload" || base ~ /^--filter-/ || base == "--new" ||
                    base == "--qnum" || base == "--fwmark" || base == "--dpi-desync-fwmark" ||
                    base == "--lua-init" || base == "--intercept" || base == "--pidfile" ||
                    base == "--daemon" || base == "--user" || base == "--uid" ||
                    base ~ /^--hostlist/ || base ~ /^--ipset/) {
                    if (token == base && (base == "--payload" || base ~ /^--filter-/ ||
                        base == "--qnum" || base == "--fwmark" || base == "--dpi-desync-fwmark" ||
                        base == "--lua-init" || base == "--intercept" || base == "--pidfile" ||
                        base == "--user" || base == "--uid" || base ~ /^--hostlist/ || base ~ /^--ipset/))
                        skip=1
                    continue
                }
                out = out (out == "" ? "" : " ") token
            }
            if (out != "") print out
        }
    '
}

scan_limits() {
    case "$SCAN_LEVEL" in
        quick)
            WANT_TLS=3; WANT_QUIC=2; TLS_TIMEOUT=120; QUIC_TIMEOUT=120; AUTO_CANDIDATE_LIMIT=3 ;;
        standard)
            WANT_TLS=8; WANT_QUIC=4; TLS_TIMEOUT=300; QUIC_TIMEOUT=300; AUTO_CANDIDATE_LIMIT=6 ;;
        force)
            WANT_TLS=15; WANT_QUIC=8; TLS_TIMEOUT=600; QUIC_TIMEOUT=600; AUTO_CANDIDATE_LIMIT=10 ;;
    esac
}

run_scan_protocol() {
    proto="$1"
    phase_index="$2"
    logfile="$TMP_DIR/blockcheck-$proto.log"
    resultfile="$TMP_DIR/$proto.txt"
    direct=0
    phase_timed_out=0
    case "$proto" in
        tls13)
            tag="curl_test_https_tls13"; want="$WANT_TLS"; phase_timeout="$TLS_TIMEOUT"
            en_tls12=0; en_tls13=1; en_http3=0; ct_tls12=0; ct_tls13=1; ct_quic=0 ;;
        tls12)
            tag="curl_test_https_tls12"; want="$WANT_TLS"; phase_timeout="$TLS_TIMEOUT"
            en_tls12=1; en_tls13=0; en_http3=0; ct_tls12=1; ct_tls13=0; ct_quic=0 ;;
        quic)
            tag="curl_test_http3"; want="$WANT_QUIC"; phase_timeout="$QUIC_TIMEOUT"
            en_tls12=0; en_tls13=0; en_http3=1; ct_tls12=0; ct_tls13=0; ct_quic=1 ;;
    esac

    : > "$logfile"
    emit "FKPSC\tphase\tscan\tАвтоподбор: $proto"
    emit "FKPSC\tscan_start\t$proto\t$phase_index\t3\t$phase_timeout\t$want\t$DISCOVERY_DOMAINS"
    (
        cd "$ZAPRET_ROOT" || exit 2
        DOMAINS="$DISCOVERY_DOMAINS" \
        SKIP_DNSCHECK=1 IPV=4 SCANLEVEL="$SCAN_LEVEL" \
        ENABLE_HTTP=0 ENABLE_HTTPS_TLS12="$en_tls12" ENABLE_HTTPS_TLS13="$en_tls13" ENABLE_HTTP3="$en_http3" \
        CURL_TEST_HTTP=0 CURL_TEST_HTTPS_TLS12="$ct_tls12" CURL_TEST_HTTPS_TLS13="$ct_tls13" CURL_TEST_QUIC="$ct_quic" \
        BATCH=1 PARALLEL=1 "$BLOCKCHECK"
    ) > "$logfile" 2>&1 &
    BLOCKCHECK_PID=$!
    phase_started="$(date +%s)"

    while kill -0 "$BLOCKCHECK_PID" >/dev/null 2>&1; do
        check_deadline || return 124
        now="$(date +%s)"
        phase_elapsed=$((now - phase_started))
        found="$(extract_available "$tag" "$logfile" 2>/dev/null | awk 'NF { n++ } END { print n + 0 }')"
        attempts="$(awk -v tag="$tag" -v engine="$ENGINE_NAME" 'index($0, tag) && index($0, engine " ") { n++ } END { print n + 0 }' "$logfile")"
        raw="$(tail -n 1 "$logfile" 2>/dev/null || true)"
        case "$raw" in
            *"$ENGINE_NAME "*) last="$ENGINE_NAME $(printf '%s' "$raw" | sed "s/.*$ENGINE_NAME //")" ;;
            *) last="$raw" ;;
        esac
        last="$(safe_text "$last")"
        emit "FKPSC\tscan_tick\t$proto\t$phase_index\t3\t$phase_elapsed\t$phase_timeout\t$attempts\t$found\t$want\t$last"

        if grep -qiE "$tag.*working without bypass" "$logfile" 2>/dev/null; then
            direct=1
            stop_blockcheck
            break
        fi
        if [ "$want" -gt 0 ] && [ "$found" -ge "$want" ]; then
            stop_blockcheck
            break
        fi
        if [ "$phase_timeout" -gt 0 ] && [ "$phase_elapsed" -ge "$phase_timeout" ]; then
            phase_timed_out=1
            stop_blockcheck
            break
        fi
        sleep "$SCAN_POLL_SECONDS"
    done

    if [ -n "$BLOCKCHECK_PID" ]; then
        wait "$BLOCKCHECK_PID" >/dev/null 2>&1 || true
        BLOCKCHECK_PID=""
        cleanup_blockcheck_nft
    fi
    extract_available "$tag" "$logfile" 2>/dev/null | sanitize_fragment | awk 'NF && !seen[$0]++' > "$resultfile"
    found="$(awk 'NF { n++ } END { print n + 0 }' "$resultfile")"
    attempts="$(awk -v tag="$tag" -v engine="$ENGINE_NAME" 'index($0, tag) && index($0, engine " ") { n++ } END { print n + 0 }' "$logfile")"
    phase_ended="$(date +%s)"
    emit "FKPSC\tscan_done\t$proto\t$phase_index\t3\t$((phase_ended - phase_started))\t$attempts\t$found\t$phase_timed_out\t$direct"
    return 0
}

prepare_ready_candidates() {
    case "$SCAN_LEVEL" in
        quick) candidate_limit=4 ;;
        standard) candidate_limit=8 ;;
        force) candidate_limit=999 ;;
    esac
    candidate_total=0
    : > "$TMP_DIR/candidates.tsv"
    while IFS="$tab" read -r row_provider candidate_id title source quic strategy; do
        case "$row_provider" in ''|'#'*) continue ;; esac
        [ "$row_provider" = "$PROVIDER" ] || continue
        [ -n "$candidate_id" ] && [ -n "$strategy" ] || continue
        [ "$candidate_total" -lt "$candidate_limit" ] || continue
        strategy="$(printf '%s\n' "$strategy" | sed "s|@BASE@|$ZAPRET_ROOT|g")"
        strategy="$(ensure_voice_profile "$strategy")"
        printf '%s\t%s\t%s\t%s\t%s\n' "$candidate_id" "$title" "$source" "$quic" "$strategy" >> "$TMP_DIR/candidates.tsv"
        candidate_total=$((candidate_total + 1))
    done < "$CATALOG"
}

build_composite_strategy() {
    tls="$1"
    quic="$2"
    if [ "$PROVIDER" = "zapret2" ]; then
        strategy="--filter-tcp=80 --filter-l7=http --payload=http_req --lua-desync=multisplit:pos=method+2"
        if [ -n "$tls" ]; then
            strategy="$strategy --new --filter-tcp=443 --filter-l7=tls --payload=tls_client_hello $tls"
        fi
        if [ -n "$quic" ]; then
            strategy="$strategy --new --filter-udp=443 --filter-l7=quic --payload=quic_initial $quic"
        fi
    else
        strategy="--filter-tcp=80 --dpi-desync=fake,fakedsplit --dpi-desync-autottl=2 --dpi-desync-fooling=badsum"
        if [ -n "$tls" ]; then
            strategy="$strategy --new --filter-tcp=443 $tls"
        fi
        if [ -n "$quic" ]; then
            strategy="$strategy --new --filter-udp=443 $quic"
        fi
    fi
    ensure_voice_profile "$strategy"
}

prepare_auto_candidates() {
    scan_limits
    DISCOVERY_DOMAINS="$(awk -F '\t' '!seen[$2]++ && $3 != "" { out=out (out=="" ? "" : " ") $3 } END { print out }' "$TMP_DIR/targets.tsv")"
    [ -n "$DISCOVERY_DOMAINS" ] || return 1
    emit "FKPSC\tdiscovery\tstart\t$DISCOVERY_DOMAINS\t$SCAN_LEVEL"
    run_scan_protocol tls13 1 || return $?
    run_scan_protocol tls12 2 || return $?
    run_scan_protocol quic 3 || return $?

    # FILENAME is used instead of NR==FNR: the latter treats the second file
    # as the first one too when the TLS 1.2 result is empty.
    awk 'FILENAME == ARGV[1] { if (NF) in12[$0]=1; next } NF && in12[$0] && !seen[$0]++ { print }' \
        "$TMP_DIR/tls12.txt" "$TMP_DIR/tls13.txt" > "$TMP_DIR/tls-common.txt"
    awk 'NF && !seen[$0]++ { print }' "$TMP_DIR/tls-common.txt" "$TMP_DIR/tls13.txt" "$TMP_DIR/tls12.txt" > "$TMP_DIR/tls-ranked.txt"
    awk 'NF && !seen[$0]++ { print }' "$TMP_DIR/quic.txt" > "$TMP_DIR/quic-ranked.txt"

    tls13_count="$(awk 'NF { n++ } END { print n + 0 }' "$TMP_DIR/tls13.txt")"
    tls12_count="$(awk 'NF { n++ } END { print n + 0 }' "$TMP_DIR/tls12.txt")"
    common_count="$(awk 'NF { n++ } END { print n + 0 }' "$TMP_DIR/tls-common.txt")"
    quic_count="$(awk 'NF { n++ } END { print n + 0 }' "$TMP_DIR/quic-ranked.txt")"
    emit "FKPSC\tdiscovery_summary\t$tls13_count\t$tls12_count\t$common_count\t$quic_count"
    emit "FKPSC\tphase\tcompose\tСборка составных стратегий из результатов blockcheck"

    cp "$TMP_DIR/tls-ranked.txt" "$TMP_DIR/tls-loop.txt"
    cp "$TMP_DIR/quic-ranked.txt" "$TMP_DIR/quic-loop.txt"
    [ -s "$TMP_DIR/tls-loop.txt" ] || printf '%s\n' '__NONE__' > "$TMP_DIR/tls-loop.txt"
    [ -s "$TMP_DIR/quic-loop.txt" ] || printf '%s\n' '__NONE__' > "$TMP_DIR/quic-loop.txt"
    : > "$TMP_DIR/candidates.tsv"
    candidate_total=0
    while IFS= read -r tls; do
        [ "$candidate_total" -lt "$AUTO_CANDIDATE_LIMIT" ] || break
        while IFS= read -r quic; do
            [ "$candidate_total" -lt "$AUTO_CANDIDATE_LIMIT" ] || break
            [ "$tls" = "__NONE__" ] && tls=""
            [ "$quic" = "__NONE__" ] && quic=""
            [ -n "$tls" ] || [ -n "$quic" ] || continue
            candidate_total=$((candidate_total + 1))
            candidate_id="auto-$(printf '%02d' "$candidate_total")"
            if [ -n "$tls" ] && grep -Fqx -- "$tls" "$TMP_DIR/tls-common.txt"; then
                tls_label="общая TLS 1.2+1.3"
            elif [ -n "$tls" ] && grep -Fqx -- "$tls" "$TMP_DIR/tls13.txt"; then
                tls_label="TLS 1.3"
            elif [ -n "$tls" ]; then
                tls_label="TLS 1.2"
            else
                tls_label="без найденной TLS"
            fi
            [ -n "$quic" ] && quic_label=" + QUIC" || quic_label=""
            title="Автоподбор: $tls_label$quic_label"
            source="Штатный $(basename "$BLOCKCHECK") · Slipstream"
            [ -n "$quic" ] && quic_marker=1 || quic_marker=0
            strategy="$(build_composite_strategy "$tls" "$quic")"
            printf '%s\t%s\t%s\t%s\t%s\n' "$candidate_id" "$title" "$source" "$quic_marker" "$strategy" >> "$TMP_DIR/candidates.tsv"
        done < "$TMP_DIR/quic-loop.txt"
    done < "$TMP_DIR/tls-loop.txt"
    return 0
}

if [ -z "$STATE_PATH" ] || [ -z "$LOG_PATH" ] || [ -z "$DONE_PATH" ] ||
   [ -z "$TARGET_SPEC" ] || [ ! -x "$ENGINE" ] || [ ! -f "$CATALOG" ]; then
    [ -n "$LOG_PATH" ] && printf '%b\n' 'FKPSC\terror\tinvalid worker arguments, engine or catalogue' > "$LOG_PATH"
    [ -n "$DONE_PATH" ] && printf 'complete\t2\t0\n' > "$DONE_PATH"
    exit 2
fi
case "$PROVIDER" in zapret|zapret2) ;; *) printf '%b\n' 'FKPSC\terror\tinvalid provider' > "$LOG_PATH"; exit 2 ;; esac
case "$SELECTION_MODE" in ready|auto) ;; *) printf '%b\n' 'FKPSC\terror\tinvalid selection mode' > "$LOG_PATH"; exit 2 ;; esac
case "$SCAN_LEVEL" in quick|standard|force) ;; *) printf '%b\n' 'FKPSC\terror\tinvalid scan level' > "$LOG_PATH"; exit 2 ;; esac
case "$MAX_SECONDS" in ''|*[!0-9]*) MAX_SECONDS=1800 ;; esac
case "$SCAN_POLL_SECONDS" in ''|*[!0-9]*) SCAN_POLL_SECONDS=2 ;; esac
[ "$SCAN_POLL_SECONDS" -ge 1 ] || SCAN_POLL_SECONDS=1
if [ "$SELECTION_MODE" = "auto" ] && [ ! -x "$BLOCKCHECK" ]; then
    printf '%b\n' 'FKPSC\terror\tinstalled blockcheck is not executable' > "$LOG_PATH"
    printf 'complete\t2\t0\n' > "$DONE_PATH"
    exit 2
fi

ENGINE_NAME="$(basename "$ENGINE")"
trap on_signal INT TERM HUP
trap finish EXIT

: > "$LOG_PATH"
rm -f "$DONE_PATH"
mkdir -p "$TMP_DIR"
emit "FKPSC\tmode\t$SELECTION_MODE"

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

emit "FKPSC\tphase\tresolve\tDNS: $target_total целей подготовлено"
while IFS="$tab" read -r target_id service host ip; do
    if [ -n "$ip" ]; then result=ok; else result=failed; fi
    emit "FKPSC\tresolve\t$target_id\t$service\t$host\t$ip\t$result"
done < "$TMP_DIR/targets.tsv"

emit "FKPSC\tphase\tbaseline\tПроверка без обхода"
run_endpoint_batch direct 0 direct
check_deadline || exit "$RC"

if [ "$SELECTION_MODE" = "auto" ]; then
    prepare_auto_candidates
    scan_rc=$?
    if [ "$scan_rc" -ne 0 ]; then
        [ "$scan_rc" -eq 124 ] && TIMED_OUT=1
        RC="$scan_rc"
        emit "FKPSC\terror\tautoselection discovery failed"
        exit "$RC"
    fi
else
    prepare_ready_candidates
fi

candidate_total="$(awk 'END { print NR + 0 }' "$TMP_DIR/candidates.tsv")"
check_total=$(((candidate_total + 1) * target_total))
emit "FKPSC\tmeta\t$PROVIDER\t$candidate_total\t$target_total\t$check_total\t$ENGINE\t$ZAPRET_ROOT\t$SELECTION_MODE"

if [ "$candidate_total" -eq 0 ]; then
    direct_score="$(awk -F '\t' '$1=="FKPSC" && $2=="endpoint" && $3=="direct" && $8==1 { n++ } END { print n + 0 }' "$LOG_PATH")"
    if [ "$SELECTION_MODE" = "auto" ] && [ "$direct_score" -eq "$target_total" ]; then
        emit "FKPSC\tphase\tcomplete\tВсе HTTPS-цели доступны напрямую; стратегия обхода не требуется"
        RC=0
        exit 0
    fi
    emit "FKPSC\terror\tblockcheck did not produce candidate strategies"
    RC=4
    exit "$RC"
fi

if ! setup_nft; then
    emit "FKPSC\terror\tfailed to create isolated nftables queue"
    RC=3
    exit "$RC"
fi

candidate_index=0
while IFS="$tab" read -r candidate_id title source quic strategy; do
    check_deadline || exit "$RC"
    candidate_index=$((candidate_index + 1))
    if [ "$SELECTION_MODE" = "auto" ]; then
        phase_title="Составная стратегия $candidate_index из $candidate_total"
    else
        phase_title="Готовый профиль $candidate_index из $candidate_total"
    fi
    emit "FKPSC\tphase\tstrategy\t$phase_title"
    emit "FKPSC\tstrategy_start\t$candidate_index\t$candidate_total\t$candidate_id\t$title\t$source\t$quic\t$strategy"
    if start_engine "$strategy"; then
        emit "FKPSC\tvoice_profile\t$candidate_index\t$candidate_id\t1\tengine_loaded"
        command -v conntrack >/dev/null 2>&1 && conntrack -F >/dev/null 2>&1 || true
        run_endpoint_batch strategy "$candidate_index" "$candidate_id"
    else
        engine_error="$(tail -n 1 "$TMP_DIR/engine.log" 2>/dev/null | tr '\t\r\n' '   ')"
        emit "FKPSC\tvoice_profile\t$candidate_index\t$candidate_id\t0\tengine"
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

if [ "$SELECTION_MODE" = "auto" ]; then
    emit "FKPSC\tphase\tcomplete\tАвтоподбор и проверка составных стратегий завершены"
else
    emit "FKPSC\tphase\tcomplete\tПроверка готовых профилей завершена"
fi
RC=0
exit 0
