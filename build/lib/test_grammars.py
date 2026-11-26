"""Tests for the renderer assets derived from the locked grammar release."""

import gzip
import hashlib
import tempfile
import unittest
from pathlib import Path

from build.lib.grammars import _prepare_wasm_assets


class CompressedGrammarTests(unittest.TestCase):
    def test_backfills_cached_release_and_checks_decompressed_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            raw_path = directory / "wasm/fixture.wasm"
            raw_path.parent.mkdir()
            module = b"\0asm" + bytes(32)
            raw_path.write_bytes(module)
            modules = {
                "fixture": {
                    "path": "wasm/fixture.wasm",
                    "size": len(module),
                    "sha256": hashlib.sha256(module).hexdigest(),
                },
            }

            with self.assertRaisesRegex(RuntimeError, "Missing compressed grammars"):
                _prepare_wasm_assets(directory, modules, verify_only=True)
            self.assertFalse((directory / "renderer-wasm").exists())

            _prepare_wasm_assets(directory, modules, verify_only=False)
            resource = directory / "renderer-wasm/fixture.wasm.gz.bin"
            self.assertEqual(gzip.decompress(resource.read_bytes()), module)
            self.assertEqual(raw_path.read_bytes(), module)
            _prepare_wasm_assets(directory, modules, verify_only=True)

            resource.write_bytes(gzip.compress(bytes(len(module))))
            with self.assertRaisesRegex(
                RuntimeError, "Compressed grammar checksum mismatch"
            ):
                _prepare_wasm_assets(directory, modules, verify_only=True)
