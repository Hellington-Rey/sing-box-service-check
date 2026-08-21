#!/bin/sh
#
# Sing-box Service Check - установщик модуля проверки доступности сервисов.
#
# Скрипт самодостаточный: полезная нагрузка лежит внутри в base64.
# Поддерживаются Tachyon, Forkop и оригинальный Podkop. Их файлы при установке
# модуля не изменяются; Forkop-фиксы доступны отдельно только на Forkop.
#
# Установка:   sh install-sing-box-service-check.sh
# Удаление:    sh install-sing-box-service-check.sh --uninstall
#

set -e

VERSION="@@VERSION@@"
BUILT_AT="@@BUILT_AT@@"

BIN_PATH="/usr/bin/sing-box-service-check"
LEGACY_BIN_PATH="/usr/bin/forkop-servicecheck"
LIB_DIR="/usr/lib/forkop-servicecheck"
SHARE_DIR="/usr/share/forkop-servicecheck"
VERSION_FILE="$SHARE_DIR/version"
VIEW_NAME="@@LUCI_VIEW_NAME@@"
VIEW_FILE="/www/luci-static/resources/view/forkop/$VIEW_NAME"
PREVIOUS_VIEW_FILE="/www/luci-static/resources/view/forkop/servicecheck-v1120.js"
OLDER_VIEW_FILE="/www/luci-static/resources/view/forkop/servicecheck-v1112.js"
ANCIENT_VIEW_FILE="/www/luci-static/resources/view/forkop/servicecheck-v1111.js"
HISTORIC_VIEW_FILE="/www/luci-static/resources/view/forkop/servicecheck-v1110.js"
LEGACY_CACHE_VIEW_FILE="/www/luci-static/resources/view/forkop/servicecheck-v1106.js"
LEGACY_VIEW_FILE="/www/luci-static/resources/view/forkop/servicecheck.js"
BROKEN_VIEW_FILE="/www/luci-static/resources/view/forkop/servicecheck-1.1.0.js"
MENU_FILE="/usr/share/luci/menu.d/luci-app-forkop-servicecheck.json"
ACL_FILE="/usr/share/rpcd/acl.d/luci-app-forkop-servicecheck.json"
STATE_DIR="/var/run/forkop-servicecheck"
NETNS_DIR="/etc/netns/fkpsc"
DEPENDENCY_MODE="prompt"

log() {
    printf '\033[0;36m[servicecheck]\033[0m %s\n' "$1"
}

fail() {
    printf '\033[0;31m[servicecheck]\033[0m %s\n' "$1" >&2
    exit 1
}

clear_luci_cache() {
    rm -rf /tmp/luci-modulecache 2>/dev/null || true
    rm -f /tmp/luci-indexcache* 2>/dev/null || true
}

reload_rpcd() {
    if [ -x /etc/init.d/rpcd ]; then
        /etc/init.d/rpcd restart >/dev/null 2>&1 || /etc/init.d/rpcd reload >/dev/null 2>&1 || true
    fi
}

do_uninstall() {
    log "Удаляю модуль проверки сервисов"

    if [ -x "$BIN_PATH" ]; then
        "$BIN_PATH" netns_teardown >/dev/null 2>&1 || true
    elif [ -x "$LEGACY_BIN_PATH" ]; then
        "$LEGACY_BIN_PATH" netns_teardown >/dev/null 2>&1 || true
    fi

    rm -f "$BIN_PATH" "$LEGACY_BIN_PATH" "$VIEW_FILE" "$PREVIOUS_VIEW_FILE" "$OLDER_VIEW_FILE" "$ANCIENT_VIEW_FILE" "$HISTORIC_VIEW_FILE" "$LEGACY_CACHE_VIEW_FILE" "$LEGACY_VIEW_FILE" "$BROKEN_VIEW_FILE" "$MENU_FILE" "$ACL_FILE"
    rm -rf "$LIB_DIR" "$SHARE_DIR" "$STATE_DIR" "$NETNS_DIR"

    clear_luci_cache
    reload_rpcd

    log "Готово. Страница пропадёт из меню после обновления вкладки LuCI."
    exit 0
}

