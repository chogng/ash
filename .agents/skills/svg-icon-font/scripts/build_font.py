#!/usr/bin/env python3
"""Compile explicitly mapped SVG artwork into native WOFF2 glyphs."""

from __future__ import annotations

import argparse
from array import array
import hashlib
import html
import json
import math
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.colorLib.builder import buildCOLR, buildCPAL
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.svgLib.path import parse_path
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables import otTables
from fontTools.ttLib.tables._g_l_y_f import GlyphCoordinates
from picosvg.svg import SVG
from picosvg.svg_transform import Affine2D
from picosvg.svg_types import SVGPath, union

SVG_NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", SVG_NS)
UPM = 1024
ELEMENTS = {"svg", "g", "path", "rect", "circle", "ellipse", "line", "polygon", "polyline", "defs", "clipPath", "use", "title", "desc"}
ATTRIBUTES = {
    "viewBox", "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "points", "d",
    "fill", "fill-rule", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit",
    "stroke-dasharray", "stroke-dashoffset", "transform", "clip-path", "clip-rule", "clipPathUnits", "id", "href",
    "opacity", "fill-opacity", "stroke-opacity", "style", "version",
}
PAINT_ALIASES = {"black": "#000", "#000000": "#000", "white": "#fff", "#ffffff": "#fff", "currentcolor": "#000"}


class _GlyphSVG(SVG):
    def _stroke(self, shape):
        # Skia's stroker uses device-space precision even for vector output.
        # Expanding at a 16-unit viewBox can turn small circles into rounded
        # squares; work in font units before restoring the SVG coordinate space.
        viewbox = self.view_box()
        scale = UPM / max(viewbox.w, viewbox.h)
        enlarged = shape.as_path().apply_transform(Affine2D(scale, 0, 0, scale, 0, 0))
        enlarged.stroke_width *= scale
        enlarged.stroke_dashoffset *= scale
        if enlarged.stroke_dasharray != "none":
            enlarged.stroke_dasharray = " ".join(str(float(value) * scale) for value in re.split(r"[, ]", enlarged.stroke_dasharray) if value)
        for path in super()._stroke(enlarged):
            yield path.apply_transform(Affine2D(1 / scale, 0, 0, 1 / scale, 0, 0))


def read_manifest(path):
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("manifest must be a JSON object")
    family = raw.get("family")
    if not isinstance(family, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9 _-]{0,79}", family):
        raise ValueError("family must be a font name containing ASCII letters, digits, spaces, underscores or hyphens")
    glyphs = raw.get("glyphs")
    if not isinstance(glyphs, list) or not glyphs:
        raise ValueError("glyphs must be a nonempty list of explicitly mapped SVG sources")
    ids, codepoints, result = set(), set(), []
    for item in glyphs:
        if not isinstance(item, dict):
            raise ValueError("each glyph must be a mapping with id, unicode and source")
        name, value, source = item.get("id"), item.get("unicode"), item.get("source")
        if not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*", name) or name in ids:
            raise ValueError(f"Invalid or duplicate icon id: {name!r}")
        if not isinstance(value, str) or not re.fullmatch(r"(?:U\+)?[0-9a-fA-F]{4,6}", value):
            raise ValueError(f"{name}: unicode must be an explicit hexadecimal PUA codepoint")
        cp = int(value.removeprefix("U+"), 16)
        if not (0xE000 <= cp <= 0xF8FF or 0xF0000 <= cp <= 0xFFFFD or 0x100000 <= cp <= 0x10FFFD) or cp in codepoints:
            raise ValueError(f"{name}: duplicate or non-PUA codepoint U+{cp:04X}")
        if not isinstance(source, str) or not source.endswith(".svg"):
            raise ValueError(f"{name}: source must name an SVG file relative to the manifest")
        ids.add(name)
        codepoints.add(cp)
        result.append((name, cp, (path.parent / source).resolve()))
    return family, sorted(result, key=lambda item: item[1])


