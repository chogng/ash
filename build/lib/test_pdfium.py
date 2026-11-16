"""Verify locked PDFium resources without downloading native libraries."""

import hashlib
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from build.lib.pdfium import copy_pdfium, prepare_pdfium


class PdfiumTests(unittest.TestCase):
    def test_prepares_verified_library_and_retains_notices(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "third_party/.cache/pdfium/chromium/8152/test/pdfium.tgz"
            archive.parent.mkdir(parents=True)
            with tarfile.open(archive, "w:gz") as output:
                for name, data in (
                    ("LICENSE", b"PDFium primary license"),
                    ("lib/libpdfium.so", b"native PDFium"),
                    ("licenses/LICENSE", b"PDFium notice"),
                ):
                    member = tarfile.TarInfo(name)
                    member.size = len(data)
                    output.addfile(member, io.BytesIO(data))
            lock = root / "third_party/pdfium/runtime-lock.json"
            lock.parent.mkdir(parents=True)
            lock.write_text(
                json.dumps(
                    {
                        "release": "chromium/8152",
                        "repository": "https://github.com/bblanchon/pdfium-binaries",
                        "artifacts": {
                            "test": {
                                "name": "pdfium.tgz",
                                "size": archive.stat().st_size,
                                "sha256": hashlib.sha256(
                                    archive.read_bytes()
                                ).hexdigest(),
                                "library": "lib/libpdfium.so",
                            }
                        },
                    }
                )
            )
            with patch("build.lib.pdfium.download_and_verify") as download:
                library = prepare_pdfium(root, "test")
                self.assertEqual(library.read_bytes(), b"native PDFium")
                library.write_bytes(b"corrupt cache")
                copy_pdfium(root, "test", root / "package")
                self.assertEqual(
                    (root / "package/pdfium/libpdfium.so").read_bytes(),
                    b"native PDFium",
                )
                self.assertEqual(
                    (root / "package/licenses/pdfium/LICENSE").read_bytes(),
                    b"PDFium notice",
                )
                self.assertEqual(
                    (root / "package/licenses/pdfium/PDFium-LICENSE").read_bytes(),
                    b"PDFium primary license",
                )
                self.assertIsNone(prepare_pdfium(root, "unsupported-musl"))
                download.assert_not_called()


if __name__ == "__main__":
    unittest.main()