case "$1" in
    --uninstall|uninstall|-u)
        do_uninstall
        ;;
    --install-missing)
        DEPENDENCY_MODE="install"
        ;;
    --skip-missing)
        DEPENDENCY_MODE="skip"
        ;;
esac

log "Sing-box Service Check $VERSION (собран $BUILT_AT)"

detect_installed_version() {
    if [ -s "$VERSION_FILE" ]; then
        head -n 1 "$VERSION_FILE"
        return
    fi

    if command -v opkg >/dev/null 2>&1; then
        PACKAGE_VERSION="$(opkg status luci-app-forkop-servicecheck 2>/dev/null |
            sed -n 's/^Version: //p' | head -n 1)"
        if [ -n "$PACKAGE_VERSION" ]; then
            printf '%s\n' "$PACKAGE_VERSION"
            return
        fi
    fi

    if command -v apk >/dev/null 2>&1 &&
        apk info -e luci-app-forkop-servicecheck >/dev/null 2>&1; then
        apk info -v luci-app-forkop-servicecheck 2>/dev/null | head -n 1
        return
    fi

    if [ -x "$BIN_PATH" ] || [ -x "$LEGACY_BIN_PATH" ]; then
        printf '%s\n' "legacy (без маркера версии)"
    fi
}

detect_update_dependencies() {
    BIND_DEPENDENCY_STATE="ok"
    BIND_DEPENDENCY_PACKAGES=""

    if ! command -v dig >/dev/null 2>&1; then
        BIND_DEPENDENCY_STATE="missing"
        BIND_DEPENDENCY_PACKAGES="bind-dig"
    elif ! dig -v >/dev/null 2>&1; then
        BIND_DEPENDENCY_STATE="repair"
        BIND_DEPENDENCY_PACKAGES="bind-libs bind-dig"
    fi
}

dependency_install_hint() {
    if command -v opkg >/dev/null 2>&1; then
        if [ "$BIND_DEPENDENCY_STATE" = "repair" ]; then
            printf '%s\n' "opkg update && opkg install --force-reinstall bind-libs bind-dig"
        else
            printf '%s\n' "opkg update && opkg install bind-dig"
        fi
    elif command -v apk >/dev/null 2>&1; then
        if [ "$BIND_DEPENDENCY_STATE" = "repair" ]; then
            printf '%s\n' "apk update && apk fix --upgrade bind-libs bind-dig"
        else
            printf '%s\n' "apk update && apk add bind-dig"
        fi
    else
        printf '%s\n' "установите $BIND_DEPENDENCY_PACKAGES через пакетный менеджер прошивки"
    fi
}

install_update_dependencies() {
    log "Устанавливаю зависимости DNS-теста: $BIND_DEPENDENCY_PACKAGES"

    if command -v opkg >/dev/null 2>&1; then
        opkg update || fail "Не удалось обновить список пакетов opkg."
        if [ "$BIND_DEPENDENCY_STATE" = "repair" ]; then
            opkg install --force-reinstall bind-libs bind-dig || fail "Не удалось переустановить bind-libs и bind-dig."
        else
            opkg install bind-dig || fail "Не удалось установить bind-dig."
        fi
    elif command -v apk >/dev/null 2>&1; then
        apk update || fail "Не удалось обновить список пакетов apk."
        if [ "$BIND_DEPENDENCY_STATE" = "repair" ]; then
            apk fix --upgrade bind-libs bind-dig || fail "Не удалось переустановить bind-libs и bind-dig."
        else
            apk add bind-dig || fail "Не удалось установить bind-dig."
        fi
    else
        fail "Не найден поддерживаемый пакетный менеджер. $(dependency_install_hint)"
    fi

    command -v dig >/dev/null 2>&1 && dig -v >/dev/null 2>&1 ||
        fail "Пакеты установлены, но dig не запускается. Выполните: $(dependency_install_hint)"
    log "Зависимости DNS-теста готовы"
}

