"""Validate source data, documentation links, and release metadata."""

import json
import re
from pathlib import Path

from assemble_sources import assemble_all
from project_version import luci_view_name


ROOT = Path(__file__).resolve().parent.parent
ALLOWED_KINDS = {"https", "tcp", "udp", "udp_dns", "gemini_geo"}
ALLOWED_ROUTES = {"any", "proxy", "direct"}


def fail(message: str) -> None:
    raise ValueError(message)


def validate_profiles() -> None:
    path = ROOT / "files/usr/share/forkop-servicecheck/profiles.json"
    document = json.loads(path.read_text(encoding="utf-8"))
    profiles = document.get("profiles")
    if not isinstance(profiles, list) or not profiles:
        fail("profiles.json must contain a non-empty profiles array")

    identifiers: set[str] = set()
    for profile in profiles:
        identifier = profile.get("id")
        if not isinstance(identifier, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", identifier):
            fail(f"invalid profile id: {identifier!r}")
        if identifier in identifiers:
            fail(f"duplicate profile id: {identifier}")
        identifiers.add(identifier)

        targets = profile.get("targets")
        if not isinstance(targets, list) or not 1 <= len(targets) <= 50:
            fail(f"profile {identifier} must contain between 1 and 50 targets")
        for index, target in enumerate(targets, start=1):
            prefix = f"profile {identifier}, target {index}"
            kind = target.get("kind")
            if kind not in ALLOWED_KINDS:
                fail(f"{prefix}: unsupported kind {kind!r}")
            host = target.get("host")
            if not isinstance(host, str) or not host or re.search(r"[\s/]", host):
                fail(f"{prefix}: invalid host {host!r}")
            port = target.get("port")
            if port is not None and (not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535):
                fail(f"{prefix}: invalid port {port!r}")
            route = target.get("expected_route", "any")
            if route not in ALLOWED_ROUTES:
                fail(f"{prefix}: invalid expected_route {route!r}")


def validate_zapret_catalog() -> None:
    path = ROOT / "files/usr/lib/forkop-servicecheck/zapret_strategy_catalog.tsv"
    counts = {"zapret": 0, "zapret2": 0}
    identifiers: set[str] = set()
    forbidden = ("--qnum", "--fwmark", "--dpi-desync-fwmark", "--hostlist", "--ipset", "pornhub")
    for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not raw or raw.startswith("#"):
            continue
        fields = raw.split("\t")
        if len(fields) != 6:
            fail(f"Zapret catalogue line {line_number}: expected 6 TSV fields, got {len(fields)}")
        provider, identifier, title, source, quic, strategy = fields
        if provider not in counts:
            fail(f"Zapret catalogue line {line_number}: unknown provider {provider!r}")
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", identifier) or identifier in identifiers:
            fail(f"Zapret catalogue line {line_number}: invalid or duplicate id {identifier!r}")
        if not title or not source or quic not in {"0", "1"}:
            fail(f"Zapret catalogue line {line_number}: title, source and QUIC marker are required")
        if len(strategy.split()) < 8:
            fail(f"Zapret catalogue line {line_number}: short generated strategy is not allowed")
        if "--filter-tcp=443" not in strategy or "--new" not in strategy or "--filter-udp=443" not in strategy:
            fail(f"Zapret catalogue line {line_number}: profile must contain complete TCP and UDP sections")
        if any(token.lower() in strategy.lower() for token in forbidden):
            fail(f"Zapret catalogue line {line_number}: runtime/conflicting option found")
        if provider == "zapret2" and ("--payload=tls_client_hello" not in strategy or "--lua-desync=" not in strategy):
            fail(f"Zapret catalogue line {line_number}: incomplete Zapret2 profile")
        if provider == "zapret" and "--dpi-desync=" not in strategy:
            fail(f"Zapret catalogue line {line_number}: incomplete Zapret profile")
        identifiers.add(identifier)
        counts[provider] += 1
    if counts != {"zapret": 10, "zapret2": 10}:
        fail(f"Zapret catalogue must contain 10 ready profiles per provider: {counts}")


def validate_documentation(version: str) -> None:
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    for source in re.findall(r'<img\s+[^>]*src="([^"]+)"', readme):
        if re.match(r"https?://", source):
            continue
        if not (ROOT / source).is_file():
            fail(f"README image does not exist: {source}")
    if not re.search(rf"^## {re.escape(version)}(?:\s|$)", changelog, flags=re.MULTILINE):
        fail(f"CHANGELOG.md has no entry for {version}")


def validate_luci_source(version: str) -> None:
    view_name = luci_view_name(version)
    view_directory = ROOT / "files/www/luci-static/resources/view/forkop"
    view_path = view_directory / view_name
    source = view_path.read_text(encoding="utf-8")
    if "UI_VERSION" in source:
        fail("LuCI source still references removed UI_VERSION; use capabilities.module_version")

    versioned_views = sorted(path.name for path in view_directory.glob("servicecheck-v*.js"))
    if versioned_views != [view_name]:
        fail(f"LuCI view must use only the current cache-busting name {view_name}: {versioned_views}")

    menu_path = ROOT / "files/usr/share/luci/menu.d/luci-app-forkop-servicecheck.json"
    menu = json.loads(menu_path.read_text(encoding="utf-8"))
    action = menu["admin/services/forkop_servicecheck"]["action"]
    expected_path = f"forkop/{view_name.removesuffix('.js')}"
    if action.get("path") != expected_path:
        fail(f"LuCI menu path {action.get('path')!r} does not match {expected_path!r}")

    repair = (ROOT / "files/usr/lib/forkop-servicecheck/repair.sh").read_text(encoding="utf-8")
    if f"www/luci-static/resources/view/forkop/{view_name}" not in repair:
        fail("repair.sh does not contain the current versioned LuCI view")


def main() -> int:
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        fail(f"invalid VERSION: {version!r}")

    assemble_all(check=True)
    validate_profiles()
    validate_zapret_catalog()
    validate_documentation(version)
    validate_luci_source(version)

    required = [
        ".github/workflows/ci.yml",
        ".github/workflows/release.yml",
        "files/usr/lib/forkop-servicecheck/repair.sh",
        "files/usr/lib/forkop-servicecheck/zapret_strategy_worker.sh",
        "files/usr/lib/forkop-servicecheck/zapret_strategy_catalog.tsv",
        "src/backend/95_zapret_strategy.part",
        "src/luci/58_zapret_strategy.part",
        "tools/test_installer_runtime_layout.sh",
        "tools/test_zapret_strategy_worker.sh",
    ]
    for relative in required:
        if not (ROOT / relative).is_file():
            fail(f"required project file is missing: {relative}")

    print(f"project structure OK ({version})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
