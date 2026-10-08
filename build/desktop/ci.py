"""Cache backend packages and transfer Electron test builds without local paths."""

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tarfile
from collections.abc import Mapping
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from build.download.artifacts import sha256
from build.lib.package import LAYOUT
from build.prepare import (
    BUILD_ENVIRONMENT_PREFIXES,
    BUILD_ENVIRONMENT_VARIABLES,
    current_package,
    development_root,
    development_source_paths,
)
from build.lib.targets import default_target
from build.protocol.artifacts import graph_source_files


def backend_cache_key(root: Path, environment: Mapping[str, str] = os.environ) -> str:
    image = environment.get("ImageVersion")
    if not image:
        raise ValueError(
            "Prepared backend caching requires the hosted runner ImageVersion"
        )
    paths = development_source_paths(root) + graph_source_files(root, [])
    paths += [root / license["source"] for license in LAYOUT["licenses"]]
    paths += [
        root / name
        for name in (
            "build/desktop/ci.py",
            ".github/actions/setup-frontend/action.yml",
            ".github/workflows/frontend-tests.yml",
            "scripts/install_python_tools.py",
            "scripts/requirements.txt",
            "package.json",
            "pnpm-lock.yaml",
            "pnpm-workspace.yaml",
            ".nvmrc",
        )
    ]
    # Git selects checkout inputs, excluding downloaded/build outputs under source
    # directories. Hash paths and contents so renames and deletions also invalidate.
    result = subprocess.run(
        [
            "git",
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            *(path.relative_to(root).as_posix() for path in paths),
        ],
        cwd=root,
        check=True,
        capture_output=True,
    )
    settings = {
        "image": image,
        "imageOS": environment.get("ImageOS"),
        "environment": {
            name: value
            for name, value in environment.items()
            if name in BUILD_ENVIRONMENT_VARIABLES
            or name.startswith(BUILD_ENVIRONMENT_PREFIXES)
        },
    }
    digest = hashlib.sha256(json.dumps(settings, sort_keys=True).encode())
    for name in sorted(set(result.stdout.split(b"\0")) - {b""}):
        path = root / os.fsdecode(name)
        digest.update(name + b"\0")
        if path.is_symlink():
            digest.update(b"symlink\0" + os.fsencode(os.readlink(path)))
        else:
            digest.update(str(path.stat().st_mode & 0o111).encode() + b"\0")
            digest.update(sha256(path).encode())
        digest.update(b"\0")
    return f"frontend-backend-v1-{default_target()}-{digest.hexdigest()}"


def archive(root: Path, output: Path, *, backend_only: bool = False) -> None:
    # Published package names and vendored resources can exceed Windows MAX_PATH.
    if os.name == "nt":
        root = Path("\\\\?\\" + str(root.resolve()).removeprefix("\\\\?\\"))
        output = Path("\\\\?\\" + str(output.resolve()).removeprefix("\\\\?\\"))
    store = development_root(root, default_target(), "host-provided-node")
    paths = [current_package(store)]
    # Transfer only the selected package and its manifest, not old generations,
    # Cargo intermediates or prepare-inputs.json with builder-specific paths.
    paths.append(sorted((store / "manifests").glob("[0-9]" * 20 + ".json"))[-1])
    binding = None
    if not backend_only:
        paths += [
            root / ".build/desktop" / name
            for name in ("package.json", "main", "preload", "renderer", "localization")
        ]
        paths += [
            root / ".build/protocol",
            root / ".build/protocol-sources.json",
            root / "src/ash/platform/extensions/common/generated",
        ]
        binding = root / "node_modules/native-keymap/build/Release/keymapping.node"
    for path in paths + ([binding] if binding else []):
        if not path.exists():
            raise FileNotFoundError(f"Missing Electron test build output: {path}")
    output.parent.mkdir(parents=True, exist_ok=True)
    # Fast compression is enough for this run's consumers. Tar retains Unix
    # executable modes; dereferencing leaves declarative resources single-link files.
    with tarfile.open(output, "w:gz", compresslevel=1, dereference=True) as bundle:
        for path in paths:
            bundle.add(path, arcname=path.relative_to(root).as_posix())
        # Extract outside pnpm's directory links, then copy into the installed module.
        if binding:
            bundle.add(binding, arcname=".build/ci/keymapping.node")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, nargs="?")
    parser.add_argument("--backend-only", action="store_true")
    parser.add_argument("--cache-key", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    if args.cache_key:
        print(backend_cache_key(root))
    elif args.output is None:
        parser.error("output is required when archiving a build")
    else:
        archive(root, args.output, backend_only=args.backend_only)
