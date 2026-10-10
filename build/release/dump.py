"""Trusted LLDB adapter: module IDs come from dump bytes, never chosen images."""

from __future__ import annotations

import json
import mmap
from pathlib import Path

from build.release.identity import Reader, codeview, elf


def minidump_modules(path: Path) -> dict:
    result = {}
    with (
        path.open("rb") as stream,
        mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data,
    ):
        reader = Reader(data)
        if reader.bytes(0, 4) != b"MDMP":
            raise ValueError("Invalid minidump signature")
        count, offset = reader.unpack("<II", 8)
        if count > 4096:
            raise ValueError("Too many minidump streams")
        for index in range(count):
            kind, size, location = reader.unpack("<III", offset + index * 12)
            if kind != 4:
                continue
            count = reader.unpack("<I", location)[0]
            if count > 8192 or 4 + count * 108 > size:
                raise ValueError("Invalid minidump module list")
            for index in range(count):
                module = location + 4 + 108 * index
                base = reader.unpack("<Q", module)[0]
                length, address = reader.unpack("<II", module + 76)
                if length:
                    try:
                        result[base] = codeview(reader.bytes(address, length))["id"]
                    except ValueError:
                        pass  # External modules without RSDS remain unresolved.
    return result


def macho_core_modules(path: Path) -> dict:
    """Read UUIDs in LLDB's version-1 all-image-infos LC_NOTE."""
    result = {}
    with (
        path.open("rb") as stream,
        mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data,
    ):
        reader = Reader(data)
        count, command_bytes = reader.unpack("<II", 16)
        offset = 32
        for _ in range(min(count, 4096)):
            kind, length = reader.unpack("<II", offset)
            if length < 8 or offset + length > 32 + command_bytes:
                raise ValueError("Invalid core load command")
            if (
                kind == 0x31
                and reader.bytes(offset + 8, 16).rstrip(b"\0") == b"all image infos"
            ):
                location, size = reader.unpack("<QQ", offset + 24)
                reader.bytes(location, size)
                version, count, entries, stride = reader.unpack("<IIQI", location)
                if version != 1 or count > 8192 or stride != 48:
                    raise ValueError("Unsupported core image metadata")
                for index in range(count):
                    entry = entries + stride * index
                    module_id = reader.bytes(entry + 8, 16).hex()
                    base = reader.unpack("<Q", entry + 24)[0]
                    if module_id != "0" * 32:
                        result[base] = module_id
            offset += length
    return result


def mapped_header(path: Path, address: int) -> bytes:
    """Read only bytes present in the ELF core, without debugger image backfill."""
    with (
        path.open("rb") as stream,
        mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data,
    ):
        reader = Reader(data)
        if reader.bytes(0, 6) != b"\x7fELF\x02\x01":
            raise ValueError("Require little-endian 64-bit ELF core")
        phoff = reader.unpack("<Q", 32)[0]
        stride, count = reader.unpack("<HH", 54)
        for index in range(min(count, 4096)):
            kind, _, offset, base, _, size = reader.unpack(
                "<IIQQQQ", phoff + index * stride
            )
            if kind == 1 and base <= address < base + size:
                start = address - base
                return reader.bytes(offset + start, min(65536, size - start))
    return b""


def export(debugger, config_path: str) -> None:
    import lldb

    config = json.loads(Path(config_path).read_text())
    dump = Path(config["dump"])
    with dump.open("rb") as stream:
        magic = stream.read(4)
    windows = magic == b"MDMP"
    if windows:
        ids = minidump_modules(dump)
    elif magic == b"\xcf\xfa\xed\xfe":
        ids = macho_core_modules(dump)
    else:
        ids = {}
    target = debugger.CreateTarget(config["executable"])
    for image in config["images"]:
        target.AddModule(image, None, None)
    error = lldb.SBError()
    process = target.LoadCore(str(dump), error)
    if not error.Success() or not process.IsValid():
        raise ValueError(f"LLDB could not open dump: {error}")
    modules, indexes = [], {}
    for module in target.module_iter():
        address = module.GetObjectFileHeaderAddress().GetLoadAddress(target)
        if address == lldb.LLDB_INVALID_ADDRESS:
            continue
        triple = module.GetTriple() or ""
        arch = "aarch64" if triple.startswith(("aarch64", "arm64")) else "x86_64"
        record = {
            "arch": arch,
            "base": address,
            "name": module.GetFileSpec().GetFilename(),
        }
        if windows:
            record.update(format="pe", id=ids.get(address, ""))
        elif magic == b"\xcf\xfa\xed\xfe":
            record.update(format="macho", id=ids.get(address, ""))
        else:
            # Clean file-backed ELF pages may be omitted. Missing dump IDs stay
            # missing, even when LLDB accepts an executable supplied by the user.
            try:
                actual = elf(Reader(mapped_header(dump, address)))
                record.update(format="elf", id=actual["id"])
            except (ValueError, KeyError):
                record.update(format="elf", id="")
        indexes[address] = len(modules)
        modules.append(record)
    frames = []
    for thread in process:
        for index, frame in enumerate(thread):
            if len(frames) >= 8192:
                raise ValueError("Dump frame limit exceeded")
            address = frame.GetPCAddress()
            file_address = address.GetFileAddress()
            module = address.GetModule()
            module_index = indexes.get(
                module.GetObjectFileHeaderAddress().GetLoadAddress(target)
            )
            # LLDB handles PT_LOAD while unwinding. PE is exported as an RVA;
            # the raw return PC is kept for architecture-specific lookup later.
            if windows and module_index is not None:
                file_address = frame.GetPC() - modules[module_index]["base"]
            frames.append(
                {
                    "thread": thread.GetThreadID(),
                    "module": module_index,
                    "pc": frame.GetPC(),
                    "fileAddress": file_address,
                    "addressKind": "instruction" if index == 0 else "returnAddress",
                }
            )
    Path(config["output"]).write_text(
        json.dumps({"schemaVersion": 1, "modules": modules, "frames": frames})
    )
