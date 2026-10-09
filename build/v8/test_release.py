"""Exercise producer outputs, version gates and complete-release verification."""

import gzip
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from build.lib.v8 import load_v8_lock
from build.v8.release import (
    BUILD_TARGETS,
    ROOT,
    checksum_name,
    prepare_compiler,
    provenance_name,
    release_metadata,
    stage_pair,
    upstream_toolchain,
    verify_release,
)


class V8ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ash v8 release ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.version = release_metadata()["version"]
        for name in (
            "Cargo.toml",
            "Cargo.lock",
            "third_party/v8/runtime-lock.json",
            "third_party/v8/source-lock.json",
        ):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes((ROOT / name).read_bytes())
        self.upstream = self.root / "upstream"
        self.upstream.mkdir()
        (self.upstream / "Cargo.toml").write_text(
            f'[package]\nname = "v8"\nversion = "{self.version}"\n'
        )
        (self.upstream / "rust-toolchain.toml").write_text(
            '[toolchain]\nchannel = "1.91.0"\n'
        )
        for arguments in (
            ["init", "--quiet"],
            ["add", "."],
            [
                "-c",
                "user.name=V8 test",
                "-c",
                "user.email=v8@example.invalid",
                "commit",
                "--quiet",
                "-m",
                "Fixture source",
            ],
        ):
            subprocess.run(["git", "-C", str(self.upstream), *arguments], check=True)
        source_path = self.root / "third_party/v8/source-lock.json"
        source = json.loads(source_path.read_text())
        source["revision"] = subprocess.check_output(
            ["git", "-C", str(self.upstream), "rev-parse", "HEAD"], text=True
        ).strip()
        source_path.write_text(json.dumps(source))
        compiler = self.upstream / "third_party/llvm-build/Release+Asserts"
        compiler.mkdir(parents=True)
        for stamp in ("cr_build_revision",):
            (compiler / stamp).write_text(source["clangRevision"])
        self.dist = self.root / "dist"

    def write_source_output(self, target):
        source = json.loads((self.root / "third_party/v8/source-lock.json").read_text())
        platform = (
            "win32"
            if target.endswith("msvc")
            else "darwin"
            if target.endswith("darwin")
            else "linux"
        )
        (
            self.upstream
            / "third_party/llvm-build/Release+Asserts/ash_binding_compiler_version"
        ).write_text(source["bindingCompiler"][platform]["version"])
        gn_out = self.upstream / "target" / target / "release" / "gn_out"
        (gn_out / "obj").mkdir(parents=True)
        (gn_out / "args.gn").write_text(
            "v8_enable_sandbox = true\nv8_enable_pointer_compression = true\n"
            "v8_enable_external_code_space = true\nuse_custom_libcxx = true\nis_debug = false\n"
        )
        if target.endswith("-linux-gnu"):
            sdk = self.root / "sysroots" / target
            if target == "aarch64-unknown-linux-gnu":
                sdk = sdk / "debian_bullseye_arm64-sysroot"
            sdk.mkdir(parents=True, exist_ok=True)
            (sdk / ".ash-source-lock-sha256").write_text(
                source["gnuSysroots"][target]["sha256"]
            )
            with (gn_out / "args.gn").open("a") as args:
                if target == "aarch64-unknown-linux-gnu":
                    args.write(
                        f"target_sysroot_dir = {json.dumps(str(sdk.parent))}\nuse_sysroot = true\n"
                    )
                else:
                    args.write(
                        f"sysroot = {json.dumps(str(sdk))}\nuse_sysroot = true\n"
                    )
        library = "rusty_v8.lib" if target.endswith("msvc") else "librusty_v8.a"
        (gn_out / "obj" / library).write_bytes(b"archive for " + target.encode())
        (gn_out / "src_binding.rs").write_text("pub const V8_VALUE: u32 = 1;\n")
        return gn_out

    def stage_all(self):
        for target in BUILD_TARGETS:
            self.write_source_output(target)
            stage_pair(self.upstream, target, self.dist, self.root)

    def test_metadata_uses_exact_pins_and_rejects_wrong_release_tag(self):
        metadata = release_metadata(self.root, f"rusty-v8-v{self.version}")
        matrix = json.loads(metadata["matrix"])["include"]
        self.assertEqual(set(load_v8_lock()), {row["target"] for row in matrix})
        self.assertEqual(8, len(matrix))
        arm_gnu = next(
            row for row in matrix if row["target"] == "aarch64-unknown-linux-gnu"
        )
        self.assertEqual("ubuntu-24.04", arm_gnu["runner"])
        self.assertEqual("link", arm_gnu["smoke"])
        with self.assertRaisesRegex(ValueError, "does not match"):
            release_metadata(self.root, "v1.0.0")
        manifest = self.root / "Cargo.toml"
        manifest.write_text(
            manifest.read_text().replace(f'v8 = "={self.version}"', 'v8 = "=0.0.0"')
        )
        with self.assertRaisesRegex(ValueError, "must agree"):
            release_metadata(self.root)

    def test_upstream_version_must_match_and_toolchain_comes_from_checkout(self):
        self.assertEqual(
            "1.91.0", upstream_toolchain(self.upstream, self.version, self.root)
        )
        with self.assertRaisesRegex(ValueError, "does not match"):
            upstream_toolchain(self.upstream, "0.0.0", self.root)

    def test_source_revision_and_rust_toolchain_are_enforced(self):
        toolchain = self.upstream / "rust-toolchain.toml"
        toolchain.write_text('[toolchain]\nchannel = "stable"\n')
        with self.assertRaisesRegex(ValueError, "differs from source lock"):
            upstream_toolchain(self.upstream, self.version, self.root)
        toolchain.write_text('[toolchain]\nchannel = "1.91.0"\n')
        path = self.root / "third_party/v8/source-lock.json"
        pin = json.loads(path.read_text())
        pin["revision"] = "0" * 40
        path.write_text(json.dumps(pin))
        with self.assertRaisesRegex(ValueError, "differs from source lock"):
            upstream_toolchain(self.upstream, self.version, self.root)

    def test_stage_matches_consumer_names_and_produces_stable_compressed_bytes(self):
        for target, pair in load_v8_lock().items():
            with self.subTest(target=target):
                self.write_source_output(target)
                outputs = stage_pair(self.upstream, target, self.dist, self.root)
                archive = Path(outputs["archive"])
                self.assertEqual(pair.archive.name, archive.name)
                self.assertEqual(pair.binding.name, Path(outputs["binding"]).name)
                self.assertEqual(
                    b"archive for " + target.encode(),
                    gzip.decompress(archive.read_bytes()),
                )
                first = archive.read_bytes()
                stage_pair(self.upstream, target, self.dist, self.root)
                self.assertEqual(first, archive.read_bytes())
                self.assertEqual(
                    2, len((self.dist / checksum_name(target)).read_text().splitlines())
                )

    def test_stage_rejects_incorrect_features_and_missing_or_empty_outputs(self):
        target = "x86_64-pc-windows-msvc"
        gn_out = self.write_source_output(target)
        args = gn_out / "args.gn"
        original = args.read_text()
        for feature in (
            "v8_enable_sandbox",
            "v8_enable_pointer_compression",
            "v8_enable_external_code_space",
            "use_custom_libcxx",
        ):
            args.write_text(original.replace(f"{feature} = true", f"{feature} = false"))
            with self.assertRaisesRegex(ValueError, feature):
                stage_pair(self.upstream, target, self.dist, self.root)
        args.write_text(original)
        binding = gn_out / "src_binding.rs"
        binding.write_bytes(b"")
        with self.assertRaisesRegex(ValueError, "Missing or empty"):
            stage_pair(self.upstream, target, self.dist, self.root)
        binding.unlink()
        with self.assertRaisesRegex(ValueError, "Missing or empty"):
            stage_pair(self.upstream, target, self.dist, self.root)
        self.assertFalse(self.dist.exists())

    def test_verify_produces_complete_candidate_without_changing_consumer_lock(self):
        lock = self.root / "third_party/v8/runtime-lock.json"
        before = lock.read_bytes()
        self.stage_all()
        candidate = verify_release(self.dist, "chogng/ash", self.root)
        pairs = load_v8_lock(candidate)
        self.assertEqual(set(BUILD_TARGETS), set(pairs))
        for pair in pairs.values():
            self.assertTrue(
                pair.archive.url.startswith("https://github.com/chogng/ash/releases/")
            )
        self.assertEqual(33, len(list(self.dist.iterdir())))
        self.assertEqual(before, lock.read_bytes())

    def test_verify_rejects_missing_extra_and_corrupt_assets(self):
        self.stage_all()
        target = next(iter(BUILD_TARGETS))
        path = self.dist / load_v8_lock()[target].binding.name
        original = path.read_bytes()
        path.unlink()
        with self.assertRaisesRegex(ValueError, "exactly one"):
            verify_release(self.dist, "chogng/ash", self.root)
        path.write_bytes(original)
        extra = self.dist / "extra.txt"
        extra.write_text("unexpected")
        with self.assertRaisesRegex(ValueError, "exactly one"):
            verify_release(self.dist, "chogng/ash", self.root)
        extra.unlink()
        path.write_text("corrupt binding")
        with self.assertRaisesRegex(ValueError, "Invalid release checksum"):
            verify_release(self.dist, "chogng/ash", self.root)
        path.write_bytes(original)
        checksum = self.dist / checksum_name(target)
        checksum.write_text(checksum.read_text() + "0" * 64 + "  extra.txt\n")
        with self.assertRaisesRegex(ValueError, "Invalid release checksum"):
            verify_release(self.dist, "chogng/ash", self.root)
        self.assertFalse((self.dist / "runtime-lock.json").exists())

    def test_verify_rejects_wrong_source_provenance(self):
        self.stage_all()
        target = next(iter(BUILD_TARGETS))
        path = self.dist / provenance_name(target)
        provenance = json.loads(path.read_text())
        provenance["source"]["revision"] = "0" * 40
        path.write_text(json.dumps(provenance))
        with self.assertRaisesRegex(ValueError, "Invalid source provenance"):
            verify_release(self.dist, "chogng/ash", self.root)

    def test_stage_rejects_a_different_binding_compiler(self):
        target = "x86_64-unknown-linux-gnu"
        self.write_source_output(target)
        stamp = (
            self.upstream
            / "third_party/llvm-build/Release+Asserts/ash_binding_compiler_version"
        )
        stamp.write_text("23.0.0")
        with self.assertRaisesRegex(ValueError, "pinned binding compiler"):
            stage_pair(self.upstream, target, self.dist, self.root)
        self.assertFalse(self.dist.exists())

    def test_compiler_bootstraps_a_clean_relative_checkout(self):
        source = json.loads((self.root / "third_party/v8/source-lock.json").read_text())
        stamp = (
            self.upstream / "third_party/llvm-build/Release+Asserts/cr_build_revision"
        )
        stamp.unlink()
        update = self.upstream / "tools/clang/scripts/update.py"
        update.parent.mkdir(parents=True)
        update.write_text(
            "from pathlib import Path\nimport sys\n"
            f"PACKAGE_VERSION = {source['clangRevision']!r}\n"
            "if __name__ == '__main__':\n"
            "    stamp = Path(__file__).resolve().parents[3] / 'third_party/llvm-build/Release+Asserts/cr_build_revision'\n"
            "    if '--print-revision' in sys.argv:\n"
            "        if not stamp.exists(): sys.exit(1)\n"
            "        print(stamp.read_text())\n"
            "    else:\n"
            "        stamp.write_text(PACKAGE_VERSION)\n"
        )
        binding_compiler = self.root / "binding compiler"
        library = binding_compiler / "lib" / "libclang.so"
        library.parent.mkdir(parents=True)
        library.write_bytes(b"fixture library")
        expected = source["bindingCompiler"][sys.platform]["version"]
        check_output = subprocess.check_output

        def query(command, **kwargs):
            if Path(command[0]).name in {"clang", "clang.exe"}:
                return (
                    f"clang version {expected}\n"
                    if "--version" in command
                    else str(binding_compiler / "lib/clang/19") + "\n"
                )
            return check_output(command, **kwargs)

        previous = Path.cwd()
        try:
            os.chdir(self.root)
            with patch("build.v8.release.subprocess.check_output", side_effect=query):
                values = prepare_compiler(Path("upstream"), binding_compiler, self.root)
        finally:
            os.chdir(previous)
        self.assertEqual(source["clangRevision"], stamp.read_text())
        self.assertEqual(str(stamp.parent.resolve()), values["clang_base_path"])
        self.assertEqual(str(library.parent.resolve()), values["libclang_path"])

    def test_stage_rejects_an_unpinned_gnu_sysroot(self):
        target = "x86_64-unknown-linux-gnu"
        gn_out = self.write_source_output(target)
        stamp = self.root / "sysroots" / target / ".ash-source-lock-sha256"
        stamp.write_text("0" * 64)
        with self.assertRaisesRegex(ValueError, "sysroot differs from source lock"):
            stage_pair(self.upstream, target, self.dist, self.root)
        args = gn_out / "args.gn"
        args.write_text(
            args.read_text().replace("use_sysroot = true", "use_sysroot = false")
        )
        with self.assertRaisesRegex(ValueError, "must use its pinned sysroot"):
            stage_pair(self.upstream, target, self.dist, self.root)
        self.assertFalse(self.dist.exists())

    def test_metadata_cli_writes_real_github_outputs(self):
        output = self.root / "github-output"
        result = subprocess.run(
            [
                sys.executable,
                "-B",
                str(ROOT / "build/v8/release.py"),
                "metadata",
                "--github-output",
                str(output),
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
        )
        values = json.loads(result.stdout)
        self.assertEqual(release_metadata(), values)
        self.assertIn(f"release_tag={values['release_tag']}\n", output.read_text())
        self.assertIn(f"matrix={values['matrix']}\n", output.read_text())


if __name__ == "__main__":
    unittest.main()
