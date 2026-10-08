# Interpolation rules

A variable glyph is not a cross-fade between two pictures. It is an interpolation between corresponding outline points.

For each glyph, the start and end master must agree structurally:

- same number of contours;
- same contour order;
- same move/line/curve/qCurve operation sequence;
- same number of points per operation;
- same open/closed contour state;
- same semantic point correspondence.

Coordinates may differ. That coordinate delta is the variation data.

## Safe fixes outside this skill

A designer may deliberately repair source SVGs by:

- reordering contours when the correspondence is unambiguous;
- choosing matching contour start points;
- reversing contour direction consistently;
- making corresponding Bézier segments use compatible control-point topology.

## Unsafe automatic fixes

The v0.1 scripts must not silently:

- add or delete arbitrary nodes;
- merge or split contours;
- substitute a different icon shape;
- infer semantic correspondence between unrelated paths;
- rasterize/retrace an icon.

If the structure differs, correct the source masters in the design tool and rerun `check`.
