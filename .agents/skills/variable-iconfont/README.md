# variable-icon-font skill

A narrow skill/toolchain for compiling compatible SVG animation masters into a real OpenType variable icon font.

Quick start:

```bash
python -m pip install -r requirements.txt
python scripts/vifont.py all templates/manifest.example.yaml --out build
```

Then inspect:

- `build/VariableIcons.ttf`
- `build/VariableIcons.woff2`
- `build/validation.json`
- `build/preview/folder/ANIM-000.svg` through `ANIM-100.svg`

The example uses one `folder` glyph mapped to `U+E001` and a custom `ANIM` axis from 0 to 100.
