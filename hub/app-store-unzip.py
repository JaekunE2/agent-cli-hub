"""Extract the uploaded app ZIP without following links or accepting host paths."""
import re
import shutil
import stat
import sys
import zipfile
from pathlib import Path

MAX_FILES = 4000
MAX_EXPANDED_BYTES = 200 * 1024 * 1024
DEVICE = re.compile(r"^(CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])$", re.I)


def unpack(archive, directory):
    root = Path(directory)
    with zipfile.ZipFile(archive) as package:
        entries = package.infolist()
        if len(entries) > MAX_FILES or sum(e.file_size for e in entries) > MAX_EXPANDED_BYTES:
            raise ValueError("archive exceeds expansion limits")

        seen = set()
        for entry in entries:
            parts = entry.orig_filename.removesuffix("/").split("/")
            kind = stat.S_IFMT(entry.external_attr >> 16)
            if kind not in (0, stat.S_IFDIR, stat.S_IFREG) or any(
                not part or part in (".", "..") or part.endswith((" ", "."))
                or part.lower() == ".git" or part.lower().startswith(".env")
                or re.search(r'[<>:"\\|?*\x00-\x1f]', part)
                or DEVICE.fullmatch(part.partition(".")[0])
                for part in parts
            ):
                raise ValueError("archive contains an unsafe path or file type")
            key = "/".join(parts).casefold()
            if key in seen:
                raise ValueError("archive contains duplicate paths")
            seen.add(key)
            target = root.joinpath(*parts)
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with package.open(entry) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output)


if __name__ == "__main__":
    try:
        unpack(sys.argv[1], sys.argv[2])
    except (OSError, ValueError, RuntimeError, zipfile.BadZipFile) as exc:
        sys.exit(str(exc))