offer_update_dependencies() {
    [ -n "$INSTALLED_VERSION" ] || return 0

    detect_update_dependencies
    [ "$BIND_DEPENDENCY_STATE" != "ok" ] || return 0

    if [ "$BIND_DEPENDENCY_STATE" = "repair" ]; then
        log "Обнаружены несовместимые пакеты BIND: $BIND_DEPENDENCY_PACKAGES"
    else
        log "Для вкладки «Тест DNS» не хватает пакета: $BIND_DEPENDENCY_PACKAGES"
    fi

    case "$DEPENDENCY_MODE" in
        install)
            install_update_dependencies
            ;;
        skip)
            log "Установка зависимостей пропущена. Позже выполните: $(dependency_install_hint)"
            ;;
        *)
            answer=""
            if [ -c /dev/tty ] && printf 'Установить недостающие пакеты сейчас? [Y/n] ' >/dev/tty 2>/dev/null; then
                IFS= read -r answer </dev/tty 2>/dev/null || answer="n"
            else
                answer="n"
                log "Нет интерактивного терминала — зависимости не устанавливаю автоматически."
            fi
            case "$answer" in
                n|N|no|NO|нет|Нет|НЕТ)
                    log "Установка зависимостей пропущена. Позже выполните: $(dependency_install_hint)"
                    ;;
                *)
                    install_update_dependencies
                    ;;
            esac
            ;;
    esac
}

INSTALLED_VERSION="$(detect_installed_version || true)"
if [ -n "$INSTALLED_VERSION" ]; then
    if [ "$INSTALLED_VERSION" = "$VERSION" ]; then
        log "Уже установлена версия $VERSION — выполняю проверку и переустановку"
    else
        log "Обнаружена предыдущая версия: $INSTALLED_VERSION"
        log "Обновляю до версии $VERSION с сохранением пользовательских профилей в /etc"
    fi
else
    log "Предыдущая версия не обнаружена — чистая установка"
fi

# --- Проверки окружения -----------------------------------------------------

[ "$(id -u)" = "0" ] || fail "Нужны права root."

offer_update_dependencies

command -v ucode >/dev/null 2>&1 || fail "Не найден ucode. Установите пакет ucode."
command -v base64 >/dev/null 2>&1 || fail "Не найдена утилита base64."
command -v tar >/dev/null 2>&1 || fail "Не найдена утилита tar."
command -v sha256sum >/dev/null 2>&1 || fail "Не найдена утилита sha256sum."

if [ -x /usr/bin/tachyon ]; then
    BACKEND="Tachyon"
    BACKEND_VERSION="$(/usr/bin/tachyon show_version 2>/dev/null || echo unknown)"
elif [ -x /usr/bin/forkop ]; then
    BACKEND="Forkop"
    BACKEND_VERSION="$(/usr/bin/forkop show_version 2>/dev/null || echo unknown)"
elif [ -x /usr/bin/podkop ]; then
    BACKEND="Podkop"
    BACKEND_VERSION="$(/usr/bin/podkop show_version 2>/dev/null || echo unknown)"
else
    fail "Не найден ни Tachyon, ни Forkop, ни Podkop. Сначала установите один из поддерживаемых backend."
fi
log "Обнаружен $BACKEND $BACKEND_VERSION"

[ -d /www/luci-static/resources ] || fail "Не найдены ресурсы LuCI. Установите luci-base."

# --- Распаковка во временный каталог ----------------------------------------

TMP_DIR="$(mktemp -d /tmp/forkop-servicecheck.XXXXXX)"
BACKUP_ARCHIVE="$TMP_DIR/rollback.tar"
TRANSACTION_ACTIVE=0

transaction_paths() {
    cat <<EOF
$BIN_PATH
$LEGACY_BIN_PATH
$LIB_DIR/probe.uc
$LIB_DIR/xhttp_hotfix.sh
$LIB_DIR/icmp_tproxy_hotfix.sh
$LIB_DIR/repair.sh
$SHARE_DIR/profiles.json
$SHARE_DIR/version
$SHARE_DIR/recovery.tar.gz
$SHARE_DIR/recovery.sha256
$VIEW_FILE
$PREVIOUS_VIEW_FILE
$OLDER_VIEW_FILE
$ANCIENT_VIEW_FILE
$HISTORIC_VIEW_FILE
$LEGACY_CACHE_VIEW_FILE
$LEGACY_VIEW_FILE
$BROKEN_VIEW_FILE
$MENU_FILE
$ACL_FILE
EOF
}

