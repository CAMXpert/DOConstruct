# Bundled document runtimes

These Windows x64 tools run as separate local processes. DOConstruct resolves
them relative to its own resources directory; no development machine paths are
part of the product. Electron/Chromium and CodeMirror are supplied by the
application's npm distribution and have their own packaged license notices.

The local UI bundle also includes Markdown-it 14.3.3 and CodeMirror Merge 6.12.3
(MIT), jsdiff 8.0.4 (BSD-3-Clause), and entities 4.5.0 (BSD-2-Clause).
Their notices and those of the other bundled UI dependencies are included in
`resources/licenses` and listed in `resources/licenses/INDEX.json`. They run
locally; no CDN or extra runtime installation is needed.

| Component | Pinned version | License and included notices | Official source |
| --- | --- | --- | --- |
| Pandoc | 3.12 | GPL-2.0-or-later; retain [COPYRIGHT.txt](vendor/pandoc/COPYRIGHT.txt) and [COPYING.rtf](vendor/pandoc/COPYING.rtf), including the component notices | [Release and binaries](https://github.com/jgm/pandoc/releases/tag/3.12), [corresponding Pandoc source](https://hackage.haskell.org/package/pandoc-3.12/pandoc-3.12.tar.gz) |
| CPython Windows embeddable distribution | 3.15.2, AMD64 | Python Software Foundation License Version 2 and included historical/component notices in [LICENSE.txt](vendor/python/LICENSE.txt) | [Release](https://www.python.org/downloads/release/python-3152/), [official archive directory](https://www.python.org/ftp/python/3.15.2/) |

The exact binary archive URLs, SHA-256 digests, shipped file hashes and Python
configuration changes are locked in [vendor/MANIFEST.json](vendor/MANIFEST.json).
Pandoc's upstream copyright file covers its bundled libraries. CPython's
upstream license file covers the embedded distribution and its bundled
components. Keep those complete notices with redistributed binaries. Pandoc
binary redistribution also requires satisfying the GPL's corresponding-source
provisions; the source link identifies the upstream version and is not itself
a written source offer.

## Reproducing the runtimes

On a Windows x64 build host with Python 3.11 or newer:

```powershell
python scripts/bootstrap-runtime.py
python scripts/bootstrap-runtime.py --check
```

The first command verifies existing files and uses them offline when all hashes
match. Missing or modified runtime files cause a download from the pinned
official URL, archive SHA-256 verification, validation of every archive entry
before extraction, and verification of all shipped file hashes. Downloaded
archives and staging files live in a temporary directory. The script does not
install anything globally. `--check` performs only local hash checks and runtime
probes, without downloading or changing runtime files.

Python retains its embedded isolated-path mode. The only configured paths are
the bundled standard-library ZIP, the executable directory, and its own
`Lib/site-packages`; `import site` enables that local extension directory.
User-site packages, `PYTHONPATH` and registry discovery remain disabled. No pip
or additional Python modules are bundled. The default layout script uses the
standard library. Additional user dependencies require compatible local files
and their own license review; they are not silently installed.

Archive path validation rejects parent traversal, absolute/drive paths,
duplicate paths (case-insensitive), symlinks, and paths resolving outside the
destination. No upstream installer or downloaded setup script is executed.
