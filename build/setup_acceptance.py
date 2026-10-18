"""Exercise Windows dependency setup and source switching in one isolated checkout."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from build.bun_acceptance import run, save  # noqa: E402


CONTRACT = "crates/app-server-protocol/src/protocol/git.rs"
GENERATED = ".build/protocol/typescript/types/GitStatusResult.ts"
MARKER = "Setup acceptance source revision"
DEPENDENCIES = ("package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml")
BROWSER_ARGS = [
    "test:browser:integration",
    "gitExtension.integration.spec.ts",
    "--project=chromium",
    "--grep",
    "SCM commit message action",
    "--max-failures=1",
]


def digest(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def source_files(root: Path) -> dict[str, str]:
    paths = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=root,
    )
    files = {}
    for name in paths.split(b"\0"):
        if not name:
            continue
        relative = os.fsdecode(name)
        path = root / relative
        if not path.exists():
            continue
        if not path.resolve().is_relative_to(root.resolve()) or not path.is_file():
            raise ValueError(f"Source is not a repository-owned file: {relative}")
        files[relative] = digest(path)
    return files


def copy_sources(root: Path, workspace: Path, files: dict[str, str]) -> None:
    for relative, expected in files.items():
        target = workspace / relative
        if not target.resolve().is_relative_to(workspace.resolve()):
            raise ValueError(f"Source path escapes acceptance workspace: {relative}")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / relative, target)
        if digest(target) != expected:
            raise RuntimeError(f"Source changed while copying: {relative}")


def source_revision(workspace: Path, revision: str) -> None:
    path = workspace / CONTRACT
    text = path.read_text(encoding="utf-8")
    marker = f"    /// {MARKER} {revision}.\n"
    if f"    /// {MARKER} A.\n" in text:
        text = text.replace(f"    /// {MARKER} A.\n", marker, 1)
    else:
        anchor = "    /// Changes only when repository identity, HEAD, refs or ref metadata changes."
        if text.count(anchor) != 1:
            raise RuntimeError(
                "Cannot locate the protocol documentation used by acceptance"
            )
        text = text.replace(anchor, marker + anchor, 1)
    path.write_text(text, encoding="utf-8", newline="\n")


def check_protocol(workspace: Path, revision: str) -> str:
    if f"{MARKER} {revision}." not in (workspace / GENERATED).read_text():
        raise RuntimeError(
            f"Normal test entrypoint did not generate protocol revision {revision}"
        )
    return json.loads((workspace / ".build/protocol-inputs.json").read_text())["inputs"]


def validate_resume(
    root: Path, workspace: Path, before: dict[str, str]
) -> dict[str, str]:
    after = source_files(root)
    protected = {*DEPENDENCIES, CONTRACT}
    protected.update(name for name in before | after if name.startswith("patches/"))
    if any(before.get(name) != after.get(name) for name in protected):
        raise RuntimeError(
            "Dependency or protocol inputs changed; start a fresh acceptance run"
        )
    changed = {
        name: value for name, value in after.items() if before.get(name) != value
    }
    copy_sources(root, workspace, changed)
    for name in before.keys() - after.keys():
        target = workspace / name
        if not target.resolve().is_relative_to(workspace.resolve()):
            raise ValueError("Removed source escapes acceptance workspace")
        target.unlink(missing_ok=True)
    return after


def workspace_parent(root: Path) -> Path:
    parent = Path(tempfile.gettempdir()) / "ash-setup-acceptance"
    if parent.resolve().is_relative_to(root.resolve()):
        raise ValueError(
            "Temporary acceptance workspace must be outside the source checkout"
        )
    return parent


def accept(output: Path, *, resume: bool = False) -> None:
    if sys.platform != "win32":
        raise RuntimeError("Windows setup acceptance must run on Windows")
    output.mkdir(parents=True, exist_ok=True)
    report_path = output / "setup.json"
    manifest_path = output / "source-files.json"
    sandbox_parent = workspace_parent(ROOT)
    if resume:
        report = json.loads(report_path.read_text())
        if report.get("format") != "ash-windows-setup-acceptance-v1" or report[
            "source"
        ] != str(ROOT):
            raise ValueError("Acceptance report belongs to another checkout")
        if report["status"] == "passed":
            raise ValueError(
                "Acceptance already passed; start a fresh run for new sources"
            )
        workspace = Path(report["workspace"])
        if (
            workspace.name != "workspace"
            or workspace.parent.parent.resolve() != sandbox_parent.resolve()
        ):
            raise ValueError(
                "Acceptance workspace must match this run's temporary sandbox"
            )
        uuid.UUID(workspace.parent.name)
        before = json.loads(manifest_path.read_text())
        if "baselineProtocol" in report and before != source_files(ROOT):
            raise RuntimeError(
                "Sources changed after baseline testing; start a fresh acceptance run"
            )
        files = validate_resume(ROOT, workspace, before)
        report.setdefault("repairs", []).append(
            sorted(
                name for name in before | files if before.get(name) != files.get(name)
            )
        )
    else:
        if report_path.exists():
            raise ValueError(
                "Output already contains a run; choose another output or --resume"
            )
        workspace = sandbox_parent / str(uuid.uuid4()) / "workspace"
        workspace.mkdir(parents=True)
        files = source_files(ROOT)
        print(f"Snapshotting {len(files)} source files into {workspace}", flush=True)
        copy_sources(ROOT, workspace, files)
        source_revision(workspace, "A")
        report = {
            "format": "ash-windows-setup-acceptance-v1",
            "source": str(ROOT),
            "sourceHead": subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
            ).strip(),
            "workspace": str(workspace),
            "platform": platform.platform(),
            "architecture": platform.machine(),
            "bootstrapPython": {
                "executable": sys.executable,
                "version": platform.python_version(),
            },
            "steps": {},
            "commands": [],
        }
    save(manifest_path, files)
    store = workspace.parent / "pnpm-store"
    browser_cache = workspace.parent / "browsers"
    report.update(status="running", store=str(store), browserCache=str(browser_cache))
    report.pop("error", None)
    save(report_path, report)
    pnpm = shutil.which("pnpm")
    if not pnpm:
        raise RuntimeError("The repository-pinned pnpm must be on PATH")
    environment = {"PLAYWRIGHT_BROWSERS_PATH": str(browser_cache)}
    # The acceptance copy owns its Python environment; a caller's override must
    # not silently route normal test preparation back into the original checkout.
    environment["PYTHON"] = str(workspace / "scripts/.venv/Scripts/python.exe")
    modules = workspace / "node_modules"
    dependency_hashes = {name: files[name] for name in DEPENDENCIES}

    def command(
        label: str, args: list[str], *, bootstrap: bool = False, reuse: bool = True
    ) -> dict:
        if reuse and report["steps"].get(label, {}).get("exitCode") == 0:
            return report["steps"][label]
        attempt = 1 + sum(item["step"] == label for item in report["commands"])
        report["activeStep"] = label
        save(report_path, report)
        try:
            result = run(
                args,
                output,
                f"{label}-{attempt}",
                cwd=workspace,
                environment={} if bootstrap else environment,
                timeout=1800,
            )
        except BaseException as error:
            report["commands"].append(
                {
                    "step": label,
                    "command": args,
                    "cwd": str(workspace),
                    "exitCode": None,
                    "error": str(error),
                    "log": f"{label}-{attempt}.log",
                }
            )
            raise
        result["step"] = label
        report["commands"].append(result)
        report["steps"][label] = result
        save(report_path, report)
        if result["exitCode"]:
            raise RuntimeError(f"{label} failed; inspect {output / result['log']}")
        return result

    def tool_versions(stage: str) -> None:
        manifest = json.loads((workspace / "package.json").read_text())
        expected = {
            "node": (workspace / ".nvmrc").read_text().strip(),
            "pnpm": manifest["packageManager"].split("@", 1)[1],
            "bun": manifest["devDependencies"]["bun"],
            "bunx": manifest["devDependencies"]["bun"],
        }
        for name, version in expected.items():
            executable = (
                str(modules / f"bun/bin/{name}.exe")
                if name in {"bun", "bunx"}
                else pnpm
                if name == "pnpm"
                else shutil.which("node")
            )
            if not executable:
                raise RuntimeError(f"Missing {name}")
            result = command(f"{stage}-{name}", [executable, "--version"])
            actual = (output / result["log"]).read_text().strip().removeprefix("v")
            if actual != version:
                raise RuntimeError(f"{name}: expected {version}, found {actual}")

    def test_entry(label: str) -> None:
        try:
            # A command can succeed while the following generated-input check
            # fails. Retrying that stage must execute the repaired entrypoint.
            result = command(label, [pnpm, *BROWSER_ARGS], reuse=False)
        finally:
            browser_results = workspace / ".build/desktop/playwright"
            if browser_results.is_dir():
                shutil.copytree(browser_results, output / "browser", dirs_exist_ok=True)
                report["browserArtifacts"] = "browser"
        log = (output / result["log"]).read_text(encoding="utf-8", errors="replace")
        if not re.search(r"\b2 passed\b", log):
            raise RuntimeError("Setup acceptance must execute both language cases")

    try:
        if "git-init" not in report["steps"]:
            if modules.exists() or store.exists():
                raise RuntimeError(
                    "First installation requires a fresh workspace and store"
                )
        command("git-init", ["git", "init", "--initial-branch=setup-base"])
        command("git-name", ["git", "config", "user.name", "Ash Setup Acceptance"])
        command(
            "git-email",
            ["git", "config", "user.email", "setup-acceptance@example.invalid"],
        )
        command("git-eol", ["git", "config", "core.autocrlf", "false"])
        command("git-no-sign", ["git", "config", "commit.gpgsign", "false"])
        command("git-no-hooks", ["git", "config", "core.hooksPath", ".git/setup-hooks"])
        pathspec = output / "snapshot-paths"
        pathspec.write_bytes(b"\0".join(os.fsencode(name) for name in files) + b"\0")
        command(
            "git-add",
            [
                "git",
                "--literal-pathspecs",
                "add",
                f"--pathspec-from-file={pathspec}",
                "--pathspec-file-nul",
            ],
        )
        command("git-baseline", ["git", "commit", "-m", "Setup acceptance source A"])
        command(
            "python-tools",
            [sys.executable, "-B", "scripts/install_python_tools.py"],
            bootstrap=True,
        )
        command(
            "first-install",
            [pnpm, "install", "--frozen-lockfile", "--store-dir", str(store)],
        )
        tool_versions("first-install")
        marker = modules / ".ash-setup-acceptance"
        if not marker.exists():
            marker.write_text(workspace.name)
            report["nodeModulesId"] = modules.stat().st_ino
        command(
            "repeat-install",
            [
                pnpm,
                "install",
                "--frozen-lockfile",
                "--offline",
                "--store-dir",
                str(store),
            ],
        )
        tool_versions("repeat-install")
        for attempt in (1, 2):
            command(f"rebuild-{attempt}", [pnpm, "rebuild", "--store-dir", str(store)])
            tool_versions(f"rebuild-{attempt}")
        if not marker.is_file() or modules.stat().st_ino != report["nodeModulesId"]:
            raise RuntimeError("Repeated setup replaced the node_modules directory")
        command("chromium", [pnpm, "exec", "playwright", "install", "chromium"])
        if "baselineProtocol" not in report:
            command("source-next-branch", ["git", "switch", "-c", "setup-next"])
            if report["steps"].get("source-next-commit", {}).get("exitCode") != 0:
                source_revision(workspace, "B")
                command("source-next-add", ["git", "add", "--", CONTRACT])
                command(
                    "source-next-commit",
                    ["git", "commit", "-m", "Setup acceptance source B"],
                )
            command("source-baseline-switch", ["git", "switch", "setup-base"])
            test_entry("source-a-test")
            report["baselineProtocol"] = check_protocol(workspace, "A")
            save(report_path, report)
        command("source-switch", ["git", "switch", "setup-next"])
        test_entry("source-b-test")
        report["nextProtocol"] = check_protocol(workspace, "B")
        if report["nextProtocol"] == report["baselineProtocol"]:
            raise RuntimeError(
                "Source switch did not refresh the protocol input fingerprint"
            )
        if dependency_hashes != {
            name: digest(workspace / name) for name in DEPENDENCIES
        }:
            raise RuntimeError(
                "Frozen setup modified a dependency manifest or lockfile"
            )
        report["workspaceStatus"] = subprocess.check_output(
            ["git", "status", "--short"], cwd=workspace, text=True
        )
        report["status"] = "passed"
        report.pop("activeStep", None)
    except BaseException as error:
        report.update(status="failed", error=str(error))
        raise
    finally:
        save(report_path, report)
        print(
            f"Windows setup acceptance: {report['status']} ({report_path})", flush=True
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    accept(args.output.resolve(), resume=args.resume)


if __name__ == "__main__":
    main()
