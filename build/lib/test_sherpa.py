import hashlib
import io
import re
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from build.lib.sherpa import ROOT, SpeechArchive, load_sherpa_lock, materialize
from build.lib.sherpa import resolve_sherpa_cargo_env
from build.lib.targets import TARGETS


class SherpaResourceTests(unittest.TestCase):
    def test_lock_matches_rust_dependency_and_supported_targets(self) -> None:
        version, archives = load_sherpa_lock()
        self.assertEqual(set(TARGETS), set(archives))
        lock = (ROOT / "Cargo.lock").read_text()
        for package in ("sherpa-onnx", "sherpa-onnx-sys"):
            versions = re.findall(
                rf'\[\[package\]\]\nname = "{package}"\nversion = "([^"]+)"', lock
            )
            self.assertEqual([version], versions)

    def test_reuses_extracted_libraries_and_repairs_corruption_without_downloading(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "speech.tar.bz2"
            with tarfile.open(source, "w:bz2") as archive:
                for name, content in (
                    ("libspeech.a", b"speech"),
                    ("libmodel.a", b"model"),
                ):
                    member = tarfile.TarInfo("speech/lib/" + name)
                    member.size = len(content)
                    archive.addfile(member, io.BytesIO(content))
                symlink = tarfile.TarInfo("speech/lib/ignored.a")
                symlink.type = tarfile.SYMTYPE
                symlink.linkname = "/outside"
                archive.addfile(symlink)
            locked = SpeechArchive(
                source.name,
                hashlib.sha256(source.read_bytes()).hexdigest(),
                source.stat().st_size,
                source.as_uri(),
            )
            names = {"libspeech.a", "libmodel.a"}
            libraries = materialize(locked, names, root / "cache")
            self.assertEqual(b"speech", (libraries / "libspeech.a").read_bytes())
            self.assertFalse((libraries / "ignored.a").exists())
            source.unlink()
            with patch("build.lib.sherpa.download_and_verify") as download:
                self.assertEqual(libraries, materialize(locked, names, root / "cache"))
                (libraries / "libspeech.a").write_bytes(b"corrupted")
                self.assertEqual(libraries, materialize(locked, names, root / "cache"))
                self.assertEqual(b"speech", (libraries / "libspeech.a").read_bytes())
                download.assert_not_called()

    def test_rejects_symlinks_in_required_library_members(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "speech.tar.bz2"
            with tarfile.open(source, "w:bz2") as archive:
                member = tarfile.TarInfo("speech/lib/libspeech.a")
                member.type = tarfile.SYMTYPE
                member.linkname = "/outside"
                archive.addfile(member)
            locked = SpeechArchive(
                source.name,
                hashlib.sha256(source.read_bytes()).hexdigest(),
                source.stat().st_size,
                source.as_uri(),
            )
            with self.assertRaisesRegex(RuntimeError, "Invalid Sherpa library member"):
                materialize(locked, {"libspeech.a"}, root / "cache")
            self.assertFalse((root / "cache/speech/files.json").exists())

    def test_explicit_library_directory_does_not_prepare_resources(self) -> None:
        with patch("build.lib.sherpa.load_sherpa_lock") as load:
            self.assertEqual(
                {},
                resolve_sherpa_cargo_env(
                    TARGETS["aarch64-apple-darwin"],
                    environ={"SHERPA_ONNX_LIB_DIR": "/custom/libs"},
                ),
            )
            load.assert_not_called()
