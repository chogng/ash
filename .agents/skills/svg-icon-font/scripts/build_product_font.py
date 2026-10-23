#!/usr/bin/env python3
"""Rebuild Ash's shipped icon fonts and append-only glyph map from SVG sources."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

from build_font import build
from build_sessions_font import build_sessions, merge_sessions

ROOT = Path(__file__).resolve().parents[4]
SOURCE = ROOT / "resources/icons"
MEDIA = ROOT / "src/ash/base/browser/ui/lxicons"
MANIFEST = SOURCE / "font/manifest.json"
SVG_EXCEPTIONS = {
    "claude": "Brand color", "csv-green": "File type color", "docx-blue": "File type color",
    "layout-panel-off-1": "Fixed color/opacity", "layout-sidebar-left-off-1": "Fixed color/opacity",
    "layout-sidebar-right-off-1": "Fixed color/opacity", "pdf-filled": "File type color",
    "pdf-red": "File type color", "xls-green": "File type color",
    "inspect": "Fixed white fill with black outlines", "symbol-method": "Translucent stroke overlay",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / ".build/product-icon-font")
    args = parser.parse_args()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    subprocess.run(["pnpm", "exec", "bun", "build/resources/icons/generate.ts", "--catalog-only"], cwd=ROOT, check=True)
    table = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {"family": "Ash UI Icons", "codepoints": {"add": "E001", "code": "E002", "projects": "E003", "clockface": "E004"}}
    codepoints = table["codepoints"]
    next_codepoint = max(int(value, 16) for value in codepoints.values()) + 1
    sources = sorted(SOURCE.glob("*.svg"))
    for source in sources:
        if source.stem not in codepoints:
            codepoints[source.stem] = f"{next_codepoint:04X}"
            next_codepoint += 1
    glyphs = [{"id": source.stem, "unicode": codepoints[source.stem], "source": str(source)} for source in sources if source.stem not in SVG_EXCEPTIONS]
    temporary = out / "manifest.json"
    temporary.write_text(json.dumps({"family": table["family"], "glyphs": glyphs}, indent=2) + "\n")
    report = build(temporary, out / "static")
    sessions = build_sessions(temporary, SOURCE / "font/sessions.json", out / "sessions")
    subprocess.run([sys.executable, str(Path(__file__).with_name("build_sidebar_variable.py")), "--out", str(out / "variable"), "--font-output", str(out / "variable/subset.woff2")], cwd=ROOT, check=True)
    coverage = merge_sessions(out / "variable/subset.woff2", sessions["woff2"], codepoints)
    table.update({"codepoints": codepoints, "svg": SVG_EXCEPTIONS, "sources": {source.stem: hashlib.sha256(source.read_text().strip().encode()).hexdigest() for source in sources}})
    MANIFEST.parent.mkdir(exist_ok=True)
    MANIFEST.write_text(json.dumps(table, indent=2) + "\n")
    shutil.copy2(report["woff2"], MEDIA / "lxicon.woff2")
    shutil.copy2(out / "variable/subset.woff2", MEDIA / "lxicon-variable.woff2")
    subprocess.run(["pnpm", "icons:generate"], cwd=ROOT, check=True)
    print(json.dumps({"glyphs": len(glyphs), "svgExceptions": len(SVG_EXCEPTIONS), "sessions": coverage, "font": str(MEDIA / "lxicon.woff2")}, indent=2))


if __name__ == "__main__":
    main()
