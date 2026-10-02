"""Exercise the MODULE patch stack with the pinned Bazel patch implementation.

Run explicitly with a cached archive and Bazel installation; ordinary Python
unit tests do not require Bazel, a JDK, or network access. See README.md.
"""

import argparse
import ast
import base64
import hashlib
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]

# Call the implementation used by repository_ctx.patch, not the host's patch
# executable: GNU patch accepts multi-file input that Bazel does not separate.
PATCH_DRIVER = """\
import com.google.devtools.build.lib.bazel.repository.decompressor.PatchUtil;
import com.google.devtools.build.lib.vfs.DigestHashFunction;
import com.google.devtools.build.lib.vfs.JavaIoFileSystem;
class ApplyPatches {
    public static void main(String[] args) throws Exception {
        var fs = new JavaIoFileSystem(DigestHashFunction.SHA256);
        for (int i = 2; i < args.length; i++) {
            System.out.println("Applying " + args[i]);
            PatchUtil.apply(fs.getPath(args[i]), Integer.parseInt(args[1]), fs.getPath(args[0]));
        }
    }
}
"""


def rules_rs_override():
    for statement in ast.parse((ROOT / "MODULE.bazel").read_text()).body:
        if (
            isinstance(statement, ast.Expr)
            and isinstance(call := statement.value, ast.Call)
            and isinstance(call.func, ast.Name)
            and call.func.id == "archive_override"
        ):
            attributes = {key.arg: ast.literal_eval(key.value) for key in call.keywords}
            if attributes["module_name"] == "rules_rs":
                return attributes
    raise AssertionError("MODULE.bazel: missing rules_rs archive_override")


class PatchStackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.override = rules_rs_override()
        integrity = (
            "sha256-"
            + base64.b64encode(
                hashlib.sha256(cls.archive.read_bytes()).digest()
            ).decode()
        )
        if integrity != cls.override["integrity"]:
            raise AssertionError(
                f"{cls.archive}: archive does not match MODULE.bazel integrity"
            )
        version = (ROOT / ".bazelversion").read_text().strip()
        if (cls.bazel_install / "build-label.txt").read_text().strip() != version:
            raise AssertionError(
                f"{cls.bazel_install}: expected pinned Bazel {version}"
            )

    def setUp(self):
        self.temporary = self.enterContext(
            tempfile.TemporaryDirectory(prefix="ash-patch-test-")
        )
        self.directory = Path(self.temporary)
        with tarfile.open(self.archive) as archive:
            archive.extractall(self.directory, filter="data")
        self.source = self.directory / self.override["strip_prefix"]
        self.driver = self.directory / "ApplyPatches.java"
        self.driver.write_text(PATCH_DRIVER)
        self.patches = []
        for label in self.override["patches"]:
            original = ROOT / label.removeprefix("//").replace(":", "/")
            patch = self.directory / original.name
            patch.write_bytes(original.read_bytes())
            self.patches.append(patch)

    def apply(self, patches=None):
        return subprocess.run(
            [
                self.java,
                # Bazel uses this same JVM option for its internal path encoding.
                "--add-opens=java.base/java.lang=ALL-UNNAMED",
                "-cp",
                str(self.bazel_install / "A-server.jar"),
                str(self.driver),
                str(self.source),
                str(self.override["patch_strip"]),
                *map(str, self.patches if patches is None else patches),
            ],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )

    def test_module_patch_stack_applies_in_declared_order(self):
        result = self.apply()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_missing_file_boundaries_reproduce_bazel_failure(self):
        patch = next(
            p
            for p in self.patches
            if p.name == "per_crate_rustc_flags_annotation.patch"
        )
        patch.write_text(
            "".join(
                line
                for line in patch.read_text().splitlines(keepends=True)
                if not line.startswith("diff --git ")
            )
        )
        result = self.apply()
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("rs/rust_crate.bzl", result.stderr)
        self.assertIn("CONTENT_DOES_NOT_MATCH_TARGET", result.stderr)

    def test_changed_context_is_rejected_without_fuzz(self):
        source = self.source / "rs/rust_crate.bzl"
        original = source.read_text()
        self.assertIn("        rustc_env = {},\n", original)
        source.write_text(
            original.replace(
                "        rustc_env = {},\n", "        rustc_env = dict(),\n", 1
            )
        )
        result = self.apply()
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("rs/rust_crate.bzl", result.stderr)
        self.assertIn("CONTENT_DOES_NOT_MATCH_TARGET", result.stderr)

    def test_patch_order_is_observable(self):
        source = self.source / "order.txt"
        source.write_text("before\n")
        patches = []
        for index, (before, after) in enumerate(
            (("before", "between"), ("between", "after"))
        ):
            patch = self.directory / f"order-{index}.patch"
            patch.write_text(
                f"diff --git a/order.txt b/order.txt\n--- a/order.txt\n+++ b/order.txt\n@@ -1 +1 @@\n-{before}\n+{after}\n"
            )
            patches.append(patch)
        result = self.apply(patches)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(source.read_text(), "after\n")
        source.write_text("before\n")
        result = self.apply(list(reversed(patches)))
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("order.txt", result.stderr)
        self.assertIn("CONTENT_DOES_NOT_MATCH_TARGET", result.stderr)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--archive",
        type=Path,
        required=True,
        help="cached rules_rs archive pinned by MODULE.bazel",
    )
    parser.add_argument(
        "--bazel-install",
        type=Path,
        required=True,
        help="install_base from the pinned Bazel",
    )
    parser.add_argument(
        "--java",
        default="java",
        help="JDK 21+ java executable (source-file launch needs jdk.compiler)",
    )
    arguments = parser.parse_args()
    PatchStackTests.archive = arguments.archive.resolve()
    PatchStackTests.bazel_install = arguments.bazel_install.resolve()
    PatchStackTests.java = arguments.java
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(PatchStackTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(0 if result.wasSuccessful() else 1)