def normalize_svg(path, preserve_paints=False):
    source = path.read_text(encoding="utf-8")
    if re.search(r"<!DOCTYPE|<!ENTITY|<\?(?!xml(?:\s|\?>))", source, re.I):
        raise ValueError(f"{path}: DTDs, entities and processing instructions are unsupported")
    root = ET.fromstring(source)
    if root.tag != f"{{{SVG_NS}}}svg":
        raise ValueError(f"{path}: expected a namespaced SVG root")
    values = [float(v) for v in re.split(r"[ ,]+", root.get("viewBox", "").strip()) if v]
    if len(values) != 4 or not all(math.isfinite(v) for v in values) or min(values[2:]) <= 0:
        raise ValueError(f"{path}: a finite positive viewBox is required")
    # An opaque white mask is precisely a geometric clip. Other masks require
    # compositing beyond the supported glyph conversion subset.
    masks = set()
    for mask in root.findall(f".//{{{SVG_NS}}}mask"):
        if set(mask.attrib) != {"id", "fill"} or mask.get("fill", "").lower() not in {"#fff", "#ffffff", "white"}:
            raise ValueError(f"{path}: only opaque white geometric masks can become glyph outlines")
        if any(set(child.attrib) - {"d"} or child.tag != f"{{{SVG_NS}}}path" for child in mask):
            raise ValueError(f"{path}: mask content is not an opaque geometric path")
        masks.add(mask.get("id"))
        mask.tag = f"{{{SVG_NS}}}clipPath"
        mask.attrib.pop("fill")
    for element in root.iter():
        mask = element.attrib.pop("mask", None)
        if mask is not None:
            match = re.fullmatch(r"url\(#([\w.-]+)\)", mask)
            if not match or match[1] not in masks or "clip-path" in element.attrib:
                raise ValueError(f"{path}: unsupported mask reference")
            element.set("clip-path", mask)
    for element in root.iter():
        tag = element.tag.removeprefix(f"{{{SVG_NS}}}")
        if tag not in ELEMENTS:
            raise ValueError(f"{path}: unsupported <{tag}>; preserve its artwork through an explicit conversion")
        if "style" in element.attrib:
            for declaration in element.attrib.pop("style").split(";"):
                if declaration.strip():
                    key, value = declaration.split(":", 1)
                    if key.strip() not in ATTRIBUTES - {"style", "id", "href"}:
                        raise ValueError(f"{path}: unsupported style property {key!r}")
                    element.set(key.strip(), value.strip())
        for key, value in list(element.attrib.items()):
            name = key.removeprefix("{http://www.w3.org/1999/xlink}")
            if name not in ATTRIBUTES or name == "href" and not re.fullmatch(r"#[\w.-]+", value):
                raise ValueError(f"{path}: unsupported attribute or external reference {name!r}")
            if "url" in value.lower() and not (name == "clip-path" and re.fullmatch(r"url\(#[\w.-]+\)", value)):
                raise ValueError(f"{path}: gradients and external resources cannot become a monochrome glyph")
            if name in {"opacity", "fill-opacity", "stroke-opacity"}:
                opacity = float(value)
                if not math.isfinite(opacity) or not 0 <= opacity <= 1:
                    raise ValueError(f"{path}: opacity must be finite and between zero and one")
                if opacity != 1 and not preserve_paints:
                    raise ValueError(f"{path}: transparency cannot become an opaque monochrome glyph")
                if opacity != 1 and tag in {"g", "svg"}:
                    raise ValueError(f"{path}: group opacity requires compositing beyond solid glyph layers")
            if name in {"fill", "stroke"}:
                paint = value.strip().lower()
                element.set(key, PAINT_ALIASES.get(paint, paint))
    svg = _GlyphSVG.fromstring(ET.tostring(root))
    # picosvg's clone returns its base class; retain the font-scale stroker.
    svg.topicosvg(ndigits=6, inplace=True)
    svg = svg.clip_to_viewbox()
    viewbox = svg.view_box()
    if viewbox is None or not all(math.isfinite(v) for v in viewbox) or viewbox.w <= 0 or viewbox.h <= 0:
        raise ValueError(f"{path}: a finite positive viewBox is required")
    shapes = list(svg.shapes())
    if preserve_paints:
        if any(float(group.get("opacity", "1")) != 1
               for group in ET.fromstring(svg.tostring()).iter(f"{{{SVG_NS}}}g")):
            raise ValueError(f"{path}: group opacity requires compositing beyond solid glyph layers")
        # Keep each expanded paint in SVG order. COLRv1's foreground palette
        # index can retain opacity while still inheriting the caller's color.
        layers = []
        for shape in shapes:
            if shape.fill == "none":
                continue
            opacity = shape.opacity * shape.fill_opacity
            if opacity:
                layers.append((shape.as_path().remove_overlaps().d, shape.fill, opacity))
        if not layers:
            raise ValueError(f"{path}: conversion produced no visible paint layers")
        return source, svg.tostring() + "\n", viewbox, layers
    paints = {PAINT_ALIASES.get(s.fill.lower(), s.fill.lower()) for s in shapes if s.fill != "none"}
    if paints != {"#000"} or not shapes:
        raise ValueError(f"{path}: expected opaque foreground paint, found {sorted(paints)}; fixed colors require explicit color-glyph classification")
    # Resolve each SVG fill rule before unioning the same-color paths. Overlap
    # removal keeps holes and joins correct in TrueType's nonzero winding model.
    shapes = [s.as_path().remove_overlaps() for s in shapes if s.fill != "none"]
    outline = SVGPath.from_commands(union(shapes)).d
    if not outline:
        raise ValueError(f"{path}: conversion produced an empty outline")
    normalized = f'<svg xmlns="{SVG_NS}" viewBox="{viewbox.x} {viewbox.y} {viewbox.w} {viewbox.h}"><path d="{outline}"/></svg>\n'
    return source, normalized, viewbox, outline


