import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from build.lib.targets import CpuArchitecture  # noqa: E402
from build.lib.targets import LinuxLibc  # noqa: E402
from build.lib.targets import OperatingSystem  # noqa: E402
from build.lib.targets import TARGETS  # noqa: E402
from build.lib.targets import TargetSpec  # noqa: E402
from build.lib.targets import WindowsAbi  # noqa: E402
from build.lib.targets import default_target  # noqa: E402
from build.lib.targets import target_spec  # noqa: E402


class TargetSpecTests(unittest.TestCase):
    def test_default_target_uses_host_operating_system_and_architecture(self) -> None:
        for system, machine, expected in [
            ("Windows", "AMD64", "x86_64-pc-windows-msvc"),
            ("Windows", "ARM64", "aarch64-pc-windows-msvc"),
            ("Linux", "x86_64", "x86_64-unknown-linux-gnu"),
            ("Darwin", "arm64", "aarch64-apple-darwin"),
        ]:
            with (
                self.subTest(system=system, machine=machine),
                patch("build.lib.targets.platform.system", return_value=system),
                patch("build.lib.targets.platform.machine", return_value=machine),
            ):
                self.assertEqual(default_target(), expected)

    def test_catalog_covers_supported_operating_system_architecture_pairs(self) -> None:
        self.assertEqual(
            {
                "aarch64-apple-darwin",
                "aarch64-pc-windows-msvc",
                "aarch64-unknown-linux-gnu",
                "aarch64-unknown-linux-musl",
                "x86_64-apple-darwin",
                "x86_64-pc-windows-msvc",
                "x86_64-unknown-linux-gnu",
                "x86_64-unknown-linux-musl",
            },
            set(TARGETS),
        )

    def test_target_properties_come_from_explicit_dimensions(self) -> None:
        windows = target_spec("aarch64-pc-windows-msvc")
        linux = target_spec("x86_64-unknown-linux-musl")
        macos = target_spec("x86_64-apple-darwin")

        self.assertEqual(
            (
                OperatingSystem.WINDOWS,
                CpuArchitecture.ARM64,
                WindowsAbi.MSVC,
                "app.exe",
            ),
            (
                windows.operating_system,
                windows.architecture,
                windows.windows_abi,
                windows.app_name,
            ),
        )
        self.assertEqual(LinuxLibc.MUSL, linux.linux_libc)
        self.assertEqual(OperatingSystem.MACOS, macos.operating_system)

    def test_rejects_platform_specific_fields_on_the_wrong_operating_system(
        self,
    ) -> None:
        with self.assertRaisesRegex(ValueError, "Linux targets"):
            TargetSpec(OperatingSystem.LINUX, CpuArchitecture.X86_64)
        with self.assertRaisesRegex(ValueError, "Windows targets"):
            TargetSpec(
                OperatingSystem.MACOS,
                CpuArchitecture.X86_64,
                windows_abi=WindowsAbi.MSVC,
            )

    def test_rejects_unknown_target(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "Unsupported Ash target"):
            target_spec("riscv64-unknown-linux-gnu")


if __name__ == "__main__":
    unittest.main()
