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
from unittest.mock import call, patch
from urllib.error import HTTPError, URLError

from build.download.artifacts import download_and_verify, extract_member


class ArtifactTests(unittest.TestCase):
    def test_transient_http_errors_retry_verified_downloads(self):
        for status in (408, 429, 500, 502, 503, 504):
            with (
                self.subTest(status=status),
                tempfile.TemporaryDirectory() as directory,
            ):
                destination = Path(directory) / "runtime"
                destination.write_bytes(b"previous")
                body = b"verified-runtime"
                artifact = SimpleNamespace(
                    url="https://example.invalid/runtime",
                    size=None,
                    sha256=hashlib.sha256(body).hexdigest(),
                )
                error_body = io.BytesIO(b"temporary server failure")
                error = HTTPError(artifact.url, status, "temporary", {}, error_body)

                def backoff(delay):
                    self.assertEqual(delay, 1)
                    self.assertTrue(error_body.closed)
                    self.assertEqual(destination.read_bytes(), b"previous")
                    self.assertEqual([destination], list(destination.parent.iterdir()))

                with (
                    patch(
                        "build.download.artifacts.urlopen",
                        side_effect=[error, io.BytesIO(body)],
                    ) as download,
                    patch(
                        "build.download.artifacts.time.sleep", side_effect=backoff
                    ) as sleep,
                ):
                    download_and_verify(
                        artifact, destination, max_bytes=len(body), timeout=17
                    )
                self.assertEqual(destination.read_bytes(), body)
                self.assertEqual(download.call_count, 2)
                self.assertTrue(
                    all(
                        attempt.kwargs == {"timeout": 17}
                        for attempt in download.call_args_list
                    )
                )
                sleep.assert_called_once_with(1)
                self.assertEqual([destination], list(destination.parent.iterdir()))

    def test_transient_http_errors_exhaust_the_retry_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "runtime"
            destination.write_bytes(b"previous")
            artifact = SimpleNamespace(
                url="https://example.invalid/runtime", size=5, sha256="0" * 64
            )
            errors = [
                HTTPError(artifact.url, 500, "temporary", {}, io.BytesIO(b"failure"))
                for _ in range(3)
            ]
            with (
                patch(
                    "build.download.artifacts.urlopen", side_effect=errors
                ) as download,
                patch("build.download.artifacts.time.sleep") as sleep,
            ):
                with self.assertRaisesRegex(
                    RuntimeError, "failed after 3 attempts"
                ) as caught:
                    download_and_verify(artifact, destination)
            self.assertIs(caught.exception.__cause__, errors[-1])
            self.assertEqual(download.call_count, 3)
            self.assertEqual(sleep.call_args_list, [call(1), call(2)])
            self.assertTrue(all(error.closed for error in errors))
            self.assertEqual(destination.read_bytes(), b"previous")
            self.assertEqual([destination], list(destination.parent.iterdir()))

    def test_permanent_http_errors_are_not_retried(self):
        for status in (400, 401, 403, 404, 501, 505):
            with (
                self.subTest(status=status),
                tempfile.TemporaryDirectory() as directory,
            ):
                destination = Path(directory) / "runtime"
                destination.write_bytes(b"previous")
                artifact = SimpleNamespace(
                    url="https://example.invalid/runtime", size=5, sha256="0" * 64
                )
                error = HTTPError(artifact.url, status, "permanent", {}, io.BytesIO())
                with (
                    patch(
                        "build.download.artifacts.urlopen", side_effect=error
                    ) as download,
                    patch("build.download.artifacts.time.sleep") as sleep,
                ):
                    with self.assertRaises(HTTPError) as caught:
                        download_and_verify(artifact, destination)
                self.assertIs(caught.exception, error)
                download.assert_called_once()
                sleep.assert_not_called()
                self.assertTrue(error.closed)
                self.assertEqual(destination.read_bytes(), b"previous")
                self.assertEqual([destination], list(destination.parent.iterdir()))

    def test_interrupted_download_retries_with_a_fresh_file(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "runtime"
            body = b"verified-runtime"
            artifact = SimpleNamespace(
                url="https://example.invalid/runtime",
                size=len(body),
                sha256=hashlib.sha256(body).hexdigest(),
            )
            interrupted = io.BytesIO()
            with (
                patch.object(
                    interrupted,
                    "read",
                    side_effect=[b"partial", http.client.IncompleteRead(b"", 4)],
                ),
                patch(
                    "build.download.artifacts.urlopen",
                    side_effect=[interrupted, io.BytesIO(body)],
                ) as download,
                patch("build.download.artifacts.time.sleep") as sleep,
            ):
                download_and_verify(artifact, destination)
            self.assertEqual(destination.read_bytes(), body)
            self.assertEqual(download.call_count, 2)
            sleep.assert_called_once_with(1)
            self.assertTrue(interrupted.closed)
            self.assertEqual([destination], list(destination.parent.iterdir()))

    def test_transport_errors_retry_downloads(self):
        for error in (
            ConnectionResetError("connection reset"),
            TimeoutError("read timed out"),
            URLError(ConnectionResetError("connection reset")),
            URLError(TimeoutError("read timed out")),
        ):
            with self.subTest(error=error), tempfile.TemporaryDirectory() as directory:
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
                        side_effect=[error, io.BytesIO(body)],
                    ) as download,
                    patch("build.download.artifacts.time.sleep") as sleep,
                ):
                    download_and_verify(artifact, destination)
                self.assertEqual(destination.read_bytes(), body)
                self.assertEqual(download.call_count, 2)
                sleep.assert_called_once_with(1)
                self.assertEqual([destination], list(destination.parent.iterdir()))

    def test_certificate_errors_and_cancellation_are_not_retried(self):
        for error in (
            ssl.SSLCertVerificationError("certificate verify failed"),
            URLError(ssl.SSLCertVerificationError("certificate verify failed")),
            KeyboardInterrupt(),
        ):
            with self.subTest(error=error), tempfile.TemporaryDirectory() as directory:
                destination = Path(directory) / "runtime"
                destination.write_bytes(b"previous")
                artifact = SimpleNamespace(
                    url="https://example.invalid/runtime", size=5, sha256="0" * 64
                )
                with (
                    patch(
                        "build.download.artifacts.urlopen", side_effect=error
                    ) as download,
                    patch("build.download.artifacts.time.sleep") as sleep,
                ):
                    with self.assertRaises(type(error)) as caught:
                        download_and_verify(artifact, destination)
                self.assertIs(caught.exception, error)
                download.assert_called_once()
                sleep.assert_not_called()
                self.assertEqual(destination.read_bytes(), b"previous")
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
                    side_effect=[
                        ssl.SSLError(8, "UNEXPECTED_EOF_WHILE_READING"),
                        io.BytesIO(body),
                    ],
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
            with (
                patch(
                    "build.download.artifacts.urlopen",
                    return_value=io.BytesIO(b"wrong"),
                ) as download,
                patch("build.download.artifacts.time.sleep") as sleep,
            ):
                with self.assertRaisesRegex(RuntimeError, "SHA-256"):
                    download_and_verify(artifact, destination)
            self.assertEqual(download.call_count, 1)
            sleep.assert_not_called()
            self.assertFalse(destination.exists())
            self.assertEqual([], list(destination.parent.iterdir()))

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
