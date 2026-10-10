#!/usr/bin/env python3
"""Offline import of .ips/classic reports, LLDB core/minidumps and module-aware JSON."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from build.release.identity import identity  # noqa: E402
from build.release.symbols import digest, extract_archive, relative_path, write_json  # noqa: E402
from build.release.tools import run, tool  # noqa: E402

MAX_REPORT = 32 * 1024**2
MAX_FRAMES = 8192


def number(value) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ValueError("Address must be an integer or hexadecimal string")
    result = int(value, 0) if isinstance(value, str) else int(value)
    if not 0 <= result < 2**64:
        raise ValueError("Invalid address")
    return result


def apple_report(text: str) -> dict:
    decoder = json.JSONDecoder()
    first, end = decoder.raw_decode(text.lstrip())
    data = (
        first
        if "usedImages" in first
        else decoder.raw_decode(text.lstrip()[end:].lstrip())[0]
    )
    modules = [
        {
            "format": "macho",
            "arch": {"arm64": "aarch64", "arm64e": "aarch64", "x86_64": "x86_64"}.get(
                image.get("arch"), image.get("arch")
            ),
            "id": image.get("uuid", "").replace("-", "").lower(),
            "name": image.get("name"),
            "base": number(image["base"]),
            "size": number(image["size"]),
        }
        for image in data["usedImages"]
    ]
    frames = []
    for index, thread in enumerate(data["threads"]):
        for frame in thread.get("frames", []):
            image = frame.get("imageIndex")
            if image is None or image >= len(modules) or image < 0:
                frames.append(
                    {
                        "thread": index,
                        "pc": frame.get("imageOffset"),
                        "reason": "Missing image identity",
                    }
                )
                continue
            offset = number(frame["imageOffset"])
            frames.append(
                {
                    "thread": index,
                    "module": image,
                    "pc": modules[image]["base"] + offset,
                    "addressKind": "reportedPC",
                }
            )
    return {"schemaVersion": 1, "modules": modules, "frames": frames}


def classic_report(text: str) -> dict:
    images = text.partition("Binary Images:")[2]
    modules = []
    for line in images.splitlines():
        match = re.match(
            r"\s*(0x[0-9a-fA-F]+)\s*-\s*(0x[0-9a-fA-F]+)\s+\+?(.*?)\s+(arm64e?|x86_64)\s+<([0-9a-fA-F-]+)>",
            line,
        )
        if match:
            base, last = int(match[1], 16), int(match[2], 16)
            modules.append(
                {
                    "format": "macho",
                    "arch": "aarch64" if match[4].startswith("arm64") else "x86_64",
                    "id": match[5].replace("-", "").lower(),
                    "name": match[3],
                    "base": base,
                    "size": last - base + 1,
                }
            )
    frames, thread = [], None
    for line in text.partition("Binary Images:")[0].splitlines():
        match = re.match(r"Thread (\d+)(?: Crashed)?:", line)
        if match:
            thread = int(match[1])
        match = re.match(r"\s*\d+\s+.+?\s+(0x[0-9a-fA-F]+)\s+", line)
        if match and thread is not None:
            pc = int(match[1], 16)
            index = next(
                (
                    index
                    for index, module in enumerate(modules)
                    if module["base"] <= pc < module["base"] + module["size"]
                ),
                None,
            )
            frames.append(
                {
                    "thread": thread,
                    "module": index,
                    "pc": pc,
                    "addressKind": "reportedPC",
                }
            )
    if not modules or not frames:
        raise ValueError("Crash report has no module identities or stack frames")
    return {"schemaVersion": 1, "modules": modules, "frames": frames}


def load_report(
    path: Path, images: Path | None, executable: Path | None, manifest: dict
) -> dict:
    with path.open("rb") as stream:
        magic = stream.read(4)
    if magic in {b"MDMP", b"\x7fELF", b"\xcf\xfa\xed\xfe"}:
        if path.stat().st_size > 16 * 1024**3:
            raise ValueError("Dump size limit exceeded")
        if not images or not executable:
            raise ValueError(
                "Dump import requires --images and --executable from a matching final product"
            )
        verify_image(executable, manifest)
        with tempfile.TemporaryDirectory(prefix="ash-dump-") as temporary:
            config = Path(temporary) / "config.json"
            result = Path(temporary) / "report.json"
            write_json(
                config,
                {
                    "dump": str(path.resolve()),
                    "executable": str(executable.resolve()),
                    "output": str(result),
                    "root": str(ROOT),
                    "images": [
                        str(candidate.resolve())
                        for package in manifest["packages"]
                        for binding in package["modules"]
                        if (
                            candidate := images / relative_path(binding["path"])
                        ).is_file()
                        and verify_image(candidate, manifest)
                    ],
                },
            )
            # Only our adapter is imported. Neither user init files nor scripts
            # embedded in debug info are executed, and symbol servers stay disabled.
            command = f"script import sys; sys.path.insert(0, {str(ROOT)!r}); from build.release.dump import export; export(lldb.debugger, {str(config)!r})"
            transcript = run(
                [
                    tool("lldb"),
                    "--no-lldbinit",
                    "--batch",
                    "-o",
                    "settings set target.load-script-from-symbol-file false",
                    "-o",
                    command,
                ]
            )
            if not result.is_file():
                raise ValueError(
                    f"Debugger could not import dump: {transcript[-4000:]}"
                )
            return json.loads(result.read_text())
    if path.stat().st_size > MAX_REPORT:
        raise ValueError("Crash report size limit exceeded")
    text = path.read_text(encoding="utf-8").lstrip()
    if text.startswith("{"):
        first = json.JSONDecoder().raw_decode(text)[0]
        if first.get("schemaVersion") == 1:
            return first
        return apple_report(text)
    return classic_report(text)


def verify_image(path: Path, manifest: dict) -> dict:
    actual = identity(path)
    module = next(
        (
            module
            for module in manifest["modules"]
            if all(module[key] == actual[key] for key in ("id", "format", "arch"))
        ),
        None,
    )
    if not module:
        raise ValueError(f"Final image identity mismatch: {path}")
    hashes = {
        binding["sha256"]
        for package in manifest["packages"]
        for binding in package["modules"]
        if binding["module"] == module["key"]
    }
    if digest(path) not in hashes:
        raise ValueError(f"Final image hash differs from bound release: {path}")
    return module


def source_reference(path: str, manifest: dict) -> dict:
    normalized = path.replace("\\", "/")
    for mapping in manifest["generatedSources"]:
        if normalized.startswith(mapping["prefix"].replace("\\", "/")):
            relative = normalized[len(mapping["prefix"]) :]
            relative_path(relative)
            return {
                "generatedSource": mapping["archivePath"] + relative,
                "commit": manifest["build"]["commit"],
            }
    for mapping in manifest["sourcePaths"]:
        if normalized.startswith(mapping["prefix"].replace("\\", "/")):
            relative = mapping["repositoryPath"] + normalized[len(mapping["prefix"]) :]
            relative_path(relative)
            result = {"repositoryPath": relative, "commit": manifest["build"]["commit"]}
            repository = manifest["build"]["ci"].get("GITHUB_REPOSITORY")
            if repository:
                result["url"] = (
                    f"https://github.com/{repository}/blob/{result['commit']}/{quote(relative)}"
                )
            return result
    return {
        "reason": "Source belongs to toolchain/dependency or has no recorded path mapping"
    }


def resolve_frame(
    symbol: Path, module: dict, address: int, image: Path | None
) -> list[dict]:
    try:
        program = tool("llvm-symbolizer")
    except RuntimeError:
        if module["format"] != "macho" or sys.platform != "darwin":
            raise
        arch = "arm64" if module["arch"] == "aarch64" else "x86_64"
        result = run(
            [
                "atos",
                "-o",
                str(symbol),
                "-arch",
                arch,
                "-inlineFrames",
                "-fullPath",
                hex(address),
            ]
        )
        frames = []
        for line in result.splitlines():
            match = re.match(r"(.*?) \(in .*?\) \((.*):(\d+)\)$", line)
            if match:
                frames.append(
                    {
                        "FunctionName": match[1],
                        "FileName": match[2],
                        "Line": int(match[3]),
                    }
                )
        return frames
    if module["format"] == "pe":
        if image is None:
            raise ValueError(
                "PDB lookup requires the matching final EXE/DLL via --images"
            )
        with tempfile.TemporaryDirectory(prefix="ash-pdb-") as temporary:
            work = Path(temporary)
            shutil.copyfile(symbol, work / module["pdbName"])
            shutil.copyfile(image, work / image.name)
            result = run(
                [
                    program,
                    "--output-style=JSON",
                    "--inlines",
                    "--demangle",
                    "--relative-address",
                    f"--obj={work / image.name}",
                    hex(address),
                ]
            )
    else:
        result = run(
            [
                program,
                "--output-style=JSON",
                "--inlines",
                "--demangle",
                f"--obj={symbol}",
                hex(address),
            ]
        )
    data = json.loads(result)
    if isinstance(data, list):
        data = data[0]
    return data.get("Symbol", [])


def symbolicate(
    report: dict, root: Path, manifest: dict, images: Path | None = None
) -> dict:
    if (
        report.get("schemaVersion") != 1
        or len(report.get("frames", [])) > MAX_FRAMES
        or len(report.get("modules", [])) > MAX_FRAMES
    ):
        raise ValueError("Unsupported or oversized crash report")
    modules = report["modules"]
    output = {
        "schemaVersion": 1,
        "build": manifest["build"],
        "frames": [],
        "complete": True,
    }
    cache = {}
    for frame in report["frames"]:
        resolved = dict(frame)
        try:
            index = frame.get("module")
            if not isinstance(index, int) or index < 0 or index >= len(modules):
                raise ValueError("Missing module identity")
            loaded = modules[index]
            module = next(
                (
                    module
                    for module in manifest["modules"]
                    if all(
                        module[key] == loaded.get(key)
                        for key in ("id", "format", "arch")
                    )
                ),
                None,
            )
            if not module:
                raise ValueError("No matching module ID and architecture in archive")
            resolved["moduleIdentity"] = {
                key: module[key] for key in ("id", "format", "arch")
            }
            pc = number(frame["pc"])
            if "fileAddress" in frame:
                address = number(frame["fileAddress"])
            elif module["format"] == "macho":
                address = pc - number(loaded["base"]) + module["imageBase"]
            elif module["format"] == "pe":
                address = pc - number(loaded["base"])
            else:
                # ELF mapping starts are not load bias. Normalized importers must
                # supply bias derived from PT_LOAD, or a debugger file address.
                address = pc - number(loaded["loadBias"])
            number(address)
            if "size" in loaded and not number(loaded["base"]) <= pc < number(
                loaded["base"]
            ) + number(loaded["size"]):
                raise ValueError("Frame PC is outside reported module")
            resolved["normalizedAddress"] = hex(address)
            lookup_address = address
            if frame.get("addressKind") == "returnAddress":
                # LLDB exports raw return PCs. Move into the call instruction
                # using its architecture; OS-reported PCs stay untouched.
                lookup_address -= 4 if module["arch"] == "aarch64" else 1
                number(lookup_address)
            resolved["lookupAddress"] = hex(lookup_address)
            image = None
            if module["format"] == "pe" and images:
                candidates = [
                    images / relative_path(binding["path"])
                    for package in manifest["packages"]
                    for binding in package["modules"]
                    if binding["module"] == module["key"]
                ]
                image = next(
                    (candidate for candidate in candidates if candidate.is_file()), None
                )
                if image:
                    verify_image(image, manifest)
            cache_key = (module["key"], lookup_address)
            if cache_key not in cache:
                cache[cache_key] = resolve_frame(
                    root / relative_path(module["symbolPath"]),
                    module,
                    lookup_address,
                    image,
                )
            symbols = cache[cache_key]
            if not symbols or not any(
                symbol.get("Line", 0)
                and symbol.get("FunctionName") not in {None, "", "??"}
                for symbol in symbols
            ):
                raise ValueError(
                    "No function/source line for address (external or missing coverage)"
                )
            resolved["symbols"] = [
                {
                    **symbol,
                    "source": source_reference(symbol.get("FileName", ""), manifest),
                }
                for symbol in symbols
            ]
        except (ValueError, KeyError, RuntimeError) as error:
            resolved["unresolved"] = str(error)
            output["complete"] = False
        output["frames"].append(resolved)
    if not output["frames"]:
        output["complete"] = False
    return output


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--symbols", type=Path, required=True)
    parser.add_argument(
        "--sha256", required=True, help="Checksum obtained from the release index"
    )
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument(
        "--images", type=Path, help="Final unpacked product root; required for dumps/PE"
    )
    parser.add_argument(
        "--executable", type=Path, help="Final primary executable for dump unwinding"
    )
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.resolve() in {args.input.resolve(), args.symbols.resolve()}:
        parser.error("Output must not replace the original report or symbol archive")
    with tempfile.TemporaryDirectory(prefix="ash-symbolicate-") as temporary:
        root = Path(temporary)
        manifest = extract_archive(args.symbols, root, args.sha256)
        report = load_report(args.input, args.images, args.executable, manifest)
        result = symbolicate(report, root, manifest, args.images)
        result.update(inputSha256=digest(args.input), symbolsSha256=args.sha256)
        write_json(args.output, result)
        lines = []
        for index, frame in enumerate(result["frames"]):
            if "unresolved" in frame:
                lines.append(
                    f"#{index} PC={frame.get('pc')} unresolved: {frame['unresolved']}"
                )
            for symbol in frame.get("symbols", []):
                lines.append(
                    f"#{index} PC={frame.get('pc')} {symbol['FunctionName']} {symbol['FileName']}:{symbol['Line']}"
                )
        text_output = args.output.with_suffix(".txt")
        if text_output == args.output:
            text_output = args.output.with_name(args.output.name + ".txt")
        text_output.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"Wrote {args.output}; complete={result['complete']}")
        return 0 if result["complete"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
