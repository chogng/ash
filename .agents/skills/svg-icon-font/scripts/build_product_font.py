#!/usr/bin/env python3
"""Rebuild Ash's shipped icon fonts and append-only glyph map from SVG sources."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from copy import deepcopy
from collections import Counter

ROOT = Path(__file__).resolve().parents[4]
SOURCE = ROOT / "resources/icons"
MEDIA = ROOT / "src/ash/base/browser/ui/lxicons"
SCRIPTS = Path(__file__).resolve().parent
REQUIREMENTS = SCRIPTS.parent / "requirements.txt"
BUN = ROOT / "node_modules/bun" / ("bun.exe" if os.name == "nt" else "bun")
COLOR_GLYPHS = {
    "claude": "Brand color", "csv-green": "File type color", "docx-blue": "File type color",
    "layout-panel-off-1": "Fixed color/opacity", "layout-sidebar-left-off-1": "Fixed color/opacity",
    "layout-sidebar-right-off-1": "Fixed color/opacity", "pdf-filled": "File type color",
    "pdf-red": "File type color", "xls-green": "File type color",
    "inspect": "Fixed white fill with black outlines", "symbol-method": "Translucent stroke overlay",
}


def input_files(source):
    return sorted(path for path in source.iterdir() if path.is_file() and path.suffix.lower() == ".svg") + [source / name for name in (
        "font/manifest.json", "font/sessions.json", "variable/sidebar/manifest.yaml", "variable/sidebar/preview.html")]


def snapshot(source):
    return {path.relative_to(source): path.read_bytes() for path in input_files(source)}


def output_files(args):
    return [args.source_directory / "manifest.json", args.source_directory / "font/manifest.json",
            args.font_directory / "lxicon.woff2", args.font_directory / "lxicon-variable.woff2", args.typescript_file]


def tool_files():
    return sorted(path for path in SCRIPTS.glob("*.py") if not path.name.startswith("test_")) + [REQUIREMENTS, ROOT / ".agents/skills/variable-iconfont/scripts/vifont.py",
        ROOT / "build/resources/icons/generate.ts", ROOT / "build/resources/icons/generate-to-ts.ts", ROOT / "build/lib/generatedTypeScript.ts", ROOT / "build/format.ts", ROOT / "tsfmt.json", ROOT / "pnpm-lock.yaml", ROOT / ".prettierrc.toml"]


def fingerprint(args):
    digest = hashlib.sha256()
    for path in input_files(args.source_directory) + output_files(args) + tool_files():
        digest.update(str(path).encode())
        digest.update(b"\0")
        digest.update(path.read_bytes() if path.is_file() else b"<missing>")
        digest.update(b"\0")
    return digest.hexdigest()


def prepare_environment(out):
    environment = out / "venv"
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    stamp = environment / "requirements.sha256"
    expected = hashlib.sha256(REQUIREMENTS.read_bytes() + sys.version.encode()).hexdigest()
    if not python.is_file():
        subprocess.run([sys.executable, "-m", "venv", str(environment)], check=True)
    if not stamp.exists() or stamp.read_text() != expected:
        subprocess.run([str(python), "-m", "pip", "install", "--disable-pip-version-check", "-r", str(REQUIREMENTS)], check=True)
        stamp.write_text(expected)
    return python


def generate(source, typescript=None):
    arguments = [str(BUN), str(ROOT / "build/resources/icons/generate.ts"), "--source-directory", str(source)]
    arguments += ["--typescript-file", str(typescript)] if typescript else ["--catalog-only"]
    subprocess.run(arguments, cwd=ROOT, check=True)


def write_manifest(path, table):
    # Match the repository formatter before publication so font rebuilds do not
    # alternate between expanded Python arrays and compact JSON coordinates.
    # Staged paths under .build are ignored by the formatter. Use the shipped
    # manifest's context while formatting stdin, without touching that live file.
    formatted = subprocess.run([str(BUN), "fmt", "--config", str(ROOT / ".prettierrc.toml"), "--stdin-filepath", str(SOURCE / "font/manifest.json")],
        input=(json.dumps(table, indent=2) + "\n").encode("utf-8"), stdout=subprocess.PIPE, cwd=ROOT, check=True)
    path.write_bytes(formatted.stdout)


def validate_layers(path, layers):
    from fontTools.ttLib import TTFont

    with TTFont(path) as font:
        def contours(name):
            coordinates, ends, flags = font["glyf"][name].getCoordinates(font["glyf"])
            result, start = [], 0
            for end in ends:
                points = tuple((int(x), int(y), int(flags[index]) & 1)
                    for index, (x, y) in enumerate(coordinates[start:end + 1], start))
                start = end + 1
                # Contour start positions may differ after overlap removal.
                result.append(min(points[index:] + points[:index] for index in range(len(points))))
            return result

        for name, components in layers.items():
            whole = Counter(contours(name))
            composed = Counter(contour for component in components for contour in contours(component["glyph"]))
            if whole != composed:
                raise ValueError(f"{name}: font layers must preserve every outline point of the complete glyph")


def compile_fonts(source, media, typescript, out):
    from build_font import PAINT_ALIASES, UPM, build, make_glyph, normalize_svg
    from build_sessions_font import build_sessions, merge_sessions

    generate(source)
    manifest = source / "font/manifest.json"
    table = json.loads(manifest.read_text())
    codepoints = table["codepoints"]
    next_codepoint = max(int(value, 16) for value in codepoints.values()) + 1
    sources = sorted(source.glob("*.svg"))
    for icon_source in sources:
        if icon_source.stem not in codepoints:
            codepoints[icon_source.stem] = f"{next_codepoint:04X}"
            next_codepoint += 1
    glyphs = [{"id": source.stem, "unicode": codepoints[source.stem], "source": str(source)} for source in sources]
    layers = {}
    if (source / "ash-mark.svg").exists():
        root = ET.parse(source / "ash-mark.svg").getroot()
        directory = out / "layers"
        directory.mkdir()
        petals = []
        for element in root.iter():
            name = element.get("id", "")
            if not name.startswith("petal-"):
                continue
            glyph_id = f"ash-mark-{name}"
            if glyph_id not in codepoints:
                codepoints[glyph_id] = f"{next_codepoint:04X}"
                next_codepoint += 1
            artwork = deepcopy(root)
            for parent in artwork.iter():
                for child in list(parent):
                    if child.tag.endswith("}path") and child.get("id") != name:
                        parent.remove(child)
            path = directory / f"{glyph_id}.svg"
            path.write_text(ET.tostring(artwork, encoding="unicode"))
            _, _, viewbox, outline = normalize_svg(path)
            glyph = make_glyph(viewbox, outline)
            glyph.recalcBounds(None)
            origin = [(glyph.xMin + glyph.xMax) / (2 * UPM), 1 - (glyph.yMin + glyph.yMax) / (2 * UPM)]
            petals.append({"id": name, "glyph": glyph_id, "origin": origin})
            glyphs.append({"id": glyph_id, "unicode": codepoints[glyph_id], "source": str(path)})
        if len(petals) != 9:
            raise ValueError("The animated Ash mark requires its nine named petal paths")
        layers["ash-mark"] = petals
    temporary = out / "manifest.json"
    temporary.write_text(json.dumps({"family": table["family"], "glyphs": glyphs}, indent=2) + "\n")
    colors = {}
    for icon_source in sources:
        # Most imports are opaque foreground icons. Avoid expanding all their
        # strokes twice just to establish that they need no color table.
        attributes = [dict(element.attrib) for element in ET.parse(icon_source).iter()]
        for values in attributes:
            for declaration in values.pop("style", "").split(";"):
                if declaration.strip():
                    key, value = declaration.split(":", 1)
                    values[key.strip()] = value.strip()
        needs_layers = any(
            key in {"fill", "stroke"} and PAINT_ALIASES.get(value.lower(), value.lower()) not in {"none", "#000"}
            or key in {"opacity", "fill-opacity", "stroke-opacity"} and float(value) != 1
            for values in attributes for key, value in values.items())
        if not needs_layers:
            continue
        _, _, _, paint_layers = normalize_svg(icon_source, preserve_paints=True)
        if any(PAINT_ALIASES.get(paint.lower(), paint.lower()) != "#000" or opacity != 1 for _, paint, opacity in paint_layers):
            colors[icon_source.stem] = COLOR_GLYPHS.get(icon_source.stem, "Source solid colors or opacity")
    report = build(temporary, out / "static", colors)
    sessions = build_sessions(temporary, source / "font/sessions.json", out / "sessions", colors)
    subprocess.run([sys.executable, "-B", str(SCRIPTS / "build_sidebar_variable.py"), "--source-directory", str(source),
        "--out", str(out / "variable"), "--font-output", str(out / "variable/subset.woff2")], cwd=ROOT, check=True)
    coverage = merge_sessions(out / "variable/subset.woff2", sessions["woff2"], codepoints)
    validate_layers(report["woff2"], layers)
    validate_layers(out / "variable/subset.woff2", layers)
    table.pop("svg", None)
    table.update({"codepoints": codepoints, "color": colors, "layers": layers, "sources": {source.stem: hashlib.sha256(source.read_text().strip().encode()).hexdigest() for source in sources}})
    write_manifest(manifest, table)
    media.mkdir(parents=True, exist_ok=True)
    shutil.copy2(report["woff2"], media / "lxicon.woff2")
    shutil.copy2(out / "variable/subset.woff2", media / "lxicon-variable.woff2")
    generate(source, typescript)
    return {"glyphs": len(glyphs), "colorGlyphs": len(colors), "sessions": coverage}


def publish(path, content):
    if path.is_file() and path.read_bytes() == content:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as file:
            file.write(content)
        os.chmod(temporary, path.stat().st_mode & 0o777 if path.exists() else 0o644)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return True


def rebuild(args, stamp):
    while True:
        inputs = snapshot(args.source_directory)
        tools = [path.read_bytes() for path in tool_files()]
        with tempfile.TemporaryDirectory(prefix="compile-", dir=args.out) as temporary:
            stage = Path(temporary)
            source, media, typescript = stage / "icons", stage / "fonts", stage / "lxiconsLibrary.ts"
            for relative, content in inputs.items():
                target = source / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
            report = compile_fonts(source, media, typescript, stage)
            # A save during conversion supersedes the complete staged result.
            # Never publish an older snapshot over an edit that arrived meanwhile.
            if snapshot(args.source_directory) != inputs:
                continue
            if [path.read_bytes() for path in tool_files()] != tools:
                raise ValueError("Icon font build tools changed during conversion; retry with the updated compiler")
            publications = [(args.source_directory / relative, (source / relative).read_bytes()) for relative in inputs]
            publications += [(args.source_directory / "manifest.json", (source / "manifest.json").read_bytes()),
                (args.font_directory / "lxicon.woff2", (media / "lxicon.woff2").read_bytes()),
                (args.font_directory / "lxicon-variable.woff2", (media / "lxicon-variable.woff2").read_bytes()),
                (args.typescript_file, typescript.read_bytes())]
            changed = False
            for path, content in publications:
                changed = publish(path, content) or changed
            stamp.write_text(fingerprint(args))
            return {**report, "changed": changed}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / ".build/product-icon-font")
    parser.add_argument("--source-directory", type=Path, default=SOURCE)
    parser.add_argument("--font-directory", type=Path, default=MEDIA)
    parser.add_argument("--typescript-file", type=Path, default=ROOT / "src/ash/base/common/lxiconsLibrary.ts")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    for field in ("out", "source_directory", "font_directory", "typescript_file"):
        setattr(args, field, getattr(args, field).resolve())
    args.out.mkdir(parents=True, exist_ok=True)
    identity = hashlib.sha256(str((args.source_directory, args.font_directory, args.typescript_file)).encode()).hexdigest()[:16]
    stamp = args.out / f"inputs-{identity}.sha256"
    if args.worker:
        print(json.dumps(rebuild(args, stamp)))
        return
    # IDE and Sessions dev servers share this compiler and its isolated environment.
    sys.path.insert(0, str(ROOT))
    from build.lib.file_lock import exclusive_lock

    with exclusive_lock(args.out / "build.lock", create=True):
        if stamp.is_file() and stamp.read_text() == fingerprint(args):
            print(json.dumps({"changed": False}))
            return
        python = prepare_environment(args.out)
        subprocess.run([str(python), "-B", str(Path(__file__).resolve()), *sys.argv[1:], "--worker"], cwd=ROOT, check=True)


if __name__ == "__main__":
    main()
