#!/usr/bin/env python3
"""Build and validate a simple animated variable icon font from SVG master pairs."""

from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
import xml.etree.ElementTree as ET

import yaml
from fontTools import varLib
from fontTools.designspaceLib import AxisDescriptor, DesignSpaceDocument, SourceDescriptor
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.svgLib.path import SVGPath
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont


@dataclass(frozen=True)
class AxisConfig:
    name: str
    tag: str
    minimum: float
    default: float
    maximum: float


@dataclass(frozen=True)
class GlyphConfig:
    name: str
    codepoint: int
    advance_width: int
    start: Path
    end: Path


@dataclass(frozen=True)
class Manifest:
    path: Path
    family: str
    units_per_em: int
    axis: AxisConfig
    preview_positions: list[float]
    glyphs: list[GlyphConfig]


class VIFontError(RuntimeError):
    pass


def _as_float(value: Any, field: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise VIFontError(f"{field} must be numeric, got {value!r}") from exc
    if not math.isfinite(number):
        raise VIFontError(f"{field} must be finite, got {value!r}")
    return number


def _parse_codepoint(value: Any) -> int:
    if isinstance(value, int):
        return value
    if not isinstance(value, str):
        raise VIFontError(f"unicode must be an integer or hex string, got {value!r}")
    text = value.strip().upper()
    if text.startswith("U+"):
        text = text[2:]
    if text.startswith("0X"):
        text = text[2:]
    try:
        return int(text, 16)
    except ValueError as exc:
        raise VIFontError(f"invalid Unicode code point: {value!r}") from exc


def load_manifest(path: Path) -> Manifest:
    path = path.resolve()
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise VIFontError("manifest root must be a mapping")

    family = str(raw.get("family", "Variable Icons")).strip()
    upm = int(raw.get("units_per_em", 1000))
    if not 16 <= upm <= 16384:
        raise VIFontError("units_per_em must be between 16 and 16384")

    a = raw.get("axis") or {}
    axis = AxisConfig(
        name=str(a.get("name", "Animation")),
        tag=str(a.get("tag", "ANIM")),
        minimum=_as_float(a.get("min", 0), "axis.min"),
        default=_as_float(a.get("default", 0), "axis.default"),
        maximum=_as_float(a.get("max", 100), "axis.max"),
    )
    if not re.fullmatch(r"[ -~]{4}", axis.tag):
        raise VIFontError("axis.tag must be exactly four printable ASCII characters")
    if axis.minimum >= axis.maximum:
        raise VIFontError("axis.min must be less than axis.max")
    if axis.default not in (axis.minimum, axis.maximum):
        raise VIFontError("axis.default must equal axis.min or axis.max with two SVG masters")

    span = axis.maximum - axis.minimum
    default_positions = [
        axis.minimum,
        axis.minimum + span * 0.25,
        axis.minimum + span * 0.5,
        axis.minimum + span * 0.75,
        axis.maximum,
    ]
    positions = [_as_float(v, "preview_positions") for v in raw.get("preview_positions", default_positions)]
    for value in positions:
        if not axis.minimum <= value <= axis.maximum:
            raise VIFontError(
                f"preview position {value:g} is outside the {axis.tag} range "
                f"[{axis.minimum:g}, {axis.maximum:g}]"
            )
    base = path.parent
    glyphs: list[GlyphConfig] = []
    seen_names: set[str] = set()
    seen_codepoints: set[int] = set()

    for item in raw.get("glyphs") or []:
        name = str(item["name"]).strip()
        cp = _parse_codepoint(item["unicode"])
        if name in seen_names:
            raise VIFontError(f"duplicate glyph name: {name}")
        if cp in seen_codepoints:
            raise VIFontError(f"duplicate Unicode code point: U+{cp:04X}")
        seen_names.add(name)
        seen_codepoints.add(cp)
        glyphs.append(
            GlyphConfig(
                name=name,
                codepoint=cp,
                advance_width=int(item.get("advance_width", upm)),
                start=(base / str(item["start"])).resolve(),
                end=(base / str(item["end"])).resolve(),
            )
        )

    if not glyphs:
        raise VIFontError("manifest must contain at least one glyph")
    return Manifest(path, family, upm, axis, positions, glyphs)


def svg_viewbox(path: Path) -> tuple[float, float, float, float]:
    if not path.exists():
        raise VIFontError(f"SVG not found: {path}")
    root = ET.parse(path).getroot()
    drawable_tags = {"path", "rect", "circle", "ellipse", "line", "polygon", "polyline"}
    for element in root.iter():
        tag = element.tag.rsplit("}", 1)[-1]
        if element.get("transform") and tag not in drawable_tags:
            raise VIFontError(
                f"unsupported transform on <{tag}> in {path}; flatten group or root transforms before building"
            )
    value = root.attrib.get("viewBox")
    if not value:
        raise VIFontError(f"SVG requires an explicit viewBox: {path}")
    nums = [float(x) for x in re.split(r"[ ,]+", value.strip()) if x]
    if len(nums) != 4 or nums[2] <= 0 or nums[3] <= 0:
        raise VIFontError(f"invalid viewBox in {path}: {value!r}")
    return nums[0], nums[1], nums[2], nums[3]


def font_transform(viewbox: tuple[float, float, float, float], upm: int) -> tuple[float, float, float, float, float, float]:
    min_x, min_y, width, height = viewbox
    scale = upm / max(width, height)
    scaled_w = width * scale
    scaled_h = height * scale
    left = (upm - scaled_w) / 2
    bottom = (upm - scaled_h) / 2
    # SVG is Y-down. Font coordinates are Y-up.
    return (
        scale,
        0.0,
        0.0,
        -scale,
        left - min_x * scale,
        bottom + (min_y + height) * scale,
    )


def record_svg(path: Path, upm: int) -> tuple[tuple[float, float, float, float], list[tuple[str, tuple[Any, ...]]]]:
    vb = svg_viewbox(path)
    pen = RecordingPen()
    SVGPath(str(path), transform=font_transform(vb, upm)).draw(pen)
    return vb, pen.value


def signature(recording: list[tuple[str, tuple[Any, ...]]]) -> list[tuple[str, int]]:
    return [(op, len(points)) for op, points in recording]


def check_glyph_pair(g: GlyphConfig, upm: int) -> dict[str, Any]:
    svb, srec = record_svg(g.start, upm)
    evb, erec = record_svg(g.end, upm)
    issues: list[str] = []
    if tuple(round(x, 6) for x in svb) != tuple(round(x, 6) for x in evb):
        issues.append(f"viewBox differs: start={svb}, end={evb}")

    ssig, esig = signature(srec), signature(erec)
    if ssig != esig:
        limit = max(len(ssig), len(esig))
        for i in range(limit):
            a = ssig[i] if i < len(ssig) else None
            b = esig[i] if i < len(esig) else None
            if a != b:
                issues.append(f"operation {i}: start={a}, end={b}")
                if len(issues) >= 11:
                    issues.append("additional mismatches omitted")
                    break

    return {
        "glyph": g.name,
        "unicode": f"U+{g.codepoint:04X}",
        "compatible": not issues,
        "start_operations": len(srec),
        "end_operations": len(erec),
        "issues": issues,
    }


def check_manifest(m: Manifest) -> dict[str, Any]:
    results = [check_glyph_pair(g, m.units_per_em) for g in m.glyphs]
    return {"ok": all(r["compatible"] for r in results), "glyphs": results}


def glyph_from_svg(path: Path, upm: int):
    vb = svg_viewbox(path)
    pen = TTGlyphPen(None)
    SVGPath(str(path), transform=font_transform(vb, upm)).draw(pen)
    return pen.glyph()


def _empty_glyph():
    return TTGlyphPen(None).glyph()


def build_master_font(m: Manifest, which: str, output: Path) -> None:
    glyph_order = [".notdef"] + [g.name for g in m.glyphs]
    cmap = {g.codepoint: g.name for g in m.glyphs}
    glyphs = {".notdef": _empty_glyph()}
    metrics = {".notdef": (m.units_per_em, 0)}

    for g in m.glyphs:
        source = g.start if which == "start" else g.end
        glyphs[g.name] = glyph_from_svg(source, m.units_per_em)
        metrics[g.name] = (g.advance_width, 0)

    fb = FontBuilder(m.units_per_em, isTTF=True)
    fb.setupGlyphOrder(glyph_order)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=int(m.units_per_em * 0.8), descent=-int(m.units_per_em * 0.2))
    suffix = "Master0" if which == "start" else "Master100"
    ps_family = re.sub(r"[^A-Za-z0-9]", "", m.family) or "VariableIcons"
    fb.setupNameTable(
        {
            "familyName": m.family,
            "styleName": "Regular",
            "uniqueFontIdentifier": f"{m.family} {suffix}",
            "fullName": f"{m.family} {suffix}",
            "psName": f"{ps_family}-{suffix}",
            "version": "Version 0.100",
        }
    )
    fb.setupOS2(
        sTypoAscender=int(m.units_per_em * 0.8),
        sTypoDescender=-int(m.units_per_em * 0.2),
        usWinAscent=m.units_per_em,
        usWinDescent=int(m.units_per_em * 0.2),
    )
    fb.setupPost()
    fb.setupMaxp()
    output.parent.mkdir(parents=True, exist_ok=True)
    fb.save(output)


