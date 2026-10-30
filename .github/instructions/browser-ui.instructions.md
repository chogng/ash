---
description: Ash browser UI DOM, CSS ownership, accessibility, and rendering rules.
applyTo: "**/src/ash/**/browser/**/*.ts,**/src/ash/**/browser/**/*.css,**/src/ash/**/*.css"
---

# Browser UI Guidelines

Detailed ownership contract: [UI styling ownership](../../docs/ui-styling-ownership.md).

## DOM vocabulary and ownership

- Keep component-created DOM private by default. Expose a root only when mounting, layout or native DOM integration is part of the component's public responsibility; document permitted host operations, node identity and lifetime. Existing callers are migration requirements, not proof that a node must remain public.
- Use `domNode` for an exposed visual root, `<role>DomNode` for owned children, and `container` for a caller-provided parent.
- Use `element` for short-lived generic DOM values, tree/model elements and established generic widget contracts.
- Stable DOM creators own listener cleanup; register it beside creation.
- Hosts own placement, visibility and cross-component associations through their own containers or an explicitly exposed root. Component-owned content, state, ARIA and presentation must go through semantic APIs; do not reach internal DOM through selectors, casts or replacement getters.
- Add a host container only for an owned layout, visibility or association boundary. Do not mechanically wrap every widget or replace DOM access with one setter per DOM operation.
- Ash-owned DOM and CSS use Ash's stable brand classes; do not copy or retain upstream product root classes.

## CSS and rendering

- Reflect state in classes such as `.checked` alongside the corresponding ARIA attribute. CSS selects classes, not `[aria-*]` or behavior identities such as `data-action-id`.
- Component variations use named presentation variants, not host-specific deep selectors or ambiguous boolean styling options.
- Keep presentation in CSS; inline styles carry computed geometry or component-local custom properties, not theme branches.
- Read measurements before DOM mutations. Retain stable DOM rather than rebuilding it on every render.

## Accessibility

- Preserve element semantics, ARIA, keyboard navigation, labels, disabled state, tab relationships and high-contrast presentation.
- Do not suppress focus outlines without an equivalent visible treatment.
