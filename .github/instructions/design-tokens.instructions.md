---
description: Design-system size tokens (spacing, corner radius, font size, lxicon size, stroke). Use when writing or editing CSS to size, space, or round UI — prefer the `--ash-*` token vars over hardcoded px values.
applyTo: src/ash/**/*.css
---

# Design tokens for sizing, spacing & radii

IDE and Agent Window share token registration, CSS variable naming, and the default values below. Agent Window-only assignments and overrides belong to [Sessions style](../../src/ash/sessions/STYLE.md); unoverridden rules keep the shared defaults. Reuse existing tokens for the same semantic role, and apply window-specific values in the owning window or component's scope instead of changing shared defaults. A window-specific assignment does not by itself require a separate token namespace.

> **These tokens are the *moves*, not the reasoning.** They implement the **design philosophy** (Values → Principles → Moves): reach for a token *after* naming the feeling and the principle it serves - the owning surface determines a radius or typography role. See the [`design-philosophy` skill](../../.agents/skills/design-philosophy/SKILL.md) for the full vocabulary, worked examples, and how to give UI feedback in design terms.

Ash ships a design-system **size** ramp. These tokens are registered in [baseSizes.ts](../../src/ash/platform/theme/common/sizes/baseSizes.ts) and emitted as `--ash-*` CSS variables. **When generating or editing CSS, use the token variable instead of a raw `px` value** wherever a token exists for that value. This keeps new UI visually consistent with the design system.

> Every `--ash-*` size var you reference must already exist in [ash-known-variables.json](../../build/lib/stylelint/ash-known-variables.json) (`"sizes"` array, alphabetically sorted) or stylelint/hygiene fails. Adding a *new* token means adding it both in `baseSizes.ts` and that JSON file.

## Rows and toolbar actions

The table gives **IDE defaults**. Use the semantic tokens below for CSS row and action geometry, use `border-box` for icon action areas, and reserve spacing tokens for spacing. Each component owns its JS layout geometry: list/tree delegates supply row heights, and action hosts supply or measure action sizes. Keep those values consistent with the component's CSS, including local overrides; theme token registration is not a dependency of JS layout code.

| Use | Size | CSS | JS |
| --- | --- | --- | --- |
| Single-line lists, trees, suggestions and dropdown options | 22px | `var(--ash-list-rowHeight)` | Component-owned row delegate |
| Standard toolbar icon actions | 22×22px | `var(--ash-toolbar-actionSize)` | Host-supplied or measured action size |
| Code-adjacent icon actions | 20×20px | Override `--ash-toolbar-actionSize` locally | Match the component's geometry |
| Explicit roomy rows / actions | 24px / 24×24px | Override the corresponding token locally | Match the component's geometry |

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

```css
/* token   */          padding: var(--ash-spacing-size80) var(--ash-spacing-size120);
/* also ok */          padding: 8px 12px;   /* on-scale raw px is fine */
/* avoid   */          padding: 5px 7px;    /* off-scale - breaks rhythm */
```

**What matters is the value, not the token.** Adopting the `var()` is optional — a raw px value is fine **as long as it lands on the scale** (0, 2, 4, 6, 8, 10, 12, 16, 20, 24, 28, 32, 36, 40). What breaks visual rhythm is an **off-scale** value (3, 5, 7, 14, 26px…). Snap those to the nearest scale value (ties round **up**), e.g. `5px → 6px`, `3px → 4px`, `1px → 2px`, `26px → 28px`. Each length of a shorthand is checked independently (`0 5px → 0 6px`). `auto`, `%`, `em`/`rem`, and any `var()`/`calc()` expression are left untouched.

## Corner radius — `border-radius`

