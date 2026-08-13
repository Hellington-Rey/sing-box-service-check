"""Validate source data, documentation links, and release metadata."""

import json
import re
from pathlib import Path

from assemble_sources import assemble_all


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


def main() -> int:
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        fail(f"invalid VERSION: {version!r}")

    assemble_all(check=True)
    validate_profiles()
    validate_documentation(version)

    required = [
        ".github/workflows/ci.yml",
        ".github/workflows/release.yml",
        "files/usr/lib/forkop-servicecheck/repair.sh",
    ]
    for relative in required:
        if not (ROOT / relative).is_file():
            fail(f"required project file is missing: {relative}")

    print(f"project structure OK ({version})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
