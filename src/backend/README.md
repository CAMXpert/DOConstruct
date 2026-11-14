# Document backend

This ESM module is independent of any authoring project. `DocumentBackend` implements the root API contract. Main injects the portable Pandoc and Python executable locations; it owns Electron windows, approved artifact URLs and actual PDF printing.

Projects use `doconstruct.json`. Opening a legacy `sections.json` imports its explicitly ordered `assets/<directory>/<body>` paths as adjacent slots and writes a new sidecar; it does not rewrite source Markdown. New projects copy the editable files from `templates/default`. Resource URLs are relative to the project root, supplied through an HTML `base` URL.

`getProject` returns a cached file list. Opening/configuring reads only the project root and explicitly selected files or command scripts; it never recursively enumerates experiment data or image archives. `saveFile` requires the opened content version, writes atomically and rejects external changes. A new file uses version `null`; an existing file is never overwritten under that token. Resolved paths and linked ancestors remain inside the project.

Markdown conversion is delegated to Pandoc, using its HTML5 writer and MathML. Ordinary chapter HTML is cached by original text, Pandoc version and reader/writer options. CSS, fonts and ordinary outline reorder reuse those results. Footnotes, reference links, internal anchors, citations and shared TeX macros explicitly switch to a cached full-document parse; correctness of global semantics takes precedence over chapter-only invalidation. The mode/reason and actual converted/reused chapter counts are returned in job statistics.

The ordered source/CSS/script inputs are captured for each build. A single async worker runs processes without a shell and publishes only the current project/revision after rechecking external inputs. Superseded/canceled work cannot replace the latest successful preview. Terminal jobs release captured source payloads; the chapter cache retains at most 256 entries.

Python layout receives JSON on stdin with `title`, `style`, `sections` (HTML), `css`, and `baseUrl`, and writes complete HTML to stdout. The captured script runs with its original project filename/import directory and project working directory. The default needs only Python's standard library. An unavailable Python uses a diagnosed built-in layout; an actual script failure stays a failed job, with stderr and the last successful preview retained. Other explicit commands use an executable plus separate argv entries and retain their logs/artifact paths.

Local checks: `node --test tests/backend.test.mjs`. The tests use the independently bundled `resources/vendor/pandoc/pandoc.exe` and `resources/vendor/python/python.exe`; environment variables `DOCONSTRUCT_PANDOC` and `DOCONSTRUCT_PYTHON` can select another explicit runtime.

References: [Pandoc manual](https://pandoc.org/MANUAL.html) documents HTML/MathML and cross-file parsing semantics; [Node child processes](https://nodejs.org/api/child_process.html) documents asynchronous spawn without shell interpolation. Screen preview uses the final HTML/CSS; PDF pagination belongs to Chromium, not to this Markdown cache.