def make_glyph(viewbox, outline):
    scale = UPM / max(viewbox.w, viewbox.h)
    left, bottom = (UPM - viewbox.w * scale) / 2, (UPM - viewbox.h * scale) / 2
    pen = TTGlyphPen(None)
    transform = (scale, 0, 0, -scale, left - viewbox.x * scale, bottom + (viewbox.y + viewbox.h) * scale)
    parse_path(outline, TransformPen(Cu2QuPen(pen, UPM / 1000), transform))
    glyph = pen.glyph()
    # Skia can emit equivalent contours in a different order or with a different
    # starting point. Canonicalize before serialization, preserving winding and
    # on/off-curve flags so a rebuild cannot change bytes without changing art.
    contours, start = [], 0
    for end in glyph.endPtsOfContours:
        points = [(x, y, flag) for (x, y), flag in zip(glyph.coordinates[start:end + 1], glyph.flags[start:end + 1])]
        first = min(points)
        contours.append(min(points[index:] + points[:index] for index, point in enumerate(points) if point == first))
        start = end + 1
    if contours:
        contours.sort()
        points = [point for contour in contours for point in contour]
        glyph.coordinates = GlyphCoordinates((x, y) for x, y, _ in points)
        glyph.flags = array("B", (flag for _, _, flag in points))
        glyph.endPtsOfContours = []
        end = -1
        for contour in contours:
            end += len(contour)
            glyph.endPtsOfContours.append(end)
    return glyph


