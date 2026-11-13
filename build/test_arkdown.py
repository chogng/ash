"""The browser bindings must follow Rust inputs and recover from missing artifacts."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from build import arkdown


class ArkdownBuildTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for name in (
            "Cargo.toml",
            "Cargo.lock",
            "rust-toolchain.toml",
            "build/arkdown.py",
            "scripts/cargo.py",
            ".cargo/config.toml",
            "crates/arkdown/Cargo.toml",
            "crates/arkdown/src/lib.rs",
        ):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("input")
        (self.root / "Cargo.toml").write_text(
            '[workspace.dependencies]\nwasm-bindgen = "=0.2.126"\n'
        )
        self.output = self.root / ".build/arkdown/web"
        self.output.mkdir(parents=True)
        for name in arkdown._OUTPUTS:
            (self.output / name).write_text("generated")
        self.stamp = self.output.parent / "browser-inputs.json"
        self.stamp.write_text(
            json.dumps(
                {
                    "digest": arkdown.input_digest(self.root),
                    "outputs": arkdown.output_hashes(self.output),
                }
            )
        )

    def test_valid_cache_needs_no_rust_toolchain(self) -> None:
        with (
            patch("build.arkdown.subprocess.run") as run,
            patch("build.arkdown.subprocess.check_output") as version,
        ):
            self.assertEqual(self.output, arkdown.prepare(self.root))
        run.assert_not_called()
        version.assert_not_called()

    def test_missing_corrupt_or_stale_artifacts_require_regeneration(self) -> None:
        mutations = ("missing", "corrupt", "source", "lock", "wrapper", "config")
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                for name in arkdown._OUTPUTS:
                    (self.output / name).write_text("generated")
                self.stamp.write_text(
                    json.dumps(
                        {
                            "digest": arkdown.input_digest(self.root),
                            "outputs": arkdown.output_hashes(self.output),
                        }
                    )
                )
                if mutation == "missing":
                    (self.output / "ash_arkdown_bg.wasm").unlink()
                elif mutation == "corrupt":
                    (self.output / "ash_arkdown.js").write_text("corrupt")
                else:
                    name = {
                        "source": "crates/arkdown/src/lib.rs",
                        "lock": "Cargo.lock",
                        "wrapper": "scripts/cargo.py",
                        "config": ".cargo/config.toml",
                    }[mutation]
                    (self.root / name).write_text("changed")
                with patch(
                    "build.arkdown.subprocess.run",
                    side_effect=RuntimeError("regenerate"),
                ) as run:
                    with self.assertRaisesRegex(RuntimeError, "regenerate"):
                        arkdown.prepare(self.root)
                    self.assertIn("wasm-bindgen-cli", run.call_args.args[0])

    def test_failed_compilation_does_not_publish_a_success_stamp(self) -> None:
        self.stamp.unlink()
        with (
            patch(
                "build.arkdown.subprocess.run",
                side_effect=[None, None, RuntimeError("compile failed")],
            ),
            patch(
                "build.arkdown.subprocess.check_output",
                return_value="wasm-bindgen 0.2.126\n",
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "compile failed"):
                arkdown.prepare(self.root)
        self.assertFalse(self.stamp.exists())
