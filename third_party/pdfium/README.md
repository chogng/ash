# PDFium runtime

Ash uses PDFium only for backend document ingestion: text extraction, page
rendering, and OCR pre-processing. Electron's normal PDF preview continues to
use Chromium's built-in viewer.

`runtime-lock.json` is the release lockfile. The selected PDFium build must
remain compatible with the `pdfium-render` crate feature enabled by
`ash-pdf`. The current lock is intentionally pinned to build 7763 and
the workspace enables the matching `pdfium_7763` feature.

Fetch and verify the host artifact into a release staging directory:

```sh
uv run --frozen --project scripts python -B build/ash_rs/pdfium.py --output /absolute/path/to/resources/native/pdfium
```

Cross-platform release jobs must specify their target explicitly:

```sh
uv run --frozen --project scripts python -B build/ash_rs/pdfium.py --target win-x64 --output "$STAGING/resources/native/pdfium"
```

The destination contains `lib/libpdfium.dylib` on macOS,
`bin/pdfium.dll` on Windows, or `lib/libpdfium.so` on Linux, along with the
upstream `LICENSE` and `licenses/` notices. Package signing must include the
macOS dynamic library before notarization.
