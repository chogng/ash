#!/usr/bin/env python3
"""Collect companion symbols before stripping staging copies; bind after signing."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zlib
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from build.lib.file_lock import exclusive_lock  # noqa: E402
from build.release.identity import identity  # noqa: E402
from build.release.tools import run, tool  # noqa: E402

MAX_ARCHIVE = 16 * 1024**3
MAX_MEMBERS = 20000


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def relative_path(value: str) -> Path:
    path = PurePosixPath(value)
    if (
        not value
        or path.is_absolute()
        or ".." in path.parts
        or "\\" in value
        or ":" in value
    ):
        raise ValueError(f"Unsafe relative path: {value}")
    reserved = {"CON", "PRN", "AUX", "NUL"} | {
        f"{prefix}{index}" for prefix in ("COM", "LPT") for index in range(1, 10)
    }
    if any(
        part.rstrip(". ") != part or part.split(".")[0].upper() in reserved
        for part in path.parts
    ):
        raise ValueError(f"Unsafe portable path: {value}")
    return Path(*path.parts)


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False
    ) as stream:
        temporary = Path(stream.name)
        try:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.close()
            temporary.replace(path)
        finally:
            stream.close()
            temporary.unlink(missing_ok=True)


def symbol_files(root: Path) -> dict[str, str]:
    result = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"Symbol trees must not contain symlinks: {path}")
        if path.is_file() and path.name not in {"manifest.json", ".lock"}:
            result[path.relative_to(root).as_posix()] = digest(path)
    return result


def check_lines(path: Path) -> None:
    statistics = json.loads(run([tool("llvm-dwarfdump"), "--statistics", str(path)]))
    if not any(
        "debug_line" in key and "bytes" in key and value > 0
        for key, value in statistics.items()
    ):
        raise ValueError(f"No DWARF line information: {path}")


def pdb_identity(path: Path) -> str:
    summary = run([tool("llvm-pdbutil"), "dump", "-summary", str(path)])
    guid = re.search(r"GUID:\s*\{?([0-9A-Fa-f-]{36})", summary)
    age = re.search(r"Age:\s*(\d+)", summary)
    if (
        not guid
        or not age
        or "MinimalDebugInfo" in summary
        or re.search(r"Has Debug Info:\s*false", summary)
    ):
        raise ValueError(f"PDB must contain standalone debug information: {path}")
    return f"{guid[1].replace('-', '').lower()}-{int(age[1])}"


class SymbolStore:
    """One build owns a store; final products bind to its immutable module IDs."""

    def __init__(self, directory: Path, repository: Path = ROOT):
        self.root = directory.expanduser().resolve()
        self.repository = repository.resolve()

    def manifest(self, target: str | None = None) -> dict:
        path = self.root / "manifest.json"
        if path.exists():
            result = json.loads(path.read_text(encoding="utf-8"))
            if result.get("schemaVersion") != 1:
                raise ValueError("Unsupported symbol manifest schema")
            if target and result["build"]["target"] != target:
                raise ValueError("Symbol store target mismatch")
            if (
                os.environ.get("ASH_BUILD_ID")
                and result["build"]["id"] != os.environ["ASH_BUILD_ID"]
            ):
                raise ValueError("Refusing to reuse another compilation's symbol store")
            commit = os.environ.get("ASH_BUILD_COMMIT")
            if commit and result["build"]["commit"] != commit.lower():
                raise ValueError("Symbol store source commit differs from this compilation")
            return result
        build_id, commit = (
            os.environ.get("ASH_BUILD_ID"),
            os.environ.get("ASH_BUILD_COMMIT"),
        )
        if not build_id or not commit or not re.fullmatch(r"[a-fA-F0-9]{40}", commit):
            raise ValueError(
                "Symbols require ASH_BUILD_ID and ASH_BUILD_COMMIT set before compilation"
            )
        if not target:
            raise ValueError("New symbol stores require a target")
        import tomllib

        cargo = tomllib.loads((self.repository / "Cargo.toml").read_text())
        return {
            "schemaVersion": 1,
            "build": {
                "id": build_id,
                "commit": commit.lower(),
                "target": target,
                "builder": "cargo",
                "version": cargo["workspace"]["package"]["version"],
                "rustc": run(["rustc", "-Vv"]).strip(),
                "cargo": run(["cargo", "-V"]).strip(),
                "profile": cargo["profile"]["release"],
                "environment": {
                    key: value
                    for key, value in os.environ.items()
                    if key.startswith("CARGO_PROFILE_RELEASE_")
                    or (
                        key.startswith("CARGO_TARGET_")
                        and key.endswith(("_LINKER", "_RUSTFLAGS"))
                    )
                    or key in {"RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS"}
                },
                "inputs": {
                    name: digest(self.repository / name)
                    for name in (
                        "Cargo.toml",
                        "Cargo.lock",
                        "rust-toolchain.toml",
                        ".cargo/config.toml",
                    )
                },
                "ci": {
                    key: os.environ.get(key)
                    for key in (
                        "GITHUB_RUN_ID",
                        "GITHUB_RUN_ATTEMPT",
                        "GITHUB_JOB",
                        "GITHUB_WORKFLOW",
                        "GITHUB_REPOSITORY",
                    )
                },
            },
            "sourcePaths": [
                {"prefix": str(self.repository) + "/", "repositoryPath": ""}
            ],
            "coverage": {
                "included": "first-party Rust and linked Rust dependencies",
                "excluded": [
                    "prebuilt V8/C++",
                    "LiveKit Go",
                    "Electron",
                    "Node",
                    "plugins",
                    "system libraries",
                ],
            },
            "modules": [],
            "packages": [],
            "generatedSources": [],
        }

    def record_compilation(
        self, target: str, command: list[str], environment: dict, artifacts: list[dict]
    ) -> None:
        """Retain Cargo's actual executable paths, features and effective profiles."""
        self.root.mkdir(parents=True, exist_ok=True)
        with exclusive_lock(self.root / ".lock", create=True):
            manifest = self.manifest(target)
            invocations = manifest.setdefault("compilations", [])
            for artifact in artifacts:
                executable = artifact.get("executable")
                if not executable:
                    continue
                path = Path(executable)
                record = {
                    "compilerSha256": digest(path),
                    "binary": path.name,
                    "features": artifact["features"],
                    "profile": artifact["profile"],
                    "command": command,
                    "environment": {
                        key: value
                        for key, value in environment.items()
                        if key.startswith("CARGO_PROFILE_RELEASE_")
                        or key in {"RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS"}
                    },
                }
                invocations[:] = [
                    item
                    for item in invocations
                    if item["compilerSha256"] != record["compilerSha256"]
                ]
                invocations.append(record)
            write_json(self.root / "manifest.json", manifest)

    def collect(self, original: Path, staged: Path, target: str) -> dict:
        original, staged = original.resolve(), staged.resolve()
        if original == staged or os.path.samefile(original, staged):
            raise ValueError("Stripping requires a separate staging copy")
        module = identity(original)
        if digest(original) != digest(staged):
            raise ValueError("Staging input differs from compiler output")
        if not target.startswith(module["arch"] + "-"):
            raise ValueError("Module architecture does not match release target")
        if (module["format"] == "macho") != ("apple-darwin" in target) or (
            module["format"] == "pe"
        ) != ("windows-msvc" in target):
            raise ValueError("Module format does not match release target")
        self.root.mkdir(parents=True, exist_ok=True)
        with exclusive_lock(self.root / ".lock", create=True):
            manifest = self.manifest(target)
            key = f"{module['format']}-{module['arch']}-{module['id']}"
            destination = self.root / "modules" / key
            existing = next(
                (item for item in manifest["modules"] if item["key"] == key), None
            )
            if existing and existing["compilerSha256"] != digest(original):
                raise ValueError("Module ID collision with different compiler output")
            with tempfile.TemporaryDirectory(
                prefix=".symbols-", dir=self.root
            ) as temporary:
                work = Path(temporary)
                if module["format"] == "macho":
                    details = run(["codesign", "-dv", str(staged)])
                    if "Signature=adhoc" not in details:
                        raise ValueError("Refusing to strip a signed Mach-O input")
                    source = Path(str(original) + ".dSYM")
                    if source.is_symlink():
                        # Cargo publishes a dSYM alias into release/deps. Copy its
                        # verified contents; archives themselves contain no links.
                        resolved = source.resolve(strict=True)
                        if not resolved.is_relative_to(original.parent):
                            raise ValueError(
                                "dSYM alias leaves the compiler output directory"
                            )
                        source = resolved
                    if not source.is_dir():
                        raise ValueError(
                            f"Missing packed dSYM: {source}; build release with split-debuginfo=packed"
                        )
                    if source.is_symlink() or any(
                        path.is_symlink() for path in source.rglob("*")
                    ):
                        raise ValueError("dSYM inputs must not contain symlinks")
                    shutil.copytree(source, work / "symbols.dSYM")
                    objects = list(
                        (work / "symbols.dSYM/Contents/Resources/DWARF").iterdir()
                    )
                    if (
                        len(objects) != 1
                        or identity(objects[0])["id"] != module["id"]
                        or identity(objects[0])["arch"] != module["arch"]
                    ):
                        raise ValueError("dSYM UUID/architecture mismatch")
                    check_lines(objects[0])
                    symbol = objects[0].relative_to(work).as_posix()
                    run(["strip", "-S", "-x", str(staged)])
                elif module["format"] == "elf":
                    symbol = original.name + ".debug"
                    debug = work / symbol
                    run(
                        [
                            tool("llvm-objcopy"),
                            "--only-keep-debug",
                            str(original),
                            str(debug),
                        ]
                    )
                    if identity(debug)["id"] != module["id"]:
                        raise ValueError("Separate ELF build-id mismatch")
                    check_lines(debug)
                    run(
                        [
                            tool("llvm-strip"),
                            "--strip-debug",
                            "--strip-unneeded",
                            str(staged),
                        ]
                    )
                    run(
                        [
                            tool("llvm-objcopy"),
                            f"--add-gnu-debuglink={debug}",
                            str(staged),
                        ]
                    )
                    # Check the actual section written, including the GNU CRC.
                    link = work / "debuglink"
                    run(
                        [
                            tool("llvm-objcopy"),
                            f"--dump-section=.gnu_debuglink={link}",
                            str(staged),
                        ]
                    )
                    data = link.read_bytes()
                    with debug.open("rb") as stream:
                        crc = 0
                        while chunk := stream.read(1024 * 1024):
                            crc = zlib.crc32(chunk, crc)
                    if (
                        data.split(b"\0", 1)[0].decode() != symbol
                        or int.from_bytes(data[-4:], "little") != crc
                    ):
                        raise ValueError("ELF debuglink name/CRC mismatch")
                    link.unlink()
                else:
                    # Cargo often renames an executable while retaining underscores in
                    # its PDB. Select the PE reference, never infer from the exe name.
                    symbol = module["pdbName"]
                    pdb = original.parent / symbol
                    if not pdb.is_file() or pdb_identity(pdb) != module["id"]:
                        raise ValueError(f"Missing or mismatched PDB: {pdb}")
                    shutil.copyfile(pdb, work / symbol)
                if identity(staged)["id"] != module["id"]:
                    raise ValueError("Stripping changed the module identity")
                if not existing:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    if destination.exists():
                        shutil.rmtree(destination)
                    shutil.copytree(work, destination)
                    module.update(
                        key=key,
                        compilerSha256=digest(original),
                        compilation=next(
                            (
                                item
                                for item in manifest.get("compilations", [])
                                if item["compilerSha256"] == digest(original)
                            ),
                            {"source": "prebuilt input; Cargo invocation not captured"},
                        ),
                        symbolPath=(
                            destination.relative_to(self.root) / symbol
                        ).as_posix(),
                        files={
                            (
                                destination.relative_to(self.root) / relative
                            ).as_posix(): sha256
                            for relative, sha256 in symbol_files(destination).items()
                        },
                        symbolTool=run(
                            [
                                tool(
                                    "llvm-pdbutil"
                                    if module["format"] == "pe"
                                    else "llvm-dwarfdump"
                                ),
                                "--version",
                            ]
                        ).strip(),
                    )
                    manifest["modules"].append(module)
                    write_json(self.root / "manifest.json", manifest)
                return existing or module

    def bind(self, product: str, package: Path, extras: list[str] = ()) -> None:
        from build.lib.package import LAYOUT, validate_package_directory
        from build.lib.targets import target_spec

        metadata = json.loads((package / "ash-package.json").read_text())
        spec = target_spec(metadata["target"])
        validate_package_directory(package, spec)
        expected = [
            path.format(exe=".exe" if spec.is_windows else "")
            for component, path in LAYOUT["binaries"].items()
            if component != "livekit"
        ]
        if spec.is_windows:
            expected += [
                "bin/ash-windows-sandbox.exe",
                "bin/ash-windows-sandbox-service.exe",
            ]
        if "cli" in metadata["components"]:
            expected.append("bin/" + spec.cli_name)
        expected += extras
        with exclusive_lock(self.root / ".lock", create=True):
            manifest = self.manifest(spec.target)
            if (
                metadata["version"] != manifest["build"]["version"]
                or metadata["buildProfile"] != "release"
            ):
                raise ValueError(
                    "Final package version/profile differs from symbol build"
                )
            bindings = []
            for relative in expected:
                path = package / relative_path(relative)
                actual = identity(path)
                match = next(
                    (
                        module
                        for module in manifest["modules"]
                        if all(
                            module[key] == actual[key]
                            for key in ("format", "id", "arch")
                        )
                    ),
                    None,
                )
                if not match:
                    raise ValueError(
                        f"Missing exact companion symbols for {product}/{relative}"
                    )
                bindings.append(
                    {"path": relative, "module": match["key"], "sha256": digest(path)}
                )
            manifest["packages"] = [
                item for item in manifest["packages"] if item["product"] != product
            ]
            manifest["packages"].append(
                {
                    "product": product,
                    "buildId": metadata["buildId"],
                    "modules": bindings,
                }
            )
            write_json(self.root / "manifest.json", manifest)

    def archive(self, output: Path, archives: dict[str, Path]) -> Path:
        self.root.mkdir(parents=True, exist_ok=True)
        with exclusive_lock(self.root / ".lock", create=True):
            manifest = self.manifest()
            if not manifest["packages"] or {
                item["product"] for item in manifest["packages"]
            } != set(archives):
                raise ValueError(
                    "Every bound product requires its final release archive"
                )
            for package in manifest["packages"]:
                path = archives[package["product"]]
                package["archive"] = {"name": path.name, "sha256": digest(path)}
            # OUT_DIR sources are needed for lines which are not present in Git.
            target = manifest["build"]["target"]
            from build.lib.cargo import resolve_cargo_target_directory

            cargo_root = resolve_cargo_target_directory(self.repository)
            generated = cargo_root / target / "release/build"
            total = 0
            for path in sorted(generated.glob("*/out/**/*.rs")):
                if path.is_symlink():
                    raise ValueError("Generated sources must be regular files")
                total += path.stat().st_size
                if total > 128 * 1024**2:
                    raise ValueError("Generated source size limit exceeded")
                relative = path.relative_to(generated)
                destination = self.root / "sources" / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, destination)
            manifest["generatedSources"] = [
                {"prefix": str(generated) + "/", "archivePath": "sources/"}
            ]
            manifest["files"] = symbol_files(self.root)
            if (
                len(manifest["files"]) >= MAX_MEMBERS
                or sum((self.root / path).stat().st_size for path in manifest["files"])
                > MAX_ARCHIVE
            ):
                raise ValueError("Symbol archive size/member limit exceeded")
            for module in manifest["modules"]:
                if any(
                    manifest["files"].get(path) != sha256
                    for path, sha256 in module["files"].items()
                ):
                    raise ValueError(
                        "Collected symbols changed before archive creation"
                    )
            write_json(self.root / "manifest.json", manifest)
            validate_store(self.root)
            output.mkdir(parents=True, exist_ok=True)
            build = manifest["build"]
            build_key = hashlib.sha256(build["id"].encode()).hexdigest()[:24]
            name = f"ash-symbols-{build['version']}-{target}-cargo-{build_key}.tar.gz"
            destination = output / name
            if destination.exists():
                raise ValueError(f"Refusing to replace symbol archive: {destination}")
            with tempfile.NamedTemporaryFile(dir=output, delete=False) as temporary:
                partial = Path(temporary.name)
            try:
                with tarfile.open(partial, "w:gz") as archive:
                    for relative in ["manifest.json", *manifest["files"]]:
                        archive.add(
                            self.root / relative, arcname=relative, recursive=False
                        )
                partial.rename(destination)
            finally:
                partial.unlink(missing_ok=True)
            checksum = destination.with_name(destination.name + ".sha256")
            checksum.write_text(f"{digest(destination)}  {destination.name}\n")
            return destination


