#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
WORKER="$ROOT/files/usr/lib/forkop-servicecheck/zapret_strategy_worker.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

mkdir -p "$TMP/bin" "$TMP/zapret2/lua" "$TMP/zapret"
: > "$TMP/zapret2/lua/zapret-lib.lua"
: > "$TMP/zapret2/lua/zapret-antidpi.lua"

cat > "$TMP/bin/resolveip" <<'EOF'
#!/bin/sh
printf '%s\n' '203.0.113.10'
EOF

cat > "$TMP/bin/nft" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$MOCK_NFT_LOG"
EOF

cat > "$TMP/bin/conntrack" <<'EOF'
#!/bin/sh
exit 0
EOF

cat > "$TMP/bin/curl" <<'EOF'
#!/bin/sh
[ "${MOCK_CURL_SLOW:-0}" = "0" ] || sleep 2
[ -s "$MOCK_ENGINE_STATE" ]
EOF

cat > "$TMP/zapret2/nfqws2" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" > "$MOCK_ENGINE_STATE"
printf '%s\n' "$*" >> "$MOCK_ENGINE_LOG"
trap 'rm -f "$MOCK_ENGINE_STATE"; exit 0' TERM INT HUP
while :; do sleep 1; done
EOF

chmod +x "$TMP/bin/resolveip" "$TMP/bin/nft" "$TMP/bin/conntrack" "$TMP/bin/curl" "$TMP/zapret2/nfqws2"
cp "$TMP/zapret2/nfqws2" "$TMP/zapret/nfqws"
chmod +x "$TMP/zapret/nfqws"

cat > "$TMP/catalog.tsv" <<'EOF'
# provider	id	title	source	quic	strategy
zapret	ready-v1	Ready v1	test source	1	--filter-tcp=443 --dpi-desync=fake,multisplit --dpi-desync-split-pos=1 --dpi-desync-repeats=6 --new --filter-udp=443 --dpi-desync=fake --dpi-desync-repeats=6 --dpi-desync-fake-quic=@BASE@/files/fake/quic.bin
zapret2	ready-1	Ready one	test source	1	--filter-tcp=443 --filter-l7=tls --payload=tls_client_hello --lua-desync=multisplit:pos=1,midsld --new --filter-udp=443 --filter-l7=quic --payload=quic_initial --lua-desync=fake:blob=fake_default_quic:repeats=6
zapret2	ready-2	Ready two	test source	1	--filter-tcp=443 --filter-l7=tls --payload=tls_client_hello --lua-desync=fake:blob=fake_default_tls:tcp_md5 --lua-desync=multidisorder:pos=1,midsld --new --filter-udp=443 --filter-l7=quic --payload=quic_initial --lua-desync=send:ipfrag --lua-desync=drop
EOF

export PATH="$TMP/bin:$PATH"
export MOCK_NFT_LOG="$TMP/nft.log"
export MOCK_ENGINE_STATE="$TMP/engine.state"
export MOCK_ENGINE_LOG="$TMP/engine.log"
export FORKOP_SC_ENGINE_START_DELAY=0

sh "$WORKER" "$TMP/state.json" "$TMP/run.log" "$TMP/run.done" zapret2 standard \
    "$TMP/zapret2/nfqws2" "$TMP/zapret2" "$TMP/catalog.tsv" \
    'youtube_web,youtube,www.youtube.com;discord_web,discord,discord.com;telegram_web,telegram,web.telegram.org' '' 30

[ "$(cut -f1 "$TMP/run.done")" = "complete" ]
[ "$(cut -f2 "$TMP/run.done")" = "0" ]
grep -Fq "FKPSC	meta	zapret2	2	3	9" "$TMP/run.log"
[ "$(awk -F '\t' '$1=="FKPSC" && $2=="endpoint" { n++ } END { print n + 0 }' "$TMP/run.log")" -eq 9 ]
[ "$(awk -F '\t' '$1=="FKPSC" && $2=="strategy_done" && $6==3 { n++ } END { print n + 0 }' "$TMP/run.log")" -eq 2 ]
[ ! -e "$TMP/engine.state" ]
grep -Fq -- '--fwmark=0x40000000' "$TMP/engine.log"
grep -Fq -- '--lua-init=@' "$TMP/engine.log"
grep -Fq 'delete table inet fkpsc_zapret_' "$TMP/nft.log"
if grep -Fiq 'pornhub' "$TMP/run.log"; then
    echo "unrequested upstream DNS targets leaked into the ready-profile test" >&2
    exit 1
fi

sh "$WORKER" "$TMP/v1-state.json" "$TMP/v1.log" "$TMP/v1.done" zapret force \
    "$TMP/zapret/nfqws" "$TMP/zapret" "$TMP/catalog.tsv" \
    'youtube_web,youtube,www.youtube.com' '' 30
[ "$(cut -f1 "$TMP/v1.done")" = "complete" ]
grep -Fq "FKPSC	meta	zapret	1	1	2" "$TMP/v1.log"
grep -Fq -- '--dpi-desync-fwmark=0x40000000' "$TMP/engine.log"

export MOCK_CURL_SLOW=1
if sh "$WORKER" "$TMP/slow-state.json" "$TMP/slow.log" "$TMP/slow.done" zapret2 quick \
    "$TMP/zapret2/nfqws2" "$TMP/zapret2" "$TMP/catalog.tsv" \
    'youtube_web,youtube,www.youtube.com' '' 1; then
    echo "worker timeout must fail" >&2
    exit 1
fi
[ "$(cut -f1 "$TMP/slow.done")" = "timeout" ]
[ "$(cut -f2 "$TMP/slow.done")" = "124" ]

echo "zapret strategy worker: OK"
