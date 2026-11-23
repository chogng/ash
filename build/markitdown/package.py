"""Build an optional, offline MarkItDown runtime for the current Ash target."""

import argparse
import gzip
import shutil
import subprocess
import sys
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from build.download.artifacts import archive_is_valid, download_and_verify, sha256  # noqa: E402
from build.lib.file_lock import exclusive_lock  # noqa: E402
from build.lib.package import package_build_id, package_files, write_json  # noqa: E402
from build.lib.targets import default_target, target_spec  # noqa: E402

SOURCE = Path(__file__).resolve().parent
PYTHON_VERSION = "3.12.14"
PYTHON_RELEASE = "20260924"
MARKITDOWN_VERSION = "0.1.9"
MAX_ARCHIVE_BYTES = 128 * 1024 * 1024  # Ash capability store download limit.
PYTHON_ARTIFACTS = {
    "aarch64-apple-darwin": (
        25017789,
        "c2edb321cd32ec2b170df208db0446dccc4398db602ca27cf2079098fb1f7d9d",
    ),
    "x86_64-apple-darwin": (
        24719239,
        "7ea9761b9069c10b9a20531d568645849d604c59e9c7f11f6659f1e1790c968e",
    ),
    "aarch64-unknown-linux-gnu": (
        29199580,
        "c8499b61252c433280f134df954464d19811527b31cb920c35fc6967c1222e35",
    ),
    "x86_64-unknown-linux-gnu": (
        34270188,
        "269b2c99e4db15b242bf01832f4fea1e8f1a664f273cff519393f296e9820b41",
    ),
    "x86_64-pc-windows-msvc": (
        22052624,
        "c5bf8edfe858c1df9891be498b5bbc8761d383df5b9790658b088fea4870433a",
    ),
}


@dataclass(frozen=True)
class PythonArchive:
    url: str
    size: int
    sha256: str


def python_archive(target: str, cache: Path) -> Path:
    size, digest = PYTHON_ARTIFACTS[target]
    name = f"cpython-{PYTHON_VERSION}+{PYTHON_RELEASE}-{target}-install_only_stripped.tar.gz"
    url = (
        "https://github.com/astral-sh/python-build-standalone/releases/download/"
        f"{PYTHON_RELEASE}/{name}"
    )
    path = cache / name
    artifact = PythonArchive(url, size, digest)
    cache.mkdir(parents=True, exist_ok=True)
    with exclusive_lock(cache / ".download.lock", create=True):
        if not archive_is_valid(path, artifact):
            download_and_verify(artifact, path)
    return path


def trim_runtime(python: Path, executable: Path, stdlib: Path, packages: Path) -> None:
    # This runtime only starts the private interpreter and calls the converters' Python APIs.
    # Keep the original wheels' license files and all converter/model/native library data.
    unused_directories = [
        python / "include",
        python / "share" / "man",
        python / "lib" / "pkgconfig",
        stdlib / "ensurepip",
        stdlib / "idlelib",
        stdlib / "test",
        stdlib / "turtledemo",
        packages / "bin",
        packages / "Scripts",
        packages / "pip",
        packages / "pandas" / "tests",
        packages / "numpy" / "tests",
        *packages.glob("pip-*.dist-info"),
    ]
    for directory in unused_directories:
        if directory.is_dir():
            shutil.rmtree(directory)
    for directory in python.rglob("__pycache__"):
        shutil.rmtree(directory)
    if executable.parent.name == "bin":
        for entry in executable.parent.iterdir():
            if entry != executable:
                entry.unlink()
    else:
        (python / "pythonw.exe").unlink(missing_ok=True)
        scripts = python / "Scripts"
        if scripts.is_dir():
            shutil.rmtree(scripts)

    # The Ash package store accepts regular files. Preserve library aliases as files when
    # present, without copying anything from outside the locked Python distribution.
    for link in python.rglob("*"):
        if link.is_symlink():
            source = link.resolve(strict=True)
            if not source.is_relative_to(python) or not source.is_file():
                raise ValueError(f"Unexpected Python runtime link: {link}")
            link.unlink()
            shutil.copy2(source, link)


