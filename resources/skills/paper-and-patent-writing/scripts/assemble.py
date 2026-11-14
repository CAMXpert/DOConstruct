#!/usr/bin/env python3
"""Assemble explicitly listed UTF-8 chapter files without collecting notes."""

import argparse
import json
from pathlib import Path


def contained(base: Path, relative: str) -> Path:
    if not isinstance(relative, str) or not relative or Path(relative).is_absolute():
        raise ValueError("Expected a nonempty relative path")
    path = (base / relative).resolve()
    if not path.is_relative_to(base):
        raise ValueError(f"Path leaves its owning directory: {relative}")
    return path


def assemble(root: Path, manifest_name: str, output_name: str) -> tuple[Path, int]:
    root = root.resolve()
    manifest = contained(root, manifest_name)
    output = contained(root, output_name)
    if output.parent != root or output.suffix.lower() not in {".md", ".txt"}:
        raise ValueError("Output must be an md/txt file directly in the article directory")
    plan = json.loads(manifest.read_text(encoding="utf-8-sig"))
    sections = plan.get("sections") if isinstance(plan, dict) else None
    if not isinstance(sections, list) or not sections:
        raise ValueError("Manifest must contain a nonempty sections list")
    assets = (root / "assets").resolve()
    parts = []
    inputs = {manifest}
    for section in sections:
        if not isinstance(section, dict):
            raise ValueError("Each section must contain directory and body")
        directory = contained(assets, section.get("directory"))
        body = section.get("body")
        if not isinstance(body, list) or not body:
            raise ValueError(f"No explicit body files for {directory.name}")
        for name in body:
            path = contained(directory, name)
            if path.suffix.lower() not in {".md", ".txt"}:
                raise ValueError(f"Body input must be md/txt: {name}")
            if path in inputs:
                raise ValueError(f"Duplicate body input: {name}")
            inputs.add(path)
            parts.append(path.read_text(encoding="utf-8-sig").rstrip("\n"))
    if output in inputs:
        raise ValueError("Output must not overwrite the manifest or a body input")
    output.write_text("\n\n".join(parts) + "\n", encoding="utf-8")
    return output, len(parts)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--manifest", default="sections.json")
    parser.add_argument("--output", default="manuscript.md")
    args = parser.parse_args()
    try:
        output, count = assemble(args.root, args.manifest, args.output)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Assembly failed: {error}\n")
    print(f"Assembled {count} explicit body files: {output}")


if __name__ == "__main__":
    main()
