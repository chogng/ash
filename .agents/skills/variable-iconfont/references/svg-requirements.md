# SVG source requirements

The FontTools SVG parser supports ordinary SVG path/shape geometry and common transforms, but variable-font interpolation still requires deterministic compatible outlines.

Recommended source practice:

- include an explicit `viewBox` on every SVG;
- use the same `viewBox` for a glyph's start and end masters;
- use filled monochrome vector geometry;
- expand strokes before export;
- expand effects/masks/boolean live effects before export when possible;
- avoid embedded raster images;
- avoid text objects; convert text to paths first;
- keep transforms simple or flatten them before export;
- keep the icon centered consistently across masters.

The build maps the SVG `viewBox` proportionally into the font em square and flips the SVG Y axis into font coordinates.
