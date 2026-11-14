#!/usr/bin/env python3
"""Prepare pinned Windows x64 runtimes using only Python's standard library."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
import tempfile
from urllib.request import urlopen
import zipfile

VENDOR = Path(__file__).resolve().parents[1] / "resources" / "vendor"


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def checked_member(root, name):
    member = PurePosixPath(name.replace("\\", "/"))
    if member.is_absolute() or ".." in member.parts or any(":" in p for p in member.parts):
        raise ValueError(f"Unsafe archive path: {name}")
    target = root.joinpath(*member.parts).resolve()
    if not target.is_relative_to(root) or target == root:
        raise ValueError(f"Archive path escapes destination: {name}")
    return target


def safe_extract(archive, destination):
    """Validate every entry before writing any archive content."""
    root = destination.resolve()
    with zipfile.ZipFile(archive) as bundle:
        entries, seen = [], set()
        for entry in bundle.infolist():
            target = checked_member(root, entry.filename)
            if stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError(f"Archive symlink is not allowed: {entry.filename}")
            key = str(target).casefold()
            if key in seen:
                raise ValueError(f"Duplicate archive path: {entry.filename}")
            seen.add(key)
            entries.append((entry, target))
        for entry, target in entries:
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(entry) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)


def verify(runtime):
    root = VENDOR / runtime["directory"]
    return [name for name, digest in runtime["files"].items()
            if not (root / name).is_file() or sha256(root / name) != digest]


def prepare(runtime):
    if not verify(runtime):
        return "verified existing files (offline)"
    archive_info = runtime["archive"]
    with tempfile.TemporaryDirectory(prefix="doconstruct-runtime-") as temporary:
        temporary = Path(temporary)
        archive = temporary / "runtime.zip"
        with urlopen(archive_info["url"], timeout=90) as response, archive.open("wb") as output:
            shutil.copyfileobj(response, output)
        if sha256(archive) != archive_info["sha256"]:
            raise ValueError(f"Archive SHA-256 mismatch: {runtime['name']}")
        # Staging keeps a rejected or incomplete download out of the shipped tree.
        stage = temporary / "unpacked"
        safe_extract(archive, stage)
        source = stage / archive_info.get("root", "")
        target = VENDOR / runtime["directory"]
        if runtime["name"] == "Python":
            for name, content in runtime["configured_files"].items():
                configured = checked_member(source.resolve(), name)
                configured.parent.mkdir(parents=True, exist_ok=True)
                configured.write_bytes(content.encode("utf-8"))
        for name, digest in runtime["files"].items():
            candidate = checked_member(source.resolve(), name)
            if not candidate.is_file() or sha256(candidate) != digest:
                raise ValueError(f"Extracted file SHA-256 mismatch: {name}")
        for name in runtime["files"]:
            output = checked_member(target.resolve(), name)
            output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / name, output)
    return "downloaded and verified official archive"


def probe(runtime):
    executable = VENDOR / runtime["directory"] / runtime["executable"]
    arguments = [str(executable), "--version"]
    if runtime["name"] == "Python":
        arguments = [str(executable), "-c", "import json,sys,platform,ssl,sqlite3; "
                     "print(json.dumps({'version':platform.python_version(),"
                     "'architecture':platform.machine(),'executable':sys.executable,"
                     "'isolated':sys.flags.isolated,'no_user_site':sys.flags.no_user_site,"
                     "'path':sys.path}))"]
    result = subprocess.run(arguments, check=True, capture_output=True, text=True,
                            timeout=20, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    output = result.stdout.strip()
    if runtime["name"] == "Python":
        detail = json.loads(output)
        if detail["version"] != runtime["version"] or not detail["isolated"] or not detail["no_user_site"]:
            raise ValueError("Embedded Python version/isolation probe failed")
        return detail
    if output.splitlines()[0] != f"pandoc {runtime['version']}":
        raise ValueError("Pandoc version probe failed")
    return output.splitlines()[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify and probe without downloading or changing files")
    args = parser.parse_args()
    if sys.platform != "win32":
        parser.error("These pinned binaries target Windows x64; prepare them on a Windows build host.")
    manifest = json.loads((VENDOR / "MANIFEST.json").read_text(encoding="utf-8"))
    results = []
    for runtime in manifest["runtimes"]:
        status = "verified existing files (offline)" if args.check else prepare(runtime)
        mismatches = verify(runtime)
        if mismatches:
            raise ValueError(f"{runtime['name']} missing/modified files: {', '.join(mismatches)}")
        results.append({"name": runtime["name"], "status": status, "probe": probe(runtime)})
    print(json.dumps({"vendor": str(VENDOR), "runtimes": results}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        print(f"Runtime preparation failed: {error}", file=sys.stderr)
        sys.exit(1)
