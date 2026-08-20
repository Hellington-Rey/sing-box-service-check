"""Single source of truth for the project version."""

import os
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
VERSION_FILE = ROOT / "VERSION"
VERSION_PATTERN = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")


def project_version() -> str:
    version = VERSION_FILE.read_text(encoding="utf-8").strip()
    if not VERSION_PATTERN.fullmatch(version):
        raise ValueError(f"invalid VERSION value: {version!r}")
    return version


def expected_tag() -> str:
    return f"v{project_version()}"


def luci_view_name(version: str | None = None) -> str:
    """Return the versioned LuCI asset name used as a browser cache buster."""
    value = version or project_version()
    if not VERSION_PATTERN.fullmatch(value):
        raise ValueError(f"invalid version for LuCI view: {value!r}")
    return f"servicecheck-v{value.replace('.', '')}.js"


def main() -> int:
    version = project_version()
    ref_type = os.environ.get("GITHUB_REF_TYPE", "")
    ref_name = os.environ.get("GITHUB_REF_NAME", "")
    if ref_type == "tag" and ref_name != f"v{version}":
        raise SystemExit(
            f"release tag {ref_name!r} does not match VERSION {version!r}"
        )
    print(version)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