def build_font(m: Manifest, out: Path) -> dict[str, str]:
    report = check_manifest(m)
    if not report["ok"]:
        raise VIFontError("master compatibility check failed; run `check` for details")

    out.mkdir(parents=True, exist_ok=True)
    masters = out / "masters"
    masters.mkdir(parents=True, exist_ok=True)
    start_ttf = masters / "master-000.ttf"
    end_ttf = masters / "master-100.ttf"
    build_master_font(m, "start", start_ttf)
    build_master_font(m, "end", end_ttf)

    ds = DesignSpaceDocument()
    axis = AxisDescriptor()
    axis.tag = m.axis.tag
    axis.name = m.axis.name
    axis.minimum = m.axis.minimum
    axis.default = m.axis.default
    axis.maximum = m.axis.maximum
    ds.addAxis(axis)

    for path, name, location in [
        (start_ttf, "master_start", m.axis.minimum),
        (end_ttf, "master_end", m.axis.maximum),
    ]:
        src = SourceDescriptor()
        src.path = str(path.resolve())
        src.name = name
        src.familyName = m.family
        src.styleName = "Regular"
        src.location = {m.axis.name: location}
        is_default = location == m.axis.default
        src.copyInfo = is_default
        src.copyLib = is_default
        src.copyGroups = is_default
        src.copyFeatures = is_default
        ds.addSource(src)

    designspace_path = out / f"{safe_filename(m.family)}.designspace"
    ds.write(designspace_path)
    variable_font, _, _ = varLib.build(ds)

    ttf_path = out / f"{safe_filename(m.family)}.ttf"
    variable_font.save(ttf_path)

    woff2_path = out / f"{safe_filename(m.family)}.woff2"
    webfont = TTFont(ttf_path)
    webfont.flavor = "woff2"
    webfont.save(woff2_path)

    return {
        "ttf": str(ttf_path),
        "woff2": str(woff2_path),
        "designspace": str(designspace_path),
    }