def build(manifest, out, color_glyphs=()):
    family, sources = read_manifest(manifest)
    color_glyphs = set(color_glyphs)
    if color_glyphs - {name for name, _, _ in sources}:
        raise ValueError("Color glyphs must name explicitly mapped sources")
    converted = [(name, cp, path, normalize_svg(path, name in color_glyphs)) for name, cp, path in sources]
    glyphs = {".notdef": TTGlyphPen(None).glyph()}
    color_paints, palette = {}, []
    for name, _, _, (_, _, vb, outline) in converted:
        if name not in color_glyphs:
            glyphs[name] = make_glyph(vb, outline)
            continue
        paints = []
        for index, (path, color, opacity) in enumerate(outline):
            layer_name = f"{name}.paint{index}"
            glyphs[layer_name] = make_glyph(vb, path)
            normalized = PAINT_ALIASES.get(color.lower(), color.lower())
            if normalized == "#000":
                palette_index = 0xFFFF
            else:
                normalized = {"red": "#ff0000", "blue": "#0000ff", "green": "#008000"}.get(normalized, normalized)
                if not re.fullmatch(r"#(?:[0-9a-f]{3}|[0-9a-f]{6})", normalized):
                    raise ValueError(f"{name}: unsupported solid paint {color!r}")
                digits = normalized[1:]
                if len(digits) == 3:
                    digits = "".join(digit * 2 for digit in digits)
                rgba = tuple(int(digits[offset:offset + 2], 16) / 255 for offset in (0, 2, 4)) + (1.0,)
                if rgba not in palette:
                    palette.append(rgba)
                palette_index = palette.index(rgba)
            paints.append({"Format": otTables.PaintFormat.PaintGlyph, "Glyph": layer_name,
                           "Paint": {"Format": otTables.PaintFormat.PaintSolid, "PaletteIndex": palette_index, "Alpha": opacity}})
        color_paints[name] = {"Format": otTables.PaintFormat.PaintColrLayers, "Layers": paints}
        silhouette = SVGPath.from_commands(union([SVGPath(d=path) for path, _, _ in outline])).d
        glyphs[name] = make_glyph(vb, silhouette)
    metrics = {}
    for name, glyph in glyphs.items():
        glyph.recalcBounds(glyphs)
        metrics[name] = (UPM, getattr(glyph, "xMin", 0))
        bounds = BoundsPen(None)
        glyph.draw(bounds, None)
        if name != ".notdef" and (not bounds.bounds or min(bounds.bounds) < -1 or max(bounds.bounds) > UPM + 1):
            raise ValueError(f"{name}: outline is empty or extends outside its SVG cell; correct its viewBox")
    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(list(glyphs))
    fb.setupCharacterMap({cp: name for name, cp, _ in sources})
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=UPM, descent=0, lineGap=0)
    stem = re.sub(r"[^A-Za-z0-9]", "", family)
    fb.setupNameTable({"familyName": family, "styleName": "Regular", "uniqueFontIdentifier": f"{family} Regular", "fullName": family, "psName": f"{stem}-Regular", "version": "Version 1.000"})
    fb.setupOS2(sTypoAscender=UPM, sTypoDescender=0, sTypoLineGap=0, usWinAscent=UPM, usWinDescent=0, usWeightClass=400)
    fb.setupPost()
    fb.setupMaxp()
    if color_paints:
        fb.font["CPAL"] = buildCPAL([palette or [(0.0, 0.0, 0.0, 1.0)]])
        fb.font["COLR"] = buildCOLR(color_paints, version=1, glyphMap=fb.font.getReverseGlyphMap())
    # Deterministic artifact bytes let callers distinguish artwork changes from
    # a mere rebuild. This fixed OpenType timestamp represents 2000-01-01 UTC.
    fb.font["head"].created = fb.font["head"].modified = 3029529600
    fb.font.recalcTimestamp = False
    out.mkdir(parents=True, exist_ok=True)
    ttf, woff2 = out / f"{stem}.ttf", out / f"{stem}.woff2"
    fb.save(ttf)
    fb.font.flavor = "woff2"
    fb.save(woff2)
    cmap = {cp: name for name, cp, _ in sources}
    for target in (ttf, woff2):
        with TTFont(target) as font:
            if font.getBestCmap() != cmap or font["hmtx"].metrics != metrics:
                raise ValueError(f"{target}: serialized font mappings or metrics changed")
    rows, mappings = [], []
    for name, cp, path, (original, normalized, _, _) in converted:
        for folder, content in (("source", original), ("normalized", normalized)):
            (out / folder).mkdir(exist_ok=True)
            (out / folder / f"{name}.svg").write_text(content, encoding="utf-8")
        mappings.append({"id": name, "unicode": f"U+{cp:04X}", "source": str(path), "sourceSha256": hashlib.sha256(original.encode()).hexdigest()})
        rows.append(f'<tr><th>{html.escape(name)}</th><td><img src="source/{name}.svg" alt="Source SVG"></td><td><img src="normalized/{name}.svg" alt="Normalized SVG"></td><td><span class="glyph" aria-label="Font glyph">&#{cp};</span></td><td><span class="glyph large" aria-label="Enlarged glyph">&#{cp};</span></td></tr>')
    preview = f'''<!doctype html><html lang="en"><meta charset="utf-8"><title>{family} preview</title>
<style>@font-face{{font-family:"{family}";src:url("{woff2.name}") format("woff2");font-weight:400}}body{{font:14px system-ui;margin:32px}}th,td{{padding:12px;text-align:left}}img{{width:16px;height:16px}}.glyph{{font-family:"{family}";font-size:16px;line-height:1;font-synthesis:none}}.large{{font-size:64px}}</style>
<h1>{family}</h1><p id="status">Loading the WOFF2 font…</p><table><tr><th>Icon</th><th>SVG</th><th>Outline</th><th>WOFF2 16px</th><th>WOFF2 64px</th></tr>{"".join(rows)}</table>
<script>document.fonts.load('400 16px "{family}"', {json.dumps("".join(chr(cp) for _, cp, _ in sources))}).then(fonts=>{{document.body.dataset.fontReady=String(fonts.length>0);document.getElementById('status').textContent=fonts.length?'Actual WOFF2 loaded.':'Font missing.';}});</script></html>'''
    (out / "index.html").write_text(preview, encoding="utf-8")
    (out / "glyphs.json").write_text(json.dumps({"family": family, "glyphs": mappings}, indent=2) + "\n", encoding="utf-8")
    report = {"ok": True, "kind": "static", "glyphs": len(sources), "colorGlyphs": len(color_paints), "unitsPerEm": UPM, "woff2": str(woff2), "woff2Sha256": hashlib.sha256(woff2.read_bytes()).hexdigest()}
    (out / "validation.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(build(args.manifest.resolve(), args.out.resolve()), indent=2))
    except (ValueError, KeyError, TypeError, OSError, ET.ParseError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
