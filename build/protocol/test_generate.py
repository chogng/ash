"""Protocol watch inputs follow Cargo's selected export dependency graph."""

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from build.protocol.generate import protocol_source_directories


class ProtocolWatchInputTests(unittest.TestCase):
    def test_path_contracts_and_macros_are_included_without_registry_or_git_sources(
        self,
    ):
        with tempfile.TemporaryDirectory(prefix="ash (protocol) ") as temporary:
            root = Path(temporary).resolve()
            protocol = root / "crates/app-server-protocol"
            contract = root / "crates/queue-contract"
            macros = root / "crates/app-server-protocol-noop-macros"
            tree = "\n".join(
                [
                    f"ash-app-server-protocol v0.1.0 ({protocol})",
                    f"ash-queue-contract v0.1.0 ({contract})",
                    f"ash-queue-contract v0.1.0 ({contract}) (*)",
                    f"noop v0.1.0 ({macros}) (proc-macro)",
                    f"noop v0.1.0 ({macros}) (proc-macro) (*)",
                    "serde v1.0.0",
                    "serde_derive v1.0.0 (proc-macro)",
                    "matcher v0.3.0 (https://example.com/matcher#1234)",
                ]
            )
            with patch(
                "build.protocol.generate.subprocess.check_output", return_value=tree
            ) as cargo:
                self.assertEqual(
                    sorted(map(str, [protocol, contract, macros])),
                    protocol_source_directories(root=root),
                )
            arguments = cargo.call_args.args[0]
            self.assertEqual(root, cargo.call_args.kwargs["cwd"])
            self.assertIn("--locked", arguments)
            self.assertEqual("export", arguments[arguments.index("--features") + 1])
            self.assertEqual("normal,build", arguments[arguments.index("--edges") + 1])

    def test_an_invalid_dependency_graph_stops_discovery(self):
        error = subprocess.CalledProcessError(101, ["cargo", "tree"])
        with patch(
            "build.protocol.generate.subprocess.check_output", side_effect=error
        ):
            with self.assertRaises(subprocess.CalledProcessError):
                protocol_source_directories()