def safe_filename(name: str) -> str:
    compact = re.sub(r"[^A-Za-z0-9_-]+", "", name.replace(" ", ""))
    return compact or "VariableIcons"


def _axis_record(font: TTFont, tag: str):
    if "fvar" not in font:
        return None
    for axis in font["fvar"].axes:
        if axis.axisTag == tag:
            return axis
    return None


def validate_font(m: Manifest, out: Path) -> dict[str, Any]:
    ttf_path = out / f"{safe_filename(m.family)}.ttf"
    if not ttf_path.exists():
        raise VIFontError(f"font not found: {ttf_path}; run build first")
    font = TTFont(ttf_path)
    issues: list[str] = []
    axis = _axis_record(font, m.axis.tag)
    if axis is None:
        issues.append(f"fvar axis {m.axis.tag!r} not found")
    else:
        expected = (m.axis.minimum, m.axis.default, m.axis.maximum)
        actual = (float(axis.minValue), float(axis.defaultValue), float(axis.maxValue))
        if any(abs(a - b) > 1e-6 for a, b in zip(actual, expected)):
            issues.append(f"axis range mismatch: expected={expected}, actual={actual}")

    cmap = font.getBestCmap() or {}
    gvar = font["gvar"].variations if "gvar" in font else {}
    glyph_results = []
    for g in m.glyphs:
        mapped = cmap.get(g.codepoint)
        has_variation = bool(gvar.get(g.name))
        gissues = []
        if mapped != g.name:
            gissues.append(f"cmap U+{g.codepoint:04X} maps to {mapped!r}, expected {g.name!r}")
        if not has_variation:
            gissues.append("no gvar variation data")
        glyph_results.append({"glyph": g.name, "mapped": mapped, "has_gvar": has_variation, "issues": gissues})
        issues.extend(f"{g.name}: {x}" for x in gissues)

    # Ensure every requested intermediate instance can be created.
    for value in m.preview_positions:
        try:
            instantiateVariableFont(font, {m.axis.tag: value}, inplace=False)
        except Exception as exc:  # pragma: no cover - defensive reporting
            issues.append(f"failed to instantiate {m.axis.tag}={value}: {exc}")

    result = {
        "ok": not issues,
        "font": str(ttf_path),
        "axis": {
            "tag": m.axis.tag,
            "min": m.axis.minimum,
            "default": m.axis.default,
            "max": m.axis.maximum,
        },
        "glyphs": glyph_results,
        "preview_positions": m.preview_positions,
        "issues": issues,
    }
    (out / "validation.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def render_preview(m: Manifest, out: Path) -> list[str]:
    ttf_path = out / f"{safe_filename(m.family)}.ttf"
    if not ttf_path.exists():
        raise VIFontError(f"font not found: {ttf_path}; run build first")
    base = TTFont(ttf_path)
    written: list[str] = []
    for value in m.preview_positions:
        inst = instantiateVariableFont(base, {m.axis.tag: value}, inplace=False)
        glyph_set = inst.getGlyphSet()
        for g in m.glyphs:
            pen = SVGPathPen(glyph_set)
            transform_pen = TransformPen(pen, (1, 0, 0, -1, 0, m.units_per_em))
            glyph_set[g.name].draw(transform_pen)
            d = pen.getCommands()
            target_dir = out / "preview" / g.name
            target_dir.mkdir(parents=True, exist_ok=True)
            label = f"{int(value):03d}" if float(value).is_integer() else str(value).replace(".", "_")
            target = target_dir / f"{m.axis.tag}-{label}.svg"
            target.write_text(
                f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {m.units_per_em} {m.units_per_em}">\n'
                f'  <path d="{d}"/>\n'
                f'</svg>\n',
                encoding="utf-8",
            )
            written.append(str(target))
    return written


def print_check(report: dict[str, Any]) -> None:
    for item in report["glyphs"]:
        state = "PASS" if item["compatible"] else "FAIL"
        print(f"[{state}] {item['glyph']} ({item['unicode']})")
        for issue in item["issues"]:
            print(f"  - {issue}")
    print("PASS" if report["ok"] else "FAIL")


def command_check(m: Manifest, _out: Path) -> int:
    report = check_manifest(m)
    print_check(report)
    return 0 if report["ok"] else 2


def command_build(m: Manifest, out: Path) -> int:
    files = build_font(m, out)
    for key, value in files.items():
        print(f"{key}: {value}")
    return 0


def command_validate(m: Manifest, out: Path) -> int:
    report = validate_font(m, out)
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 3


def command_preview(m: Manifest, out: Path) -> int:
    files = render_preview(m, out)
    print(f"wrote {len(files)} preview SVG(s)")
    return 0


def command_all(m: Manifest, out: Path) -> int:
    report = check_manifest(m)
    print_check(report)
    if not report["ok"]:
        return 2
    build_font(m, out)
    validation = validate_font(m, out)
    render_preview(m, out)
    print(f"validation: {'PASS' if validation['ok'] else 'FAIL'}")
    print(f"output: {out}")
    return 0 if validation["ok"] else 3


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["check", "build", "validate", "preview", "all"])
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--out", type=Path, default=Path("build"))
    args = parser.parse_args(argv)

    try:
        m = load_manifest(args.manifest)
        out = args.out.resolve()
        return {
            "check": command_check,
            "build": command_build,
            "validate": command_validate,
            "preview": command_preview,
            "all": command_all,
        }[args.command](m, out)
    except VIFontError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
