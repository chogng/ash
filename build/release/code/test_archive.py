from __future__ import annotations

import hashlib
import json
import os
import platform
import stat
import subprocess
import tarfile
import tempfile
import unittest
import zipfile
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator
from unittest.mock import patch


from build.release.code import archive as archive_builder


@contextmanager
def posix_executable(path: Path) -> Iterator[None]:
    # Windows chmod cannot supply POSIX execute bits for an archive fixture.
    original_stat = os.stat
    original_lstat = os.lstat

    def metadata(function, candidate, *args, **kwargs):
        result = function(candidate, *args, **kwargs)
        if candidate == path or candidate == str(path):
            mode = stat.S_IFMT(result.st_mode) | 0o755
            return os.stat_result((mode, *result[1:]))
        return result

    with (
        patch.object(
            os,
            "stat",
            side_effect=lambda *args, **kwargs: metadata(
                original_stat, *args, **kwargs
            ),
        ),
        patch.object(
            os,
            "lstat",
            side_effect=lambda *args, **kwargs: metadata(
                original_lstat, *args, **kwargs
            ),
        ),
    ):
        yield


class AshCodeArchiveTests(unittest.TestCase):
    def test_archive_is_rootless_deterministic_and_has_a_named_checksum(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = root / "package"
            executable = package / "bin/ash"
            executable.parent.mkdir(parents=True)
            executable.write_bytes(b"ash")
            (package / "ash-package.json").write_text(
                json.dumps(
                    {
                        "layoutVersion": 2,
                        "target": "aarch64-unknown-linux-gnu",
                        "components": {"cli": {}},
                    }
                ),
                encoding="utf-8",
            )
            first = root / "first/ash-code-aarch64-unknown-linux-gnu.tar.gz"
            second = root / "second/ash-code-aarch64-unknown-linux-gnu.tar.gz"

            with (
                posix_executable(executable),
                patch.object(archive_builder, "validate_package_directory"),
            ):
                checksum = archive_builder.create_archive(package, first)
                for path in package.rglob("*"):
                    os.utime(path, (86400, 86400))
                archive_builder.create_archive(package, second)

            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual(
                checksum.read_text(encoding="ascii"),
                f"{archive_builder.sha256(first)}  {first.name}\n",
            )
            with tarfile.open(first, "r:gz") as archive:
                self.assertEqual(
                    archive.getnames(),
                    ["ash-package.json", "bin", "bin/ash"],
                )
                self.assertEqual(archive.extractfile("bin/ash").read(), b"ash")
                self.assertEqual(archive.getmember("bin/ash").mode, 0o755)
                self.assertEqual(archive.getmember("ash-package.json").mode, 0o644)
                for member in archive.getmembers():
                    self.assertEqual((member.uid, member.gid, member.mtime), (0, 0, 0))
                    self.assertEqual((member.uname, member.gname), ("", ""))

    def test_macos_archive_is_a_deterministic_rootless_zip(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = root / "package"
            executable = package / "bin/ash"
            executable.parent.mkdir(parents=True)
            executable.write_bytes(b"ash")
            (package / "ash-package.json").write_text(
                json.dumps(
                    {
                        "layoutVersion": 2,
                        "target": "aarch64-apple-darwin",
                        "components": {"cli": {}},
                    }
                ),
                encoding="utf-8",
            )
            first = root / "first/ash-code-aarch64-apple-darwin.zip"
            second = root / "second/ash-code-aarch64-apple-darwin.zip"

            with (
                posix_executable(executable),
                patch.object(archive_builder, "validate_package_directory"),
                patch.object(archive_builder, "require_verified_system_signing"),
            ):
                archive_builder.create_archive(package, first)
                archive_builder.create_archive(package, second)

            self.assertEqual(first.read_bytes(), second.read_bytes())
            with zipfile.ZipFile(first) as archive:
                self.assertEqual(
                    archive.namelist(), ["ash-package.json", "bin/", "bin/ash"]
                )
                self.assertEqual(
                    archive.getinfo("bin/ash").external_attr >> 16, 0o100755
                )
                self.assertEqual(
                    archive.getinfo("ash-package.json").external_attr >> 16, 0o100644
                )

    def test_archive_requires_cli_package_identity_and_new_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = root / "package"
            package.mkdir()
            (package / "ash-package.json").write_text(
                json.dumps(
                    {
                        "layoutVersion": 2,
                        "target": "aarch64-apple-darwin",
                        "components": {},
                    }
                ),
                encoding="utf-8",
            )
            output = root / "ash-code-aarch64-apple-darwin.zip"
            with self.assertRaisesRegex(RuntimeError, "identity is invalid"):
                archive_builder.create_archive(package, output)

    def test_macos_archive_refuses_an_unsigned_package(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = root / "package"
            package.mkdir()
            (package / "ash-package.json").write_text(
                json.dumps(
                    {
                        "layoutVersion": 2,
                        "target": "aarch64-apple-darwin",
                        "components": {"cli": {}},
                    }
                ),
                encoding="utf-8",
            )
            output = root / "ash-code-aarch64-apple-darwin.zip"
            with patch.object(archive_builder, "validate_package_directory"):
                with self.assertRaisesRegex(RuntimeError, "system signing"):
                    archive_builder.create_archive(package, output)

    @unittest.skipIf(os.name == "nt", "the POSIX installer is tested on POSIX hosts")
    def test_posix_installer_publishes_a_version_and_stable_launcher(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = root / "fixture"
            executable = fixture / "bin/ash"
            executable.parent.mkdir(parents=True)
            executable.write_text(
                "#!/bin/sh\nprintf 'ash 1.2.3\\n'\n", encoding="utf-8"
            )
            executable.chmod(0o755)
            target = {
                ("Darwin", "arm64"): "aarch64-apple-darwin",
                ("Darwin", "x86_64"): "x86_64-apple-darwin",
                ("Linux", "aarch64"): "aarch64-unknown-linux-gnu",
                ("Linux", "x86_64"): "x86_64-unknown-linux-gnu",
            }[(platform.system(), platform.machine())]
            if platform.system() == "Darwin":
                archive = root / "package.zip"
                with zipfile.ZipFile(archive, "w") as output:
                    output.write(fixture / "bin", arcname="bin/")
                    output.write(executable, arcname="bin/ash")
                release_name = f"ash-code-{target}.zip"
            else:
                archive = root / "package.tar.gz"
                with tarfile.open(archive, "w:gz") as output:
                    output.add(fixture / "bin", arcname="bin")
                release_name = f"ash-code-{target}.tar.gz"
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            checksum = root / "package.sha256"
            checksum.write_text(f"{digest}  {release_name}\n", encoding="ascii")
            tools = root / "tools"
            tools.mkdir()
            curl = tools / "curl"
            curl.write_text(
                "#!/bin/sh\n"
                'while [ "$#" -gt 0 ]; do\n'
                '  if [ "$1" = -o ]; then shift; output=$1; fi\n'
                "  shift\n"
                "done\n"
                'case "$output" in\n'
                '  *.sha256) cp "$ASH_TEST_CHECKSUM" "$output" ;;\n'
                '  *) cp "$ASH_TEST_ARCHIVE" "$output" ;;\n'
                "esac\n",
                encoding="utf-8",
            )
            curl.chmod(0o755)
            install_root = root / "install"
            launcher_root = root / "launchers"
            environment = {
                **os.environ,
                "PATH": f"{tools}:/usr/bin:/bin",
                "ASH_INSTALL_ROOT": str(install_root),
                "ASH_BIN_DIR": str(launcher_root),
                "ASH_TEST_ARCHIVE": str(archive),
                "ASH_TEST_CHECKSUM": str(checksum),
            }

            result = subprocess.run(
                ["sh", "scripts/ash-code/install.sh"],
                cwd=archive_builder.REPOSITORY_ROOT,
                env=environment,
                check=True,
                capture_output=True,
                text=True,
            )

            self.assertIn("Installed Ash Code 1.2.3", result.stdout)
            selected = (install_root / "current").readlink()
            self.assertEqual(selected.parts[0], "versions")
            self.assertTrue((install_root / selected / "bin/ash").is_file())
            self.assertEqual(
                (launcher_root / "ash").readlink(),
                install_root / "current/bin/ash",
            )


if __name__ == "__main__":
    unittest.main()
