---
description: Ash source code organization — layers, target environments, dependency injection, and folder structure conventions. Reference when adding new modules, services, or contributions.
applyTo: "**/src/ash/**"
---

# Source Code Organization

Canonical reference: https://github.com/microsoft/vscode/wiki/Source-Code-Organization

## Layers

The `src/ash/` core is partitioned into ordered layers — each may only import from layers below it:

1. **`base`** — General utilities and UI building blocks (no service dependencies)
2. **`platform`** — Service injection support and base services shared across layers
3. **`editor`** — Stanza Editor core (no `node` or `electron-*` dependencies)
4. **`workbench`** — Full Ash workbench, panels, views, and framework
5. **`code`** — Desktop app entry point (Electron main, shared process, CLI)
6. **`server`** — Server app entry point for remote development
7. **`sessions`** — Agent Sessions window (may import from `workbench` and below; `workbench` must never import from `sessions`)

## Target Environments

Choose the owning layer and feature first, then its runtime environment. The table limits available APIs; it does not require every function without DOM access to live in `common`. A browser feature may keep pure helpers beside its orchestration. Extract shared code only for a concrete independent responsibility and consumer.

| Folder | APIs Available | May Use |
|--------|---------------|---------|
| `common` | Basic JavaScript only | — |
| `browser` | Web/DOM APIs | `common` |
| `node` | Node.js APIs | `common` |
| `electron-browser` | Browser + limited Electron IPC | `common`, `browser` |
| `electron-utility` | Electron utility process | `common`, `node` |
| `electron-main` | Electron main process | `common`, `node`, `electron-utility` |

## Workbench Organization

- `ash/workbench/{common|browser|electron-browser}` — minimal workbench core
- `ash/workbench/api` — `ash.d.ts` API provider
- `ash/workbench/services` — core services (not contrib-specific)
- `ash/workbench/contrib` — feature contributions

### Contribution Rules

- Workbench core and shared services must not depend on contribution-owned contracts or implementations. This includes type-only imports. Entry points may import contributions to assemble features.
- Workbench contributions use a `.contribution.ts` registration entry point. Editor contributions follow their editor bundle and registration contracts; this convention does not require an extra editor entry file.
- Cross-contribution consumers use the owning feature's public API, never its private implementation. There is no requirement to create a `common` API file for every contribution.
- Contracts consumed by shared registries belong to the lower shared owner; contributions implement or consume them. Do not place those contracts inside a contribution and import them back into the shared registry.

## Entry Points

Only code referenced from entry point files is loaded:

- `workbench.common.main.ts` — shared dependencies
- `workbench.desktop.main.ts` — desktop-only
- `workbench.web.main.ts` — web-only

## Dependency Injection

Services are consumed via constructor injection with decorator identifiers:

```typescript
class MyComponent {
  constructor(@IMyService private readonly myService: IMyService) { }
}
```

Services are provided via `registerSingleton(IMyService, MyServiceImpl, InstantiationType.Delayed)`.
