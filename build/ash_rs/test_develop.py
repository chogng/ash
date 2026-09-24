"""Backend development build and App Server publication contracts."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from build.ash_rs import develop


class DevelopTests(unittest.TestCase):
    def test_generation_reuses_content_and_keeps_one_distinct_rollback(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "ash-app-server"
            directory = root / "generations"
            source.write_text("one")
            first = develop.publish_generation(source, directory, is_windows=False)
            self.assertTrue(first[0])
            self.assertEqual(
                (False, first[1]),
                develop.publish_generation(source, directory, is_windows=False),
            )
            source.write_text("two")
            second = develop.publish_generation(source, directory, is_windows=False)
            os.utime(directory / first[1], ns=(1_000, 1_000))
            os.utime(directory / second[1], ns=(2_000, 2_000))
            source.write_text("three")
            third = develop.publish_generation(source, directory, is_windows=False)
            self.assertEqual(
                {second[1], third[1]},
                {path.name for path in directory.glob("ash-app-server.*")},
            )
            self.assertEqual(
                {"version": 1, "executable": third[1]},
                json.loads((directory / "current.json").read_text()),
            )

    def test_publication_removes_duplicate_legacy_generations(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "ash-app-server"
            directory = root / "generations"
            directory.mkdir()
            source.write_text("current")
            (directory / "ash-app-server.100.0").write_text("rollback")
            (directory / "ash-app-server.200.0").write_text("current")
            (directory / "ash-app-server.300.0").write_text("current")
            (directory / "current.json").write_text(
                json.dumps({"version": 1, "executable": "ash-app-server.300.0"})
            )
            result = develop.publish_generation(source, directory, is_windows=False)
            self.assertEqual(
                {"ash-app-server.100.0", result[1]},
                {path.name for path in directory.glob("ash-app-server.*")},
            )

    def test_development_build_publishes_backend_executables(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binaries = {}
            for name in (
                "ash-app-server",
                "ash-voice-host",
                "ash-collaboration-server",
            ):
                path = root / name
                path.write_text(name)
                binaries[name] = path
            media = root / "livekit-server"
            media.write_text("livekit")
            with (
                patch.object(
                    develop, "default_target", return_value="x86_64-pc-windows-msvc"
                ),
                patch.object(develop, "build_binaries", return_value=binaries) as build,
                patch.object(develop, "resolve_livekit", return_value=media),
            ):
                changed, generation = develop.build_development_server(root=root)
            self.assertTrue(changed)
            self.assertEqual(set(binaries), set(build.call_args.args[2]))
            self.assertEqual(True, build.call_args.kwargs["host_build"])
            directory = root / ".build/app-ts/dev/app-server"
            self.assertEqual(
                binaries["ash-app-server"].read_bytes(),
                (directory / generation).read_bytes(),
            )
            for name, source in (
                ("ash-voice-host.exe", binaries["ash-voice-host"]),
                ("ash-collaboration-server.exe", binaries["ash-collaboration-server"]),
                ("livekit-server.exe", media),
            ):
                self.assertEqual(source.read_bytes(), (directory / name).read_bytes())


if __name__ == "__main__":
    unittest.main()
