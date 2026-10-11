---
description: Ash best practices — reusing common UI primitives and patterns. Reference when writing or reviewing code.
applyTo: src/ash/**
---

# UI Primitives and APIs

## Buttons and Actions

- Use `Button` (`ash/base/browser/ui/button/button.ts`) and `Action` (`ash/base/common/actions.ts`); do not create a custom class or CSS to render a button or action.
- Render actions with `MenuWorkbenchToolBar` (`ash/platform/actions/browser/toolbar.ts`) and a `MenuId`. Use `WorkbenchToolBar` when actions and separator placement require explicit control.
- Use `Separator` (`ash/base/common/actions.ts`); do not insert separators inside action rendering.
- A toolbar in a widget that can have multiple instances needs an `IContextKeyService` scoped to that instance's DOM, with per-instance context keys.

## Editor and Session Actions

- Use invocation arguments to identify the target editor or session; it may be inactive. Resolve editor arguments with `resolveCommandsContext` (`ash/workbench/browser/parts/editor/editorCommandsContext.ts`), not `editorService.activeEditor`.
- Handle all editors in the resolved context, including multi-selected tabs.
- Context keys are for declarative enablement and visibility, not application state. Read state from its model or service rather than branching on `IContextKeyService.getContextKeyValue()`.

## Multi-Window DOM

- Create workbench elements in the main-window realm using `dom.$`, `dom.h` or `mainWindow.document.createElement`, including elements displayed in auxiliary windows. Do not use `targetWindow.document.createElement` or `element.ownerDocument.createElement`; auxiliary windows reject it to preserve `instanceof HTMLElement` checks.
- For window-bound timers, animation frames, focus, observers and computed styles, resolve the target window with `dom.getWindow(element)`.

## URI

- Use `Schemas` from `ash/base/common/network.ts`, not literal scheme strings.
- Compare URIs with `isEqual`, `isEqualOrParent` and `getComparisonKey` from `ash/base/common/resources.ts`, not `===` or `toString()`. Choose an `ExtUri` instance when case sensitivity needs explicit control.
- Preserve exact URI identity by default; domains explicitly select alternate policies such as ignoring fragments.

## Resource Labels

- Set `ResourceLabel`'s `supportIcons: true` only to parse inline `$(codicon)` text; file icons do not require it.
- For file icons in a tree/list, call `createFileIconThemableTreeContainerScope` (`ash/workbench/contrib/files/browser/views/explorerView.ts`) on an ancestor and register its disposable. Do not manually add `show-file-icons`; the scope keeps classes synchronized with the icon theme.

## Styling and Decorations

- Avoid reading CSS values back with `getComputedStyle`. For a value shared by TypeScript and CSS, set it on the element or through a component-local custom property.
- Editor highlights use regular decorations with `inlineClassName` or `className` and CSS. `ICodeEditorService.registerDecorationType` and `setDecorationsByType` are reserved for the extension-host API.
