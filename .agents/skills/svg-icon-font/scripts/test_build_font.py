"""Exercise SVG fidelity, stable mappings and serialized font output."""

import json
import math
import tempfile
import unittest
from pathlib import Path

from fontTools.pens.areaPen import AreaPen
from fontTools.ttLib import TTFont

from build_font import UPM, build, normalize_svg
from build_sessions_font import build_sessions


class SvgFontTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def svg(self, body, name="sample", attributes=""):
        path = self.root / f"{name}.svg"
        path.write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" {attributes}>{body}</svg>')
        return path

    def manifest(self, sources):
        path = self.root / "manifest.json"
        path.write_text(json.dumps({"family": "Ash Test Icons", "glyphs": sources}))
        return path

    def test_stroked_circle_keeps_its_hole_and_metrics(self):
        source = self.svg('<circle cx="8" cy="8" r="5" fill="none" stroke="currentColor"/>')
        manifest = self.manifest([{"id": "ring", "unicode": "E001", "source": source.name}])
        out = self.root / "font"
        report = build(manifest, out)
        self.assertTrue(report["ok"])
        with TTFont(report["woff2"]) as font:
            glyphs = font.getGlyphSet()
            pen = AreaPen(glyphs)
            glyphs["ring"].draw(pen)
            expected = math.pi * (5.5 ** 2 - 4.5 ** 2) * (UPM / 16) ** 2
            self.assertAlmostEqual(abs(pen.value) / expected, 1, delta=0.025)
            glyph = font["glyf"]["ring"]
            self.assertEqual(font["hmtx"].metrics["ring"], (UPM, glyph.xMin))
            self.assertEqual((font["hhea"].ascent, font["hhea"].descent, font["hhea"].lineGap), (UPM, 0, 0))
            self.assertNotIn("fvar", font)

    def test_curves_group_transforms_and_reordered_manifest(self):
        a = self.svg('<g transform="translate(1 2)"><path d="M1 4 C4 0 8 0 11 4" fill="none" stroke="#000" stroke-linecap="round"/></g>', "curve")
        b = self.svg('<rect x="2" y="2" width="12" height="12"/>', "box")
        entries = [{"id": "curve", "unicode": "E002", "source": a.name}, {"id": "box", "unicode": "E001", "source": b.name}]
        one = build(self.manifest(entries), self.root / "one")
        two = build(self.manifest(list(reversed(entries))), self.root / "two")
        self.assertEqual(one["woff2Sha256"], two["woff2Sha256"])
        with TTFont(one["woff2"]) as font:
            self.assertEqual(font.getBestCmap(), {0xE001: "box", 0xE002: "curve"})
            self.assertGreater(font["glyf"]["curve"].numberOfContours, 0)

    def test_evenodd_hole_survives_union(self):
        source = self.svg('<path fill-rule="evenodd" d="M1 1H15V15H1Z M4 4H12V12H4Z"/>')
        report = build(self.manifest([{"id": "hole", "unicode": "E001", "source": source.name}]), self.root / "font")
        with TTFont(report["woff2"]) as font:
            glyphs = font.getGlyphSet()
            pen = AreaPen(glyphs)
            glyphs["hole"].draw(pen)
            self.assertAlmostEqual(abs(pen.value), (14 ** 2 - 8 ** 2) * (UPM / 16) ** 2)

    def test_white_mask_and_viewport_clip_preserve_visible_area(self):
        source = self.svg('<defs><mask id="cut" fill="white"><path d="M0 0H8V16H0Z"/></mask></defs><path mask="url(#cut)" d="M-4 -4H20V20H-4Z"/>')
        report = build(self.manifest([{"id": "clipped", "unicode": "E001", "source": source.name}]), self.root / "font")
        with TTFont(report["woff2"]) as font:
            glyphs = font.getGlyphSet()
            pen = AreaPen(glyphs)
            glyphs["clipped"].draw(pen)
            self.assertAlmostEqual(abs(pen.value), UPM ** 2 / 2)

    def test_lossy_or_unsafe_inputs_fail_explicitly(self):
        inputs = [
            '<path fill="red" d="M1 1H4V4H1Z"/>',
            '<path fill="red" d="M1 1H4V4H1Z"/><path fill="blue" d="M8 8H12V12H8Z"/>',
            '<rect x="1" y="1" width="14" height="14" opacity="0.5"/>',
            '<text x="1" y="10">A</text>',
            '<image href="file:///secret"/>',
            '<path d="M1 1H8V8Z" onclick="alert(1)"/>',
            '<defs><linearGradient id="a"/></defs><path fill="url(#a)" d="M1 1H8V8Z"/>',
        ]
        for index, body in enumerate(inputs):
            with self.subTest(body=body), self.assertRaises(ValueError):
                normalize_svg(self.svg(body, f"bad{index}"))

    def test_duplicate_and_non_pua_mapping_fail(self):
        source = self.svg('<rect x="1" y="1" width="14" height="14"/>')
        for codepoint in ["0041", "E001"]:
            entries = [{"id": "one", "unicode": "E001", "source": source.name}, {"id": "two", "unicode": codepoint, "source": source.name}]
            with self.subTest(codepoint=codepoint), self.assertRaises(ValueError):
                build(self.manifest(entries), self.root / "font")

    def sessions(self, source, profile):
        manifest = self.manifest([{"id": source.stem, "unicode": "E001", "source": source.name}])
        path = self.root / "sessions.json"
        path.write_text(json.dumps({"strokeWidth": 1.25, **profile}))
        return build_sessions(manifest, path, self.root / "sessions")

    def glyph_area(self, report, name):
        with TTFont(report["woff2"]) as font:
            glyphs = font.getGlyphSet()
            pen = AreaPen(glyphs)
            glyphs[name].draw(pen)
            return abs(pen.value) / (UPM / 16) ** 2

    def test_sessions_normalizes_strokes_without_changing_source_or_ide_font(self):
        source = self.svg('<circle cx="8" cy="8" r="5" fill="none" stroke="#000" stroke-width="2"/>', "ring")
        original = source.read_bytes()
        manifest = self.manifest([{"id": "ring", "unicode": "E001", "source": source.name}])
        ide = build(manifest, self.root / "ide")
        sessions = self.sessions(source, {})
        expected = math.pi * ((5 + 1.25 / 2) ** 2 - (5 - 1.25 / 2) ** 2)
        self.assertAlmostEqual(self.glyph_area(sessions, "ring"), expected, delta=0.4)
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(build(manifest, self.root / "ide-again")["woff2Sha256"], ide["woff2Sha256"])

    def test_sessions_offsets_filled_outline_but_keeps_solid_dot(self):
        source = self.svg('<path fill-rule="evenodd" d="M2 2H14V14H2Z M3 3H13V13H3Z"/><circle cx="8" cy="8" r="1"/>', "mixed")
        report = self.sessions(source, {"outlinedFills": {"mixed": [0]}})
        # A 1px filled ring grows by 0.125px on each side. The solid dot is unchanged.
        expected = 12.25 ** 2 - 9.75 ** 2 + math.pi
        self.assertAlmostEqual(self.glyph_area(report, "mixed"), expected, delta=0.1)

    def test_sessions_preserves_the_visible_width_of_an_inside_masked_stroke(self):
        source = self.svg('<mask id="edge" fill="white"><path d="M2 2H14V14H2Z"/></mask><path fill="none" stroke="#000" stroke-width="2" mask="url(#edge)" d="M2 2H14V14H2Z"/>', "inset")
        report = self.sessions(source, {"insetStrokes": {"inset": [0]}})
        self.assertAlmostEqual(self.glyph_area(report, "inset"), 12 ** 2 - 9.5 ** 2)

    def test_sessions_rejects_stale_shape_classification(self):
        source = self.svg('<circle cx="8" cy="8" r="5" fill="none" stroke="#000"/>', "ring")
        with self.assertRaises(ValueError):
            self.sessions(source, {"outlinedFills": {"ring": [0]}})

    def test_sessions_can_use_outlines_in_place_of_solid_ui_shapes(self):
        source = self.svg('<circle cx="8" cy="8" r="5"/><path fill="#000" d="M1 1H2V2H1Z"/>', "solid")
        report = self.sessions(source, {"outlineShapes": {"solid": [0]}, "omitShapes": {"solid": [1]}})
        expected = math.pi * ((5 + 1.25 / 2) ** 2 - (5 - 1.25 / 2) ** 2)
        self.assertAlmostEqual(self.glyph_area(report, "solid"), expected, delta=0.4)


if __name__ == "__main__":
    unittest.main()
