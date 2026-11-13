"""Prepare the browser's Arkdown module from the owning Rust workspace crate."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib

_OUTPUTS = (
    "ash_arkdown.js",
    "ash_arkdown_bg.wasm",
    "ash_arkdown.d.ts",
    "ash_arkdown_bg.wasm.d.ts",
)

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from build.lib.file_lock import exclusive_lock  # noqa: E402


def input_digest(root: Path) -> str:
    files = [
        root / name
        for name in (
            "Cargo.toml",
            "Cargo.lock",
            "rust-toolchain.toml",
            "build/arkdown.py",
            "scripts/cargo.py",
            ".cargo/config.toml",
        )
    ]
    files += sorted((root / "crates/arkdown").rglob("*.rs"))
    files.append(root / "crates/arkdown/Cargo.toml")
    digest = hashlib.sha256()
    for path in files:
        digest.update(path.relative_to(root).as_posix().encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def output_hashes(output: Path) -> dict[str, str] | None:
    try:
        return {
            name: hashlib.sha256((output / name).read_bytes()).hexdigest()
            for name in _OUTPUTS
        }
    except FileNotFoundError:
        return None


def prepare(root: Path = ROOT) -> Path:
    directory = root / ".build/arkdown"
    directory.mkdir(parents=True, exist_ok=True)
    output = directory / "web"
    stamp = directory / "browser-inputs.json"
    with exclusive_lock(directory / "prepare.lock", create=True):
        digest = input_digest(root)
        try:
            cached = json.loads(stamp.read_text())
        except (FileNotFoundError, ValueError):
            cached = None
        artifacts = output_hashes(output)
        if artifacts is not None and cached == {"digest": digest, "outputs": artifacts}:
            return output
        manifest = tomllib.loads((root / "Cargo.toml").read_text())
        version = manifest["workspace"]["dependencies"]["wasm-bindgen"].removeprefix(
            "="
        )
        tools = root / ".build/tools/arkdown"
        executable = (
            tools / "bin" / ("wasm-bindgen.exe" if os.name == "nt" else "wasm-bindgen")
        )
        if not executable.is_file():
            subprocess.run(
                [
                    "cargo",
                    "install",
                    "wasm-bindgen-cli",
                    "--version",
                    version,
                    "--locked",
                    "--root",
                    str(tools),
                ],
                cwd=root,
                check=True,
            )
        actual = subprocess.check_output(
            [str(executable), "--version"], text=True
        ).strip()
        if actual != f"wasm-bindgen {version}":
            raise RuntimeError(f"Expected wasm-bindgen {version}, got {actual}")
        subprocess.run(
            ["rustup", "target", "add", "wasm32-unknown-unknown"], cwd=root, check=True
        )
        subprocess.run(
            [
                sys.executable,
                "-B",
                "scripts/cargo.py",
                "build",
                "-p",
                "ash-arkdown",
                "--profile",
                "dev-small",
                "--target",
                "wasm32-unknown-unknown",
                "--features",
                "wasm",
                "--lib",
            ],
            cwd=root,
            check=True,
        )
        wasm = root / ".build/cargo/wasm32-unknown-unknown/dev-small/ash_arkdown.wasm"
        with tempfile.TemporaryDirectory(
            prefix="bindings-", dir=directory
        ) as temporary:
            subprocess.run(
                [str(executable), str(wasm), "--target", "web", "--out-dir", temporary],
                cwd=root,
                check=True,
            )
            output.mkdir(exist_ok=True)
            for path in Path(temporary).iterdir():
                path.replace(output / path.name)
        temporary_stamp = stamp.with_suffix(".tmp")
        artifacts = output_hashes(output)
        if artifacts is None:
            raise RuntimeError(
                "Arkdown binding generation did not produce every browser artifact"
            )
        temporary_stamp.write_text(
            json.dumps({"digest": digest, "outputs": artifacts}) + "\n"
        )
        temporary_stamp.replace(stamp)
    return output


if __name__ == "__main__":
    print(f"Prepared Arkdown: {prepare()}")
