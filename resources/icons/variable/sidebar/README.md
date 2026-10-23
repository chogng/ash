# Sidebar variable icon experiment

Four existing monochrome sidebar icons, with a `wght` axis from 400 to 700.
At 16px, the designed stroke range is 1px to 1.5px; 550 is the 1.25px midpoint.
There is no optical-size or animation axis in this experiment.

The source centerlines come from `resources/icons/{add,code,projects,clockface}.svg`.
The plus's two round-capped centerlines reproduce its existing filled silhouette.
The other strokes are expanded at matching fixed sample positions. The generated
regular/bold SVG masters retain the 16×16 cell and corresponding contour points.
Regular/bold masters are generated intermediates under `.build/`, not a second
set of artwork the user must supply. The original SVGs remain the editable sources.

Follow `.agents/skills/svg-icon-font/SKILL.md` for SVG imports and font generation.
Install its `requirements.txt`, then run:

```sh
python3 .agents/skills/svg-icon-font/scripts/build_sidebar_variable.py
python3 -m http.server 8765 --bind 127.0.0.1 --directory .build/variable-sidebar-icons
```

Open `http://127.0.0.1:8765` for a preview using the actual WOFF2 file. The build
checks master compatibility, compiles the font, validates glyph mappings and
variation data, and renders five intermediate instances. The preview compares
the original SVGs against real variable-font glyphs at matching sizes.

The Agents Window uses weight 550 for these four glyphs in navigation (Code is
currently in the titlebar mode switch). Functional icons keep their outlines when
selected, with the selection highlight carrying state. The shared renderer uses native span/pseudo-element glyphs with no SVG wrapper.
Dedicated artwork and failed font loads may mount an SVG inside the stable icon
node. The IDE uses the original outlines at weight 400; only
the Agents Window selects this variable subset at 550.

To update the shipped static and variable fonts and their shared registry map, run:

```sh
python3 .agents/skills/svg-icon-font/scripts/build_product_font.py
```

The shipped files live beside the shared renderer in
`src/ash/base/browser/ui/lxicons/`. `lxicon.woff2` preserves IDE artwork;
`lxicon-variable.woff2` contains the complete Sessions catalog, combining these
four variable glyphs with fixed 1.25px linework and outline aliases. The Sessions
profile is maintained in `resources/icons/font/sessions.json`. Running the sidebar
builder alone only updates its preview artifacts; it does not replace a product font.
