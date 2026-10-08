"""Guard first-party workspace package registration in Bazel."""

import ast
from pathlib import Path
import tomllib
import unittest


ROOT = Path(__file__).resolve().parents[1]


class BazelRegistrationTests(unittest.TestCase):
    def test_first_party_workspace_packages_have_build_files(self) -> None:
        workspace = tomllib.loads((ROOT / "Cargo.toml").read_text())["workspace"]
        packages = {
            path
            for member in workspace["members"]
            for path in ROOT.glob(member)
            if (path / "Cargo.toml").is_file()
            and not {"vendor", "third_party"}.intersection(path.relative_to(ROOT).parts)
        }
        self.assertTrue(packages, "Cargo must declare first-party workspace packages")
        missing = sorted(
            path.relative_to(ROOT).as_posix()
            for path in packages
            if not (path / "BUILD.bazel").is_file() and not (path / "BUILD").is_file()
        )
        self.assertEqual(missing, [], "Workspace packages need their own Bazel BUILD")

    def test_assets_registers_its_cargo_library_with_the_shared_macro(self) -> None:
        directory = ROOT / "crates/assets"
        build = directory / "BUILD.bazel"
        self.assertTrue(build.is_file(), "The assets dependency needs a Bazel package")
        manifest = tomllib.loads((directory / "Cargo.toml").read_text())
        crate_name = manifest.get("lib", {}).get(
            "name", manifest["package"]["name"].replace("-", "_")
        )
        # These BUILD declarations use the Python-compatible call syntax subset.
        # This checks registration structure; Bazel query validates Starlark loading.
        declarations = ast.parse(build.read_text(), filename=str(build))
        calls = [
            node
            for node in ast.walk(declarations)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "ash_rust_crate"
        ]
        self.assertEqual(len(calls), 1)
        arguments = {keyword.arg: keyword.value for keyword in calls[0].keywords}
        self.assertEqual(ast.literal_eval(arguments["name"]), "assets")
        self.assertEqual(ast.literal_eval(arguments["crate_name"]), crate_name)


if __name__ == "__main__":
    unittest.main()
