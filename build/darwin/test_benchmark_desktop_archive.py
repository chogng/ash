import plistlib
import shutil
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from build.darwin import benchmark_desktop_archive as archives


class DesktopArchiveBenchmarkTests(unittest.TestCase):
    def test_measures_the_same_bundle_and_alternates_restore_order(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "Ash.app"
            source.mkdir()
            (source / "payload").write_bytes(b"signed application content")
            (source / "Contents").mkdir()
            (source / "Contents" / "Info.plist").write_bytes(
                plistlib.dumps(
                    {"CFBundleIdentifier": "test.ash", "CFBundleVersion": "1"}
                )
            )
            output = root / "results"
            restores = []
            packed = {}

            def run(*args):
                if args[0] == "codesign":
                    self.assertEqual(
                        (args[-1] / "payload").read_bytes(),
                        b"signed application content",
                    )
                elif args[:2] == ("ditto", "-c"):
                    self.assertEqual(args[-2].parent.name, "payload")
                    packed[args[-1]] = args[-2]
                    args[-1].write_bytes(b"1234")
                elif args[:2] == ("hdiutil", "create"):
                    self.assertEqual(args[3].name, "payload")
                    self.assertEqual(args[5], "ULMO")
                    self.assertIn(args[3] / source.name, packed.values())
                    packed[args[-1]] = args[3] / source.name
                    args[-1].write_bytes(b"12")
                elif args[:2] == ("ditto", "-x"):
                    restores.append("zip")
                    shutil.copytree(packed[args[-2]], args[-1] / source.name)
                elif args[:2] == ("hdiutil", "attach"):
                    restores.append("dmg")
                    shutil.copytree(packed[args[-1]], args[-2] / source.name)
                elif args[0] == "ditto":
                    shutil.copytree(args[1], args[2])

            with patch.object(archives, "run", side_effect=run):
                report = archives.benchmark(source, output, runs=2)

            self.assertEqual(restores, ["zip", "dmg", "dmg", "zip"])
            self.assertEqual(report["bundleVersion"], "1")
            self.assertEqual(report["downloadBytesSaved"], 2)
            self.assertEqual(report["downloadPercentSaved"], 50)
            self.assertEqual(
                {path.name for path in output.iterdir()},
                {"Ash.zip", "Ash-lzma.dmg", "report.json"},
            )

    def test_dmg_detaches_after_a_copy_failure(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            install_path = root / "install"
            mount = install_path / "mounted-image"
            copy_failure = subprocess.CalledProcessError(1, "ditto")
            with patch.object(
                archives, "run", side_effect=[None, copy_failure, None]
            ) as run:
                with self.assertRaises(subprocess.CalledProcessError):
                    archives.install(root / "Ash.dmg", install_path, "Ash.app")
                run.assert_called_with("hdiutil", "detach", mount)
