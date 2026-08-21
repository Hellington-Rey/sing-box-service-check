#!/bin/sh
set -eu

SHARE_DIR="${FORKOP_SC_SHARE:-/usr/share/forkop-servicecheck}"
RECOVERY="$SHARE_DIR/recovery.tar.gz"
CHECKSUM="$SHARE_DIR/recovery.sha256"
WORK="$(mktemp -d /tmp/forkop-servicecheck-repair.XXXXXX)"
BACKUP="$WORK/current.tar.gz"
ACTIVE=0

TARGETS="
usr/bin/sing-box-service-check
usr/bin/forkop-servicecheck
usr/lib/forkop-servicecheck/probe.uc
usr/lib/forkop-servicecheck/xhttp_hotfix.sh
usr/lib/forkop-servicecheck/icmp_tproxy_hotfix.sh
usr/lib/forkop-servicecheck/repair.sh
usr/share/forkop-servicecheck/profiles.json
usr/share/forkop-servicecheck/version
www/luci-static/resources/view/forkop/servicecheck-v1120.js
usr/share/luci/menu.d/luci-app-forkop-servicecheck.json
usr/share/rpcd/acl.d/luci-app-forkop-servicecheck.json
"

cleanup() {
    status=$?
    trap - EXIT INT TERM
    if [ "$ACTIVE" = "1" ] && [ "$status" -ne 0 ]; then
        printf '%s\n' "[repair] проверка не прошла, возвращаю предыдущие файлы" >&2
        for path in $TARGETS; do rm -f "/$path"; done
        tar -xzf "$BACKUP" -C / 2>/dev/null || true
    fi
    rm -rf "$WORK"
    exit "$status"
}
trap cleanup EXIT INT TERM

[ "$(id -u)" = "0" ] || { echo "[repair] нужны права root" >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo "[repair] не найден sha256sum" >&2; exit 1; }
[ -s "$RECOVERY" ] || { echo "[repair] локальный архив восстановления отсутствует" >&2; exit 1; }
[ -s "$CHECKSUM" ] || { echo "[repair] контрольная сумма восстановления отсутствует" >&2; exit 1; }

(cd "$SHARE_DIR" && sha256sum -c "${CHECKSUM##*/}") >/dev/null 2>&1 || {
    echo "[repair] архив восстановления повреждён" >&2
    exit 1
}
if tar -tzf "$RECOVERY" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
    echo "[repair] архив содержит небезопасные пути" >&2
    exit 1
fi

set --
for path in $TARGETS; do
    [ -e "/$path" ] && set -- "$@" "$path"
done
tar -czf "$BACKUP" -C / "$@"
ACTIVE=1

tar -xzf "$RECOVERY" -C /
sh -n /usr/bin/sing-box-service-check
if ucode -c -o /dev/null /usr/lib/forkop-servicecheck/probe.uc >/dev/null 2>&1; then
    :
elif ! /usr/bin/sing-box-service-check capabilities >/dev/null 2>&1; then
    echo "[repair] восстановленный backend не запускается" >&2
    exit 1
fi
/usr/bin/sing-box-service-check capabilities >/dev/null

chmod 0755 /usr/bin/sing-box-service-check /usr/bin/forkop-servicecheck
chmod 0755 /usr/lib/forkop-servicecheck/xhttp_hotfix.sh /usr/lib/forkop-servicecheck/icmp_tproxy_hotfix.sh /usr/lib/forkop-servicecheck/repair.sh
rm -rf /tmp/luci-modulecache 2>/dev/null || true
rm -f /tmp/luci-indexcache* 2>/dev/null || true
[ -x /etc/init.d/rpcd ] && /etc/init.d/rpcd restart >/dev/null 2>&1 || true

ACTIVE=0
echo "[repair] файлы текущей версии восстановлены и проверены"
