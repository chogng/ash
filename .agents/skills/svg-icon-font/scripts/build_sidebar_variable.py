#!/usr/bin/env python3
"""Build a four-glyph weight experiment from the existing sidebar artwork.

Strokes are expanded along the original centerlines at fixed sample positions.
Both masters therefore have corresponding points; compatibility is still checked
before compilation. Product icon registration and the shipped SVGs are untouched.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import shutil
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
import yaml

from fontTools.pens.recordingPen import RecordingPen
from fontTools.svgLib.path import parse_path
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[4]
ICONS = ("add", "code", "projects", "clockface")


def unit(vector):
    length = math.hypot(*vector)
    if length < 1e-9:
        raise ValueError("Repeated centerline point")
    return vector[0] / length, vector[1] / length


def sample_path(data):
    pen = RecordingPen()
    parse_path(data, pen)
    paths, points = [], []
    for operation, values in pen.value:
        if operation == "moveTo":
            if points:
                paths.append((points, False))
            points = [values[0]]
        elif operation == "lineTo":
            if math.dist(points[-1], values[0]) > 1e-9:
                points.append(values[0])
        elif operation in ("curveTo", "qCurveTo"):
            controls = [points[-1], *values]
            for index in range(1, 49):
                t = index / 48
                level = controls
                while len(level) > 1:
                    level = [tuple((1 - t) * a + t * b for a, b in zip(left, right))
                             for left, right in zip(level, level[1:])]
                if math.dist(points[-1], level[0]) > 1e-9:
                    points.append(level[0])
        elif operation in ("closePath", "endPath"):
            closed = operation == "closePath"
            if closed and math.dist(points[0], points[-1]) < 1e-9:
                points.pop()
            paths.append((points, closed))
            points = []
        else:
            raise ValueError(f"Unsupported centerline operation: {operation}")
    if points:
        paths.append((points, False))
    return paths


def centerlines(name, source_directory):
    if name == "add":
        # These two round-capped strokes reproduce add.svg's filled plus outline.
        return [([(1.5, 7.5), (13.5, 7.5)], False),
                ([(7.5, 1.5), (7.5, 13.5)], False)]
    result = []
    for element in ET.parse(source_directory / f"{name}.svg").getroot():
        tag = element.tag.rsplit("}", 1)[-1]
        if tag == "path":
            if element.get("stroke") != "#000":
                raise ValueError(f"Expected a monochrome centerline in {name}")
            result.extend(sample_path(element.attrib["d"]))
        elif tag == "circle":
            x, y, radius = (float(element.attrib[k]) for k in ("cx", "cy", "r"))
            result.append(([(x + radius * math.cos(i * math.tau / 192),
                             y + radius * math.sin(i * math.tau / 192))
                            for i in range(192)], True))
        else:
            raise ValueError(f"Unsupported element in {name}: {tag}")
    return result


def arc(center, start_angle, sweep, radius):
    steps = max(1, math.ceil(abs(sweep) / (math.pi / 16)))
    return [(center[0] + radius * math.cos(start_angle + sweep * i / steps),
             center[1] + radius * math.sin(start_angle + sweep * i / steps))
            for i in range(1, steps + 1)]


def offset_side(points, closed, side, radius, round_join):
    result = []
    count = len(points)
    for index, point in enumerate(points):
        incoming = unit(tuple(a - b for a, b in zip(point, points[(index - 1) % count])))
        outgoing = unit(tuple(a - b for a, b in zip(points[(index + 1) % count], point)))
        if not closed and index == 0:
            incoming = outgoing
        if not closed and index == count - 1:
            outgoing = incoming
        first, second = (-incoming[1], incoming[0]), (-outgoing[1], outgoing[0])
        turn = incoming[0] * outgoing[1] - incoming[1] * outgoing[0]
        cosine = incoming[0] * outgoing[0] + incoming[1] * outgoing[1]
        if 1 + cosine < 1e-6:
            raise ValueError("A reversing centerline needs explicitly designed masters")
        if round_join and side * turn < -1e-8:
            start = math.atan2(first[1] * side, first[0] * side)
            result.append((point[0] + first[0] * side * radius,
                           point[1] + first[1] * side * radius))
            result.extend(arc(point, start, math.atan2(turn, cosine), radius))
        else:
            result.append((point[0] + side * radius * (first[0] + second[0]) / (1 + cosine),
                           point[1] + side * radius * (first[1] + second[1]) / (1 + cosine)))
    return result


def outlines(name, width, source_directory):
    contours = []
    for points, closed in centerlines(name, source_directory):
        radius = width / 2
        # Projects uses SVG's default miter join; the other selected icons use round joins.
        left = offset_side(points, closed, 1, radius, name != "projects")
        right = offset_side(points, closed, -1, radius, name != "projects")
        if closed:
            contours.extend([list(reversed(left)), right])
        else:
            end = math.atan2(left[-1][1] - points[-1][1], left[-1][0] - points[-1][0])
            start = math.atan2(right[0][1] - points[0][1], right[0][0] - points[0][0])
            contour = left + arc(points[-1], end, -math.pi, radius)
            contour += list(reversed(right)) + arc(points[0], start, -math.pi, radius)
            contours.append(list(reversed(contour)))
    return contours


def write_masters(masters, source_directory):
    masters.mkdir(parents=True, exist_ok=True)
    for name in ICONS:
        for label, width in (("regular", 1), ("bold", 1.5)):
            paths = []
            for contour in outlines(name, width, source_directory):
                coordinates = " L".join(f"{x:.6f},{y:.6f}" for x, y in contour)
                paths.append(f'  <path d="M{coordinates} Z"/>')
            svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">\n'
            (masters / f"{name}.{label}.svg").write_text(svg + "\n".join(paths) + "\n</svg>\n")


def normalize_metrics(path, export_webfont=True):
    font = TTFont(path)
    upm = font["head"].unitsPerEm
    # Square icon cells use the SVG bottom as baseline, with their original side bearing.
    font["hhea"].ascent, font["hhea"].descent, font["hhea"].lineGap = upm, 0, 0
    font["OS/2"].sTypoAscender, font["OS/2"].sTypoDescender, font["OS/2"].sTypoLineGap = upm, 0, 0
    font["OS/2"].usWinAscent, font["OS/2"].usWinDescent = upm, 0
    for name in font.getGlyphOrder():
        glyph = font["glyf"][name]
        glyph.recalcBounds(font["glyf"])
        font["hmtx"].metrics[name] = (upm, getattr(glyph, "xMin", 0))
        if name == "add":
            glyph.flags[0] |= 0x40  # The plus is the union of two overlapping round-capped strokes.
    font.save(path)
    if export_webfont:
        font.flavor = "woff2"
        font.save(path.with_suffix(".woff2"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / ".build/variable-sidebar-icons")
    parser.add_argument("--font-output", type=Path)
    parser.add_argument("--source-directory", type=Path, default=ROOT / "resources/icons")
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("vifont", ROOT / ".agents/skills/variable-iconfont/scripts/vifont.py")
    vifont = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = vifont
    spec.loader.exec_module(vifont)
    build_master = vifont.build_master_font

    def build_square_master(manifest, which, path):
        build_master(manifest, which, path)
        # Side bearings must be correct before varLib derives phantom-point deltas.
        # Repairing only the final font would make heavier glyphs drift sideways.
        normalize_metrics(path, export_webfont=False)

    vifont.build_master_font = build_square_master
    args.out.mkdir(parents=True, exist_ok=True)
    masters = args.out / "source-masters"
    write_masters(masters, args.source_directory)
    source = yaml.safe_load((args.source_directory / "variable/sidebar/manifest.yaml").read_text())
    for glyph in source["glyphs"]:
        glyph["start"] = str((masters / f'{glyph["name"]}.regular.svg').resolve())
        glyph["end"] = str((masters / f'{glyph["name"]}.bold.svg').resolve())
    generated_manifest = args.out / "source-manifest.yaml"
    generated_manifest.write_text(yaml.safe_dump(source))
    manifest = vifont.load_manifest(generated_manifest)
    compatibility = vifont.check_manifest(manifest)
    vifont.print_check(compatibility)
    if not compatibility["ok"]:
        raise SystemExit("Master incompatibility: correct the SVG sources before building")
    artifacts = vifont.build_font(manifest, args.out)
    normalize_metrics(Path(artifacts["ttf"]))
    validation = vifont.validate_font(manifest, args.out)
    if not validation["ok"]:
        raise SystemExit(json.dumps(validation, indent=2))
    if args.font_output:
        args.font_output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(Path(artifacts["ttf"]).with_suffix(".woff2"), args.font_output)
    vifont.render_preview(manifest, args.out)
    reference = args.out / "reference"
    reference.mkdir(exist_ok=True)
    for name in ICONS:
        shutil.copy2(args.source_directory / f"{name}.svg", reference / f"{name}.svg")
    shutil.copy2(args.source_directory / "variable/sidebar/preview.html", args.out / "index.html")
    print(json.dumps({"artifacts": artifacts, "validation": validation}, indent=2))


if __name__ == "__main__":
    main()