begin_transaction() {
    backup_root="$TMP_DIR/rollback"
    mkdir -p "$backup_root"
    transaction_paths | while IFS= read -r path; do
        [ -n "$path" ] || continue
        if [ -f "$path" ]; then
            mkdir -p "$backup_root$(dirname "$path")"
            cp -p "$path" "$backup_root$path"
        fi
    done
    tar -cf "$BACKUP_ARCHIVE" -C "$backup_root" .
    TRANSACTION_ACTIVE=1
}

rollback_transaction() {
    log "Ошибка после начала установки — возвращаю предыдущую версию"
    transaction_paths | while IFS= read -r path; do
        [ -n "$path" ] && rm -f "$path"
    done
    tar -xf "$BACKUP_ARCHIVE" -C / 2>/dev/null || true
    clear_luci_cache
    reload_rpcd
}

cleanup() {
    status=$?
    trap - EXIT INT TERM
    if [ "$TRANSACTION_ACTIVE" = "1" ] && [ "$status" -ne 0 ]; then
        rollback_transaction
    fi
    rm -rf "$TMP_DIR"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

log "Распаковываю файлы"

extract_payload() {
    # Payload находится в here-document, поэтому установка одинаково работает
    # из файла и через `wget -O- URL | sh`, где $0 указывает на `sh`.
    base64 -d <<'__FORKOP_SC_PAYLOAD__' | tar -xzf - -C "$TMP_DIR"
@@PAYLOAD@@
__FORKOP_SC_PAYLOAD__
}

extract_payload || fail "Не удалось распаковать полезную нагрузку."

[ -f "$TMP_DIR/usr/lib/forkop-servicecheck/probe.uc" ] || fail "В архиве нет движка проверки."

# --- Проверка синтаксиса до подмены живых файлов ----------------------------

command -v ucode >/dev/null 2>&1 || fail "Не найден ucode. Установите пакет ucode и повторите установку."

SYNTAX_CHECK_WORKS=0
printf 'print("ok");\n' > "$TMP_DIR/.syntax-probe.uc"
if ucode -c -o /dev/null "$TMP_DIR/.syntax-probe.uc" >/dev/null 2>&1; then
    SYNTAX_CHECK_WORKS=1
fi

if [ "$SYNTAX_CHECK_WORKS" = "1" ]; then
    if ! ucode -c -o /dev/null "$TMP_DIR/usr/lib/forkop-servicecheck/probe.uc" >/dev/null 2>&1; then
        printf '\n'
        ucode -c -o /dev/null "$TMP_DIR/usr/lib/forkop-servicecheck/probe.uc" || true
        fail "Синтаксическая ошибка в probe.uc - установка отменена, система не тронута."
    fi
    log "Синтаксис ucode-файлов в порядке"
else
    log "Внимание: ucode -c недоступен, пропускаю проверку синтаксиса"
fi

if ! sh -n "$TMP_DIR/usr/bin/forkop-servicecheck" >/dev/null 2>&1; then
    fail "Синтаксическая ошибка в CLI - установка отменена, система не тронута."
fi

# --- Установка --------------------------------------------------------------

log "Устанавливаю файлы"

begin_transaction

mkdir -p "$LIB_DIR" "$SHARE_DIR" "$STATE_DIR"
mkdir -p /usr/share/luci/menu.d /usr/share/rpcd/acl.d
mkdir -p /www/luci-static/resources/view/forkop

cp -f "$TMP_DIR/usr/bin/forkop-servicecheck" "$BIN_PATH"
cp -f "$TMP_DIR/usr/bin/forkop-servicecheck" "$LEGACY_BIN_PATH"
cp -f "$TMP_DIR/usr/lib/forkop-servicecheck/probe.uc" "$LIB_DIR/probe.uc"
cp -f "$TMP_DIR/usr/lib/forkop-servicecheck/xhttp_hotfix.sh" "$LIB_DIR/xhttp_hotfix.sh"
cp -f "$TMP_DIR/usr/lib/forkop-servicecheck/icmp_tproxy_hotfix.sh" "$LIB_DIR/icmp_tproxy_hotfix.sh"
cp -f "$TMP_DIR/usr/lib/forkop-servicecheck/repair.sh" "$LIB_DIR/repair.sh"
cp -f "$TMP_DIR/usr/share/forkop-servicecheck/profiles.json" "$SHARE_DIR/profiles.json"
cp -f "$TMP_DIR/usr/share/forkop-servicecheck/recovery.tar.gz" "$SHARE_DIR/recovery.tar.gz"
cp -f "$TMP_DIR/usr/share/forkop-servicecheck/recovery.sha256" "$SHARE_DIR/recovery.sha256"
cp -f "$TMP_DIR/www/luci-static/resources/view/forkop/$VIEW_NAME" "$VIEW_FILE"
rm -f "$LEGACY_VIEW_FILE" "$BROKEN_VIEW_FILE" "$LEGACY_CACHE_VIEW_FILE" "$HISTORIC_VIEW_FILE" "$ANCIENT_VIEW_FILE" "$OLDER_VIEW_FILE" "$PREVIOUS_VIEW_FILE"
cp -f "$TMP_DIR/usr/share/luci/menu.d/luci-app-forkop-servicecheck.json" "$MENU_FILE"
cp -f "$TMP_DIR/usr/share/rpcd/acl.d/luci-app-forkop-servicecheck.json" "$ACL_FILE"

chmod 0755 "$BIN_PATH" "$LEGACY_BIN_PATH"
chmod 0755 "$LIB_DIR/xhttp_hotfix.sh" "$LIB_DIR/icmp_tproxy_hotfix.sh" "$LIB_DIR/repair.sh"
chmod 0644 "$LIB_DIR/probe.uc" "$SHARE_DIR/profiles.json" "$SHARE_DIR/recovery.tar.gz" "$SHARE_DIR/recovery.sha256" "$VIEW_FILE" "$MENU_FILE" "$ACL_FILE"
printf '%s\n' "$VERSION" > "$VERSION_FILE"

# --- Дожимаем LuCI ----------------------------------------------------------

clear_luci_cache
reload_rpcd

# --- Проверка работоспособности ---------------------------------------------

log "Проверяю установку"

if ! CAPS="$("$BIN_PATH" capabilities 2>&1)"; then
    fail "Модуль установлен, но не запускается: $CAPS"
fi

echo "$CAPS" | grep -q '"fakeip_ranges"' || fail "Неожиданный ответ модуля: $CAPS"

PROFILES="$("$BIN_PATH" list 2>/dev/null | grep -o '"id":' | wc -l)"

if ! (cd "$SHARE_DIR" && sha256sum -c recovery.sha256 >/dev/null 2>&1); then
    fail "Локальный архив восстановления не прошёл проверку SHA-256"
fi

TRANSACTION_ACTIVE=0

log "Модуль отвечает, профилей сервисов: $PROFILES"

# ucode печатает JSON с пробелом после двоеточия, поэтому сверяемся регуляркой.
if ! echo "$CAPS" | grep -q '"curl": *true'; then
    log "Совет: поставьте curl (opkg install curl / apk add curl) - без него"
    log "       тайминги TCP/TLS и коды ответов определяются приблизительно."
fi

if ! echo "$CAPS" | grep -q '"backend_running": *true'; then
    log "Внимание: $BACKEND сейчас не запущен - проверка покажет доступность без обхода."
fi

cat <<'EOF'

Готово.

  Веб-интерфейс: LuCI -> Сервисы -> "Sing-box Service Check"
  (если пункт не появился - обновите страницу с Ctrl+F5, кеш LuCI уже сброшен)

  Из консоли:
    sing-box-service-check list
    sing-box-service-check run telegram,youtube
    sing-box-service-check run all netns
    sing-box-service-check capabilities

  Удалить:
    sh install-sing-box-service-check.sh --uninstall

EOF

exit 0
