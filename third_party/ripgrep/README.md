# ripgrep runtime

Ash packages ripgrep as the implementation behind the model-visible
`shell-command` search surface. The runtime is an upstream command-line
executable, not a Ash Rust crate and not a second Tool API.

[`runtime-lock.json`](runtime-lock.json) is the release authority for the
upstream version, package-target mapping, archive size, SHA-256 digest, format,
and executable member. [`build/package/build.py`](../../build/package/build.py)
downloads and validates one artifact, extracts only the named executable, and
places it at `ash-path/rg[.exe]`.

Downloaded archives and extracted executables live below
`third_party/.cache/ripgrep/` and are not source controlled. An invalid cache
entry is discarded; a digest or size mismatch after download aborts packaging.
`--rg-bin` is an authoritative local override for release jobs that already
materialized or signed ripgrep.

The package copies `LICENSE-MIT` and `UNLICENSE` into
`ash-resources/licenses/ripgrep/`. When updating ripgrep, update the lock,
re-check every official release digest, review the upstream license files, and
run the package tests.

```sh
python3 -m unittest discover -s scripts -p 'test_*.py'
```
