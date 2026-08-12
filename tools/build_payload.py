"""Build the deterministic ustar+gzip payload embedded in both installers."""

import gzip
import io
import os
import sys
import tarfile
from pathlib import Path


MTIME = 1735689600  # 2025-01-01 00:00:00 UTC


def mode_for(relative_path: Path, is_dir: bool) -> int:
    if is_dir:
        return 0o755
    path = relative_path.as_posix()
    if path.startswith("usr/bin/") or path.endswith(".sh"):
        return 0o755
    return 0o644


def tar_info(name: str, size: int, mode: int, is_dir: bool) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.size = size
    info.mode = mode
    info.mtime = MTIME
    info.uid = 0
    info.gid = 0
    info.uname = "root"
    info.gname = "root"
    info.type = tarfile.DIRTYPE if is_dir else tarfile.REGTYPE
    return info


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: build_payload.py STAGING_DIR OUTPUT_TAR_GZ", file=sys.stderr)
        return 2

    staging = Path(sys.argv[1]).resolve()
    output = Path(sys.argv[2]).resolve()
    if not staging.is_dir():
        print(f"staging directory does not exist: {staging}", file=sys.stderr)
        return 2

    entries = []
    for root_name in ("usr", "www"):
        root = staging / root_name
        if not root.is_dir():
            print(f"payload root does not exist: {root}", file=sys.stderr)
            return 2
        entries.append((Path(root_name), root, True))
        for current, directories, files in os.walk(root):
            directories.sort()
            files.sort()
            current_path = Path(current)
            for directory in directories:
                path = current_path / directory
                entries.append((path.relative_to(staging), path, True))
            for filename in files:
                path = current_path / filename
                entries.append((path.relative_to(staging), path, False))

    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for relative, source, is_dir in sorted(entries, key=lambda item: item[0].as_posix()):
            name = relative.as_posix() + ("/" if is_dir else "")
            data = b"" if is_dir else source.read_bytes()
            info = tar_info(name, len(data), mode_for(relative, is_dir), is_dir)
            archive.addfile(info, None if is_dir else io.BytesIO(data))

    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as output_file:
        with gzip.GzipFile(filename="", fileobj=output_file, mode="wb", mtime=MTIME) as compressed:
            compressed.write(raw.getvalue())

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
