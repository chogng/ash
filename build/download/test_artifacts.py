import hashlib
import http.client
import io
import ssl
import tempfile
import unittest
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from unittest.mock import patch

from build.download.artifacts import download_and_verify, extract_member


class ArtifactTests(unittest.TestCase):
    def test_interrupted_download_retries_with_a_fresh_file(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "runtime"
            body = b"verified-runtime"
            artifact = SimpleNamespace(
                url="https://example.invalid/runtime",
                size=len(body),
                sha256=hashlib.sha256(body).hexdigest(),
            )
            with (
                patch(
                    "build.download.artifacts.urlopen",
                    side_effect=[http.client.IncompleteRead(b"partial", 4), io.BytesIO(body)],
                ) as download,
                patch("build.download.artifacts.time.sleep") as sleep,
            ):
                download_and_verify(artifact, destination)
            self.assertEqual(destination.read_bytes(), body)
            self.assertEqual(download.call_count, 2)
            sleep.assert_called_once_with(1)
            self.assertEqual([destination], list(destination.parent.iterdir()))

    def test_tls_eof_retries_download(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "runtime"
            body = b"verified-runtime"
            artifact = SimpleNamespace(
                url="https://example.invalid/runtime",
                size=len(body),
                sha256=hashlib.sha256(body).hexdigest(),
            )
            with (
                patch(
                    "build.download.artifacts.urlopen",
                    side_effect=[ssl.SSLError(8, "UNEXPECTED_EOF_WHILE_READING"), io.BytesIO(body)],
                ) as download,
                patch("build.download.artifacts.time.sleep"),
            ):
                download_and_verify(artifact, destination)
            self.assertEqual(destination.read_bytes(), body)
            self.assertEqual(download.call_count, 2)

    def test_checksum_failure_is_not_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "runtime"
            artifact = SimpleNamespace(
                url="https://example.invalid/runtime", size=5, sha256="0" * 64
            )
            with patch(
                "build.download.artifacts.urlopen", return_value=io.BytesIO(b"wrong")
            ) as download:
                with self.assertRaisesRegex(RuntimeError, "SHA-256"):
                    download_and_verify(artifact, destination)
            self.assertEqual(download.call_count, 1)
            self.assertFalse(destination.exists())

    def test_failed_download_cannot_remove_another_downloads_result(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            destination = root / "runtime.zip"
            body = b"verified-runtime"
            artifact = SimpleNamespace(
                url="https://example.invalid/runtime",
                size=len(body),
                sha256=hashlib.sha256(body).hexdigest(),
            )
            entered, published = Event(), Event()

            def response(request, **kwargs):
                if request.full_url.endswith("/bad"):
                    entered.set()
                    if not published.wait(5):
                        raise TimeoutError("concurrent publication did not finish")
                    return io.BytesIO(b"wrong")
                return io.BytesIO(body)

            bad = SimpleNamespace(**vars(artifact))
            bad.url += "/bad"
            with (
                patch("build.download.artifacts.urlopen", side_effect=response),
                ThreadPoolExecutor() as pool,
            ):
                failure = pool.submit(download_and_verify, bad, destination)
                self.assertTrue(entered.wait(5))
                download_and_verify(artifact, destination)
                published.set()
                with self.assertRaisesRegex(RuntimeError, "SHA-256"):
                    failure.result(timeout=5)
            self.assertEqual(destination.read_bytes(), body)
            self.assertEqual([destination], list(root.iterdir()))

    def test_oversized_download_preserves_existing_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "runtime"
            destination.write_bytes(b"previous")
            artifact = SimpleNamespace(
                url="https://example.invalid/runtime", size=3, sha256="0" * 64
            )
            with patch(
                "build.download.artifacts.urlopen",
                return_value=io.BytesIO(b"too large"),
            ):
                with self.assertRaisesRegex(RuntimeError, "exceeds locked size"):
                    download_and_verify(artifact, destination)
            self.assertEqual(destination.read_bytes(), b"previous")
            self.assertEqual([destination], list(destination.parent.iterdir()))

    def test_parallel_extraction_keeps_only_complete_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "runtime.zip"
            body = b"runtime" * 10000
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("bin/runtime", body)
            destination = root / "runtime"
            with ThreadPoolExecutor() as pool:
                futures = [
                    pool.submit(
                        extract_member, archive, "zip", "bin/runtime", destination
                    )
                    for _ in range(8)
                ]
                for future in futures:
                    future.result(timeout=5)
            self.assertEqual(body, destination.read_bytes())
            self.assertEqual({archive, destination}, set(root.iterdir()))

    def test_special_zip_members_are_rejected_without_replacing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "runtime.zip"
            entry = zipfile.ZipInfo("runtime")
            entry.external_attr = 0o010644 << 16
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr(entry, b"fifo")
            destination = root / "runtime"
            destination.write_bytes(b"previous")
            with self.assertRaisesRegex(RuntimeError, "not a regular file"):
                extract_member(archive, "zip", "runtime", destination)
            self.assertEqual(b"previous", destination.read_bytes())
