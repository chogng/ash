import ast
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT))

from build.lib.targets import TARGETS  # noqa: E402
from build.lib.v8 import (  # noqa: E402
    DEFAULT_LOCK,
    LockedFile,
    load_v8_lock,
    materialize,
)
from build.lib.v8 import resolve_v8_cargo_env  # noqa: E402


class V8ArtifactTests(unittest.TestCase):
    def test_bazel_output_directory_patch_survives_moved_function_lines(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "build.rs"
            source.write_text(
                "// Upstream additions move the function away from its original line.\n"
                "fn static_lib_dir() -> PathBuf {\n"
                '  build_dir().join("gn_out").join("obj")\n'
                "}\n\n"
                "fn build_dir() -> PathBuf {\n"
                "  let cwd = env::current_dir().unwrap();\n\n"
                "  cwd\n}\n",
                newline="\n",
            )
            subprocess.run(
                [
                    "git",
                    "apply",
                    str(REPOSITORY_ROOT / "bazel/toolchains/v8_bazel_build_dir.patch"),
                ],
                cwd=root,
                check=True,
            )
            patched = source.read_text()
            library_directory = patched.split("fn static_lib_dir() -> PathBuf {")[1]
            library_directory, build_directory = library_directory.split(
                "fn build_dir() -> PathBuf {"
            )
            self.assertIn('env::var_os("RUSTY_V8_ARCHIVE")', library_directory)
            self.assertIn('env::var_os("OUT_DIR")', library_directory)
            self.assertNotIn("RUSTY_V8_ARCHIVE", build_directory)

    def test_lock_covers_every_release_target_and_build_system_pin(self) -> None:
        pairs = load_v8_lock()
        self.assertEqual(set(TARGETS), set(pairs))

        cargo_lock = (REPOSITORY_ROOT / "Cargo.lock").read_text()
        versions = set(
            re.findall(r'\[\[package\]\]\nname = "v8"\nversion = "([^"]+)"', cargo_lock)
        )
        self.assertEqual({next(iter(pairs.values())).version}, versions)

        module = (REPOSITORY_ROOT / "MODULE.bazel").read_text()
        target_build = (
            REPOSITORY_ROOT / "third_party" / "v8" / "BUILD.bazel"
        ).read_text()
        for target, pair in pairs.items():
            for artifact in (pair.archive, pair.binding):
                self.assertIn(artifact.name, module)
                self.assertIn(artifact.sha256, module)
            repository_fragment = target.replace("-", "_")
            self.assertIn(repository_fragment, target_build)
        annotations = [
            node
            for node in ast.walk(ast.parse(module))
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "annotation"
        ]
        v8_annotation = next(
            node
            for node in annotations
            if any(
                keyword.arg == "crate" and ast.literal_eval(keyword.value) == "v8"
                for keyword in node.keywords
            )
        )
        features = ast.literal_eval(
            next(
                keyword.value
                for keyword in v8_annotation.keywords
                if keyword.arg == "crate_features_select"
            )
        )
        self.assertEqual(set(pairs), set(features))
        for target in features:
            self.assertEqual(["v8_enable_sandbox"], features[target], target)

        cargo_config = (REPOSITORY_ROOT / ".cargo" / "config.toml").read_text()
        self.assertIn(
            'RUSTY_V8_MIRROR = { value = "third_party/.cache/v8", relative = true }',
            cargo_config,
        )

    def test_materialize_replaces_a_corrupt_cached_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.gz"
            source.write_bytes(b"verified-v8")
            digest = hashlib.sha256(source.read_bytes()).hexdigest()
            artifact = LockedFile("archive.gz", digest, source.as_uri())
            cache = root / "cache"
            cached = cache / artifact.name
            cache.mkdir()
            cached.write_bytes(b"corrupt")

            resolved = materialize(artifact, cache)

            self.assertEqual(b"verified-v8", resolved.read_bytes())

    def test_explicit_sources_are_resolved_by_upstream(self) -> None:
        spec = TARGETS["aarch64-apple-darwin"]
        for environment in (
            {"V8_FROM_SOURCE": "true"},
            {"RUSTY_V8_ARCHIVE": "/artifact-directory"},
            {"RUSTY_V8_SRC_BINDING_PATH": "/binding"},
            {"RUSTY_V8_SRC_BINDING_URL": "https://example.invalid/binding.rs"},
            {"RUSTY_V8_MIRROR": "/mirror"},
            {"RUSTY_V8_MIRROR_TAG": "custom-tag"},
            {
                "RUSTY_V8_ARCHIVE": "/archive",
                "RUSTY_V8_SRC_BINDING_URL": "/binding",
            },
            {
                "RUSTY_V8_SRC_BINDING_PATH": "/binding",
                "RUSTY_V8_SRC_BINDING_URL": "/ignored-binding",
                "RUSTY_V8_SKIP_DOWNLOAD": "1",
            },
        ):
            with (
                self.subTest(environment=environment),
                patch("build.lib.v8.load_v8_lock", side_effect=AssertionError),
            ):
                self.assertEqual({}, resolve_v8_cargo_env(spec, environ=environment))

    def test_environment_uses_the_cargo_mirror_layout(self) -> None:
        spec = TARGETS["aarch64-apple-darwin"]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            lock_path = root / "runtime-lock.json"
            cache = root / "cache"
            document = json.loads(DEFAULT_LOCK.read_text())
            entry = document["artifacts"][spec.target]
            mirror = cache / f"v{document['version']}"
            mirror.mkdir(parents=True)
            for kind, contents in (("archive", b"archive"), ("binding", b"binding")):
                artifact = entry[kind]
                artifact["sha256"] = hashlib.sha256(contents).hexdigest()
                (mirror / artifact["name"]).write_bytes(contents)
            lock_path.write_text(json.dumps(document))

            for overrides in (
                {},
                {"V8_FROM_SOURCE": "TRUE", "RUSTY_V8_SKIP_DOWNLOAD": "TRUE"},
            ):
                environment = resolve_v8_cargo_env(
                    spec,
                    environ=overrides,
                    lock_path=lock_path,
                    cache_root=cache,
                )
                self.assertIn("RUSTY_V8_ARCHIVE", environment)

            self.assertEqual(
                {
                    "RUSTY_V8_ARCHIVE": str(
                        (mirror / entry["archive"]["name"]).resolve()
                    ),
                    "RUSTY_V8_ARCHIVE_SHA256": entry["archive"]["sha256"],
                    "RUSTY_V8_SRC_BINDING_PATH": str(
                        (mirror / entry["binding"]["name"]).resolve()
                    ),
                },
                environment,
            )

    def test_lock_rejects_a_target_gap(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "runtime-lock.json"
            document = json.loads(DEFAULT_LOCK.read_text())
            del document["artifacts"]["aarch64-apple-darwin"]
            path.write_text(json.dumps(document))
            with self.assertRaisesRegex(RuntimeError, "target set is incomplete"):
                load_v8_lock(path)

    def test_check_mode_only_needs_the_verified_binding(self) -> None:
        spec = TARGETS["aarch64-apple-darwin"]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            lock_path = root / "runtime-lock.json"
            document = json.loads(DEFAULT_LOCK.read_text())
            entry = document["artifacts"][spec.target]
            mirror = root / "cache" / f"v{document['version']}"
            mirror.mkdir(parents=True)
            binding = mirror / entry["binding"]["name"]
            binding.write_bytes(b"verified binding")
            entry["binding"]["sha256"] = hashlib.sha256(
                binding.read_bytes()
            ).hexdigest()
            # Any attempt to fetch the archive fails. Check mode must work
            # with only the small binding available.
            document["source"]["repository"] = "https://missing.invalid/v8"
            lock_path.write_text(json.dumps(document))
            for value in ("1", "true", "yes"):
                with self.subTest(value=value):
                    environment = resolve_v8_cargo_env(
                        spec,
                        environ={"RUSTY_V8_SKIP_DOWNLOAD": value},
                        lock_path=lock_path,
                        cache_root=root / "cache",
                    )
                    self.assertEqual(
                        {"RUSTY_V8_SRC_BINDING_PATH": str(binding.resolve())},
                        environment,
                    )
                    self.assertFalse((mirror / entry["archive"]["name"]).exists())

            binding.write_bytes(b"corrupt binding")
            with (
                patch(
                    "build.lib.v8.download_and_verify",
                    side_effect=RuntimeError("Binding must be downloaded again"),
                ) as download,
                self.assertRaisesRegex(RuntimeError, "downloaded again"),
            ):
                resolve_v8_cargo_env(
                    spec,
                    environ={"RUSTY_V8_SKIP_DOWNLOAD": "1"},
                    lock_path=lock_path,
                    cache_root=root / "cache",
                )
            self.assertEqual(entry["binding"]["name"], download.call_args.args[0].name)


if __name__ == "__main__":
    unittest.main()
