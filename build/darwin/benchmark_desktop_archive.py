"""Compare ZIP and LZMA DMG delivery from one notarized Ash Desktop bundle."""

import argparse
import json
import platform
import plistlib
import subprocess
import sys
from pathlib import Path
from statistics import median
from tempfile import TemporaryDirectory
from time import perf_counter


def run(*args: str | Path) -> None:
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL)


def verify_bundle(bundle: Path) -> None:
    run("codesign", "--verify", "--deep", "--strict", bundle)
    run("xcrun", "stapler", "validate", bundle)


def install(archive: Path, target: Path, bundle_name: str) -> float:
    target.mkdir()
    if archive.suffix == ".zip":
        start = perf_counter()
        run("ditto", "-x", "-k", archive, target)
    else:
        mount = target / "mounted-image"
        mount.mkdir()
        start = perf_counter()
        run(
            "hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", mount, archive
        )
        try:
            run("ditto", mount / bundle_name, target / bundle_name)
        finally:
            run("hdiutil", "detach", mount)
    duration = perf_counter() - start
    verify_bundle(target / bundle_name)
    return duration


def benchmark(bundle: Path, output: Path, runs: int) -> dict:
    bundle = bundle.resolve(strict=True)
    output = output.resolve()
    if not bundle.is_dir() or bundle.suffix != ".app":
        raise ValueError("Expected an Ash Desktop .app directory")
    if output == bundle or bundle in output.parents:
        raise ValueError("The output directory must be outside the application bundle")
    if output.exists():
        raise FileExistsError(f"The output directory already exists: {output}")
    if runs < 1:
        raise ValueError("At least one timing run is required")

    verify_bundle(bundle)
    with (bundle / "Contents" / "Info.plist").open("rb") as info_file:
        info = plistlib.load(info_file)
    output.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix="ash-archive-benchmark-", dir=output.parent) as temp:
        work = Path(temp)
        source = work / "payload"
        source.mkdir()
        staged = source / bundle.name
        run("ditto", bundle, staged)

        zip_path = work / f"{bundle.stem}.zip"
        dmg_path = work / f"{bundle.stem}-lzma.dmg"
        run("ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", staged, zip_path)
        run(
            "hdiutil",
            "create",
            "-srcfolder",
            source,
            "-format",
            "ULMO",
            "-volname",
            bundle.stem,
            "-o",
            dmg_path,
        )

        zip_runs: list[float] = []
        dmg_runs: list[float] = []
        variants = [(zip_path, zip_runs), (dmg_path, dmg_runs)]
        for index in range(runs):
            # Alternate the order so one format does not always get the warmer cache.
            order = variants if index % 2 == 0 else reversed(variants)
            for archive, samples in order:
                with TemporaryDirectory(dir=work) as run_dir:
                    samples.append(
                        install(archive, Path(run_dir) / "install", bundle.name)
                    )

        zip_size = zip_path.stat().st_size
        dmg_size = dmg_path.stat().st_size
        saved = zip_size - dmg_size
        report = {
            "bundle": bundle.name,
            "bundleIdentifier": info.get("CFBundleIdentifier"),
            "bundleVersion": info.get("CFBundleVersion"),
            "macOS": platform.mac_ver()[0],
            "architecture": platform.machine(),
            "timingScope": "Local ZIP extraction or DMG mount, copy and detach",
            "zip": {
                "bytes": zip_size,
                "installSeconds": zip_runs,
                "medianInstallSeconds": median(zip_runs),
            },
            "lzmaDmg": {
                "bytes": dmg_size,
                "installSeconds": dmg_runs,
                "medianInstallSeconds": median(dmg_runs),
            },
            "downloadBytesSaved": saved,
            "downloadPercentSaved": 100 * saved / zip_size,
        }
        report_path = work / "report.json"
        report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        output.mkdir()
        for file in (zip_path, dmg_path, report_path):
            file.rename(output / file.name)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", required=True, type=Path, help="Stapled Ash.app")
    parser.add_argument(
        "--output", required=True, type=Path, help="New result directory"
    )
    parser.add_argument(
        "--runs", type=int, default=3, help="Local install timings per format"
    )
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("The benchmark requires macOS system packaging tools")
    print(json.dumps(benchmark(args.app, args.output, args.runs), indent=2))


if __name__ == "__main__":
    main()
