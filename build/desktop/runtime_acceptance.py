"""Verify installed Desktop runtime selection through real daemon command processes."""

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from build.lib.package import (
    file_sha256,
    package_build_id,
    package_files,
    validate_package_directory,
)
from build.lib.targets import target_spec


def bundle_paths(bundle: Path) -> tuple[Path, Path]:
    if sys.platform == "darwin":
        return bundle / "Contents/Resources", bundle / "Contents/MacOS/Ash"
    return bundle / "resources", bundle / "Ash.exe"


def accept(bundle: Path, standalone: Path, report_path: Path) -> dict:
    resources, electron = bundle_paths(bundle.resolve())
    metadata = json.loads((resources / "ash-package.json").read_text(encoding="utf-8"))
    spec = target_spec(metadata["target"])
    # Electron resources also contain the application and update helper. The backend's immutable
    # manifest names its own payload; installation verifies that exact subset after copying it.
    for relative, digest in metadata["files"].items():
        path = resources / relative
        assert not Path(relative).is_absolute() and path.resolve().is_relative_to(
            resources.resolve()
        )
        assert path.is_file() and not path.is_symlink()
        assert file_sha256(resources / relative) == digest, relative
    expected = metadata["javascriptRuntime"]
    assert expected["kind"] == "hostProvidedNode" and expected["electronVersion"]
    assert "node" not in metadata["components"]
    assert not (resources / "ash-resources/node").exists()
    assert not (resources / "ash-resources/licenses/node").exists()
    validate_package_directory(standalone, spec)
    original = (standalone / "ash-package.json").read_bytes()
    assert json.loads(original)["javascriptRuntime"] == {"kind": "packagedNode"}
    assert (standalone / "ash-resources/node/bin" / spec.node_name).is_file()
    daemon = resources / "bin" / spec.app_server_daemon_name
    events = []
    report = {
        "target": spec.target,
        "electronVersion": expected["electronVersion"],
        "packageBuildId": metadata["buildId"],
        "backendBuildProfile": metadata["buildProfile"],
    }
    # Windows AF_UNIX has a 108-byte address limit, including the profile/run suffix.
    with tempfile.TemporaryDirectory(prefix="ash-") as temporary:
        root = Path(temporary).resolve()
        assert root.parent == Path(tempfile.gettempdir()).resolve()
        profile = root / "profile"
        profile.mkdir()
        base = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith("ASH_")
            and key not in ("NODE_OPTIONS", "ELECTRON_RUN_AS_NODE")
        }
        base["ASH_HOME"] = str(profile)

        def command(operation, backend=None, runtime=None, success=True):
            environment = {
                **base,
                "ASH_APP_SERVER_PATH": str(
                    backend or (resources / metadata["entrypoint"])
                ),
            }
            if runtime is not None:
                environment["ASH_ELECTRON_RUN_AS_NODE_PATH"] = str(runtime)
            result = subprocess.run(
                [str(daemon), operation],
                env=environment,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=35,
            )
            events.append(
                {
                    "operation": operation,
                    "success": result.returncode == 0,
                    "stdout": result.stdout,
                    "stderr": result.stderr,
                }
            )
            if success:
                assert result.returncode == 0, events[-1]
                return json.loads(result.stdout)
            assert result.returncode != 0, events[-1]
            return result.stderr

        def selection():
            files = sorted(
                (profile / "app-server-packages/manifests").glob("[0-9]*.json")
            )
            return json.loads(files[-1].read_text(encoding="utf-8"))

        def assert_binding(path):
            selected = selection()
            assert selected["formatVersion"] == 1
            assert Path(selected["installation"]["executable"]) == path.resolve()
            assert (
                selected["installation"]["electronVersion"]
                == expected["electronVersion"]
            )
            return selected

        hidden = None
        try:
            first = command("ensure-selected", runtime=electron)
            assert first["status"] == "started"
            original_binding = assert_binding(electron)["installation"]
            # The command carrier has exited; the background process remains initialized.
            assert command("version")["pid"] == first["pid"]
            report["carrierExitKeepsBackend"] = True
            other_backend = standalone / metadata["entrypoint"]
            attached = command("start", backend=other_backend)
            assert attached["pid"] == first["pid"]
            restarted = command("restart", backend=other_backend)
            assert (
                restarted["status"] == "restarted"
                and restarted["instanceId"] != first["instanceId"]
            )
            assert assert_binding(electron)["installation"] == original_binding
            report["tuiReuseAndRestartKeepsElectron"] = True
            pid = restarted["pid"]
            os.kill(pid, signal.SIGTERM if os.name == "nt" else signal.SIGKILL)
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                version = command("version")
                if version["status"] == "notRunning":
                    break
                time.sleep(0.1)
            else:
                raise AssertionError("terminated backend did not retire")
            recovered = command("start", backend=other_backend)
            assert (
                recovered["status"] == "started"
                and recovered["instanceId"] != restarted["instanceId"]
            )
            assert_binding(electron)
            report["crashRecoveryKeepsElectron"] = True

            replacement = root / bundle.name
            shutil.copytree(bundle, replacement, symlinks=True)
            replacement_resources, replacement_electron = bundle_paths(replacement)
            switched = command(
                "ensure-selected",
                replacement_resources / metadata["entrypoint"],
                replacement_electron,
            )
            assert (
                switched["status"] == "restarted"
                and switched["pid"] != recovered["pid"]
            )
            assert_binding(replacement_electron)
            rollback = command("ensure-selected", runtime=electron)
            assert (
                rollback["status"] == "restarted" and rollback["pid"] != switched["pid"]
            )
            assert assert_binding(electron)["installation"] == original_binding
            report["bindingUpgradeAndRollback"] = True

            # A correctly hashed package with an incompatible Electron contract must not be selected.
            rejected = root / "incompatible"
            rejected.mkdir()
            for relative in metadata["files"]:
                target = rejected / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(resources / relative, target)
            shutil.copy2(resources / "ash-package.json", rejected / "ash-package.json")
            incompatible = json.loads(
                (rejected / "ash-package.json").read_text(encoding="utf-8")
            )
            incompatible["javascriptRuntime"]["electronVersion"] = "999.0.0"
            identity = {
                key: value
                for key, value in incompatible.items()
                if key not in ("files", "buildId")
            }
            files = package_files(rejected)
            incompatible.update(files=files, buildId=package_build_id(identity, files))
            (rejected / "ash-package.json").write_text(
                json.dumps(incompatible), encoding="utf-8"
            )
            before = selection()
            assert "contract" in command(
                "ensure-selected",
                rejected / metadata["entrypoint"],
                electron,
                success=False,
            )
            assert selection() == before
            assert command("version")["pid"] == rollback["pid"]
            report["incompatibleRuntimeDoesNotReplaceSelection"] = True
            assert "Desktop application" in command("update", success=False)
            assert "Desktop application" in command(
                "update", backend=other_backend, success=False
            )
            report["standaloneUpdateCannotReplaceDesktop"] = True

            command("stop")
            hidden = replacement_electron.with_name(
                replacement_electron.name + ".unavailable"
            )
            assert replacement_electron.resolve().is_relative_to(root)
            assert hidden.parent.resolve().is_relative_to(root) and not hidden.exists()
            # Select a valid installation before modelling its Electron executable's removal.
            command(
                "ensure-selected",
                replacement_resources / metadata["entrypoint"],
                replacement_electron,
            )
            command("stop")
            replacement_electron.rename(hidden)
            without_electron = command("start", backend=other_backend)
            assert without_electron["status"] == "started"
            assert command("version")["status"] == "running"
            report["missingElectronKeepsRustBackend"] = True
            hidden.rename(replacement_electron)
            hidden = None
            restored = command(
                "ensure-selected",
                replacement_resources / metadata["entrypoint"],
                replacement_electron,
            )
            assert restored["status"] == "restarted"
            report["restoredElectronCreatesAReadyGeneration"] = True
            command("ensure-selected", runtime=electron)
        finally:
            if hidden is not None and hidden.exists():
                hidden.rename(
                    hidden.with_name(hidden.name.removesuffix(".unavailable"))
                )
            command("stop")
    assert (standalone / "ash-package.json").read_bytes() == original
    validate_package_directory(standalone, spec)
    report["otherHostNodeRetained"] = True
    report["events"] = events
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--standalone-package", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args()
    print(
        json.dumps(
            accept(
                args.bundle.resolve(),
                args.standalone_package.resolve(),
                args.report.resolve(),
            ),
            indent=2,
        )
    )
