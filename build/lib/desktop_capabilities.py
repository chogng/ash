"""Stage Windows Desktop runtime packages for product-bound downloads."""

import hashlib
import json
import shutil
import subprocess
from pathlib import Path

from build.builtin import write_builtin_extension_index
from build.lib.grammars import resolve_grammars_cargo_env
from build.lib.media_package import DESKTOP_NATIVE_GRAMMARS, capability_release
from build.lib.package import package_build_id, package_files
from build.lib.package_binaries import build_binaries
from build.lib.targets import TargetSpec


def write_capability(
    resources: Path,
    root: Path,
    metadata: dict,
    spec: TargetSpec,
    kind: str,
    entrypoint: str,
    archive_directory: Path,
) -> None:
    (root / "bin").mkdir(exist_ok=True)
    (root / "ash-path").mkdir(exist_ok=True)
    (root / "ash-resources").mkdir(exist_ok=True)
    files = package_files(root)
    if entrypoint not in files:
        raise ValueError(f"Missing Desktop capability entrypoint: {entrypoint}")
    identity = {
        "layoutVersion": 2,
        "version": metadata["version"],
        "target": spec.target,
        "buildProfile": metadata["buildProfile"],
        "entrypoint": entrypoint,
        "pathDir": "ash-path",
        "resourcesDir": "ash-resources",
        "javascriptRuntime": {"kind": kind},
        "protocol": {
            "major": 1,
            "schemaHash": "sha256:" + hashlib.sha256(kind.encode("ascii")).hexdigest(),
        },
        "components": {},
    }
    (root / "ash-package.json").write_text(
        json.dumps(
            {**identity, "files": files, "buildId": package_build_id(identity, files)},
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    release = capability_release(
        root, spec, metadata["buildProfile"], kind, archive_dir=archive_directory
    )
    capability = resources / "ash-resources" / "capabilities"
    capability.mkdir(exist_ok=True)
    (capability / f"{kind}.json").write_text(
        json.dumps(release, indent=2) + "\n", encoding="utf-8"
    )


def split_typescript(
    resources: Path, packages: Path, metadata: dict, spec: TargetSpec, archives: Path
) -> None:
    kind = "desktop-typescript"
    relative = Path("ash-resources/extensions/typescript-basics")
    package = resources / relative
    # The managed language server uses tsserver and the standard library from this
    # private package. Workspace build tasks obtain tsc from the workspace toolchain.
    compiler = package / "node_modules/typescript"
    for file in ("bin/tsc", "lib/tsc.js", "lib/_tsc.js"):
        (compiler / file).unlink(missing_ok=True)
    # Preserve the original full-tree index for verifying the acquired runtime.
    write_builtin_extension_index(
        package.parent, package.parent.parent / "extensions.index"
    )
    root = packages / kind
    shutil.copytree(package, root / relative)
    write_capability(
        resources,
        root,
        metadata,
        spec,
        kind,
        (relative / "server.mjs").as_posix(),
        archives,
    )
    shutil.rmtree(package / "node_modules")


def split_debuggers(
    resources: Path, packages: Path, metadata: dict, spec: TargetSpec, archives: Path
) -> None:
    kind = "desktop-debug"
    root = packages / kind
    (root / "bin").mkdir(parents=True)
    for component, binary in (
        ("lldbExtension", "ash-debug-lldb"),
        ("javascriptDebugExtension", "ash-debug-javascript"),
        ("serverReadyExtension", "ash-debug-server-ready"),
    ):
        relative = Path(f"bin/{binary}{spec.executable_suffix}")
        shutil.move(resources / relative, root / relative)
        del metadata["components"][component]
    relative = Path("ash-resources/extensions/debug-javascript")
    shutil.copytree(resources / relative, root / relative)
    shutil.rmtree(resources / relative / "runtime")
    write_capability(
        resources,
        root,
        metadata,
        spec,
        kind,
        f"bin/ash-debug-javascript{spec.executable_suffix}",
        archives,
    )


def stage_computer_use(
    resources: Path, packages: Path, metadata: dict, spec: TargetSpec, archives: Path
) -> None:
    kind = "desktop-computer-use"
    binary = build_binaries(
        Path(__file__).resolve().parents[2],
        spec,
        {"ash-computer-use": None},
        cargo="cargo",
        cargo_profile=metadata["buildProfile"],
    )["ash-computer-use"]
    root = packages / kind
    executable = Path("bin") / f"ash-computer-use{spec.executable_suffix}"
    (root / executable).parent.mkdir(parents=True)
    shutil.copy2(binary, root / executable)
    write_capability(
        resources, root, metadata, spec, kind, executable.as_posix(), archives
    )


def stage_native_grammars(
    resources: Path, packages: Path, metadata: dict, spec: TargetSpec, archives: Path
) -> None:
    native = Path(resolve_grammars_cargo_env(spec.target)["ASH_GRAMMARS_LIB_DIR"])
    grammars = json.loads(DESKTOP_NATIVE_GRAMMARS.read_text(encoding="utf-8"))
    work = packages / "grammar-link"
    work.mkdir()
    for name, (_, symbol) in grammars.items():
        kind = f"desktop-grammar-{name}"
        root = packages / kind
        destination = root / "ash-resources"
        destination.mkdir(parents=True)
        source = work / (name + ".rs")
        source.write_text(
            f'unsafe extern "C" {{ fn {symbol}() -> *const (); }}\n'
            f'#[unsafe(no_mangle)] pub extern "C" fn ash_tree_sitter_language() -> *const () {{ unsafe {{ {symbol}() }} }}\n',
            encoding="utf-8",
        )
        dll = work / (name + ".dll")
        subprocess.run(
            [
                "rustc",
                "--edition=2024",
                "--crate-type=cdylib",
                "--target",
                spec.target,
                "-C",
                "opt-level=s",
                "-C",
                "panic=abort",
                "-C",
                "strip=symbols",
                "-C",
                "target-feature=+crt-static",
                "-C",
                "link-arg=/Brepro",
                "-L",
                f"native={native}",
                "-l",
                "static=ash_grammars",
                "-o",
                str(dll),
                str(source),
            ],
            cwd=DESKTOP_NATIVE_GRAMMARS.parents[2],
            check=True,
        )
        shutil.move(dll, destination / "grammar.dll")
        shutil.copytree(native.parent / "licenses", destination / "licenses")
        write_capability(
            resources, root, metadata, spec, kind, "ash-resources/grammar.dll", archives
        )
    shutil.rmtree(work)
