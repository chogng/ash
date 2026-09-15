import hashlib
import io
import json
import os
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT))

from build.lib.ash_build.targets import TARGETS
from build.package.build import generate_protocol_metadata
from build.package.build import main as build_main
from build.package.bubblewrap import load_vendored_source, resolve_bubblewrap
from build.package.layout import (
    build_package_directory,
    copy_builtin_extensions,
    copy_builtin_skills,
    file_sha256,
    load_protocol_metadata,
    validate_product_services,
    record_system_signing,
    require_verified_system_signing,
    system_signing_artifacts,
)
from build.package.node import (
    NodeResolution,
    artifact_for_target,
    load_node_lock,
    resolve_node,
)
from build.package.ripgrep import load_lock, resolve_ripgrep
from build.package.version import read_workspace_version


PRODUCTION_LOCK = REPOSITORY_ROOT / "third_party" / "ripgrep" / "runtime-lock.json"
PRODUCTION_NODE_LOCK = REPOSITORY_ROOT / "third_party" / "node" / "runtime-lock.json"
PRODUCTION_BUBBLEWRAP_SOURCE = REPOSITORY_ROOT / "ash-rs" / "vendor" / "bubblewrap"


class PackageTests(unittest.TestCase):
    def test_reads_only_the_workspace_package_version(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            manifest = Path(temporary) / "Cargo.toml"
            manifest.write_text(
                "[package]\nversion = '9.9.9'\n"
                "[workspace.package]\nversion = '1.2.3' # release version\n",
                encoding="utf-8",
            )
            self.assertEqual(read_workspace_version(manifest), "1.2.3")

    def test_rejects_missing_or_invalid_workspace_versions(self) -> None:
        manifests = (
            "[workspace.package]\nlicense = 'MIT'\n[package]\nversion = '9.9.9'\n",
            "[package]\nversion = '9.9.9'\n",
            "workspace = 'invalid'\n",
            "[workspace.package]\nversion = 123\n",
            "[workspace.package]\nversion = ''\n",
        )
        with tempfile.TemporaryDirectory() as temporary:
            manifest = Path(temporary) / "Cargo.toml"
            for source in manifests:
                with self.subTest(source=source):
                    manifest.write_text(source, encoding="utf-8")
                    with self.assertRaisesRegex(RuntimeError, "workspace.package"):
                        read_workspace_version(manifest)

    def test_build_command_stages_all_cargo_reported_binaries(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            names = (
                "ash-app-server",
                "ash-app-server-daemon",
                "ash-code-mode-host",
                "ash-remote",
                "ash-remote-server",
                "ash-exec-server",
            )
            artifacts = [
                json.dumps(
                    {
                        "reason": "compiler-artifact",
                        "target": {"kind": ["bin"], "name": name},
                        "executable": str(executable_file(root / name, name.encode())),
                    }
                )
                for name in names
            ]
            rg = executable_file(root / "rg", b"ripgrep")
            output = root / "package"
            with (
                patch(
                    "build.package.build.generate_protocol_metadata",
                    return_value=load_protocol_metadata(REPOSITORY_ROOT),
                ),
                patch("build.package.cargo.cargo_environment", return_value={}),
                patch(
                    "build.package.cargo.subprocess.run",
                    return_value=subprocess.CompletedProcess(
                        ["cargo"], 0, "\n".join(artifacts)
                    ),
                ) as run,
            ):
                self.assertEqual(
                    0,
                    build_main(
                        [
                            "--target",
                            "aarch64-apple-darwin",
                            "--package-dir",
                            str(output),
                            "--rg-bin",
                            str(rg),
                            "--javascript-runtime",
                            "host-provided-node",
                        ]
                    ),
                )
            run.assert_called_once()
            command = run.call_args.args[0]
            self.assertEqual(
                set(names),
                {command[i + 1] for i, value in enumerate(command) if value == "--bin"},
            )
            for name in names:
                self.assertEqual(name.encode(), (output / "bin" / name).read_bytes())

    def test_product_services_requires_every_sources_regular_trust_root(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            official = {"name": "ash", "trustedRoot": "marketplace-root.json"}
            vendor = {"name": "vendor", "trustedRoot": "vendor/root.json"}
            (root / "marketplace-root.json").write_text("official root")
            (root / "vendor").mkdir()
            (root / "vendor/root.json").write_text("vendor root")
            config = root / "product-services.json"
            config.write_text(
                json.dumps({"schemaVersion": 2, "marketplaces": [official, vendor]})
            )
            validate_product_services(root)
            (root / "vendor/root.json").unlink()
            with self.assertRaises(FileNotFoundError):
                validate_product_services(root)
            (root / "empty.json").write_text("")
            for source in [
                official,
                {"name": "vendor\n", "trustedRoot": "marketplace-root.json"},
                {"name": "vendor", "trustedRoot": "../root.json"},
                {"name": "vendor", "trustedRoot": "/root.json"},
                {"name": "vendor", "trustedRoot": "C:\\root.json"},
                {"name": "vendor", "trustedRoot": "empty.json"},
            ]:
                with self.subTest(source=source):
                    config.write_text(
                        json.dumps(
                            {"schemaVersion": 2, "marketplaces": [official, source]}
                        )
                    )
                    with self.assertRaises(RuntimeError):
                        validate_product_services(root)

    @unittest.skipIf(os.name == "nt", "symbolic links require Windows privileges")
    def test_product_services_rejects_a_symbolic_trust_root_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            root = parent / "product"
            root.mkdir()
            (root / "marketplace-root.json").write_text("official root")
            (parent / "root.json").write_text("outside root")
            (root / "linked").symlink_to(parent, target_is_directory=True)
            (root / "product-services.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": 2,
                        "marketplaces": [
                            {"name": "ash", "trustedRoot": "marketplace-root.json"},
                            {"name": "vendor", "trustedRoot": "linked/root.json"},
                        ],
                    }
                )
            )
            with self.assertRaises(RuntimeError):
                validate_product_services(root)

    BUILT_IN_EXTENSIONS = [
        "css",
        "html",
        "javascript",
        "json",
        "markdown-basics",
        "python",
        "rust",
        "shellscript",
        "sql",
        "theme-defaults",
        "typescript-basics",
        "xml",
        "yaml",
    ]

    def test_product_protocol_metadata_comes_from_generator_output(self) -> None:
        generated_fixture = (
            "export const APP_SERVER_PROTOCOL_MAJOR = 7 as const;\n"
            "export const APP_SERVER_PROTOCOL_REVISION = 11 as const;\n"
            'export const APP_SERVER_SCHEMA_HASH = "sha256:'
            + "a" * 64
            + '" as const;\n'
        )
        commands = []

        def run(command, *, cwd, check):
            commands.append((command, cwd, check))
            output_directory = Path(command[command.index("--out") + 1])
            output_directory.mkdir(parents=True, exist_ok=True)
            (output_directory / "protocol.ts").write_text(
                generated_fixture,
                encoding="utf-8",
            )

        with patch("build.package.build.subprocess.run", side_effect=run):
            metadata = generate_protocol_metadata(REPOSITORY_ROOT, "cargo")

        self.assertEqual(
            {
                "major": 7,
                "revision": 11,
                "schemaHash": "sha256:" + "a" * 64,
            },
            metadata,
        )
        self.assertEqual(1, len(commands))
        command, cwd, check = commands[0]
        self.assertEqual(REPOSITORY_ROOT, cwd)
        self.assertTrue(check)
        self.assertEqual("ash-app-server-protocol", command[command.index("-p") + 1])
        self.assertEqual("typescript", command[command.index("--") + 1])
        self.assertNotEqual(metadata, load_protocol_metadata(REPOSITORY_ROOT))

    def test_production_lock_covers_every_package_target(self) -> None:
        lock = load_lock(PRODUCTION_LOCK)

        self.assertEqual(set(TARGETS), set(lock["packageTargets"]))
        for artifact_key in lock["packageTargets"].values():
            artifact = lock["artifacts"][artifact_key]
            self.assertEqual(64, len(artifact["sha256"]))
            self.assertIn(artifact["format"], ("tar.gz", "zip"))

        node_lock = load_node_lock(PRODUCTION_NODE_LOCK)
        self.assertEqual(
            set(TARGETS),
            set(node_lock["packageTargets"]) | set(node_lock["licenseTargets"]),
        )
        for artifact in node_lock["artifacts"].values():
            self.assertEqual(64, len(artifact["sha256"]))
            self.assertIn(artifact["format"], ("tar.xz", "zip"))

        bubblewrap_source = load_vendored_source(PRODUCTION_BUBBLEWRAP_SOURCE)
        self.assertEqual("0.11.2", bubblewrap_source.version)
        self.assertEqual(64, len(bubblewrap_source.archive_sha256))

    def test_node_lock_requires_an_explicit_musl_binary(self) -> None:
        lock = load_node_lock(PRODUCTION_NODE_LOCK)

        with self.assertRaisesRegex(RuntimeError, "pass --node-bin"):
            artifact_for_target(lock, "x86_64-unknown-linux-musl")
        license_artifact = artifact_for_target(
            lock,
            "x86_64-unknown-linux-musl",
            license_only=True,
        )
        self.assertEqual("linux-x64", license_artifact.key)

    def test_local_overrides_build_canonical_package(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            server_binary = executable_file(root / "ash-source", b"ash-app-server")
            daemon_binary = executable_file(
                root / "daemon-source", b"ash-app-server-daemon"
            )
            code_mode_host_binary = executable_file(
                root / "code-mode-host-source", b"ash-code-mode-host"
            )
            cli_binary = executable_file(root / "cli-source", b"ash-cli")
            rg_binary = executable_file(root / "rg-source", b"ripgrep")
            output = root / "package"
            spec = TARGETS["aarch64-apple-darwin"]
            ripgrep = resolve_ripgrep(
                spec,
                PRODUCTION_LOCK,
                root / "cache",
                explicit_binary=rg_binary,
            )
            node = test_node_resolution(root, spec)

            build_package_directory(
                output,
                REPOSITORY_ROOT,
                read_workspace_version(REPOSITORY_ROOT / "Cargo.toml"),
                spec,
                server_binary,
                executable_file(root / "remote-source", b"remote"),
                executable_file(root / "remote-server-source", b"remote-server"),
                executable_file(root / "exec-server-source", b"exec-server"),
                daemon_binary,
                code_mode_host_binary,
                ripgrep,
                node,
                cli_binary=cli_binary,
                update_public_key="11" * 32,
            )

            self.assertEqual(
                b"ash-app-server", (output / "bin" / "ash-app-server").read_bytes()
            )
            self.assertEqual(
                b"ash-app-server-daemon",
                (output / "bin" / "ash-app-server-daemon").read_bytes(),
            )
            self.assertEqual(
                b"ash-code-mode-host",
                (output / "bin" / "ash-code-mode-host").read_bytes(),
            )
            self.assertEqual(b"ash-cli", (output / "bin" / "ash").read_bytes())
            self.assertEqual(b"ripgrep", (output / "ash-path" / "rg").read_bytes())
            for name in ("LICENSE-APACHE", "NOTICE"):
                self.assertEqual(
                    (REPOSITORY_ROOT / "ash-rs" / "uds" / name).read_bytes(),
                    (output / "ash-resources" / "licenses" / "uds" / name).read_bytes(),
                )
            self.assertEqual(
                b"node",
                (output / "ash-resources" / "node" / "bin" / "node").read_bytes(),
            )
            self.assertTrue(os.access(str(output / "bin" / "ash-app-server"), os.X_OK))
            self.assertTrue(os.access(str(output / "ash-path" / "rg"), os.X_OK))
            self.assertTrue(
                (
                    output / "ash-resources" / "licenses" / "ripgrep" / "LICENSE-MIT"
                ).is_file()
            )
            self.assertEqual(
                (REPOSITORY_ROOT / "third_party" / "vscode" / "LICENSE.txt").read_text(
                    encoding="utf-8"
                ),
                (
                    output / "ash-resources" / "licenses" / "vscode" / "LICENSE.txt"
                ).read_text(encoding="utf-8"),
            )
            self.assertEqual(
                (
                    REPOSITORY_ROOT
                    / "ash-rs"
                    / "skills"
                    / "assets"
                    / "skill-creator"
                    / "SKILL.md"
                ).read_text(encoding="utf-8"),
                (
                    output / "ash-resources" / "skills" / "skill-creator" / "SKILL.md"
                ).read_text(encoding="utf-8"),
            )
            self.assertTrue((output / "ash-resources" / "extensions").is_dir())
            product_services = json.loads(
                (
                    output
                    / "ash-resources"
                    / "product-services"
                    / "product-services.json"
                ).read_text(encoding="utf-8")
            )
            self.assertEqual(
                "marketplace-root.json",
                next(
                    source
                    for source in product_services["marketplaces"]
                    if source["name"] == "ash"
                )["trustedRoot"],
            )
            self.assertEqual(
                (
                    REPOSITORY_ROOT
                    / "resources"
                    / "product-services"
                    / "marketplace-root.json"
                ).read_bytes(),
                (
                    output
                    / "ash-resources"
                    / "product-services"
                    / "marketplace-root.json"
                ).read_bytes(),
            )
            self.assertEqual(
                [
                    path.name
                    for path in sorted(
                        (output / "ash-resources" / "extensions").iterdir(),
                        key=lambda path: path.name,
                    )
                ],
                self.BUILT_IN_EXTENSIONS,
            )
            self.assertIn(
                '"name": "json"',
                (
                    output / "ash-resources" / "extensions" / "json" / "package.json"
                ).read_text(encoding="utf-8"),
            )

            self.assert_extension_resources(output / "ash-resources" / "extensions")
            metadata = json.loads(
                (output / "ash-package.json").read_text(encoding="utf-8")
            )
            self.assertEqual(2, metadata["layoutVersion"])
            self.assertEqual("release", metadata["buildProfile"])
            self.assertEqual(
                hashlib.sha256(b"ash-app-server").hexdigest(),
                metadata["files"]["bin/ash-app-server"],
            )
            self.assertEqual({"kind": "packagedNode"}, metadata["javascriptRuntime"])
            self.assertEqual("aarch64-apple-darwin", metadata["target"])
            self.assertEqual(
                "local-override", metadata["components"]["ripgrep"]["source"]
            )
            self.assertEqual("local-override", metadata["components"]["node"]["source"])
            self.assertRegex(metadata["buildId"], r"^sha256:[a-f0-9]{64}$")
            self.assertEqual(
                load_protocol_metadata(REPOSITORY_ROOT),
                metadata["protocol"],
            )
            self.assertEqual(
                hashlib.sha256(b"ash-app-server").hexdigest(),
                metadata["components"]["appServer"]["binarySha256"],
            )
            self.assertEqual(
                hashlib.sha256(b"ash-app-server-daemon").hexdigest(),
                metadata["components"]["appServerDaemon"]["binarySha256"],
            )
            self.assertEqual(
                hashlib.sha256(b"ash-cli").hexdigest(),
                metadata["components"]["cli"]["binarySha256"],
            )
            self.assertEqual(
                "11" * 32,
                metadata["components"]["cli"]["updatePublicKey"],
            )
            self.assertEqual(
                hashlib.sha256(b"ripgrep").hexdigest(),
                metadata["components"]["ripgrep"]["binarySha256"],
            )
            self.assertEqual(
                hashlib.sha256(b"node").hexdigest(),
                metadata["components"]["node"]["binarySha256"],
            )

            with self.assertRaisesRegex(RuntimeError, "update public key"):
                build_package_directory(
                    root / "missing-update-key",
                    REPOSITORY_ROOT,
                    "0.1.0",
                    spec,
                    server_binary,
                    executable_file(root / "remote-source", b"remote"),
                    executable_file(root / "remote-server-source", b"remote-server"),
                    executable_file(root / "exec-server-source", b"exec-server"),
                    daemon_binary,
                    code_mode_host_binary,
                    ripgrep,
                    node,
                    cli_binary=cli_binary,
                )

            with self.assertRaisesRegex(RuntimeError, "Refusing to replace"):
                build_package_directory(
                    output,
                    REPOSITORY_ROOT,
                    "0.1.0",
                    spec,
                    server_binary,
                    executable_file(root / "remote-source", b"remote"),
                    executable_file(root / "remote-server-source", b"remote-server"),
                    executable_file(root / "exec-server-source", b"exec-server"),
                    daemon_binary,
                    code_mode_host_binary,
                    ripgrep,
                    node,
                )

    def test_host_provided_runtime_package_omits_standalone_node(self) -> None:
        generated_protocol = {
            "major": 7,
            "revision": 11,
            "schemaHash": "sha256:" + "a" * 64,
        }
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            spec = TARGETS["aarch64-apple-darwin"]
            output = root / "package"
            build_package_directory(
                output,
                REPOSITORY_ROOT,
                read_workspace_version(REPOSITORY_ROOT / "Cargo.toml"),
                spec,
                executable_file(root / "ash-source", b"ash-app-server"),
                executable_file(root / "remote-source", b"remote"),
                executable_file(root / "remote-server-source", b"remote-server"),
                executable_file(root / "exec-server-source", b"exec-server"),
                executable_file(root / "daemon-source", b"ash-app-server-daemon"),
                executable_file(root / "code-mode-host-source", b"ash-code-mode-host"),
                resolve_ripgrep(
                    spec,
                    PRODUCTION_LOCK,
                    root / "cache",
                    explicit_binary=executable_file(root / "rg-source", b"ripgrep"),
                ),
                None,
                protocol_metadata=generated_protocol,
            )

            metadata = json.loads(
                (output / "ash-package.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                {"kind": "hostProvidedNode"}, metadata["javascriptRuntime"]
            )
            self.assertEqual(generated_protocol, metadata["protocol"])
            self.assertNotIn("node", metadata["components"])
            self.assertFalse((output / "ash-resources" / "node").exists())
            self.assertFalse((output / "ash-resources" / "licenses" / "node").exists())

            signed = {}
            for name, path in system_signing_artifacts(output, spec).items():
                unsigned_digest = file_sha256(path)
                path.write_bytes(path.read_bytes() + b"-signed")
                signed[name] = {
                    "unsignedSha256": unsigned_digest,
                    "signedSha256": file_sha256(path),
                }
            record_system_signing(output, spec, signed)
            require_verified_system_signing(output, spec)
            signed_metadata = json.loads(
                (output / "ash-package.json").read_text(encoding="utf-8")
            )
            self.assertEqual("verified", signed_metadata["systemSigning"]["status"])
            self.assertEqual(generated_protocol, signed_metadata["protocol"])
            self.assertEqual(
                file_sha256(output / "bin" / spec.server_name),
                signed_metadata["components"]["appServer"]["binarySha256"],
            )

    def assert_extension_resources(self, extensions: Path) -> None:
        self.assertEqual(
            self.BUILT_IN_EXTENSIONS,
            sorted(path.name for path in extensions.iterdir() if path.is_dir()),
        )
        seen_ids = set()
        file_templates = []
        for package_name in self.BUILT_IN_EXTENSIONS:
            package = extensions / package_name
            manifest = json.loads(
                (package / "package.json").read_text(encoding="utf-8")
            )
            extension_id = "{}.{}".format(manifest["publisher"], manifest["name"])
            self.assertNotIn(extension_id, seen_ids)
            seen_ids.add(extension_id)
            self.assertTrue(manifest["version"])
            contributes = manifest.get("contributes", {})
            for language in contributes.get("languages", []):
                if "configuration" in language:
                    self.assert_extension_resource(package, language["configuration"])
            for contribution_name in ("grammars", "snippets", "themes"):
                for contribution in contributes.get(contribution_name, []):
                    self.assert_extension_resource(package, contribution["path"])
                    if contribution_name == "snippets":
                        snippet_path = package.joinpath(
                            *contribution["path"][2:].split("/")
                        )
                        snippet_document = json.loads(
                            snippet_path.read_text(encoding="utf-8")
                        )
                        languages = contribution["language"]
                        if isinstance(languages, str):
                            languages = [languages]
                        for snippet_name, snippet in snippet_document.items():
                            if snippet.get("isFileTemplate") is True:
                                file_templates.extend(
                                    (extension_id, language, snippet_name)
                                    for language in languages
                                )
        self.assertEqual(
            [
                ("vscode.html", "html", "html doc"),
                ("vscode.javascript", "javascript", "Class Definition"),
                ("vscode.javascript", "javascriptreact", "Class Definition"),
                ("vscode.typescript", "typescript", "Class Definition"),
                ("vscode.typescript", "typescriptreact", "Class Definition"),
            ],
            sorted(file_templates),
        )

    def assert_extension_resource(self, package: Path, relative_path: str) -> None:
        self.assertTrue(relative_path.startswith("./"))
        normalized = relative_path[2:]
        self.assertNotIn("\\", normalized)
        self.assertNotIn("..", Path(normalized).parts)
        resource = package.joinpath(*normalized.split("/"))
        self.assertTrue(
            resource.is_file(), "missing extension resource: {}".format(resource)
        )

    def test_repository_builtin_extension_contract(self) -> None:
        self.assert_extension_resources(REPOSITORY_ROOT / "extensions")

    def test_linux_package_contains_built_sandbox_resource_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            server_binary = executable_file(root / "ash-source", b"ash-app-server")
            daemon_binary = executable_file(
                root / "daemon-source", b"ash-app-server-daemon"
            )
            code_mode_host_binary = executable_file(
                root / "code-mode-host-source", b"ash-code-mode-host"
            )
            rg_binary = executable_file(root / "rg-source", b"ripgrep")
            bwrap_binary = executable_file(root / "bwrap-source", b"bubblewrap")
            spec = TARGETS["x86_64-unknown-linux-musl"]
            ripgrep = resolve_ripgrep(
                spec,
                PRODUCTION_LOCK,
                root / "rg-cache",
                explicit_binary=rg_binary,
            )
            node = test_node_resolution(root, spec)
            bubblewrap = resolve_bubblewrap(
                REPOSITORY_ROOT,
                spec,
                explicit_binary=bwrap_binary,
                cargo="cargo",
                cargo_profile="release",
            )
            self.assertIsNotNone(bubblewrap)
            output = root / "package"

            build_package_directory(
                output,
                REPOSITORY_ROOT,
                "0.1.0",
                spec,
                server_binary,
                executable_file(root / "remote-source", b"remote"),
                executable_file(root / "remote-server-source", b"remote-server"),
                executable_file(root / "exec-server-source", b"exec-server"),
                daemon_binary,
                code_mode_host_binary,
                ripgrep,
                node,
                bubblewrap,
            )

            self.assertEqual(
                b"bubblewrap",
                (output / "ash-resources" / "bwrap").read_bytes(),
            )
            self.assertTrue(
                (
                    output / "ash-resources" / "licenses" / "bubblewrap" / "COPYING"
                ).is_file()
            )
            metadata = json.loads(
                (output / "ash-package.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                "0.11.2",
                metadata["components"]["bubblewrap"]["version"],
            )
            self.assertEqual(
                "local-override",
                metadata["components"]["bubblewrap"]["source"],
            )

    def test_windows_package_excludes_retired_account_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            server_binary = root / "ash-app-server.exe"
            server_binary.write_bytes(b"ash-app-server")
            daemon_binary = root / "ash-app-server-daemon.exe"
            daemon_binary.write_bytes(b"ash-app-server-daemon")
            code_mode_host_binary = root / "ash-code-mode-host.exe"
            code_mode_host_binary.write_bytes(b"ash-code-mode-host")
            rg_binary = root / "rg.exe"
            rg_binary.write_bytes(b"ripgrep")
            spec = TARGETS["x86_64-pc-windows-msvc"]
            ripgrep = resolve_ripgrep(
                spec,
                PRODUCTION_LOCK,
                root / "rg-cache",
                explicit_binary=rg_binary,
            )
            node = test_node_resolution(root, spec)
            output = root / "package"

            build_package_directory(
                output,
                REPOSITORY_ROOT,
                "0.1.0",
                spec,
                server_binary,
                executable_file(root / "remote-source", b"remote"),
                executable_file(root / "remote-server-source", b"remote-server"),
                executable_file(root / "exec-server-source", b"exec-server"),
                daemon_binary,
                code_mode_host_binary,
                ripgrep,
                node,
                windows_sandbox_binary=executable_file(
                    root / "sandbox-source.exe", b"sandbox"
                ),
            )

            resources = output / "ash-resources"
            for name in [
                "ash-command-runner.exe",
                "ash-windows-sandbox-service.exe",
                "ash-windows-sandbox-worker.exe",
            ]:
                self.assertFalse((resources / name).exists())
            artifacts = system_signing_artifacts(output, spec)
            self.assertNotIn("mxcUserRuntime", artifacts)
            self.assertFalse((output / "bin/mxc-user.exe").exists())
            self.assertEqual(
                {"windowsSandbox"},
                {name for name in artifacts if name.startswith("windows")},
            )
            signed = {}
            for name, artifact in artifacts.items():
                unsigned = file_sha256(artifact)
                artifact.write_bytes(artifact.read_bytes() + b"-signed")
                signed[name] = {
                    "unsignedSha256": unsigned,
                    "signedSha256": file_sha256(artifact),
                }
            record_system_signing(output, spec, signed)
            require_verified_system_signing(output, spec)

    @unittest.skipIf(
        os.name == "nt", "creating symbolic links may require Windows privilege"
    )
    def test_builtin_skill_copy_rejects_symbolic_links(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            skill = source / "review"
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text(
                "---\nname: review\ndescription: Reviews code when requested.\n---\n",
                encoding="utf-8",
            )
            (skill / "linked.md").symlink_to(skill / "SKILL.md")

            with self.assertRaisesRegex(RuntimeError, "symbolic link"):
                copy_builtin_skills(source, root / "destination")

    def test_builtin_extension_copy_rejects_an_empty_source(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()

            with self.assertRaisesRegex(RuntimeError, "source is empty"):
                copy_builtin_extensions(source, root / "destination")

    def test_builtin_extension_copy_rejects_an_empty_package_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            (source / "demo").mkdir(parents=True)

            with self.assertRaisesRegex(RuntimeError, "missing package.json"):
                copy_builtin_extensions(source, root / "destination")

    @unittest.skipIf(
        os.name == "nt", "creating symbolic links may require Windows privilege"
    )
    def test_builtin_extension_copy_rejects_a_symbolic_source_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "source-target"
            target.mkdir()
            source = root / "source"
            source.symlink_to(target, target_is_directory=True)

            with self.assertRaisesRegex(RuntimeError, "source is not a real directory"):
                copy_builtin_extensions(source, root / "destination")

    @unittest.skipIf(
        os.name == "nt", "creating symbolic links may require Windows privilege"
    )
    def test_builtin_extension_copy_rejects_a_symbolic_package_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            extension = root / "demo-target"
            extension.mkdir()
            (extension / "package.json").write_text(
                '{"name":"demo","publisher":"ash","version":"1.0.0"}',
                encoding="utf-8",
            )
            (source / "demo").symlink_to(extension, target_is_directory=True)

            with self.assertRaisesRegex(
                RuntimeError, "Invalid built-in extension package"
            ):
                copy_builtin_extensions(source, root / "destination")

    def test_bubblewrap_metadata_rejects_invalid_source_digest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = write_vendored_bubblewrap(root)
            metadata_path = source / "ash-source.json"
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            metadata["archive"]["sha256"] = "invalid"
            metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
            bwrap_binary = executable_file(root / "bwrap-source", b"bubblewrap")

            with self.assertRaisesRegex(RuntimeError, "SHA-256"):
                resolve_bubblewrap(
                    root,
                    TARGETS["x86_64-unknown-linux-musl"],
                    explicit_binary=bwrap_binary,
                    cargo="cargo",
                    cargo_profile="release",
                )

    def test_bubblewrap_vendor_requires_complete_source(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = write_vendored_bubblewrap(root)
            (source / "bubblewrap.c").unlink()

            with self.assertRaisesRegex(RuntimeError, "bubblewrap.c"):
                load_vendored_source(source)

    def test_fetches_and_extracts_exact_tar_member(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "ripgrep-test.tar.gz"
            write_tar_archive(archive, "bundle/rg", b"tar-rg")
            lock_path = write_test_lock(
                root, archive, "tar.gz", "bundle/rg", "x86_64-unknown-linux-musl"
            )

            resolution = resolve_ripgrep(
                TARGETS["x86_64-unknown-linux-gnu"],
                lock_path,
                root / "cache",
            )

            self.assertEqual(b"tar-rg", resolution.executable.read_bytes())
            self.assertTrue(os.access(str(resolution.executable), os.X_OK))
            self.assertEqual("upstream-release", resolution.source)

    def test_fetches_and_extracts_exact_zip_member(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "ripgrep-test.zip"
            with zipfile.ZipFile(str(archive), "w") as output:
                output.writestr("bundle/rg.exe", b"zip-rg")
            lock_path = write_test_lock(
                root, archive, "zip", "bundle/rg.exe", "x86_64-pc-windows-msvc"
            )

            resolution = resolve_ripgrep(
                TARGETS["x86_64-pc-windows-msvc"],
                lock_path,
                root / "cache",
            )

            self.assertEqual(b"zip-rg", resolution.executable.read_bytes())
            self.assertEqual("rg.exe", resolution.executable.name)

    def test_node_fetches_and_extracts_exact_tar_members(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "node-test.tar.xz"
            write_node_tar_archive(archive, "bundle/bin/node", "bundle/LICENSE")
            lock_path = write_node_lock(
                root,
                archive,
                "tar.xz",
                "bundle/bin/node",
                "bundle/LICENSE",
                "x86_64-unknown-linux-gnu",
            )

            resolution = resolve_node(
                TARGETS["x86_64-unknown-linux-gnu"],
                lock_path,
                root / "cache",
            )

            self.assertEqual(b"node-runtime", resolution.executable.read_bytes())
            self.assertEqual(b"node-license", resolution.license_file.read_bytes())
            self.assertTrue(os.access(str(resolution.executable), os.X_OK))

    def test_node_fetches_and_extracts_exact_zip_members(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "node-test.zip"
            with zipfile.ZipFile(str(archive), "w") as output:
                output.writestr("bundle/node.exe", b"node-runtime")
                output.writestr("bundle/LICENSE", b"node-license")
            lock_path = write_node_lock(
                root,
                archive,
                "zip",
                "bundle/node.exe",
                "bundle/LICENSE",
                "x86_64-pc-windows-msvc",
            )

            resolution = resolve_node(
                TARGETS["x86_64-pc-windows-msvc"],
                lock_path,
                root / "cache",
            )

            self.assertEqual(b"node-runtime", resolution.executable.read_bytes())
            self.assertEqual(b"node-license", resolution.license_file.read_bytes())
            self.assertEqual("node.exe", resolution.executable.name)

    def test_digest_mismatch_aborts_and_removes_download(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "ripgrep-test.tar.gz"
            write_tar_archive(archive, "bundle/rg", b"tampered")
            lock_path = write_test_lock(
                root,
                archive,
                "tar.gz",
                "bundle/rg",
                "x86_64-unknown-linux-musl",
                digest="0" * 64,
            )
            cache = root / "cache"

            with self.assertRaisesRegex(RuntimeError, "SHA-256"):
                resolve_ripgrep(
                    TARGETS["x86_64-unknown-linux-musl"],
                    lock_path,
                    cache,
                )

            self.assertFalse(
                (cache / "test" / "x86_64-unknown-linux-musl" / archive.name).exists()
            )


def executable_file(path: Path, contents: bytes) -> Path:
    path.write_bytes(contents)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


def write_tar_archive(path: Path, member_name: str, contents: bytes) -> None:
    with tarfile.open(str(path), "w:gz") as archive:
        member = tarfile.TarInfo(member_name)
        member.size = len(contents)
        member.mode = 0o755
        archive.addfile(member, io.BytesIO(contents))


def write_node_tar_archive(
    path: Path, executable_member: str, license_member: str
) -> None:
    with tarfile.open(str(path), "w:xz") as archive:
        for member_name, contents, mode in (
            (executable_member, b"node-runtime", 0o755),
            (license_member, b"node-license", 0o644),
        ):
            member = tarfile.TarInfo(member_name)
            member.size = len(contents)
            member.mode = mode
            archive.addfile(member, io.BytesIO(contents))


def write_vendored_bubblewrap(root: Path) -> Path:
    source = root / "ash-rs" / "vendor" / "bubblewrap"
    source.mkdir(parents=True)
    for name in (
        "COPYING",
        "bind-mount.c",
        "bind-mount.h",
        "bubblewrap.c",
        "network.c",
        "network.h",
        "utils.c",
        "utils.h",
    ):
        (source / name).write_bytes(b"source")
    metadata = {
        "schemaVersion": 1,
        "name": "bubblewrap",
        "version": "0.11.2-test",
        "repository": "https://example.invalid/bubblewrap",
        "release": "test",
        "archive": {
            "name": "bubblewrap-test.tar.xz",
            "sha256": "0" * 64,
        },
    }
    (source / "ash-source.json").write_text(json.dumps(metadata), encoding="utf-8")
    return source


def write_test_lock(
    root: Path,
    archive: Path,
    archive_format: str,
    executable_member: str,
    artifact_target: str,
    digest: str = "",
) -> Path:
    actual_digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    lock = {
        "schemaVersion": 1,
        "runtime": "ripgrep",
        "version": "test",
        "source": {
            "repository": "https://example.invalid/ripgrep",
            "release": "test",
        },
        "packageTargets": {
            "x86_64-unknown-linux-gnu": artifact_target,
            "x86_64-unknown-linux-musl": artifact_target,
            "x86_64-pc-windows-msvc": artifact_target,
        },
        "artifacts": {
            artifact_target: {
                "archive": archive.name,
                "size": archive.stat().st_size,
                "sha256": digest or actual_digest,
                "format": archive_format,
                "executable": executable_member,
                "url": archive.as_uri(),
            }
        },
    }
    lock_path = root / "runtime-lock.json"
    lock_path.write_text(json.dumps(lock), encoding="utf-8")
    return lock_path


def write_node_lock(
    root: Path,
    archive: Path,
    archive_format: str,
    executable_member: str,
    license_member: str,
    target: str,
) -> Path:
    artifact_key = "test-artifact"
    lock = {
        "schemaVersion": 1,
        "runtime": "node",
        "version": "test",
        "source": {"baseUrl": root.as_uri()},
        "packageTargets": {target: artifact_key},
        "licenseTargets": {},
        "artifacts": {
            artifact_key: {
                "archive": archive.name,
                "size": archive.stat().st_size,
                "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                "format": archive_format,
                "executable": executable_member,
                "license": license_member,
            }
        },
    }
    lock_path = root / "node-lock.json"
    lock_path.write_text(json.dumps(lock), encoding="utf-8")
    return lock_path


def test_node_resolution(root: Path, spec) -> NodeResolution:
    executable = executable_file(root / spec.node_name, b"node")
    license_file = root / "node-license"
    license_file.write_bytes(b"node license")
    return NodeResolution(
        executable=executable,
        license_file=license_file,
        version="24.18.1-test",
        source="local-override",
        binary_sha256=hashlib.sha256(b"node").hexdigest(),
        archive="node-test.zip",
        archive_sha256="a" * 64,
    )


if __name__ == "__main__":
    unittest.main()
