---
name: ux-theming
description: Ash theming, color tokens, widget styles, focus indicators, and high-contrast theme support. Use when registering colors, styling widgets with theme tokens, or ensuring HC/focus compliance.
---

This skill covers color registration, CSS variable usage, widget style patterns, focus indicators, and high-contrast theme requirements.

---

## 1. Registering Colors

**File**: `src/ash/platform/theme/common/colorUtils.ts`

```typescript
export const myWidgetBackground = registerColor('myWidget.background',
    { light: '#ffffff', dark: '#252526', hcDark: Color.black, hcLight: Color.white },
    nls.localize('myWidgetBackground', "Background color of My Widget."));
```

**Rules**:
- Provide defaults for all four theme types: `light`, `dark`, `hcDark`, `hcLight`.
- HC themes must use solid colors (avoid transparency) and set explicit borders via `contrastBorder`.
- Use color transforms for derived colors: `transparent()`, `darken()`, `lighten()`, `oneOf()`.
- Reference existing colors when possible instead of hardcoding hex values.

## 2. Color Categories

| File | Colors |
|------|--------|
| `src/ash/platform/theme/common/colors/baseColors.ts` | `foreground`, `focusBorder`, `contrastBorder`, text links |
| `src/ash/platform/theme/common/colors/editorColors.ts` | Editor widgets, find match, errors/warnings |
| `src/ash/platform/theme/common/colors/inputColors.ts` | Input, toggle, validation |
| `src/ash/platform/theme/common/colors/listColors.ts` | List/tree selection, focus, hover, drop |
| `src/ash/platform/theme/common/colors/miscColors.ts` | Badge, scrollbar, progress bar, sash |
| `src/ash/workbench/common/theme.ts` | Tabs, sidebar, status bar, panels, editor groups, banner |

## 3. Using Colors in CSS

### Workbench Tooltip 配色

