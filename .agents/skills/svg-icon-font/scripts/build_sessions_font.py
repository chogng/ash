"""Bake the Sessions stroke profile into a font without changing IDE artwork.

Ordinary SVG strokes are expanded at the requested width. Explicitly classified
filled outlines are offset before clipping; solid shapes and brands keep their
artwork. The existing four variable glyphs remain variable, while all other
glyphs have a fixed Sessions outline at every weight coordinate.
"""

import json
import math
from pathlib import Path
import xml.etree.ElementTree as ET

from fontTools.ttLib import TTFont
from picosvg.svg_types import SVGPath, difference, union

from build_font import SVG_NS, build as build_static, read_manifest

SHAPES = {"path", "rect", "circle", "ellipse", "line", "polygon", "polyline"}
DEFINITIONS = {"defs", "mask", "clipPath"}


def prepare_svg(path, profile):
    root = ET.fromstring(path.read_text())
    width = profile["strokeWidth"]
    if not isinstance(width, (int, float)) or not math.isfinite(width) or width <= 0:
        raise ValueError("Sessions strokeWidth must be a finite positive number")
    viewbox = [float(value) for value in root.attrib["viewBox"].replace(",", " ").split()]
    scale = max(viewbox[2:]) / 16
    outlined = set(profile.get("outlinedFills", {}).get(path.stem, []))
    hollow = set(profile.get("outlineShapes", {}).get(path.stem, []))
    omitted = set(profile.get("omitShapes", {}).get(path.stem, []))
    inset = set(profile.get("insetStrokes", {}).get(path.stem, []))
    source_width = profile.get("sourceWidths", {}).get(path.stem, 1) * scale
    found, hollowed, removed = set(), set(), set()
    changed = {"strokes": 0, "filledOutlines": 0, "outlineShapes": 0, "omittedShapes": 0}
    index = 0

    def walk(element, inherited, parent=None):
        nonlocal index
        tag = element.tag.rsplit("}", 1)[-1]
        if tag in DEFINITIONS:
            return
        style = {**inherited, **element.attrib}
        if tag in SHAPES:
            current = index
            index += 1
            fill, stroke = style.get("fill", "black"), style.get("stroke", "none")
            if current in omitted:
                parent.remove(element)
                removed.add(current)
                changed["omittedShapes"] += 1
                return
            if current in hollow:
                if fill == "none":
                    raise ValueError(f"{path}: outlineShapes[{current}] no longer has a fill")
                element.set("fill", "none")
                stroke = stroke if stroke != "none" else fill
                element.set("stroke", stroke)
                fill = "none"
                hollowed.add(current)
                changed["outlineShapes"] += 1
            if stroke != "none" or current in outlined:
                if style.get("mask") and current not in inset:
                    raise ValueError(f"{path}: classify masked outline {current} in insetStrokes")
                multiplier = 2 if current in inset else 1
                if stroke != "none":
                    element.set("stroke-width", str(width * scale * multiplier))
                    changed["strokes"] += 1
                elif fill != "none" and tag == "path":
                    # Resolve winding and discard degenerate subpaths before
                    # offsetting, so exported stroke contours do not grow spurs.
                    outline = SVGPath(d=element.attrib["d"], fill_rule=style.get("fill-rule", "nonzero")).remove_overlaps()
                    delta = (width * scale - source_width) * multiplier
                    if abs(delta) > 1e-9:
                        outline.stroke_width = abs(delta)
                        outline.stroke_linejoin = "round"
                        border = SVGPath.from_commands(outline.stroke_commands(0.001))
                        operation = union if delta > 0 else difference
                        outline = SVGPath.from_commands(operation([outline, border]))
                    element.set("d", outline.d)
                    element.set("fill-rule", "nonzero")
                    changed["filledOutlines"] += 1
                    found.add(current)
                else:
                    raise ValueError(f"{path}: outlinedFills[{current}] must be a filled path")
        for child in list(element):
            walk(child, style, element)

    walk(root, {})
    if found != outlined or hollowed != hollow or removed != omitted or any(value < 0 or value >= index for value in inset):
        raise ValueError(f"{path}: stroke profile no longer matches its SVG shapes")
    return ET.tostring(root, encoding="unicode"), changed


def build_sessions(manifest, profile_path, out):
    _, sources = read_manifest(manifest)
    profile = json.loads(profile_path.read_text())
    known = {name for name, _, _ in sources}
    for field in ("outlinedFills", "outlineShapes", "omitShapes", "insetStrokes", "sourceWidths"):
        if set(profile.get(field, {})) - known:
            raise ValueError(f"Unknown Sessions glyphs in {field}")
    prepared = out / "sources"
    prepared.mkdir(parents=True, exist_ok=True)
    glyphs, changes = [], {}
    for name, codepoint, path in sources:
        artwork, changes[name] = prepare_svg(path, profile)
        (prepared / path.name).write_text(artwork)
        glyphs.append({"id": name, "unicode": f"{codepoint:04X}", "source": str((prepared / path.name).resolve())})
    generated = out / "manifest.json"
    generated.write_text(json.dumps({"family": "Ash UI Sessions", "glyphs": glyphs}, indent=2) + "\n")
    report = build_static(generated, out / "font")
    report.update({"strokeWidth": profile["strokeWidth"], "changes": changes})
    (out / "validation.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def merge_sessions(variable_path, static_path, codepoints):
    """Keep true variation for four glyphs and add fixed-width Sessions glyphs."""
    with TTFont(variable_path) as variable, TTFont(static_path) as static:
        names = set(static.getBestCmap().values())
        aliases = {name: name.removesuffix("-filled") for name in names
                   if name.endswith("-filled") and name.removesuffix("-filled") in names}
        order = list(variable.getGlyphOrder())
        varying = {name for name, variations in variable["gvar"].variations.items() if variations}
        for name in static.getGlyphOrder():
            if name not in order and name not in aliases:
                variable["glyf"][name] = static["glyf"][name]
                variable["hmtx"].metrics[name] = static["hmtx"].metrics[name]
                variable["gvar"].variations[name] = []
                order.append(name)
        variable.setGlyphOrder(order)
        variable["glyf"].setGlyphOrder(order)
        cmap = {codepoint: aliases.get(name, name) for codepoint, name in static.getBestCmap().items()}
        expected = {int(codepoints[name], 16): aliases.get(name, name) for name in names}
        for table in variable["cmap"].tables:
            if table.isUnicode():
                table.cmap = dict(cmap)
        variable["OS/2"].usFirstCharIndex = min(cmap)
        variable["OS/2"].usLastCharIndex = max(cmap)
        variable.recalcTimestamp = False
        variable["head"].created = variable["head"].modified = 3029529600
        variable.save(variable_path)
    with TTFont(variable_path) as font:
        if font.getBestCmap() != expected:
            raise ValueError("Sessions font lost a semantic glyph mapping")
        if {name for name, variations in font["gvar"].variations.items() if variations} != varying:
            raise ValueError("Sessions font changed the variable glyph set")
        return {"codepoints": len(expected), "glyphs": len(font.getGlyphOrder()) - 1,
                "variableGlyphs": len(varying), "outlineAliases": len(aliases)}
