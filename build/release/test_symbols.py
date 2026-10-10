"""Release-stage regression tests use real optimized executables, not mock debug files."""

from __future__ import annotations

import io
import json
import os
import re
import shutil
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from build.code.package import build_code_package
from build.lib.package import validate_package_directory
from build.lib.package_test_support import create_runtime_package
from build.lib.targets import default_target, target_spec
from build.release.identity import Reader, codeview, identity
from build.release.symbolicate import (
    apple_report,
    classic_report,
    load_report,
    symbolicate,
)
from build.release.symbols import (
    ROOT,
    SymbolStore,
    capture_cargo_build,
    digest,
    extract_archive,
)
from build.release.tools import run, tool


class ReleaseSymbolsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.root = Path(cls.temporary.name).resolve()
        cls.target = default_target()
        cls.spec = target_spec(cls.target)
        cls.binary = cls.root / ("fixture.exe" if cls.spec.is_windows else "fixture")
        cls.source = ROOT / "build/release/fixtures/crash.rs"
        command = [
            "rustc",
            str(cls.source),
            "--edition=2024",
            "-C",
            "debuginfo=line-tables-only",
            "-C",
            "opt-level=3",
            "-C",
            "split-debuginfo=" + ("packed" if "darwin" in cls.target else "off"),
            "-o",
            str(cls.binary),
        ]
        run(command)
        cls.original_hash = digest(cls.binary)
        if cls.spec.is_windows:
            output = run([str(cls.binary)])
            pc, base = [
                int(value, 16)
                for value in re.search(
                    r"PC=([a-f0-9]+) BASE=([a-f0-9]+)", output
                ).groups()
            ]
            cls.address = pc - base + 4
        else:
            # Resolve the fixture before stripping. ASLR is introduced in the
            # crash report, independently of the link address used by nm.
            nm = "nm" if sys.platform == "darwin" else tool("llvm-nm")
            output = run([nm, "-n", str(cls.binary)])
            match = re.search(
                r"^([a-fA-F0-9]+)\s+T\s+_?ash_symbol_fixture$", output, re.MULTILINE
            )
            if not match:
                raise AssertionError("Fixture function missing from compiler output")
            cls.address = int(match[1], 16) + 4

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir=self.root)
        self.addCleanup(temporary.cleanup)
        self.work = Path(temporary.name)
        self.environment = patch.dict(
            os.environ,
            {
                "ASH_BUILD_ID": "fixture-" + self.work.name,
                "ASH_BUILD_COMMIT": "a" * 40,
                "ASH_SYMBOLS_DIR": "",
            },
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.store = SymbolStore(self.work / "symbols")
        self.staged = self.work / self.binary.name
        shutil.copy2(self.binary, self.staged)

    def collect(self):
        return self.store.collect(self.binary, self.staged, self.target)

    def test_stripped_release_resolves_source_and_rejects_other_build(self):
        module = self.collect()
        self.assertEqual(digest(self.binary), self.original_hash)
        self.assertEqual(identity(self.staged)["id"], module["id"])
        self.assertIn("VALUE=42", run([str(self.staged)]))
        manifest = self.store.manifest()
        manifest["generatedSources"] = []
        if module["format"] == "pe":
            # Windows symbolizer needs a final PE alongside its PDB.
            manifest["packages"] = [
                {
                    "modules": [
                        {
                            "module": module["key"],
                            "path": self.staged.name,
                            "sha256": digest(self.staged),
                        }
                    ]
                }
            ]
        base = 0x7000000000
        address = self.address
        pc = (
            base + address - (module["imageBase"] if module["format"] == "macho" else 0)
        )
        loaded = {**module, "base": base, "size": 0x10000000, "loadBias": base}
        report = {
            "schemaVersion": 1,
            "modules": [loaded],
            "frames": [{"module": 0, "pc": pc}],
        }
        result = symbolicate(report, self.store.root, manifest, self.work)
        self.assertTrue(result["complete"], result)
        symbols = result["frames"][0]["symbols"]
        self.assertTrue(
            any("inline_site" in item["FunctionName"] for item in symbols), symbols
        )
        self.assertTrue(
            any("ash_symbol_fixture" in item["FunctionName"] for item in symbols),
            symbols,
        )
        self.assertTrue(
            any(
                "crash.rs" in item["FileName"] and item["Line"] > 0 for item in symbols
            ),
            symbols,
        )
        self.assertTrue(
            any(item["source"].get("commit") == "a" * 40 for item in symbols), symbols
        )
        report["modules"][0]["id"] = "0" * 32
        bad = symbolicate(report, self.store.root, manifest, self.work)
        self.assertFalse(bad["complete"])
        self.assertIn("No matching module", bad["frames"][0]["unresolved"])

    def test_rejects_stripping_original_and_wrong_target(self):
        with self.assertRaisesRegex(ValueError, "separate staging"):
            self.store.collect(self.binary, self.binary, self.target)
        other = (
            "x86_64" if self.target.startswith("aarch64") else "aarch64"
        ) + self.target[self.target.index("-") :]
        with self.assertRaisesRegex(ValueError, "architecture"):
            self.store.collect(self.binary, self.staged, other)

    def test_same_module_id_with_different_bytes_and_reused_build_id_are_rejected(self):
        self.collect()
        changed = self.work / "changed"
        shutil.copy2(self.binary, changed)
        with changed.open("ab") as stream:
            stream.write(b"different build bytes")
        copy = self.work / "changed-copy"
        shutil.copy2(changed, copy)
        with self.assertRaisesRegex(ValueError, "collision"):
            self.store.collect(changed, copy, self.target)
        with patch.dict(os.environ, {"ASH_BUILD_ID": "another-build-same-version"}):
            with self.assertRaisesRegex(ValueError, "another compilation"):
                self.store.manifest(self.target)
        with patch.dict(os.environ, {"ASH_BUILD_COMMIT": "b" * 40}):
            with self.assertRaisesRegex(ValueError, "source commit"):
                self.store.manifest(self.target)

    def test_cargo_provenance_records_reported_features_and_effective_profile(self):
        cargo = self.work / "cargo-fixture.py"
        artifact = {
            "reason": "compiler-artifact",
            "executable": str(self.binary),
            "features": ["fixture-feature"],
            "profile": {"opt_level": "3", "debuginfo": 1},
        }
        cargo.write_text("print(" + repr(json.dumps(artifact)) + ")\n")
        environment = os.environ.copy()
        environment["ASH_SYMBOLS_DIR"] = str(self.store.root)
        environment["CARGO_PROFILE_RELEASE_SPLIT_DEBUGINFO"] = (
            "packed" if self.spec.operating_system.value == "darwin" else "off"
        )
        status = capture_cargo_build(
            [sys.executable, str(cargo)], ROOT, environment, self.target
        )
        self.assertEqual(status, 0)
        module = self.collect()
        self.assertEqual(module["compilation"]["features"], ["fixture-feature"])
        self.assertEqual(module["compilation"]["profile"], artifact["profile"])
        self.assertEqual(module["compilerSha256"], self.original_hash)

    @unittest.skipUnless(sys.platform == "darwin", "Cargo dSYM aliases require macOS")
    def test_cargo_dsym_alias_is_copied_as_regular_archive_files(self):
        original = self.work / "cargo-output"
        shutil.copy2(self.binary, original)
        deps = self.work / "deps"
        deps.mkdir()
        shutil.copytree(Path(str(self.binary) + ".dSYM"), deps / "fixture-hash.dSYM")
        Path(str(original) + ".dSYM").symlink_to(deps / "fixture-hash.dSYM")
        module = self.store.collect(original, self.staged, self.target)
        self.assertEqual(module["id"], identity(original)["id"])
        self.assertFalse(any(path.is_symlink() for path in self.store.root.rglob("*")))

    @unittest.skipUnless(
        sys.platform == "darwin", "Controlled Mach-O core capture requires macOS LLDB"
    )
    def test_real_abort_core_resolves_first_party_frames_and_keeps_external_frames(
        self,
    ):
        module = self.collect()
        manifest = self.store.manifest()
        manifest["packages"] = [
            {
                "modules": [
                    {
                        "path": self.staged.name,
                        "module": module["key"],
                        "sha256": digest(self.staged),
                    }
                ]
            }
        ]
        core = self.work / "crash.core"
        run(
            [
                tool("lldb"),
                "--no-lldbinit",
                "--batch",
                str(self.staged),
                "-o",
                "settings set target.disable-aslr false",
                "-o",
                "run --abort",
                "-k",
                f"process save-core -s stack {core}",
            ]
        )
        self.assertTrue(core.is_file())
        report = load_report(core, self.work, self.staged, manifest)
        result = symbolicate(report, self.store.root, manifest, self.work)
        symbols = [
            symbol for frame in result["frames"] for symbol in frame.get("symbols", [])
        ]
        self.assertTrue(
            any(
                "crash_site" in symbol["FunctionName"] and symbol["Line"] > 0
                for symbol in symbols
            ),
            result,
        )
        self.assertTrue(any("unresolved" in frame for frame in result["frames"]))
        self.assertFalse(result["complete"])

    def test_package_hashes_are_computed_after_stripping_and_archive_is_verified(self):
        module = self.collect()
        # Reassemble through the real package path with actual compiler outputs
        # for every first-party role and preserve the existing external fixtures.
        runtime = create_runtime_package(
            self.work,
            self.target,
            first_party_binary=self.binary,
            symbols_dir=self.store.root,
        )
        metadata = json.loads((runtime / "ash-package.json").read_text())
        self.assertEqual(
            metadata["components"]["appServer"]["binarySha256"],
            digest(runtime / "bin" / self.spec.server_name),
        )
        code = self.work / "code"
        build_code_package(runtime, code, self.binary, "b" * 64, self.store.root)
        validate_package_directory(code, self.spec)
        self.store.bind("ash-code", code)
        self.store.bind("ash-app-server", runtime)
        product_archive = self.work / "product.tar.gz"
        product_archive.write_bytes(b"final package archive")
        archive = self.store.archive(
            self.work / "archives",
            {"ash-code": product_archive, "ash-app-server": product_archive},
        )
        extracted = self.work / "extracted"
        extracted.mkdir()
        manifest = extract_archive(archive, extracted, digest(archive))
        self.assertEqual(manifest["modules"][0]["id"], module["id"])
        self.assertEqual(
            manifest["packages"][0]["archive"]["sha256"], digest(product_archive)
        )
        self.assertFalse(
            list(code.rglob("*.pdb"))
            or list(code.rglob("*.dSYM"))
            or list(code.rglob("*.debug"))
        )
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            extract_archive(archive, self.work / "bad", "0" * 64)
        with self.assertRaisesRegex(ValueError, "replace symbol archive"):
            self.store.archive(
                self.work / "archives",
                {"ash-code": product_archive, "ash-app-server": product_archive},
            )
        altered = extracted / manifest["modules"][0]["symbolPath"]
        altered.write_bytes(b"corrupt")
        from build.release.symbols import validate_store

        with self.assertRaisesRegex(ValueError, "hashes"):
            validate_store(extracted)

    def test_archive_rejects_traversal_and_symlinks(self):
        for name, kind in (("../escape", tarfile.REGTYPE), ("link", tarfile.SYMTYPE)):
            archive = self.work / "bad.tar.gz"
            with tarfile.open(archive, "w:gz") as stream:
                member = tarfile.TarInfo(name)
                member.type = kind
                member.linkname = "/tmp/escape"
                stream.addfile(member, io.BytesIO(b""))
            with self.assertRaisesRegex(ValueError, "Unsafe"):
                extract_archive(archive, self.work / "output", digest(archive))

    def test_imports_apple_aslr_reports_without_using_function_names(self):
        module = identity(self.binary)
        text = (
            json.dumps({"incident_id": "fixture"})
            + "\n"
            + json.dumps(
                {
                    "usedImages": [
                        {
                            "arch": "arm64",
                            "uuid": module["id"],
                            "base": 4096,
                            "size": 1024,
                            "name": "fixture",
                        }
                    ],
                    "threads": [{"frames": [{"imageIndex": 0, "imageOffset": 7}]}],
                }
            )
        )
        self.assertEqual(apple_report(text)["frames"][0]["pc"], 4103)
        classic = "Thread 0 Crashed:\n0 fixture 0x1007 ignored + 7\nBinary Images:\n0x1000 - 0x13ff fixture arm64 <12345678-1234-1234-1234-123456789012> /fixture\n"
        self.assertEqual(classic_report(classic)["frames"][0]["pc"], 4103)

    def test_truncated_headers_and_renamed_pdb_references(self):
        with self.assertRaisesRegex(ValueError, "Truncated"):
            Reader(b"short").unpack("<Q", 0)
        rsds = (
            b"RSDS"
            + bytes(range(16))
            + (3).to_bytes(4, "little")
            + b"C:\\builder\\renamed_symbols.pdb\0"
        )
        self.assertEqual(codeview(rsds)["pdbName"], "renamed_symbols.pdb")
        self.assertTrue(codeview(rsds)["id"].endswith("-3"))


if __name__ == "__main__":
    unittest.main()
