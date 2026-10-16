---
description: Design-system size tokens (spacing, corner radius, font size, lxicon size, stroke). Use when writing or editing CSS to size, space, or round UI — prefer the `--ash-*` token vars over hardcoded px values.
applyTo: src/ash/**/*.css
---

# Design tokens for sizing, spacing & radii

Size tokens are registered in [baseSizes.ts](../../src/ash/platform/theme/common/sizes/baseSizes.ts) and emitted as `--ash-*` variables. Use tokens where available, except on-scale spacing literals as allowed below. Structural measurements without tokens may remain literal.

After changing registrations, run `pnpm stylelint:update`, review [ash-known-variables.json](../../build/lib/stylelint/ash-known-variables.json), then run `pnpm stylelint` and `pnpm hygiene`. Referenced size variables must be in the generated `sizes` list; component-owned variables enter `others` only after verifying their defining owner.

## Rows and toolbar actions

- Standard single-line lists and trees: 24px (`--ash-list-rowHeight`). TS geometry and token registration share `listRowHeight` in `src/ash/base/common/uiSizes.ts`; center contents without enlarging rows.
- Ordinary toolbar and row icon buttons: 24×24px (`--ash-toolbar-actionSize`), including editor-title and view-title toolbars. Glyph sizes follow the icon rules below.
- Code-adjacent editor actions, such as diff gutter buttons: retain 20×20px with 16px glyphs through a local override. Preserve editor line height; do not mechanically convert these buttons to 24px.
- No separate 22px control tier. Derive border-box inner sizes with `calc()`.
- Multi-line content, cards, section headers and specialized layouts such as history graphs retain content-specific sizing. New density tiers require a product decision.

## Spacing — padding, margin, gap

Use for `padding`, `margin`, `gap`, and fixed `width`/`height` of spacers. The numeric token name is the value in tenths of a px (`size200` = 20px).

| px | Variable |
|----|----------|
| 0  | `--ash-spacing-sizeNone` |
| 2  | `--ash-spacing-size20` |
| 4  | `--ash-spacing-size40` |
| 6  | `--ash-spacing-size60` |
| 8  | `--ash-spacing-size80` |
| 10 | `--ash-spacing-size100` |
| 12 | `--ash-spacing-size120` |
| 16 | `--ash-spacing-size160` |
| 20 | `--ash-spacing-size200` |
| 24 | `--ash-spacing-size240` |
| 28 | `--ash-spacing-size280` |
| 32 | `--ash-spacing-size320` |
| 36 | `--ash-spacing-size360` |
| 40 | `--ash-spacing-size400` |

On-scale raw px is permitted. Snap off-scale px to the nearest listed value, ties upward; check each shorthand length independently (`0 5px` → `0 6px`). Leave `auto`, `%`, `em`/`rem`, `var()` and `calc()` untouched.

## Corner radius — `border-radius`

| px | Variable | Use |
|----|----------|-----|
| 2  | `--ash-cornerRadius-xSmall` | very compact elements |
| 4  | `--ash-cornerRadius-small` | controls (buttons, inputs) |
| 6  | `--ash-cornerRadius-medium` | base / inner surfaces |
| 8  | `--ash-cornerRadius-large` | prominent / outer surfaces |
| 12 | `--ash-cornerRadius-xLarge` | very prominent surfaces |
| 9999 | `--ash-cornerRadius-circle` | fully rounded (pills, dots) |

**Snap map** for off-scale literals (ties round **up**): `2→xSmall`, `3,4→small`, `5,6→medium`, `7,8→large`, `10,11,12→xLarge`, `14,16,18,20→xLarge`, `999→circle`.

- **Pills** (radius ≈ half the element height, e.g. `28h`/`14r`, `36h`/`18r`, `22×22`/`11r`) → `--ash-cornerRadius-circle`, **not** xLarge. The literal-nearest token would square them and lose the fully-rounded intent.
- **Leave untouched:** `50%`, `0`, `0px`, `inherit`, and any `calc()`/`var()` expression. Preserve `!important`.

## Font size — `font-size`

Pair each font-size token with the weight listed below:

| px | Size var | Weight |
|----|----------|--------|
| 26 | `--ash-fontSize-heading1` | semiBold |
| 18 | `--ash-fontSize-heading2` | semiBold |
| 13 | `--ash-fontSize-heading3` | semiBold |
| 13 | `--ash-fontSize-body1` | regular |
| 11 | `--ash-fontSize-body2` | regular |
| 12 | `--ash-fontSize-label1` | regular |
| 11 | `--ash-fontSize-label2` | regular |
| 10 | `--ash-fontSize-label3` | regular |

## Font weight — `font-weight`

Use only these two weights:

| weight | Variable | Use |
|--------|----------|-----|
| 400 | `--ash-fontWeight-regular` | body, labels, metadata |
| 600 | `--ash-fontWeight-semiBold` | headings, "strong" emphasis |

- **No medium (500).** `font-weight: 500` is **off the ramp** — snap it to `semiBold` (600). The same goes for `700`/`bold` and any other numeric weight: round to the nearer of 400/600.
- **"Strong" is not a separate size.** A "Body 1 Strong" / "Label 2 Strong" style reuses the matching `--ash-fontSize-*` token paired with `semiBold`. Never introduce a separate strong *size* token.
- `normal` ≡ 400 → `regular`. **Leave untouched:** `inherit`, `lighter`, `bolder`, and any `var()`/`calc()` expression. Preserve `!important`.

## Lxicon size — icon `font-size`

Lxicons use only these two sizes:

| px | Variable | Use |
|----|----------|-----|
| 16 | `--ash-lxiconFontSize` (base) | default icon size |
| 12 | `--ash-lxiconFontSize-compact` | dense/inline chrome |

At 12px, use the registered `*Compact` glyph when available and update selectors targeting the original glyph class. Icons without compact variants (agent, vm, info, lock) keep their regular glyph.

## Stroke — border width

Use `--ash-strokeThickness` for 1px border and outline widths, including shorthands. Leave other widths unchanged.

## `.stanza-editor-background` must be opaque

Keep `.stanza-editor-background` fully opaque: Stanza uses it to carve reverse-rounded selection notches. For an embedded editor, `.stanza-editor` may be transparent while `.stanza-editor-background` uses the container's solid color.