def build(output: Path, cache: Path, artifact_url: str | None) -> Path:
    target = default_target()
    if target not in PYTHON_ARTIFACTS:
        raise ValueError(f"MarkItDown packaging is unsupported on {target}")
    if artifact_url is not None:
        url = urlsplit(artifact_url)
        if (
            url.scheme != "https"
            or not url.hostname
            or url.username is not None
            or url.password is not None
            or url.query
            or url.fragment
        ):
            raise ValueError("The runtime URL must be a credential-free HTTPS URL")
    if output.exists():
        raise FileExistsError(output)

    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".markitdown-", dir=output.parent) as work:
        directory = Path(work)
        runtime = directory / "runtime"
        with tarfile.open(python_archive(target, cache), "r:gz") as source:
            source.extractall(runtime, filter="data")
        python = runtime / "python"
        windows = target_spec(target).is_windows
        executable = python / ("python.exe" if windows else "bin/python3.12")
        stdlib = python / ("Lib" if windows else "lib/python3.12")
        packages = stdlib / "site-packages"
        subprocess.run(
            [
                "uv",
                "--no-config",
                "pip",
                "sync",
                "--only-binary",
                ":all:",
                "--require-hashes",
                "--python",
                str(executable),
                "--target",
                str(packages),
                str(SOURCE / "requirements.lock"),
            ],
            check=True,
        )
        trim_runtime(python, executable, stdlib, packages)
        worker = runtime / "convert.py"
        shutil.copyfile(SOURCE / worker.name, worker)
        subprocess.run(
            [str(executable), "-I", "-B", "-X", "utf8", str(worker), "--help"],
            stdout=subprocess.DEVNULL,
            check=True,
        )

        files = package_files(runtime)
        identity = {
            "layoutVersion": 2,
            "version": MARKITDOWN_VERSION,
            "target": target,
            "buildProfile": "release",
            "javascriptRuntime": {"kind": "markitdown"},
            "entrypoint": executable.relative_to(runtime).as_posix(),
            "protocol": {"major": 1, "schemaHash": "sha256:" + sha256(worker)},
        }
        build_id = package_build_id(identity, files)
        write_json(
            runtime / "ash-package.json",
            {**identity, "files": files, "buildId": build_id},
        )

        release = directory / "release"
        release.mkdir()
        archive = release / f"ash-markitdown-{MARKITDOWN_VERSION}-{target}.tar.gz"
        with (
            archive.open("wb") as raw,
            gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed,
            tarfile.open(fileobj=compressed, mode="w|") as tar,
        ):
            for name in sorted((*files, "ash-package.json")):
                file = runtime / name
                info = tar.gettarinfo(str(file), arcname=name)
                info.uid = info.gid = info.mtime = 0
                info.uname = info.gname = ""
                with file.open("rb") as content:
                    tar.addfile(info, content)

        size = archive.stat().st_size
        if size > MAX_ARCHIVE_BYTES:
            raise ValueError(
                f"MarkItDown archive exceeds the capability store limit: {size}"
            )
        digest = sha256(archive)
        (release / (archive.name + ".sha256")).write_text(
            f"{digest}  {archive.name}\n", encoding="utf-8"
        )
        if artifact_url is not None:
            write_json(
                release / "markitdown.json",
                {
                    "schemaVersion": 1,
                    "target": target,
                    "buildId": build_id,
                    "source": {
                        "kind": "archive",
                        "url": artifact_url,
                        "size": size,
                        "sha256": digest,
                    },
                },
            )
        release.rename(output)
    return output / archive.name


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--cache", type=Path, default=ROOT / ".build/markitdown/downloads"
    )
    parser.add_argument(
        "--artifact-url",
        help="Emit a product-bound capability descriptor for this HTTPS URL",
    )
    arguments = parser.parse_args()
    print(
        build(
            arguments.output.resolve(),
            arguments.cache.resolve(),
            arguments.artifact_url,
        )
    )
