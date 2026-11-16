#!/usr/bin/env python3
"""Generate a deterministic PDF corpus and stress the real aspdf native service fixture.

The large scan contains a real uncompressed RGB image, not appended padding. Raw samples
and failures remain in the output JSON; baseline rejection is never counted as success.
"""

import argparse
import base64
import hashlib
import json
import os
import signal
import statistics
import subprocess
import threading
import time
from pathlib import Path


def write_pdf(path: Path, identifier: int, pages: int, *, scan=False):
    objects = [b"", b"", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    page_ids = []
    image_id = None
    if scan:
        width, height = 4096, 3584
        # Reproducible visible pixels. The stream itself occupies 42 MiB.
        row = bytes((index * 37 + index // 97) % 256 for index in range(width * 3))
        pixels = row * height
        objects.append(
            f"<< /Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length {len(pixels)} >>\nstream\n".encode()
            + pixels
            + b"\nendstream"
        )
        image_id = len(objects)
    for number in range(1, pages + 1):
        text = f"aspdf corpus {identifier:05d} page {number:04d}"
        lines = [f"BT /F1 14 Tf 40 740 Td ({text}) Tj ET"]
        for line in range(24):
            lines.append(
                f"BT /F1 10 Tf 40 {700 - line * 22} Td (Evidence row {line:02d} for document {identifier}, page {number}.) Tj ET"
            )
        if scan:
            lines.append("q 520 0 0 480 40 100 cm /Im0 Do Q")
        stream = "\n".join(lines).encode()
        content_id = len(objects) + 1
        objects.append(
            f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream"
        )
        annotation_id = len(objects) + 1
        objects.append(
            f"<< /Type /Annot /Subtype /Text /Rect [40 710 60 730] /T (Corpus reviewer) /Contents (Review document {identifier} page {number}) >>".encode()
        )
        page_ids.append(len(objects) + 1)
        resources = "/Font << /F1 3 0 R >>" + (
            f" /XObject << /Im0 {image_id} 0 R >>" if image_id else ""
        )
        rotation = (identifier % 4) * 90
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Rotate {rotation} /Resources << {resources} >> /Contents {content_id} 0 R /Annots [{annotation_id} 0 R] >>".encode()
        )
    objects[0] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objects[1] = (
        f"<< /Type /Pages /Count {pages} /Kids [".encode()
        + " ".join(f"{index} 0 R" for index in page_ids).encode()
        + b"] >>"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as output:
        output.write(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
        offsets = [0]
        for index, value in enumerate(objects, 1):
            offsets.append(output.tell())
            output.write(f"{index} 0 obj\n".encode() + value + b"\nendobj\n")
        start = output.tell()
        output.write(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
        for offset in offsets[1:]:
            output.write(f"{offset:010d} 00000 n \n".encode())
        output.write(
            f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n".encode()
        )


def generate(root: Path, count: int):
    root.mkdir(parents=True, exist_ok=True)
    for index in range(count):
        path = root / "library" / f"paper-{index:05d}.pdf"
        if not path.exists():
            write_pdf(path, index, 1 + index % 12)
    if not (root / "thousand-pages.pdf").exists():
        write_pdf(root / "thousand-pages.pdf", 10000, 1000)
    if not (root / "large-scan.pdf").exists():
        write_pdf(root / "large-scan.pdf", 10004, 1, scan=True)


class NativeService:
    def __init__(self, binary):
        self.child = subprocess.Popen(
            [str(binary), "--fixture"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=os.name == "posix",
        )
        self.sequence = 0
        self.samples = []
        self.stop = threading.Event()
        self.monitor = threading.Thread(target=self.sample, daemon=True)
        self.monitor.start()

    def sample(self):
        while not self.stop.is_set():
            try:
                table = subprocess.check_output(
                    ["ps", "-axo", "pid=,ppid=,rss="], text=True
                )
                processes = [
                    tuple(map(int, line.split()))
                    for line in table.splitlines()
                    if len(line.split()) == 3
                ]
                owned = {self.child.pid}
                for _ in range(4):
                    owned.update(pid for pid, parent, _ in processes if parent in owned)
                self.samples.append(
                    {
                        "time": time.monotonic(),
                        "rss_kib": sum(
                            rss for pid, _, rss in processes if pid in owned
                        ),
                        "processes": len(owned),
                    }
                )
            except (OSError, subprocess.SubprocessError):
                pass
            self.stop.wait(0.05)

    def rpc(self, method, **params):
        self.sequence += 1
        self.child.stdin.write(
            json.dumps({"id": self.sequence, "method": method, "params": params}) + "\n"
        )
        self.child.stdin.flush()
        line = self.child.stdout.readline()
        if not line:
            raise RuntimeError(
                "Native fixture exited: " + self.child.stderr.read()[-2048:]
            )
        reply = json.loads(line)
        if "error" in reply:
            raise RuntimeError(reply["error"])
        return reply["result"]

    def open(self, identifier, path):
        size = path.stat().st_size
        self.rpc("pdf/open", documentId=identifier, size=size)
        offset = 0
        with path.open("rb") as source:
            while data := source.read(192 * 1024):
                result = self.rpc(
                    "pdf/append",
                    documentId=identifier,
                    offset=offset,
                    dataBase64=base64.b64encode(data).decode(),
                )
                offset += len(data)
                assert result["nextOffset"] == offset

    def page(self, identifier, number, dimension):
        result = self.rpc(
            "pdf/page",
            documentId=identifier,
            revision=0,
            page=number,
            dimension=dimension,
            edit=None,
        )
        assert result["page"] == number and "Evidence row" in result["text"], result[
            "text"
        ][:200]
        assert result["annotations"] and result["fileSize"] > 0
        png = bytearray()
        while True:
            image = self.rpc(
                "pdf/read",
                documentId=identifier,
                revision=0,
                image=True,
                imageSha256=result["imageSha256"],
                offset=len(png),
                maxBytes=192 * 1024,
            )
            png.extend(base64.b64decode(image["dataBase64"]))
            if image["eof"]:
                break
        assert png.startswith(b"\x89PNG"), "Missing rendered image"
        assert len(png) == result["imageSize"]
        assert hashlib.sha256(png).hexdigest() == result["imageSha256"]
        return result

    def close(self, identifier):
        self.rpc("pdf/close", documentId=identifier)

    def dispose(self):
        try:
            self.child.stdin.close()
            try:
                self.child.wait(timeout=35)
            except subprocess.TimeoutExpired:
                # The fixture owns this process group, including native helpers.
                if os.name == "posix":
                    os.killpg(self.child.pid, signal.SIGKILL)
                else:
                    subprocess.run(
                        ["taskkill", "/PID", str(self.child.pid), "/T", "/F"],
                        check=False,
                        capture_output=True,
                    )
                self.child.wait(timeout=5)
                raise RuntimeError("Native fixture teardown timed out") from None
            if self.child.returncode != 0:
                raise RuntimeError(
                    f"Native fixture exited with {self.child.returncode}"
                )
        finally:
            self.stop.set()
            self.monitor.join(timeout=2)


def summary(samples):
    ordered = sorted(samples)
    return (
        {
            "count": len(samples),
            "median_ms": statistics.median(samples),
            "p95_ms": ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))],
            "max_ms": max(samples),
        }
        if samples
        else {"count": 0}
    )


def run(args):
    args.output.parent.mkdir(parents=True, exist_ok=True)
    generate(args.corpus, args.documents)
    if args.generate_only:
        print(
            json.dumps(
                {
                    "documents": args.documents,
                    "large_bytes": (args.corpus / "large-scan.pdf").stat().st_size,
                }
            )
        )
        return
    service = NativeService(args.binary.resolve())
    report = {
        "label": args.label,
        "binary_sha256": hashlib.sha256(args.binary.read_bytes()).hexdigest(),
        "documents": args.documents,
        "samples_ms": {},
        "errors": [],
        "parameters": {
            "dimension": args.dimension,
            "file_count": args.documents,
            "scenario": args.scenario,
            "large_scan": "4096x3584 RGB, 42 MiB image stream",
            "long_document_pages": 1000,
        },
        "memory_note": "Sum of OS RSS for fixture and descendants, includes shared pages; not private footprint.",
    }
    started = time.monotonic()
    try:
        listing = time.perf_counter()
        paths = sorted((args.corpus / "library").glob("*.pdf"))[: args.documents]
        sizes = sum(path.stat().st_size for path in paths)
        report["listing_ms"] = (time.perf_counter() - listing) * 1000
        report["library_bytes"] = sizes
        if args.scenario == "pool":
            for index, path in enumerate(paths[:8]):
                service.open(str(index), path)
                service.page(str(index), 1, args.dimension)
            for index in range(8):
                service.page(str(index), 1, args.dimension - 1)
            for index in range(8):
                service.close(str(index))
            time.sleep(0.3)
            assert service.samples, "Process memory sampler is unavailable"
            report["peak_processes"] = max(
                sample["processes"] for sample in service.samples
            )
            report["settled_processes"] = service.samples[-1]["processes"]
            assert report["peak_processes"] <= 3 and report["settled_processes"] == 1
            large = args.corpus / "large-scan.pdf"
            result = service.rpc(
                "pdf/process",
                documentId="agent",
                page=1,
                output="text",
                dataBase64=base64.b64encode(large.read_bytes()).decode(),
            )
            assert result["imageBytes"] == 0 and result["page"]["annotations"]
            assert (
                result["page"]["sha256"]
                == hashlib.sha256(large.read_bytes()).hexdigest()
            )
            report["large_agent_text_verified"] = True
            time.sleep(0.3)
            report["settled_rss_kib"] = service.samples[-1]["rss_kib"]
            return
        if args.scenario == "agent":
            samples = []
            report["samples_ms"]["agent_text"] = samples
            for index, path in enumerate(paths):
                before = time.perf_counter()
                result = service.rpc(
                    "pdf/process",
                    documentId="agent",
                    page=1,
                    output="text",
                    dataBase64=base64.b64encode(path.read_bytes()).decode(),
                )
                assert "Evidence row" in result["page"]["text"]
                assert result["imageBytes"] == 0 and result["page"]["annotations"]
                if index > 0:
                    samples.append((time.perf_counter() - before) * 1000)
            time.sleep(0.3)
            report["settled_rss_kib"] = (
                service.samples[-1]["rss_kib"] if service.samples else None
            )
            return
        service.open("warmup", paths[0])
        service.page("warmup", 1, args.dimension)
        service.close("warmup")
        samples = []
        report["samples_ms"]["library_first_page"] = samples
        for index, path in enumerate(paths):
            before = time.perf_counter()
            identifier = f"paper-{index}"
            service.open(identifier, path)
            try:
                service.page(identifier, 1, args.dimension)
            finally:
                service.close(identifier)
            samples.append((time.perf_counter() - before) * 1000)
            if (index + 1) % 100 == 0:
                print(f"{args.label}: {index + 1}/{len(paths)} PDFs", flush=True)
        service.open("long", args.corpus / "thousand-pages.pdf")
        sequential = []
        report["samples_ms"]["thousand_sequential_pages"] = sequential
        for number in range(1, 1001):
            before = time.perf_counter()
            result = service.page("long", number, args.dimension)
            assert result["pageCount"] == 1000
            sequential.append((time.perf_counter() - before) * 1000)
        flips = []
        report["samples_ms"]["long_document_flips"] = flips
        for number in [1, 500, 1000, 2, 999] * args.rounds:
            before = time.perf_counter()
            result = service.page("long", number, args.dimension)
            assert result["pageCount"] == 1000
            flips.append((time.perf_counter() - before) * 1000)
        repeats = []
        report["samples_ms"]["cached_page"] = repeats
        for _ in range(50):
            before = time.perf_counter()
            service.page("long", 999, args.dimension)
            repeats.append((time.perf_counter() - before) * 1000)
        service.close("long")
        time.sleep(0.3)
        report["common_peak_rss_kib"] = max(
            (sample["rss_kib"] for sample in service.samples), default=0
        )
        report["common_settled_rss_kib"] = (
            service.samples[-1]["rss_kib"] if service.samples else None
        )
        try:
            before = time.perf_counter()
            service.open("large", args.corpus / "large-scan.pdf")
            report["large_open_ms"] = (time.perf_counter() - before) * 1000
            before = time.perf_counter()
            page = service.page("large", 1, args.dimension)
            assert page["fileSize"] > 39 * 1024 * 1024
            report["large_first_page_ms"] = (time.perf_counter() - before) * 1000
            report["large_image_size"] = page["imageSize"]
            edited = service.rpc(
                "pdf/page",
                documentId="large",
                revision=0,
                page=1,
                dimension=args.dimension,
                edit={
                    "kind": "update",
                    "index": 0,
                    "contents": "large scan annotation persists",
                },
            )
            assert (
                edited["revision"] == 1
                and edited["annotations"][0]["contents"]
                == "large scan annotation persists"
            )
            exported = bytearray()
            while True:
                chunk = service.rpc(
                    "pdf/read",
                    documentId="large",
                    revision=1,
                    image=False,
                    offset=len(exported),
                    maxBytes=192 * 1024,
                )
                exported.extend(base64.b64decode(chunk["dataBase64"]))
                if chunk["eof"]:
                    break
            assert hashlib.sha256(exported).hexdigest() == edited["sha256"]
            saved = args.output.with_suffix(".saved.pdf")
            saved.write_bytes(exported)
            service.close("large")
            service.open("large-reopened", saved)
            reopened = service.page("large-reopened", 1, args.dimension)
            assert (
                reopened["annotations"][0]["contents"]
                == "large scan annotation persists"
            )
            service.close("large-reopened")
            report["large_annotation_export_reopen"] = True
        except RuntimeError as error:
            report["errors"].append({"scenario": "large_scan", "message": str(error)})
        # Observe actual release, without forcing allocator-specific trimming.
        time.sleep(0.3)
        report["settled_rss_kib"] = (
            service.samples[-1]["rss_kib"] if service.samples else None
        )
    except Exception as error:
        report["errors"].append({"scenario": "workload", "message": str(error)})
        raise
    finally:
        try:
            service.dispose()
        except Exception as error:
            report["errors"].append({"scenario": "teardown", "message": str(error)})
        report["elapsed_seconds"] = time.monotonic() - started
        report["summary"] = {
            key: summary(value) for key, value in report["samples_ms"].items()
        }
        report["memory_samples"] = service.samples
        report["peak_rss_kib"] = max(
            (sample["rss_kib"] for sample in service.samples), default=0
        )
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2))
        print(
            json.dumps(
                {
                    key: report.get(key)
                    for key in [
                        "label",
                        "summary",
                        "peak_rss_kib",
                        "settled_rss_kib",
                        "errors",
                        "elapsed_seconds",
                    ]
                },
                indent=2,
            )
        )

        if report["errors"]:
            raise SystemExit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path, default=Path(".build/aspdf-perf/corpus"))
    parser.add_argument("--binary", type=Path)
    parser.add_argument(
        "--output", type=Path, default=Path(".build/aspdf-perf/result.json")
    )
    parser.add_argument("--label", default="candidate")
    parser.add_argument("--scenario", choices=["full", "agent", "pool"], default="full")
    parser.add_argument("--documents", type=int, default=1000)
    parser.add_argument("--dimension", type=int, default=1600)
    parser.add_argument("--rounds", type=int, default=10)
    parser.add_argument("--generate-only", action="store_true")
    arguments = parser.parse_args()
    if (
        not 1 <= arguments.documents <= 10000
        or not 256 <= arguments.dimension <= 2048
        or not 1 <= arguments.rounds <= 100
    ):
        parser.error("Invalid stress workload size")
    if arguments.scenario == "pool" and (
        arguments.documents < 8 or arguments.dimension <= 256
    ):
        parser.error("The pool workload needs at least 8 documents and dimension > 256")
    if not arguments.generate_only and arguments.binary is None:
        parser.error("--binary is required unless generating the corpus only")
    run(arguments)