- 常规 Workbench tooltip 的背景与文字颜色跟随当前主题，采用 VS Code `editorHoverWidget.background` / `editorHoverWidget.foreground` 的主题语义：浅色主题使用浅色浮层，深色主题使用深色浮层，允许主题自定义覆盖。不能把所有主题的默认配色统一成深灰背景与浅色文字。
- 共享 tooltip、外层容器和箭头使用同一组主题颜色。Sessions 的 tooltip 背景与文字配色由 [Sessions 设计规范](../sessions-design-philosophy/SKILL.md#悬停提示tooltip) 独立定义；Sessions 专属配色不能修改共享 Workbench token 的注册值，也不能放进无窗口限定的共享选择器。

Colors are injected as CSS custom properties on `.stanza-workbench`:

```
Color ID: editor.background
CSS variable: --ash-editor-background
Usage: var(--ash-editor-background)
```

Conversion functions in `colorUtils.ts`:
- `asCssVariable(colorId)` → `'var(--ash-editor-background)'`
- `asCssVariableName(colorId)` → `'--ash-editor-background'`

**In CSS files**, reference directly:
```css
.my-widget {
    background-color: var(--ash-editor-background);
    color: var(--ash-foreground);
    border: 1px solid var(--ash-contrastBorder);
}
```

## 4. Widget Styles Pattern

**File**: `src/ash/platform/theme/browser/defaultStyles.ts`

Every widget type has a default style object and an override factory:

```typescript
// Use defaults:
const button = new Button(container, defaultButtonStyles);

// Override specific colors:
const button = new Button(container, getButtonStyles({
    buttonBackground: myCustomBackgroundColor
}));
```

Available defaults: `defaultButtonStyles`, `defaultInputBoxStyles`, `defaultCheckboxStyles`, `defaultToggleStyles`, `defaultDialogStyles`, `defaultListStyles`, `defaultSelectBoxStyles`, `defaultMenuStyles`, `defaultProgressBarStyles`, `defaultCountBadgeStyles`, `defaultBreadcrumbsWidgetStyles`, `defaultKeybindingLabelStyles`, `defaultFindWidgetStyles`.

## 5. Focus Indicators

Defined in `src/ash/workbench/browser/media/style.css`:

```css
.my-widget:focus {
    outline-width: 1px;
    outline-style: solid;
    outline-offset: -1px;
    outline-color: var(--ash-focusBorder);
}
```

**Rules**:
- Use `var(--ash-focusBorder)` — never hardcode a focus color.
- Default `outline-offset: -1px` (inset). Exception: checkboxes use `2px`.
- Active elements suppress focus ring: `.my-widget:active { outline: 0 !important; }`
- Use `.synthetic-focus` class for programmatic focus indication.
- Toggle buttons use `border: 1px dashed var(--ash-focusBorder)` instead of outline.

### Focus Trapping

Modal dialogs must trap focus within the dialog until dismissed. Use `dom.trackFocus()` and handle `Tab`/`Shift+Tab` cycling.

## 6. High Contrast Theme Rules

- **Always** provide `hcDark` and `hcLight` defaults when registering colors.
- HC backgrounds: `Color.black` (hcDark), `Color.white` (hcLight).
- HC borders: reference `contrastBorder` — it is `null` in normal themes, visible in HC.
- HC focus: use `activeContrastBorder` (derived from `focusBorder`).
- In CSS, use `.hc-black` / `.hc-light` class selectors for HC-specific overrides:
  ```css
  .hc-black .my-widget { border: 1px solid var(--ash-contrastBorder); }
  ```
- In TypeScript, check `isHighContrast(theme.type)` for runtime behavior changes.
- **Box shadows** must be removed or replaced in HC mode (shadows are invisible/distracting with high contrast borders):
  ```css
  .my-widget {
      box-shadow: 0 1px 3px var(--ash-widget-shadow);
  }
  .ash-high-contrast .my-widget {
      box-shadow: none;
      border: 1px solid var(--ash-contrastBorder);
  }
  ```

## 7. No Hardcoded Visual Values

Reviewers will always flag hardcoded colors, shadows, sizes that should use theme tokens or CSS variables.

| Hardcoded (flagged) | Correct |
|---------------------|---------|
| `rgba(0, 0, 0, 0.12)` | `var(--ash-widget-shadow)` or theme-aware variable |
| `#252526` | `var(--ash-editor-background)` |
| `color: white` | `var(--ash-button-foreground)` |
| `border: 1px solid #ccc` | `var(--ash-editorWidget-border)` |
| `border: 1px solid …` (width) | `var(--ash-strokeThickness)` for the 1px width |
| `border-radius: 6px` | `var(--ash-cornerRadius-medium)` (radius ramp) |
| `padding: 8px 12px` (off-scale) | spacing ramp (`--ash-spacing-size*`) |
| `font-size: 14px` (arbitrary) | size ramp (`--ash-fontSize-*`) |
| `font-weight: 500` | `--ash-fontWeight-semiBold` (no 500) |
| codicon `font-size: 14px` | `--ash-codiconFontSize` (16) / `-compact` (12) |

**Rule:** If a value relates to color, shadow, or border — it must come from a CSS variable or registered color token. The only exception is `0` (zero) values and purely structural measurements like `100%`.

**Size, spacing, radius, font and stroke** values have their own design-system **size** tokens (and decision logic — snap maps, the pill→`circle` rule, and the compact-glyph convention). Those live in the **ux-css-layout** skill (§10 Design-System Size Tokens) and the auto-injected `.github/instructions/design-tokens.instructions.md`. Reach for those when a flag is about *how big / how round / how bold* something is rather than *what color*.


---

## Key Files

| Area | File |
|------|------|
| Color registration | `src/ash/platform/theme/common/colorUtils.ts` |
| Color registry (barrel) | `src/ash/platform/theme/common/colorRegistry.ts` |
| Base colors | `src/ash/platform/theme/common/colors/baseColors.ts` |
| Workbench colors | `src/ash/workbench/common/theme.ts` |
| Default widget styles | `src/ash/platform/theme/browser/defaultStyles.ts` |
| Global workbench styles | `src/ash/workbench/browser/media/style.css` |
