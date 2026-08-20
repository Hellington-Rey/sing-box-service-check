"""Static checks for the generated self-contained installer."""

import base64
import gzip
import hashlib
import io
import tarfile
from pathlib import Path

from project_version import project_version


ROOT = Path(__file__).resolve().parent.parent
INSTALLER = ROOT / "install-sing-box-service-check.sh"
LEGACY_INSTALLER = ROOT / "install-forkop-servicecheck.sh"
VERSION = project_version()
PACKAGE = ROOT / "dist" / f"luci-app-forkop-servicecheck_{VERSION}-r1_all.ipk"
APK_MAKER = ROOT / "dist" / "make-apk.sh"
CHECKSUMS = ROOT / "dist" / "SHA256SUMS.txt"
FEED_DIR = ROOT / "dist" / "feed"
MARKER = "__FORKOP_SC_PAYLOAD__"


def assert_shell(name, shell_script):
    assert shell_script.startswith(b"#!/bin/sh\n"), f"{name} has an invalid shebang"
    assert b"\r" not in shell_script, f"{name} contains CRLF/CR line endings"


def main():
    script = INSTALLER.read_text(encoding="utf-8")
    assert f'VERSION="{VERSION}"' in script
    assert LEGACY_INSTALLER.read_bytes() == INSTALLER.read_bytes()
    assert "detect_installed_version()" in script
    assert 'INSTALLED_VERSION="$(detect_installed_version || true)"' in script
    assert "offer_update_dependencies()" in script
    assert "install_update_dependencies()" in script
    assert 'Установить недостающие пакеты сейчас? [Y/n]' in script
    assert '--install-missing' in script and '--skip-missing' in script
    assert 'opkg install --force-reinstall bind-libs bind-dig' in script
    assert 'apk fix --upgrade bind-libs bind-dig' in script
    assert 'command -v dig >/dev/null 2>&1 && dig -v >/dev/null 2>&1' in script
    assert "sed -n '/^__PAYLOAD_BELOW__$/,$p' \"$0\"" not in script

    chunks = script.split(MARKER)
    assert len(chunks) >= 3, "payload heredoc is missing"
    payload = chunks[1].split("\n", 1)[1].rsplit("\n", 1)[0]
    archive = base64.b64decode("".join(payload.split()), validate=True)

    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        names = set(tar.getnames())
        payload_modes = {name: tar.getmember(name).mode for name in names}
        cli_raw = tar.extractfile("usr/bin/forkop-servicecheck").read()
        xhttp_fix = tar.extractfile("usr/lib/forkop-servicecheck/xhttp_hotfix.sh").read()
        icmp_fix = tar.extractfile("usr/lib/forkop-servicecheck/icmp_tproxy_hotfix.sh").read()
        repair_script = tar.extractfile("usr/lib/forkop-servicecheck/repair.sh").read()
        recovery_archive = tar.extractfile("usr/share/forkop-servicecheck/recovery.tar.gz").read()
        recovery_checksum = tar.extractfile("usr/share/forkop-servicecheck/recovery.sha256").read().decode("ascii")
        cli = cli_raw.decode("utf-8")
        engine = tar.extractfile("usr/lib/forkop-servicecheck/probe.uc").read().decode("utf-8")
        profiles = tar.extractfile("usr/share/forkop-servicecheck/profiles.json").read().decode("utf-8")
        version_marker = tar.extractfile("usr/share/forkop-servicecheck/version").read().decode("utf-8").strip()
        view = tar.extractfile("www/luci-static/resources/view/forkop/servicecheck-v112.js").read().decode("utf-8")

    required = {
        "usr/bin/forkop-servicecheck",
        "usr/lib/forkop-servicecheck/probe.uc",
        "usr/lib/forkop-servicecheck/xhttp_hotfix.sh",
        "usr/lib/forkop-servicecheck/icmp_tproxy_hotfix.sh",
        "usr/lib/forkop-servicecheck/repair.sh",
        "usr/share/forkop-servicecheck/recovery.tar.gz",
        "usr/share/forkop-servicecheck/recovery.sha256",
        "usr/share/forkop-servicecheck/profiles.json",
        "usr/share/forkop-servicecheck/version",
        "www/luci-static/resources/view/forkop/servicecheck-v112.js",
    }
    missing = required - names
    assert not missing, f"missing payload files: {sorted(missing)}"
    assert_shell("installer CLI", cli_raw)
    assert_shell("installer xHTTP fix", xhttp_fix)
    assert_shell("installer ICMP fix", icmp_fix)
    assert_shell("installer repair", repair_script)
    assert payload_modes["usr/bin/forkop-servicecheck"] == 0o755
    assert payload_modes["usr/lib/forkop-servicecheck/xhttp_hotfix.sh"] == 0o755
    assert payload_modes["usr/lib/forkop-servicecheck/icmp_tproxy_hotfix.sh"] == 0o755
    assert payload_modes["usr/lib/forkop-servicecheck/repair.sh"] == 0o755
    assert hashlib.sha256(recovery_archive).hexdigest() in recovery_checksum
    with tarfile.open(fileobj=io.BytesIO(recovery_archive), mode="r:gz") as recovery_tar:
        recovery_names = set(recovery_tar.getnames())
        assert "usr/bin/forkop-servicecheck" in recovery_names or "./usr/bin/forkop-servicecheck" in recovery_names
        assert not any(name.startswith("/") or "../" in name for name in recovery_names)
    assert payload_modes["usr/lib/forkop-servicecheck/probe.uc"] == 0o644
    assert "#!/usr/bin/ucode" not in cli
    assert "command -v ucode" in cli
    assert "    custom)" in cli
    assert 'else if (mode == "custom")' in engine
    assert 'else if (mode == "cancel")' in engine
    assert 'function cancel_job(job_id)' in engine
    assert 'callBin(["cancel", runState.jobId])' in view
    assert 'callBin(["cancel", jobId])' in view
    assert 'cancel JOB_ID' in cli
    assert 'function sanitizedReport(state, moduleVersion)' in view
    assert 'function reportAsText(report)' in view
    assert '"Скопировать отчёт"' in view
    assert '"Скачать JSON"' in view
    assert 'Report is sanitized' in view
    assert 'expected_route: as_string(target.expected_route || "any")' in engine
    assert 'function apply_route_expectation(item, backend_running)' in engine
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
    assert 'backend_version: backend_version(backend)' in engine
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
    assert 'function vpn_create(name, protocol, payload)' in engine
    assert 'else if (mode == "vpn-packages")' in engine
    assert 'vpn-install PROTOCOL' in cli
    assert 'callBin(["vpn-create", name, protocol, config])' in view
    assert 'AmneziaWG (авто: AWG 2.0/3.0)' in view
    assert 'callBin(["profiles-save", JSON.stringify(profilesDraft)])' in view
    assert 'function renderProfilesCards()' in view
    assert 'Добавить категорию' in view
    assert 'Редактируйте список обычными полями' in view
    assert 'forkop-servicecheck-theme' in view
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
    assert 'var showForkopFixes = backendId === "forkop"' in view
    assert 'showForkopFixes ? [checkTab, dnsTab, vpnTab, fixTab, listsTab] : [checkTab, dnsTab, vpnTab, listsTab]' in view
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
    with tarfile.open(PACKAGE, mode="r:gz") as outer:
        control_archive = outer.extractfile("./control.tar.gz").read()
        data_archive = outer.extractfile("./data.tar.gz").read()
    with tarfile.open(fileobj=io.BytesIO(control_archive), mode="r:gz") as control_tar:
        control = control_tar.extractfile("./control").read().decode("utf-8")
        assert "Depends: luci-base, ucode" in control
        assert f"Version: {VERSION}-r1" in control
        assert "для Tachyon, Forkop и оригинального Podkop" in control
        assert "оригинального Podkop" in control
    with tarfile.open(fileobj=io.BytesIO(data_archive), mode="r:gz") as data_tar:
        assert_shell("IPK primary CLI", data_tar.extractfile("./usr/bin/sing-box-service-check").read())
        assert_shell("IPK CLI", data_tar.extractfile("./usr/bin/forkop-servicecheck").read())
        assert_shell("IPK xHTTP fix", data_tar.extractfile("./usr/lib/forkop-servicecheck/xhttp_hotfix.sh").read())
        assert_shell("IPK ICMP fix", data_tar.extractfile("./usr/lib/forkop-servicecheck/icmp_tproxy_hotfix.sh").read())
        assert data_tar.extractfile("./usr/lib/forkop-servicecheck/probe.uc").read().decode("utf-8") == engine
        assert data_tar.extractfile("./www/luci-static/resources/view/forkop/servicecheck-v112.js").read().decode("utf-8") == view
        assert data_tar.extractfile("./usr/share/forkop-servicecheck/version").read().decode("utf-8").strip() == version_marker

    feed_packages = (FEED_DIR / "Packages").read_text(encoding="utf-8")
    assert f"Version: {VERSION}-r1" in feed_packages
    assert "для Tachyon, Forkop и оригинального Podkop" in feed_packages
    assert (FEED_DIR / PACKAGE.name).read_bytes() == PACKAGE.read_bytes()
    with gzip.open(FEED_DIR / "Packages.gz", "rt", encoding="utf-8") as compressed_feed:
        assert compressed_feed.read() == feed_packages

    apk_maker = APK_MAKER.read_text(encoding="utf-8")
    assert f'VERSION="{VERSION}-r1"' in apk_maker
    assert "для Tachyon, Forkop и оригинального Podkop" in apk_maker

    artifact_by_name = {
        path.name: path
        for path in (PACKAGE, INSTALLER, LEGACY_INSTALLER, APK_MAKER)
    }
    checksum_lines = [line.split(None, 1) for line in CHECKSUMS.read_text(encoding="utf-8").splitlines() if line]
    assert {name for _, name in checksum_lines} == set(artifact_by_name)
    for digest, name in checksum_lines:
        assert digest == hashlib.sha256(artifact_by_name[name].read_bytes()).hexdigest()

    print(f"installer/IPK OK: {len(archive)} bytes, {len(names)} entries")


if __name__ == "__main__":
    main()
