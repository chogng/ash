"""Keep first-party Cargo path dependencies resolvable by Bazel."""

import ast
from pathlib import Path
import tomllib
import unittest


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
LIBRARY_RULES = {
    "ash_rust_crate",
    "app_rust_library",
    "rust_library",
    "rust_proc_macro",
    "alias",
}


class BazelWorkspaceDependencyTests(unittest.TestCase):
    def test_cargo_path_dependencies_have_default_bazel_library_targets(self):
        workspace = tomllib.loads(
            (REPOSITORY_ROOT / "Cargo.toml").read_text(encoding="utf-8")
        )["workspace"]
        members = {
            (REPOSITORY_ROOT / member).resolve() for member in workspace["members"]
        }
        dependencies = set()
        for member in members:
            manifest = tomllib.loads(
                (member / "Cargo.toml").read_text(encoding="utf-8")
            )
            for section in [manifest, *manifest.get("target", {}).values()]:
                for kind in ("dependencies", "dev-dependencies", "build-dependencies"):
                    for name, spec in section.get(kind, {}).items():
                        if not isinstance(spec, dict):
                            continue
                        base = member
                        if spec.get("workspace"):
                            spec = workspace["dependencies"][name]
                            base = REPOSITORY_ROOT
                        if isinstance(spec, dict) and "path" in spec:
                            dependency = (base / spec["path"]).resolve()
                            if dependency in members:
                                dependencies.add(dependency)

        self.assertTrue(dependencies)
        for dependency in sorted(dependencies):
            with self.subTest(package=dependency.relative_to(REPOSITORY_ROOT)):
                build_file = dependency / "BUILD.bazel"
                self.assertTrue(build_file.is_file(), f"missing {build_file}")
                tree = ast.parse(build_file.read_text(encoding="utf-8"))
                targets = {
                    keyword.value.value
                    for node in ast.walk(tree)
                    if isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Name)
                    and node.func.id in LIBRARY_RULES
                    for keyword in node.keywords
                    if keyword.arg == "name" and isinstance(keyword.value, ast.Constant)
                }
                # rules_rs 0.0.96 cargo_workspace_graph.bzl emits //path for
                # local dependencies; Bazel expands that to //path:basename.
                self.assertIn(dependency.name, targets)


if __name__ == "__main__":
    unittest.main()
