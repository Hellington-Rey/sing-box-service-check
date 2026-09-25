"""Static checks for the generated self-contained installer."""

import base64
import gzip
import hashlib
import io
import json
import tarfile
from pathlib import Path

from project_version import luci_view_name, project_version


ROOT = Path(__file__).resolve().parent.parent
INSTALLER = ROOT / "install-sing-box-service-check.sh"
VERSION = project_version()
LUCI_VIEW_NAME = luci_view_name(VERSION)
LUCI_VIEW_PATH = f"www/luci-static/resources/view/sing-box-service-check/{LUCI_VIEW_NAME}"
PACKAGE = ROOT / "dist" / f"luci-app-sing-box-service-check_{VERSION}-r1_all.ipk"
APK_MAKER = ROOT / "dist" / "make-apk.sh"
CHECKSUMS = ROOT / "dist" / "SHA256SUMS.txt"
FEED_DIR = ROOT / "dist" / "feed"
MARKER = "__FORKOP_SC_PAYLOAD__"
STALE_LUCI_VIEWS = [
    "servicecheck-v1140.js",
    "servicecheck-v1130.js",
    "servicecheck-v1125.js",
    "servicecheck-v1124.js",
    "servicecheck-v1123.js",
    "servicecheck-v1122.js",
    "servicecheck-v1121.js",
    "servicecheck-v1120.js",
]


def assert_shell(name, shell_script):
    assert shell_script.startswith(b"#!/bin/sh\n"), f"{name} has an invalid shebang"
    assert b"\r" not in shell_script, f"{name} contains CRLF/CR line endings"


