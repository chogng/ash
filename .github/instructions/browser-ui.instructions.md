---
description: Ash browser UI DOM, CSS ownership, accessibility, and rendering rules.
applyTo: "**/src/ash/**/browser/**/*.ts,**/src/ash/**/browser/**/*.css,**/src/ash/**/*.css"
---

# Browser UI Guidelines

Detailed ownership contract: [UI styling ownership](../../docs/ui-styling-ownership.md).

## DOM vocabulary and ownership

- Use `domNode` for an exposed visual root, `<role>DomNode` for owned children, and `container` for a caller-provided parent.
- Use `element` for short-lived generic DOM values, tree/model elements and established generic widget contracts.
- Stable DOM creators own listener cleanup; register it beside creation.
- Hosts may size and position a directly hosted root, but must not mutate or style through its internal DOM.
- Ash-owned DOM and CSS use Ash's stable brand classes; do not copy or retain upstream product root classes.

## CSS and rendering

- Reflect state in classes such as `.checked` alongside the corresponding ARIA attribute. CSS selects classes, not `[aria-*]` or behavior identities such as `data-action-id`.
- Component variations use named presentation variants, not host-specific deep selectors or ambiguous boolean styling options.
- Keep presentation in CSS; inline styles carry computed geometry or component-local custom properties, not theme branches.
- Read measurements before DOM mutations. Retain stable DOM rather than rebuilding it on every render.

## Accessibility

- Preserve element semantics, ARIA, keyboard navigation, labels, disabled state, tab relationships and high-contrast presentation.
- Do not suppress focus outlines without an equivalent visible treatment.
