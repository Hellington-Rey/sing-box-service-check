"""Validate the generated opkg feed and its package checksum."""

import gzip
import hashlib
import re
from pathlib import Path

from project_version import project_version


ROOT = Path(__file__).resolve().parent.parent
FEED = ROOT / "dist" / "feed"
VERSION = project_version()
PACKAGE = f"luci-app-forkop-servicecheck_{VERSION}-r1_all.ipk"


def field(manifest: str, name: str) -> str:
    match = re.search(rf"^{re.escape(name)}:\s*(.+)$", manifest, re.MULTILINE)
    if not match:
        raise AssertionError(f"missing feed field: {name}")
    return match.group(1).strip()


def main() -> int:
    manifest = (FEED / "Packages").read_text(encoding="utf-8")
    with gzip.open(FEED / "Packages.gz", "rt", encoding="utf-8") as stream:
        assert stream.read() == manifest, "Packages.gz differs from Packages"

    assert field(manifest, "Version") == f"{VERSION}-r1"
    assert field(manifest, "Filename") == PACKAGE
    package = FEED / PACKAGE
    raw = package.read_bytes()
    assert int(field(manifest, "Size")) == len(raw)
    assert field(manifest, "SHA256sum") == hashlib.sha256(raw).hexdigest()
    print(f"opkg feed OK: {PACKAGE}, {len(raw)} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