Token values are shared; the role assignments below are **IDE defaults**. Agent Window-only component assignments are defined in [Sessions style](../../src/ash/sessions/STYLE.md#圆角与边界).

| px | Variable | Use |
|----|----------|-----|
| 2  | `--ash-cornerRadius-xSmall` | very compact elements |
| 4  | `--ash-cornerRadius-small` | controls (buttons, inputs) |
| 6  | `--ash-cornerRadius-medium` | base / inner surfaces |
| 8  | `--ash-cornerRadius-large` | prominent / outer surfaces |
| 12 | `--ash-cornerRadius-xLarge` | very prominent surfaces |
| 16 | `--ash-cornerRadius-xxLarge` | extra-large surfaces |
| 9999 | `--ash-cornerRadius-circle` | fully rounded (pills, dots) |

**Snap map** for off-scale literals (ties round **up**): `2→xSmall`, `3,4→small`, `5,6→medium`, `7,8→large`, `10,11,12→xLarge`, `14,16,18,20→xxLarge`, `999→circle`.

- **Pills** (radius ≈ half the element height, e.g. `28h`/`14r`, `36h`/`18r`, `22×22`/`11r`) → `--ash-cornerRadius-circle`, **not** xLarge. The literal-nearest token would square them and lose the fully-rounded intent.
- **Leave untouched:** `50%`, `0`, `0px`, `inherit`, and any `calc()`/`var()` expression. Preserve `!important`.

## Font size — `font-size`

The values below are **IDE defaults**; Agent Window-only typography assignments are defined in [Sessions style](../../src/ash/sessions/STYLE.md#字体与留白). Pair a **size** token with a **weight** token; "Strong" reuses the matching size token + `fontWeight.semiBold`, **never** a separate "strong" size:

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

The generic ramp uses two weights — there are no others. Pair every text style with one of these:

| weight | Variable | Use |
|--------|----------|-----|
| 400 | `--ash-fontWeight-regular` | body, labels, metadata |
| 600 | `--ash-fontWeight-semiBold` | headings, "strong" emphasis |

- **No medium (500).** `font-weight: 500` is **off the ramp** — snap it to `semiBold` (600). The same goes for `700`/`bold` and any other numeric weight: round to the nearer of 400/600.
- **"Strong" is not a separate size.** A "Body 1 Strong" / "Label 2 Strong" style reuses the matching `--ash-fontSize-*` token paired with `semiBold`. Never introduce a separate strong *size* token.
- `normal` ≡ 400 → `regular`. **Leave untouched:** `inherit`, `lighter`, `bolder`, and any `var()`/`calc()` expression. Preserve `!important`.

```css
/* avoid */            font-weight: 500;   /* not on the 400/600 ramp */
/* prefer */           font-weight: var(--ash-fontWeight-semiBold);
```

## Lxicon size — icon `font-size`

Lxicons use **16px (base)**, **12px (compact)** or **18px (large)**. Agent Window primary actions and navigation explicitly select the large token; compact icons remain 12px. Keep the base token at 16px instead of overriding it on a window root. Other sizes require an explicit component assignment:

| px | Variable | Use |
|----|----------|-----|
| 16 | `--ash-lxiconFontSize` (base) | default icon size |
| 12 | `--ash-lxiconFontSize-compact` | dense/inline chrome |
| 18 | `--ash-lxiconFontSize-large` | large actions and navigation |

If a design or existing CSS sizes a lxicon at 14px, treat it as a bug: choose 16 (base), 12 (compact) or 18 (large) for its role and flag it.

When sizing an icon at the **compact** 12px size, also swap the registered glyph to its `*Compact` variant (e.g. `Lxicon.close` → `Lxicon.closeCompact`) so the icon is visually optimized for the small size. CSS `font-size` alone only scales the icon — it does not change to the compact glyph. Only swap the glyph when no CSS selector targets the original glyph class (e.g. `.lxicon-close`), otherwise update that selector too. Some icons (agent, vm, info, lock) have no compact variant — keep the regular glyph at the compact size.

## Stroke — border width

The design system has a **single** stroke thickness: 1px. Any `border`/`outline` width of 1px should use the token.

| px | Variable |
|----|----------|
| 1  | `--ash-strokeThickness` |

```css
/* prefer */           border: var(--ash-strokeThickness) solid var(--ash-widget-border);
/* avoid  */           border: 1px solid var(--ash-widget-border);
```

Applies to the `border: 1px solid <color>` shorthand and `border-width: 1px`. Other widths have no token — leave them as-is.

## `.stanza-editor-background` must be opaque

`.stanza-editor-background` must use a fully opaque color — making it `transparent` (or any partial alpha) is forbidden. Stanza reuses this layer to carve the reverse-rounded notches out of text selections, so a non-opaque background introduces subtle rendering bugs (blocky selection corners) and performance problems. To blend an embedded editor into its surface, keep `.stanza-editor` transparent and paint `.stanza-editor-background` with the container's solid background color.

