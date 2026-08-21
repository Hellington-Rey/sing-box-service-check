#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
WORK="$(mktemp -d /tmp/fkpsc-installer-layout.XXXXXX)"
INSTALLER="${FORKOP_SC_INSTALLER:-$ROOT/install-sing-box-service-check.sh}"
SOURCE="$WORK/payload/usr/lib/forkop-servicecheck"
TARGET="$WORK/root/usr/lib/forkop-servicecheck"
HELPERS="$WORK/runtime-helpers.sh"
MODE_PROBE="$WORK/mode-probe"

cleanup() {
    rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

mkdir -p "$WORK/payload" "$TARGET"
[ -s "$INSTALLER" ] || { echo "generated installer is missing: $INSTALLER" >&2; exit 1; }

# Распаковываем payload именно из готового self-contained установщика, а не из
# исходного каталога: тест проверяет тот артефакт, который скачает пользователь.
sed -n "/base64 -d <<'__FORKOP_SC_PAYLOAD__'/,/^__FORKOP_SC_PAYLOAD__$/p" "$INSTALLER" |
    sed '1d;$d' | base64 -d | tar -xzf - -C "$WORK/payload"
[ -d "$SOURCE" ] || { echo "installer payload has no runtime directory" >&2; exit 1; }

# Файл, которого нет в текущем ручном списке, доказывает, что helper не может
# забыть новый runtime при следующем расширении payload.
cp -p "$ROOT/files/usr/lib/forkop-servicecheck/zapret_strategy_worker.sh" "$SOURCE/future_runtime.sh"
printf '%s\n' stale > "$TARGET/zapret_strategy_worker.sh"
chmod 0600 "$TARGET/zapret_strategy_worker.sh"

sed -n '/^runtime_payload_paths() {$/,/^}$/p' "$INSTALLER" > "$HELPERS"
sed -n '/^install_runtime_payload() {$/,/^}$/p' "$INSTALLER" >> "$HELPERS"
. "$HELPERS"

install_runtime_payload "$SOURCE" "$TARGET"

expected_paths="$(runtime_payload_paths "$SOURCE" "$TARGET" | LC_ALL=C sort)"
actual_paths="$(find "$TARGET" -maxdepth 1 -type f | LC_ALL=C sort)"
[ "$actual_paths" = "$expected_paths" ] || {
    echo "runtime layout differs from payload" >&2
    printf '%s\n' "expected:" "$expected_paths" "actual:" "$actual_paths" >&2
    exit 1
}

: > "$MODE_PROBE"
chmod 0600 "$MODE_PROBE"
MODE_CHECK=0
[ "$(stat -c '%a' "$MODE_PROBE")" = "600" ] && MODE_CHECK=1

for source in "$SOURCE/"*; do
    [ -f "$source" ] || continue
    target="$TARGET/${source##*/}"
    cmp "$source" "$target"
    if [ "$MODE_CHECK" = "1" ]; then
        case "$target" in
            *.sh) [ "$(stat -c '%a' "$target")" = "755" ] ;;
            *) [ "$(stat -c '%a' "$target")" = "644" ] ;;
        esac
    fi
done

[ -x "$TARGET/zapret_strategy_worker.sh" ]
[ -x "$TARGET/future_runtime.sh" ]
sh -n "$TARGET/zapret_strategy_worker.sh"

echo "installer runtime layout OK"
