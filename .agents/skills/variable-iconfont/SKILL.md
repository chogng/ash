---
name: variable-icon-font
description: Build and validate an animated OpenType variable icon font from compatible start/end SVG masters. Use when creating a monochrome icon font whose glyph shapes interpolate along a custom ANIM axis.
---

# Variable Icon Font

Build a real OpenType variable icon font from SVG master pairs. This skill is deliberately narrow: it compiles geometry; it does not design icons, integrate UI components, or silently redraw incompatible artwork.

## Supported in v0.1

- Two SVG masters per glyph: `start` and `end`.
- One custom OpenType variation axis, default `ANIM` from 0 to 100.
- One or many monochrome glyphs in one font.
- Private Use Area or other explicit Unicode mappings.
- TTF and WOFF2 outputs.
- Strict interpolation compatibility checks.
- Preview instances at configurable axis positions.
- Final-font validation of `fvar`, `gvar`, glyph mapping, and endpoint/intermediate rendering.

## Hard constraints

1. Treat SVGs as source artwork and generated fonts as build artifacts.
2. Never silently redraw an icon just to make interpolation pass.
3. Start/end SVGs for a glyph must have the same `viewBox`.
4. Start/end outlines must produce the same pen operation sequence: same contour count, segment kinds, and point arity.
5. All masters of a glyph use the same advance width.
6. Keep the custom axis tag exactly four ASCII characters. For private axes prefer uppercase tags such as `ANIM`.
7. If compatibility fails, stop and report the first mismatches. Ask for corrected SVG masters rather than inventing new geometry.

## Workflow

Run from the skill directory.

### 1. Install dependencies

```bash
python -m pip install -r requirements.txt
```

### 2. Prepare a manifest

Copy `templates/manifest.example.yaml`, then list every glyph and its start/end SVGs.

### 3. Check masters before building

```bash
python scripts/vifont.py check manifest.yaml
```

Do not continue if this fails.

### 4. Build the variable font

```bash
python scripts/vifont.py build manifest.yaml --out build
```

Expected build artifacts:

- `build/VariableIcons.ttf`
- `build/VariableIcons.woff2`
- `build/VariableIcons.designspace`
- `build/masters/master-000.ttf`
- `build/masters/master-100.ttf`

### 5. Validate and render previews

```bash
python scripts/vifont.py validate manifest.yaml --out build
python scripts/vifont.py preview manifest.yaml --out build
```

Or run the complete pipeline:

```bash
python scripts/vifont.py all manifest.yaml --out build
```

The complete pipeline additionally writes `build/validation.json` and SVG previews under `build/preview/<glyph>/`.

## Decision rules

- If only coordinates differ while the pen operation sequence matches, accept the masters.
- If contour order, segment type, point count, or close/open contour state differs, fail as incompatible in v0.1.
- Do not automatically add/delete points, split contours, merge contours, or convert fundamentally different geometry.
- If an SVG contains unsupported or surprising constructs, first flatten/expand it in the design tool and rerun the check.
- Review at least `ANIM=0,25,50,75,100`. Passing endpoints alone is insufficient evidence that the interpolation is visually valid.

## Success criteria

A build is successful only when all of the following are true:

- every SVG pair passes structural compatibility;
- the compiled font contains the configured axis with the configured min/default/max values;
- every configured Unicode maps to the expected glyph;
- every configured glyph has `gvar` variation data;
- the font can be instantiated at every configured preview position;
- preview SVGs are generated for inspection.

## Implementation note

The scripts use FontTools directly. Static TTF masters are built from the SVG outlines, a DesignSpace document defines the custom axis, and `fontTools.varLib` compiles the variable font. This avoids requiring Glyphs or fontmake for the v0.1 pipeline.

Read `references/interpolation-rules.md` before repairing source artwork and `references/variable-font-structure.md` when debugging the generated font tables.
