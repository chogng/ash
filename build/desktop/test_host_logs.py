import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from build.desktop import host_logs


class HostLogPublicationTests(unittest.TestCase):
    def test_new_generation_does_not_overwrite_a_running_windows_executable(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / "ash-host-logs.exe"
            binary.write_bytes(b"first native build")
            with (
                patch.object(host_logs, "ROOT", root),
                patch.object(
                    host_logs,
                    "build_binaries",
                    return_value={
                        "ash-host-logs": binary,
                        "ash-host-integrity": binary,
                    },
                ),
            ):
                host_logs.main()
                previous = next(
                    (root / ".build/desktop/main/host-logs").glob("*/ash-host-logs.exe")
                )
                binding = root / ".build/desktop/hostLogs.ts"
                first_binding = binding.read_text()
                binary.write_bytes(b"second native build")
                host_logs.main()
                self.assertEqual(previous.read_bytes(), b"first native build")
                self.assertNotEqual(binding.read_text(), first_binding)
                self.assertEqual(
                    len(list(previous.parent.parent.glob("*/ash-host-logs.exe"))), 2
                )
                modified = binding.stat().st_mtime_ns
                host_logs.main()
                self.assertEqual(binding.stat().st_mtime_ns, modified)