def validate_store(root: Path) -> dict:
    manifest = json.loads((root / "manifest.json").read_text())
    if manifest.get("schemaVersion") != 1 or not manifest.get("modules"):
        raise ValueError("Missing or unsupported symbol manifest")
    if manifest.get("files") != symbol_files(root):
        raise ValueError("Symbol archive file hashes do not match manifest")
    seen = set()
    for module in manifest["modules"]:
        if module["key"] in seen:
            raise ValueError("Duplicate symbol module identity")
        seen.add(module["key"])
        symbol = root / relative_path(module["symbolPath"])
        if not symbol.is_file():
            raise ValueError("Symbol path missing")
        actual = (
            pdb_identity(symbol) if module["format"] == "pe" else identity(symbol)["id"]
        )
        if actual != module["id"]:
            raise ValueError("Symbol ID mismatch")
    return manifest


def extract_archive(archive: Path, destination: Path, expected: str) -> dict:
    if archive.stat().st_size > MAX_ARCHIVE:
        raise ValueError("Symbol archive size limit exceeded")
    if not re.fullmatch(r"[a-f0-9]{64}", expected) or digest(archive) != expected:
        raise ValueError("Symbol archive SHA-256 mismatch")
    total, seen = 0, set()
    with tarfile.open(archive, "r:gz") as source:
        for count, member in enumerate(source):
            path = relative_path(member.name)
            total += member.size
            if (
                count >= MAX_MEMBERS
                or total > MAX_ARCHIVE
                or not member.isfile()
                or member.name in seen
            ):
                raise ValueError("Unsafe or oversized symbol archive member")
            seen.add(member.name)
            output = destination / path
            output.parent.mkdir(parents=True, exist_ok=True)
            stream = source.extractfile(member)
            with stream, output.open("xb") as target:
                shutil.copyfileobj(stream, target)
    return validate_store(destination)


