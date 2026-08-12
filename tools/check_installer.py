"""Static checks for the generated self-contained installer."""

import base64
import io
import tarfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
INSTALLER = ROOT / "install-sing-box-service-check.sh"
LEGACY_INSTALLER = ROOT / "install-forkop-servicecheck.sh"
PACKAGE = ROOT / "dist" / "luci-app-forkop-servicecheck_1.7.0-r1_all.ipk"
MARKER = "__FORKOP_SC_PAYLOAD__"


def assert_shell(name, shell_script):
    assert shell_script.startswith(b"#!/bin/sh\n"), f"{name} has an invalid shebang"
    assert b"\r" not in shell_script, f"{name} contains CRLF/CR line endings"


def main():
    script = INSTALLER.read_text(encoding="utf-8")
    assert 'VERSION="1.7.0"' in script
    assert LEGACY_INSTALLER.read_bytes() == INSTALLER.read_bytes()
    assert "detect_installed_version()" in script
    assert 'INSTALLED_VERSION="$(detect_installed_version || true)"' in script
    assert "sed -n '/^__PAYLOAD_BELOW__$/,$p' \"$0\"" not in script

    chunks = script.split(MARKER)
    assert len(chunks) >= 3, "payload heredoc is missing"
    payload = chunks[1].split("\n", 1)[1].rsplit("\n", 1)[0]
    archive = base64.b64decode("".join(payload.split()), validate=True)

    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        names = set(tar.getnames())
        cli_raw = tar.extractfile("usr/bin/forkop-servicecheck").read()
        xhttp_fix = tar.extractfile("usr/lib/forkop-servicecheck/xhttp_hotfix.sh").read()
        icmp_fix = tar.extractfile("usr/lib/forkop-servicecheck/icmp_tproxy_hotfix.sh").read()
        cli = cli_raw.decode("utf-8")
        engine = tar.extractfile("usr/lib/forkop-servicecheck/probe.uc").read().decode("utf-8")
        profiles = tar.extractfile("usr/share/forkop-servicecheck/profiles.json").read().decode("utf-8")
        view = tar.extractfile("www/luci-static/resources/view/forkop/servicecheck-v112.js").read().decode("utf-8")

    required = {
        "usr/bin/forkop-servicecheck",
        "usr/lib/forkop-servicecheck/probe.uc",
        "usr/lib/forkop-servicecheck/xhttp_hotfix.sh",
        "usr/lib/forkop-servicecheck/icmp_tproxy_hotfix.sh",
        "usr/share/forkop-servicecheck/profiles.json",
        "usr/share/forkop-servicecheck/version",
        "www/luci-static/resources/view/forkop/servicecheck-v112.js",
    }
    missing = required - names
    assert not missing, f"missing payload files: {sorted(missing)}"
    assert_shell("installer CLI", cli_raw)
    assert_shell("installer xHTTP fix", xhttp_fix)
    assert_shell("installer ICMP fix", icmp_fix)
    assert "#!/usr/bin/ucode" not in cli
    assert "command -v ucode" in cli
    assert "    custom)" in cli
    assert 'else if (mode == "custom")' in engine
    assert 'status == 28 && connect_ms <= 0 && remote_ip == ""' in engine
    assert 'else if (mode == "profiles-save")' in engine
    assert 'callBin(["profiles-save", JSON.stringify(profilesDraft)])' in view
    assert 'function renderProfilesCards()' in view
    assert 'Добавить категорию' in view
    assert 'Редактируйте список обычными полями' in view
    assert 'forkop-servicecheck-theme' in view
    assert 'theme-dark' in view and 'theme-light' in view and 'theme-auto' in view
    assert 'Тёмная' in view and 'Светлая' in view and 'Авто' in view
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
    assert 'const PODKOP_BIN' in engine
    assert '"get_sing_box_status"' in engine
    assert 'uci_get("podkop.settings.config_path")' in engine
    assert 'controller + "/connections"' in engine
    assert 'backend_running: running' in engine
    assert 'var showForkopFixes = backendId === "forkop"' in view
    assert 'showForkopFixes ? [checkTab, fixTab, listsTab] : [checkTab, listsTab]' in view
    assert '[ -x /usr/bin/podkop ]' in script
    assert 'update-check|update-start|update-status)' in cli
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
    assert 'callBin(["update-start"])' in view
    assert 'callBin(["update-status"])' in view
    assert 'Обновление модуля' in view
    assert 'Перед установкой будет проверен SHA-256' in view
    assert "GEMINI_API_KEY_DEFAULT" not in engine
    assert "AIza" not in engine
    assert '"path": "/v1beta/models"' in profiles
    assert 'class: "fkpsc-tile-header"' in view
    assert 'tileHeader.addEventListener("click", toggle)' in view
    assert 'tile.addEventListener("click", toggle)' not in view
    with tarfile.open(PACKAGE, mode="r:gz") as outer:
        control_archive = outer.extractfile("./control.tar.gz").read()
        data_archive = outer.extractfile("./data.tar.gz").read()
    with tarfile.open(fileobj=io.BytesIO(control_archive), mode="r:gz") as control_tar:
        control = control_tar.extractfile("./control").read().decode("utf-8")
        assert "Depends: luci-base, ucode" in control
        assert "оригинального Podkop" in control
    with tarfile.open(fileobj=io.BytesIO(data_archive), mode="r:gz") as data_tar:
        assert_shell("IPK primary CLI", data_tar.extractfile("./usr/bin/sing-box-service-check").read())
        assert_shell("IPK CLI", data_tar.extractfile("./usr/bin/forkop-servicecheck").read())
        assert_shell("IPK xHTTP fix", data_tar.extractfile("./usr/lib/forkop-servicecheck/xhttp_hotfix.sh").read())
        assert_shell("IPK ICMP fix", data_tar.extractfile("./usr/lib/forkop-servicecheck/icmp_tproxy_hotfix.sh").read())

    print(f"installer/IPK OK: {len(archive)} bytes, {len(names)} entries")


if __name__ == "__main__":
    main()
