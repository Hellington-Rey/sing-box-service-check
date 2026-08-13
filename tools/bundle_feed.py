"""Create a deterministic ZIP that can be published as an opkg feed."""

import zipfile
from pathlib import Path

from project_version import project_version


ROOT = Path(__file__).resolve().parent.parent
FEED = ROOT / "dist" / "feed"
OUTPUT = ROOT / "dist" / f"opkg-feed-{project_version()}.zip"
ZIP_TIME = (2025, 1, 1, 0, 0, 0)


def main() -> int:
    files = sorted(path for path in FEED.iterdir() if path.is_file())
    if not files:
        raise SystemExit("feed is empty")
    with zipfile.ZipFile(OUTPUT, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files:
            info = zipfile.ZipInfo(path.name, ZIP_TIME)
            info.external_attr = 0o644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, path.read_bytes())
    print(OUTPUT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
