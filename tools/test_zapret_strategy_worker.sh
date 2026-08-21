#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
WORKER="$ROOT/files/usr/lib/forkop-servicecheck/zapret_strategy_worker.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

cat > "$TMP/blockcheck.sh" <<'EOF'
#!/bin/sh
[ "$BATCH" = "1" ]
[ "$PARALLEL" = "0" ]
[ "$ENABLE_HTTPS_TLS12" = "1" ]
[ "$ENABLE_HTTPS_TLS13" = "1" ]
[ "$ENABLE_HTTP3" = "1" ]
printf '%s\n' '* SUMMARY'
printf '%s\n' 'curl_test_https_tls13 ipv4 www.youtube.com : nfqws2 --lua-desync=multisplit:pos=1,midsld'
EOF
chmod +x "$TMP/blockcheck.sh"

sh "$WORKER" "$TMP/state.json" "$TMP/run.log" "$TMP/run.done" zapret2 standard \
    "$TMP/blockcheck.sh" 'www.youtube.com discord.com telegram.org' '' 30

[ "$(cut -f1 "$TMP/run.done")" = "complete" ]
[ "$(cut -f2 "$TMP/run.done")" = "0" ]
grep -Fq -- '* SUMMARY' "$TMP/run.log"
grep -Fq -- 'nfqws2 --lua-desync=multisplit:pos=1,midsld' "$TMP/run.log"

cat > "$TMP/slow-blockcheck.sh" <<'EOF'
#!/bin/sh
sleep 5
EOF
chmod +x "$TMP/slow-blockcheck.sh"
if sh "$WORKER" "$TMP/slow-state.json" "$TMP/slow.log" "$TMP/slow.done" zapret2 quick \
    "$TMP/slow-blockcheck.sh" 'www.youtube.com' '' 1; then
    echo "worker timeout must fail" >&2
    exit 1
fi
[ "$(cut -f1 "$TMP/slow.done")" = "timeout" ]
[ "$(cut -f2 "$TMP/slow.done")" = "124" ]

echo "zapret strategy worker: OK"
