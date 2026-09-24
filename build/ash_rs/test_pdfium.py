"""PDFium runtime fetch and output contract."""

import hashlib
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from build.ash_rs.pdfium import fetch_pdfium


class PdfiumTests(unittest.TestCase):
    def test_cached_archive_produces_a_reusable_receipted_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "third_party/.cache/pdfium/1.0/linux-x64/pdfium.tgz"
            archive.parent.mkdir(parents=True)
            with tarfile.open(archive, "w:gz") as output:
                member = tarfile.TarInfo("lib/libpdfium.so")
                member.size = len(b"pdfium")
                output.addfile(member, io.BytesIO(b"pdfium"))
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            lock_path = root / "third_party/pdfium/runtime-lock.json"
            lock_path.parent.mkdir(parents=True)
            lock_path.write_text(
                json.dumps(
                    {
                        "version": "1.0",
                        "source": {
                            "repository": "https://example.com",
                            "release": "v1",
                        },
                        "artifacts": {
                            "linux-x64": {
                                "archive": "pdfium.tgz",
                                "sha256": digest,
                                "library": "lib/libpdfium.so",
                            }
                        },
                    }
                )
            )
            output = root / "output"
            with patch(
                "build.ash_rs.pdfium.download_and_verify",
                side_effect=AssertionError("unexpected download"),
            ):
                self.assertEqual(output, fetch_pdfium("linux-x64", output, root=root))
                self.assertEqual(output, fetch_pdfium("linux-x64", output, root=root))
            self.assertEqual(b"pdfium", (output / "lib/libpdfium.so").read_bytes())
            self.assertEqual(
                digest,
                json.loads((output / ".ash-pdfium-receipt.json").read_text())["sha256"],
            )

    def test_existing_output_with_wrong_receipt_is_not_replaced(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            lock_path = root / "third_party/pdfium/runtime-lock.json"
            lock_path.parent.mkdir(parents=True)
            lock_path.write_text(
                json.dumps(
                    {
                        "version": "1.0",
                        "artifacts": {
                            "linux-x64": {
                                "archive": "pdfium.tgz",
                                "sha256": "a" * 64,
                                "library": "lib/libpdfium.so",
                            }
                        },
                    }
                )
            )
            output = root / "output"
            output.mkdir()
            with self.assertRaisesRegex(RuntimeError, "Refusing to replace"):
                fetch_pdfium("linux-x64", output, root=root)