def main():
    script = INSTALLER.read_text(encoding="utf-8")
    assert f'VERSION="{VERSION}"' in script
    assert f'VIEW_NAME="{LUCI_VIEW_NAME}"' in script
    assert "@@LUCI_VIEW_NAME@@" not in script
    stale_variables = {
        "PREVIOUS_VIEW_FILE": STALE_LUCI_VIEWS[0],
        "OLDER_VIEW_FILE": STALE_LUCI_VIEWS[1],
        "ANCIENT_VIEW_FILE": STALE_LUCI_VIEWS[2],
        "HISTORIC_VIEW_FILE": STALE_LUCI_VIEWS[3],
        "LEGACY_CACHE_VIEW_FILE": STALE_LUCI_VIEWS[4],
        "OLDER_CACHE_VIEW_FILE": STALE_LUCI_VIEWS[5],
        "EARLY_CACHE_VIEW_FILE": STALE_LUCI_VIEWS[6],
        "OLDEST_CACHE_VIEW_FILE": STALE_LUCI_VIEWS[7],
    }
    for variable, filename in stale_variables.items():
        assert f'{variable}="/www/luci-static/resources/view/forkop/{filename}"' in script
    assert 'OLD_CURRENT_VIEW_FILE="/www/luci-static/resources/view/forkop/servicecheck-v1141.js"' in script
    assert '"$MIGRATE_SCRIPT" || fail' in script
    assert 'opkg remove "$OLD_PACKAGE"' in script
    assert 'apk del "$OLD_PACKAGE"' in script
    assert "detect_installed_version()" in script
    assert 'INSTALLED_VERSION="$(detect_installed_version || true)"' in script
    assert "offer_update_dependencies()" in script
    assert "install_update_dependencies()" in script
    assert 'Установить недостающие пакеты сейчас? [Y/n]' in script
    assert '--install-missing' in script and '--skip-missing' in script
    assert 'NETNS_DIR="/etc/netns/sbsvcchk"' in script
    assert 'opkg install --force-reinstall bind-libs bind-dig' in script
    assert 'apk fix --upgrade bind-libs bind-dig' in script
    assert 'command -v dig >/dev/null 2>&1 && dig -v >/dev/null 2>&1' in script
    assert "sed -n '/^__PAYLOAD_BELOW__$/,$p' \"$0\"" not in script
    assert 'runtime_payload_paths "$TMP_DIR/usr/lib/sing-box-service-check" "$LIB_DIR"' in script
    assert 'install_runtime_payload "$TMP_DIR/usr/lib/sing-box-service-check" "$LIB_DIR"' in script
    assert 'for runtime_file in probe.uc xhttp_hotfix.sh icmp_tproxy_hotfix.sh repair.sh migrate.sh zapret_strategy_worker.sh zapret_strategy_catalog.tsv; do' in script
    assert '[ -x "$LIB_DIR/zapret_strategy_worker.sh" ]' in script

    chunks = script.split(MARKER)
    assert len(chunks) >= 3, "payload heredoc is missing"
    payload = chunks[1].split("\n", 1)[1].rsplit("\n", 1)[0]
    archive = base64.b64decode("".join(payload.split()), validate=True)

    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        names = set(tar.getnames())
        payload_modes = {name: tar.getmember(name).mode for name in names}
        cli_raw = tar.extractfile("usr/bin/sing-box-service-check").read()
        xhttp_fix = tar.extractfile("usr/lib/sing-box-service-check/xhttp_hotfix.sh").read()
        icmp_fix = tar.extractfile("usr/lib/sing-box-service-check/icmp_tproxy_hotfix.sh").read()
        repair_script = tar.extractfile("usr/lib/sing-box-service-check/repair.sh").read()
        migrate_script = tar.extractfile("usr/lib/sing-box-service-check/migrate.sh").read()
        zapret_worker = tar.extractfile("usr/lib/sing-box-service-check/zapret_strategy_worker.sh").read()
        zapret_catalog = tar.extractfile("usr/lib/sing-box-service-check/zapret_strategy_catalog.tsv").read()
        recovery_archive = tar.extractfile("usr/share/sing-box-service-check/recovery.tar.gz").read()
        recovery_checksum = tar.extractfile("usr/share/sing-box-service-check/recovery.sha256").read().decode("ascii")
        cli = cli_raw.decode("utf-8")
        engine = tar.extractfile("usr/lib/sing-box-service-check/probe.uc").read().decode("utf-8")
        profiles = tar.extractfile("usr/share/sing-box-service-check/profiles.json").read().decode("utf-8")
        version_marker = tar.extractfile("usr/share/sing-box-service-check/version").read().decode("utf-8").strip()
        menu = json.loads(tar.extractfile("usr/share/luci/menu.d/luci-app-sing-box-service-check.json").read())
        view = tar.extractfile(LUCI_VIEW_PATH).read().decode("utf-8")

    runtime_names = {
        name for name in names
        if name.startswith("usr/lib/sing-box-service-check/") and not name.endswith("/")
    }

    required = {
        "usr/bin/sing-box-service-check",
        "usr/lib/sing-box-service-check/probe.uc",
        "usr/lib/sing-box-service-check/xhttp_hotfix.sh",
        "usr/lib/sing-box-service-check/icmp_tproxy_hotfix.sh",
        "usr/lib/sing-box-service-check/repair.sh",
        "usr/lib/sing-box-service-check/migrate.sh",
        "usr/lib/sing-box-service-check/zapret_strategy_worker.sh",
        "usr/lib/sing-box-service-check/zapret_strategy_catalog.tsv",
        "usr/share/sing-box-service-check/recovery.tar.gz",
        "usr/share/sing-box-service-check/recovery.sha256",
        "usr/share/sing-box-service-check/profiles.json",
        "usr/share/sing-box-service-check/version",
        LUCI_VIEW_PATH,
    }
    missing = required - names
    assert not missing, f"missing payload files: {sorted(missing)}"
    assert runtime_names == {
        "usr/lib/sing-box-service-check/probe.uc",
        "usr/lib/sing-box-service-check/xhttp_hotfix.sh",
        "usr/lib/sing-box-service-check/icmp_tproxy_hotfix.sh",
        "usr/lib/sing-box-service-check/repair.sh",
        "usr/lib/sing-box-service-check/migrate.sh",
        "usr/lib/sing-box-service-check/zapret_strategy_worker.sh",
        "usr/lib/sing-box-service-check/zapret_strategy_catalog.tsv",
    }
    assert not any(f"www/luci-static/resources/view/forkop/{name}" in names for name in STALE_LUCI_VIEWS)
    assert menu["admin/services/sing_box_service_check"]["action"]["path"] == f"sing-box-service-check/{LUCI_VIEW_NAME[:-3]}"
    assert_shell("installer CLI", cli_raw)
    assert_shell("installer xHTTP fix", xhttp_fix)
    assert_shell("installer ICMP fix", icmp_fix)
    assert_shell("installer repair", repair_script)
    assert_shell("installer migration", migrate_script)
    assert_shell("installer Zapret strategy worker", zapret_worker)
    repair_text = repair_script.decode("utf-8")
    for runtime_name in runtime_names:
        assert runtime_name in repair_text, f"repair transaction misses {runtime_name}"
    assert payload_modes["usr/bin/sing-box-service-check"] == 0o755
    assert payload_modes["usr/lib/sing-box-service-check/xhttp_hotfix.sh"] == 0o755
    assert payload_modes["usr/lib/sing-box-service-check/icmp_tproxy_hotfix.sh"] == 0o755
    assert payload_modes["usr/lib/sing-box-service-check/repair.sh"] == 0o755
    assert payload_modes["usr/lib/sing-box-service-check/migrate.sh"] == 0o755
    assert payload_modes["usr/lib/sing-box-service-check/zapret_strategy_worker.sh"] == 0o755
    assert payload_modes["usr/lib/sing-box-service-check/zapret_strategy_catalog.tsv"] == 0o644
    assert b"pornhub" not in zapret_catalog.lower()
    assert zapret_catalog.count(b"\nzapret\t") >= 10
    assert zapret_catalog.count(b"\nzapret2\t") >= 10
    assert hashlib.sha256(recovery_archive).hexdigest() in recovery_checksum
    with tarfile.open(fileobj=io.BytesIO(recovery_archive), mode="r:gz") as recovery_tar:
        recovery_names = set(recovery_tar.getnames())
        assert "usr/bin/sing-box-service-check" in recovery_names or "./usr/bin/sing-box-service-check" in recovery_names
        assert LUCI_VIEW_PATH in recovery_names or f"./{LUCI_VIEW_PATH}" in recovery_names
        for runtime_name in runtime_names:
            assert runtime_name in recovery_names or f"./{runtime_name}" in recovery_names
        recovery_worker_name = next(
            name for name in recovery_names
            if name.lstrip("./") == "usr/lib/sing-box-service-check/zapret_strategy_worker.sh"
        )
        assert recovery_tar.getmember(recovery_worker_name).mode == 0o755
        assert recovery_tar.extractfile(recovery_worker_name).read() == zapret_worker
        assert not any(name.lstrip("./").startswith("www/luci-static/resources/view/forkop/") and any(name.endswith("/" + stale) for stale in STALE_LUCI_VIEWS) for name in recovery_names)
        assert not any(name.startswith("/") or "../" in name for name in recovery_names)
    assert payload_modes["usr/lib/sing-box-service-check/probe.uc"] == 0o644
    assert "#!/usr/bin/ucode" not in cli
    assert "command -v ucode" in cli
    assert "    custom)" in cli
    assert 'else if (mode == "custom")' in engine
    assert 'else if (mode == "cancel")' in engine
    assert 'function cancel_job(job_id)' in engine
    assert 'const TACHYON_INIT = getenv("TACHYON_INIT") || "/etc/init.d/tachyon";' in engine
    assert 'getenv("SBSC_NETNS") || getenv("FORKOP_SC_NETNS")' in engine
    assert 'function tachyon_active_service_action()' in engine
    assert 'function tachyon_runtime_conflicts()' in engine
    assert 'get_zapret_status' in engine and 'get_zapret2_status' in engine and 'get_byedpi_status' in engine
    assert 'callBin(["cancel", runState.jobId])' in view
    assert 'callBin(["cancel", jobId])' in view
    assert 'cancel JOB_ID' in cli
    assert 'function sanitizedReport(state, moduleVersion)' in view
    assert 'function reportAsText(report)' in view
    assert '"Скопировать отчёт"' in view
    assert '"Скачать JSON"' in view
    assert 'Report is sanitized' in view
    assert 'expected_route: as_string(target.expected_route || "any")' in engine
    assert 'function apply_route_expectation(item, backend_running, routing_engine)' in engine
    assert 'route_mismatch' in engine and 'route_unconfirmed' in engine
    assert '"Ожидаемый маршрут"' in view
    assert '["proxy", "Только через sing-box"]' in view
    assert 'function save_history(state)' in engine
    assert 'else if (mode == "history")' in engine
    assert 'else if (mode == "history-clear")' in engine
    assert 'function renderHistoryComparison(currentState, previous)' in view
    assert 'callBin(["history"])' in view
    assert 'callBin(["history-clear"])' in view
    assert 'history-clear' in cli
    assert 'function profiles_validate(payload)' in engine
    assert 'profiles-validate' in cli
    assert '"Импорт JSON"' in view and '"Экспорт JSON"' in view
    assert 'callBin(["profiles-validate", raw])' in view
    assert 'new FileReader()' in view
    assert 'function clash_api_diagnostic()' in engine
    assert 'function dns_diagnostic()' in engine
    assert 'backend_version: fast ? "" : backend_version(backend)' in engine
    assert '"Backend и DNS · расширенная диагностика"' in view
    assert 'function dns_chain_diagnostics(host)' in engine
    assert 'dns-diagnostics' in cli
    assert 'callBin(["dns-diagnostics", target])' in view
    assert 'const DNS_MATRIX = [' in engine
    assert 'function run_dns_matrix(domain, progress_path)' in engine
    assert 'function dns_matrix_error_detail(output)' in engine
    assert '"dig", "-u", as_string(protocol.option)' in engine
    assert 'query_us = int(timing_us[1])' in engine
    assert 'function dns_matrix_sort_items(items)' in engine
    assert 'dns_matrix_speed_us(item) < dns_matrix_speed_us(existing)' in engine
    assert 'быстрее → медленнее' in view
    assert 'function dnsQueryTime(item)' in view
    assert 'Точное время DNS-запроса' in view
    assert 'function dig_runtime_check()' in engine
    assert '"dig", "-v"' in engine
    assert 'opkg install --force-reinstall bind-libs bind-dig' in engine
    assert 'apk fix --upgrade bind-libs bind-dig' in engine
    assert 'dig: dig_status.runnable' in engine
    assert 'dig сломан' in view
    assert 'не удалось выполнить защищённый DNS-запрос' not in engine
    assert 'else if (mode == "dns-start")' in engine
    assert 'dns|dns-start)' in cli
    assert 'callBin(["dns-start", domain])' in view
    assert '"Тест DNS"' in view
    assert 'function doctor()' in engine and 'function repair()' in engine
    assert 'doctor|repair' in cli
    assert 'callBin(["doctor"])' in view and 'callBin(["repair"])' in view
    assert 'begin_transaction' in script and 'rollback_transaction' in script
    assert 'recovery.sha256' in script
    assert 'status == 28 && connect_ms <= 0 && remote_ip == ""' in engine
    assert 'else if (mode == "profiles-save")' in engine
    assert 'function vpn_create(name, protocol, payload, probe_target)' in engine
    assert 'function vpn_probe(name, protocol, target)' in engine
    assert 'function vpn_check(name, target)' in engine
    assert 'else if (mode == "vpn-packages")' in engine
    assert 'vpn-install PROTOCOL' in cli
    assert 'callBin(["vpn-create", name, protocol, config, probeTarget])' in view
    assert 'AWG Tools (AWG 1.5/2.0/3.0)' in view
    assert 'function vpnDetectedProtocol()' in view
    assert 'function vpn_awg_i(value)' in engine
    assert 'function vpn_address(value)' in engine
    assert 'function vpn_safe_address(value)' in engine
    assert 'vpn_set(section,"route_allowed_ips","0")' in engine
    assert 'vpn_set(name,"dns"' not in engine
    assert 'vpn_set(name,"fwmark"' not in engine
    assert 'vpn_set(name,"listen_port"' not in engine
    assert 'addresses_host_only:true' in engine
    assert 'callBin(["profiles-save", JSON.stringify(profilesDraft)])' in view
    assert 'function renderProfilesCards()' in view
    assert 'Добавить категорию' in view
    assert 'Редактируйте список обычными полями' in view
    assert 'sing-box-service-check-theme' in view
    assert 'theme-dark' in view and 'theme-light' in view and 'theme-auto' in view
    assert 'Тёмная' in view and 'Светлая' in view and '["auto", "LuCI"]' in view
    assert 'color:var(--text) !important' in view
    assert 'match(host, /[ \\t\\r\\n\\/]/)' in engine
    assert '--surface-raised:#fff' in view
    assert 'background:var(--surface-raised)' in view
    assert 'MTProto DC' not in profiles
    assert 'UDP / QUIC / Discord' not in profiles
    assert '"host": "assets.nflxext.com"' in profiles
    assert '"host": "api-global.netflix.com"' not in profiles
    assert '"Проверить IP/домен"' in view
    assert 'gemini_key_set)' in cli
    assert 'else if (mode == "gemini-key-set")' in engine
    assert 'function probe_gemini_geo(ctx, target)' in engine
    assert 'function backend_id()' in engine
    assert 'const TACHYON_BIN' in engine
    assert 'override == "tachyon"' in engine
    assert 'const PODKOP_BIN' in engine
    assert '"get_sing_box_status"' in engine
    assert 'backend + ".settings.config_path"' in engine
    assert 'backend == "tachyon" ? "tachyon"' in engine
    assert 'TACHYON_BIN, "get_status"' in engine
    assert 'TACHYON_BIN, "clash_api", "get_connections"' in engine
    assert 'tachyon_installed: fs.stat(TACHYON_BIN) != null' in engine
    assert 'backend_id() != "forkop" || fs.stat(FORKOP_BIN) == null' in engine
    assert 'controller + "/connections"' in engine
    assert 'backend_running: running' in engine
    assert 'backendId === "tachyon" ? "Tachyon"' in view
    assert 'var showForkopFixes = capabilities.tachyon_installed !== true &&' in view
    assert 'var showZapretStrategy = capabilities.tachyon_installed !== true' in view
    assert 'showForkopFixes ? [checkTab, dnsTab, vpnTab, fixTab, listsTab] : [checkTab, dnsTab, vpnTab, listsTab]' in view
    assert 'showZapretStrategy ? [vlessVpnTab, tunnelVpnTab, zapretVpnTab] : [vlessVpnTab, tunnelVpnTab]' in view
    assert '[ -x /usr/bin/tachyon ]' in script
    assert '[ -x /usr/bin/podkop ]' in script
    assert script.index('[ -x /usr/bin/tachyon ]') < script.index('[ -x /usr/bin/forkop ]') < script.index('[ -x /usr/bin/podkop ]')
    assert engine.index('if (fs.stat(TACHYON_BIN) != null)') < engine.index('if (fs.stat(FORKOP_BIN) != null)') < engine.index('if (fs.stat(PODKOP_BIN) != null)')
    assert 'update-check|update-status)' in cli
    assert 'update-start)' in cli
    assert 'update-start [--install-missing|--skip-missing]' in cli
    assert 'function latest_release_info()' in engine
    assert 'function update_worker()' in engine
    assert 'function update_temp_dir_valid(path)' in engine
    assert 'UPDATE_API = "https://api.github.com/repos/Hellington-Rey/sing-box-service-check/releases/latest"' in engine
    assert 'UPDATE_INSTALLER = "install-sing-box-service-check.sh"' in engine
    assert 'download_url != expected_url' in engine
    assert 'match(digest, /^sha256:[0-9a-f]{64}$/)' in engine
    assert 'actual_digest != expected_digest' in engine
    assert 'version_marker == null || as_string(version_marker[1]) != info.latest_version' in engine
    assert 'callBin(["update-check"])' in view
    assert 'callBin(["update-start", installMode])' in view
    assert 'callBin(["update-status"])' in view
    assert 'Обновление модуля' in view
    assert 'Перед установкой будет проверен SHA-256' in view
    assert 'Будет предложено установить недостающие пакеты' in view
    assert 'missing_packages: dependencies.packages' in engine
    assert 'state.install_missing ? "--install-missing" : "--skip-missing"' in engine
    assert "GEMINI_API_KEY_DEFAULT" not in engine
    assert "AIza" not in engine
    assert '"path": "/v1beta/models"' in profiles
    assert 'class: "fkpsc-tile-header"' in view
    assert 'tileHeader.addEventListener("click", toggle)' in view
    assert 'tile.addEventListener("click", toggle)' not in view
    assert version_marker == VERSION
    assert 'capabilities.module_version || "unknown"' in view
    assert '"VLESS ↔ JSON"' in view
    assert '"WireGuard / AWG"' in view
    assert 'function showVpnTool(name)' in view
    assert 'callBin(["vpn-interfaces"])' in view
    assert 'callBin(["vpn-check", name, probeTarget])' in view
    assert 'var name = vpnManagedSelect.value' in view
    assert '"Обновить список"' in view
    assert '"Проверить туннель вручную"' in view
    assert 'else if (mode == "vpn-check")' in engine
    assert 'else if (mode == "vpn-interfaces")' in engine
    assert 'function vpn_unsigned_range(value, maximum)' in engine
    assert 'awg_header_protection_key' in engine
    assert 'awg_content_padding_addition' in engine
    assert 'установленный netifd-протокол AmneziaWG не поддерживает поля AWG 3.0' in engine
    assert 'replace(/[^A-Za-z0-9_]/g, "_")' in view
    assert 'suggestedName.slice(0, 15)' in view
    assert 'function zapret_strategy_start(provider, selection_mode, scan_level, selected_payload)' in engine
    assert 'function zapret_parse_log(path, provider, targets)' in engine
    assert 'function zapret_find_install(provider)' in engine
    assert 'else if (mode == "zapret-start")' in engine
    assert 'else if (mode == "zapret-settings")' in engine
    assert 'else if (mode == "zapret-services-save")' in engine
    assert 'else if (mode == "zapret-results-clear")' in engine
    assert 'zapret-start TYPE MODE LEVEL' in cli
    assert 'callBin(["zapret-start", provider, mode, depth, JSON.stringify(selectedIds)])' in view
    assert 'callBin(["zapret-settings"])' in view
    assert 'callBin(["zapret-services-save", JSON.stringify(payload)])' in view
    assert 'callBin(["zapret-results-clear", record.provider' in view
    assert 'result.success !== true || !result.job_id' in view
    assert 'callBin(["zapret-status", jobId])' in view
    assert 'callBin(["zapret-cancel", jobId])' in view
    assert '"Подбор стратегии Zapret"' in view
    assert '"Под формат Forkop"' in view
    assert '"Автоподбор"' in view
    assert '"Готовые профили"' in view
    assert '"Какие сервисы проверяем"' in view
    assert '"Свои сервисы и домены"' in view
    assert '"Сохранённый результат"' in view
    assert '"Discord Voice — профиль загружен"' in view
    assert '"Интеграция Tachyon"' in view
    assert '"Tachyon занят: "' in view
    assert '"Проверено всего"' in view
    assert '"HTTPS-проверки"' in view
    assert '"Корень установки"' in view
    assert '"8 готовых профилей"' in view
    with tarfile.open(PACKAGE, mode="r:gz") as outer:
        control_archive = outer.extractfile("./control.tar.gz").read()
        data_archive = outer.extractfile("./data.tar.gz").read()
    with tarfile.open(fileobj=io.BytesIO(control_archive), mode="r:gz") as control_tar:
        control = control_tar.extractfile("./control").read().decode("utf-8")
        preinst_raw = control_tar.extractfile("./preinst").read()
        preinst = preinst_raw.decode("utf-8")
        postinst = control_tar.extractfile("./postinst").read().decode("utf-8")
        assert_shell("IPK preinst", preinst_raw)
        assert all(f"upgrade:{version}-*" in preinst for version in ("1.15.0", "1.15.1", "1.14.2"))
        assert "grep -Fqx" in preinst and 'mkdir -p "${old_view%/*}"' in preinst
        assert "Package: luci-app-sing-box-service-check" in control
        assert "Replaces: luci-app-forkop-servicecheck" in control
        assert "Conflicts: luci-app-forkop-servicecheck" in control
        assert "Depends: luci-base, ucode" in control
        assert f"Version: {VERSION}-r1" in control
        assert "/usr/lib/sing-box-service-check/migrate.sh" in postinst
        assert "для Tachyon, HomeProxy, Forkop и оригинального Podkop" in control
        assert "оригинального Podkop" in control
        for stale in STALE_LUCI_VIEWS:
            assert f"rm -f /www/luci-static/resources/view/forkop/{stale}" in postinst
    with tarfile.open(fileobj=io.BytesIO(data_archive), mode="r:gz") as data_tar:
        data_members = data_tar.getmembers()
        data_names = {member.name for member in data_members}
        view_dir = f"./{LUCI_VIEW_PATH.rsplit('/', 1)[0]}"
        view_dir_index = next(
            (index for index, member in enumerate(data_members)
             if member.name.rstrip("/") == view_dir and member.isdir()),
            None,
        )
        view_file_index = next(
            index for index, member in enumerate(data_members)
            if member.name == f"./{LUCI_VIEW_PATH}"
        )
        assert view_dir_index is not None and view_dir_index < view_file_index
        assert f"./{LUCI_VIEW_PATH}" in data_names
        assert not any(f"./www/luci-static/resources/view/forkop/{name}" in data_names for name in STALE_LUCI_VIEWS)
        assert_shell("IPK primary CLI", data_tar.extractfile("./usr/bin/sing-box-service-check").read())
        assert_shell("IPK compatibility CLI", data_tar.extractfile("./usr/bin/forkop-servicecheck").read())
        assert_shell("IPK xHTTP fix", data_tar.extractfile("./usr/lib/sing-box-service-check/xhttp_hotfix.sh").read())
        assert_shell("IPK ICMP fix", data_tar.extractfile("./usr/lib/sing-box-service-check/icmp_tproxy_hotfix.sh").read())
        assert_shell("IPK Zapret strategy worker", data_tar.extractfile("./usr/lib/sing-box-service-check/zapret_strategy_worker.sh").read())
        assert data_tar.getmember("./usr/lib/sing-box-service-check/zapret_strategy_worker.sh").mode == 0o755
        assert data_tar.getmember("./usr/lib/sing-box-service-check/zapret_strategy_catalog.tsv").mode == 0o644
        assert data_tar.extractfile("./usr/lib/sing-box-service-check/zapret_strategy_catalog.tsv").read() == zapret_catalog
        assert data_tar.extractfile("./usr/lib/sing-box-service-check/probe.uc").read().decode("utf-8") == engine
        assert data_tar.extractfile(f"./{LUCI_VIEW_PATH}").read().decode("utf-8") == view
        assert data_tar.extractfile("./usr/share/sing-box-service-check/version").read().decode("utf-8").strip() == version_marker

    feed_packages = (FEED_DIR / "Packages").read_text(encoding="utf-8")
    assert f"Version: {VERSION}-r1" in feed_packages
    assert "для Tachyon, HomeProxy, Forkop и оригинального Podkop" in feed_packages
    assert (FEED_DIR / PACKAGE.name).read_bytes() == PACKAGE.read_bytes()
    with gzip.open(FEED_DIR / "Packages.gz", "rt", encoding="utf-8") as compressed_feed:
        assert compressed_feed.read() == feed_packages

    apk_maker = APK_MAKER.read_text(encoding="utf-8")
    assert f'VERSION="{VERSION}-r1"' in apk_maker
    assert '--info "provides:luci-app-forkop-servicecheck=$VERSION"' in apk_maker
    assert '--info "replaces:luci-app-forkop-servicecheck"' in apk_maker
    assert "для Tachyon, HomeProxy, Forkop и оригинального Podkop" in apk_maker
    apk_payload = base64.b64decode(apk_maker.split("__PAYLOAD_BELOW__\n", 1)[1].strip())
    with tarfile.open(fileobj=io.BytesIO(apk_payload), mode="r:gz") as apk_tar:
        apk_members = apk_tar.getmembers()
        apk_dir_index = next(
            (index for index, member in enumerate(apk_members)
             if member.name.rstrip("/") == view_dir and member.isdir()),
            None,
        )
        apk_file_index = next(
            index for index, member in enumerate(apk_members)
            if member.name == f"./{LUCI_VIEW_PATH}"
        )
        assert apk_dir_index is not None and apk_dir_index < apk_file_index

    artifact_by_name = {
        path.name: path
        for path in (PACKAGE, INSTALLER, APK_MAKER)
    }
    checksum_lines = [line.split(None, 1) for line in CHECKSUMS.read_text(encoding="utf-8").splitlines() if line]
    assert {name for _, name in checksum_lines} == set(artifact_by_name)
    for digest, name in checksum_lines:
        assert digest == hashlib.sha256(artifact_by_name[name].read_bytes()).hexdigest()

    print(f"installer/IPK OK: {len(archive)} bytes, {len(names)} entries")


if __name__ == "__main__":
    main()
