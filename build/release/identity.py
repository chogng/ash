"""Read module identities from executable headers, independently of filenames."""

from __future__ import annotations

import mmap
import struct
import uuid
from pathlib import Path


class Reader:
    def __init__(self, data):
        self.data = data

    def bytes(self, offset: int, length: int) -> bytes:
        if offset < 0 or length < 0 or offset + length > len(self.data):
            raise ValueError("Truncated or invalid executable header")
        return self.data[offset : offset + length]

    def unpack(self, fmt: str, offset: int) -> tuple:
        return struct.unpack(fmt, self.bytes(offset, struct.calcsize(fmt)))


def codeview(data: bytes) -> dict:
    if len(data) < 25 or data[:4] != b"RSDS":
        raise ValueError("Missing PDB RSDS identity")
    guid = uuid.UUID(bytes_le=data[4:20]).hex
    age = struct.unpack_from("<I", data, 20)[0]
    basename = (
        data[24:].split(b"\0", 1)[0].decode("utf-8").replace("\\", "/").split("/")[-1]
    )
    if not basename or not age:
        raise ValueError("Invalid PDB name or age")
    return {"id": f"{guid}-{age}", "pdbName": basename}


def identity(path: Path) -> dict:
    with path.open("rb") as stream:
        with mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
            reader = Reader(data)
            magic = reader.bytes(0, 4)
            if magic == b"\xcf\xfa\xed\xfe":
                return macho(reader)
            if magic == b"\x7fELF":
                return elf(reader)
            if magic[:2] == b"MZ":
                return pe(reader)
            raise ValueError(
                f"Unsupported executable (require thin 64-bit Mach-O/ELF/PE): {path}"
            )


def macho(r: Reader) -> dict:
    cpu, _, _, count, size = r.unpack("<IIIII", 4)
    arch = {0x0100000C: "aarch64", 0x01000007: "x86_64"}[cpu]
    end = 32 + size
    r.bytes(32, size)
    offset = 32
    result = {"format": "macho", "arch": arch, "imageBase": 0}
    for _ in range(min(count, 4096)):
        kind, length = r.unpack("<II", offset)
        if length < 8 or offset + length > end:
            raise ValueError("Invalid Mach-O load command")
        if kind == 0x1B:
            result["id"] = uuid.UUID(bytes=r.bytes(offset + 8, 16)).hex
        if kind == 0x19 and r.bytes(offset + 8, 16).rstrip(b"\0") == b"__TEXT":
            result["imageBase"] = r.unpack("<Q", offset + 24)[0]
        offset += length
    if "id" not in result:
        raise ValueError("Mach-O has no UUID")
    return result


def elf(r: Reader) -> dict:
    if r.bytes(4, 2) != b"\x02\x01":
        raise ValueError("Require little-endian 64-bit ELF")
    arch = {183: "aarch64", 62: "x86_64"}[r.unpack("<H", 18)[0]]
    phoff = r.unpack("<Q", 32)[0]
    stride, count = r.unpack("<HH", 54)
    result = {"format": "elf", "arch": arch, "imageBase": 0, "segments": []}
    for index in range(min(count, 4096)):
        kind, _, offset, address, _, filesz, memsz, align = r.unpack(
            "<IIQQQQQQ", phoff + index * stride
        )
        if kind == 1:
            result["segments"].append(
                {"offset": offset, "address": address, "size": memsz, "align": align}
            )
        if kind == 4:
            end = offset + filesz
            while offset + 12 <= end:
                namesz, descsz, note = r.unpack("<III", offset)
                name = r.bytes(offset + 12, namesz)
                desc = offset + 12 + ((namesz + 3) & ~3)
                next_offset = desc + ((descsz + 3) & ~3)
                if next_offset > end:
                    raise ValueError("Invalid ELF note")
                if name == b"GNU\0" and note == 3 and descsz:
                    result["id"] = r.bytes(desc, descsz).hex()
                offset = next_offset
    if "id" not in result:
        raise ValueError(
            "ELF has no GNU build-id; enable it in the Linux release linker"
        )
    return result


def pe(r: Reader) -> dict:
    header = r.unpack("<I", 0x3C)[0]
    if r.bytes(header, 4) != b"PE\0\0":
        raise ValueError("Invalid PE signature")
    machine, sections = r.unpack("<HH", header + 4)
    arch = {0xAA64: "aarch64", 0x8664: "x86_64"}[machine]
    optional = header + 24
    if r.unpack("<H", optional)[0] != 0x20B:
        raise ValueError("Require PE32+")
    base = r.unpack("<Q", optional + 24)[0]
    debug_rva, debug_size = r.unpack("<II", optional + 112 + 6 * 8)
    section_start = optional + r.unpack("<H", header + 20)[0]
    debug_offset = None
    for index in range(min(sections, 4096)):
        virtual_size, address, raw_size, raw_offset = r.unpack(
            "<IIII", section_start + 40 * index + 8
        )
        if address <= debug_rva < address + max(virtual_size, raw_size):
            debug_offset = raw_offset + debug_rva - address
    if debug_offset is None or debug_size > 1024 * 1024:
        raise ValueError("PE has no usable debug directory")
    for offset in range(debug_offset, debug_offset + debug_size, 28):
        kind, length, _, pointer = r.unpack("<IIII", offset + 12)
        if kind == 2:
            return {
                "format": "pe",
                "arch": arch,
                "imageBase": base,
                **codeview(r.bytes(pointer, length)),
            }
    raise ValueError("PE has no PDB CodeView reference")