def pairs(values: list[str]) -> dict[str, Path]:
    result = {}
    for value in values:
        key, separator, path = value.partition("=")
        if not key or not separator or key in result:
            raise ValueError("Expected unique PRODUCT=PATH arguments")
        result[key] = Path(path).resolve()
    return result


def capture_cargo_build(
    command: list[str], repository: Path, environment: dict, target: str
) -> int:
    """Preserve diagnostics while capturing release provenance from Cargo JSON."""
    from build.lib.cargo import cargo_rendered_diagnostic, parse_cargo_message

    if any(argument.startswith("--message-format") for argument in command):
        raise ValueError(
            "Symbol provenance owns Cargo's message format for release builds"
        )
    command = [*command, "--message-format=json-render-diagnostics"]
    artifacts = []
    with subprocess.Popen(
        command, cwd=repository, env=environment, stdout=subprocess.PIPE, text=True
    ) as process:
        try:
            for line in process.stdout:
                message = parse_cargo_message(line)
                if message is None:
                    sys.stdout.write(line)
                    continue
                diagnostic = cargo_rendered_diagnostic(message)
                if diagnostic:
                    sys.stderr.write(diagnostic)
                if message.get("reason") == "compiler-artifact" and message.get(
                    "executable"
                ):
                    artifacts.append(message)
            status = process.wait()
        except BaseException:
            process.kill()
            process.wait()
            raise
    if status == 0:
        SymbolStore(
            Path(environment["ASH_SYMBOLS_DIR"]), repository
        ).record_compilation(target, command, environment, artifacts)
    return status


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--symbols-dir",
        type=Path,
        default=os.environ.get("ASH_SYMBOLS_DIR"),
    )
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("build-update-host")
    build.add_argument("--target", required=True)
    build.add_argument("--artifact-file", type=Path, required=True)
    collect = sub.add_parser("collect")
    collect.add_argument("--binary", type=Path, required=True)
    collect.add_argument("--staged", type=Path, required=True)
    collect.add_argument("--target", required=True)
    archive = sub.add_parser("archive")
    archive.add_argument(
        "--package", action="append", default=[], metavar="PRODUCT=PATH"
    )
    archive.add_argument(
        "--archive", action="append", default=[], metavar="PRODUCT=PATH"
    )
    archive.add_argument(
        "--desktop",
        type=Path,
        help="Desktop backend resources directory (includes update host)",
    )
    archive.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "build-update-host":
        from build.lib.package_binaries import build_binaries
        from build.lib.targets import target_spec

        binaries = build_binaries(
            ROOT,
            target_spec(args.target),
            {"ash-update-host": None},
            cargo="cargo",
            cargo_profile="release",
        )
        write_json(args.artifact_file, {"binary": str(binaries["ash-update-host"])})
        return 0
    if not args.symbols_dir:
        parser.error("--symbols-dir or ASH_SYMBOLS_DIR is required")
    store = SymbolStore(args.symbols_dir)
    if args.command == "collect":
        store.collect(args.binary, args.staged, args.target)
    else:
        for product, package in pairs(args.package).items():
            store.bind(product, package)
        if args.desktop:
            suffix = ".exe" if "windows" in store.manifest()["build"]["target"] else ""
            store.bind("ash-desktop", args.desktop, ["bin/ash-update-host" + suffix])
        print(store.archive(args.output, pairs(args.archive)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
