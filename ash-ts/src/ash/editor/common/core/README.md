# Stanza editor core

`core/` is Stanza's DOM-free editor algebra. It is the TypeScript equivalent of
the operational part of VS Code's `src/vs/editor/common/core`, adapted to
Ash's explicit zero-based UTF-16 coordinates and LF-normalized text contract.
The directory is intentionally broad: cursor math, text coordinates, edit
composition, line edits, and small geometry/value helpers all need to agree on
one coordinate model.

| Area | Canonical modules | Responsibility |
| --- | --- | --- |
| Coordinates | `position.ts`, `range.ts`, `selection.ts`, `cursorColumns.ts` | Positions, ranges, selections, visible/indent columns |
| Ranges | `ranges/offsetRange.ts`, `lineRange.ts`, `columnRange.ts`, `rangeMapping.ts`, `rangeSingleLine.ts` | Offset, line, column, and source-to-modified mappings |
| Text coordinates | `text/textLength.ts`, `positionToOffset*.ts`, `abstractText.ts`, `getPositionOffsetTransformerFromTextModel.ts` | UTF-16 offset/position conversion and detached text views |
| Edit algebra | `edits/edit.ts`, `arrayEdit.ts`, `lengthEdit.ts`, `lineEdit.ts`, `stringEdit.ts`, `textEdit.ts` | Normalize, compose, inverse, rebase, map, and apply edits |
| Edit operations | `editOperation.ts`, `textChange.ts` | Single operations, compact offset changes, change compression/serialization |
| Text helpers | `characterClassifier.ts`, `wordCharacterClassifier.ts`, `wordHelper.ts`, `stringBuilder.ts` | Word boundaries, classifiers, UTF-16 assembly |
| Geometry/misc | `2d/*`, `misc/*` | DOM-free points, sizes, rectangles, EOL, indentation, RGBA, model defaults |
| Editor colors | `editorColorRegistry.ts` | Cursor, current-line, ruler, overview-ruler and bracket nesting colors; Platform owns registration and theme resolution |

`editorColorRegistry.ts` registers editor-owned colors with Platform's shared
registry. Themes include these definitions even when a theme was created before
the editor module loaded. Shared widget, token and diff colors remain in
`platform/theme/common/colors/editorColors.ts`.

The parent `common/` layer owns the mutable `TextModel`, piece-tree storage,
tracked ranges, decorations, command planning, and history implementation.
`core/` defines the values and algebra those owners consume; it does not own
the mutable document or undo stack. Browser projection, language services,
workbench state, and file transport may depend on `core/`, while `core/` must
not depend on any of them.

Consumers import directly from `position.ts`, `range.ts`, `selection.ts`,
`editOperation.ts`, `textChange.ts`, and the focused modules under `text/`.
The core has no aggregate entry that hides those owners.
