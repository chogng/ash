---
description: Ash TypeScript layers, runtime API boundaries, contributions, and entrypoints.
applyTo: "**/src/ash/**"
---

# Source Code Organization

## Layers

Modules may import their own layer and lower layers; they must not import, reference or derive defaults from higher layers.

| Layer | Responsibility and restrictions |
| --- | --- |
| `base` | Domain-neutral utilities and UI primitives; no service dependencies or references to higher-level features. |
| `platform` | DI support and services shared across layers. |
| `editor` | Stanza Editor core; no `node` or `electron-*` dependencies. |
| `workbench` | Application shell, panels, views and framework. |
| `code` | Desktop entrypoints: Electron main, shared process and CLI. |
| `server` | Remote development server entrypoint. |
| `sessions` | Agent Sessions window; may import `workbench` and below, but `workbench` must never import `sessions`. |

`src/ash/nls.ts` is the shared root NLS entrypoint and may depend only on `base`. Layer checks must allow that entrypoint and check its dependencies; do not move it into `base/common` merely to satisfy a path assertion.

## Target Environments

Pure helpers may stay beside browser feature orchestration; absence of DOM access does not require moving them to `common`.

| Folder | APIs available | May use |
| --- | --- | --- |
| `common` | Basic JavaScript | — |
| `browser` | Web/DOM | `common` |
| `node` | Node.js | `common` |
| `electron-browser` | Browser and limited Electron IPC | `common`, `browser` |
| `electron-utility` | Electron utility process | `common`, `node` |
| `electron-main` | Electron main process | `common`, `node`, `electron-utility` |

## Workbench Organization

| Path under `ash/workbench/` | Responsibility |
| --- | --- |
| `common`, `browser`, `electron-browser` | Workbench core |
| `api` | `ash.d.ts` API provider |
| `services` | Core services |
| `contrib` | Feature contributions |

- Core and shared services must not depend on contribution-owned contracts or implementations, including type-only imports. Entry points may import contributions to assemble features.
- Workbench contributions use `.contribution.ts` registration entrypoints. Editor contributions follow their bundle and registration contracts without requiring an extra entry file.
- Cross-contribution consumers use the feature's public API, never private implementation. Not every contribution needs a `common` API file.
- Contracts consumed by shared registries belong to the lower shared owner; contributions implement or consume them.

## Entry Points

Register shared dependencies in `workbench.common.main.ts`, desktop-only dependencies in `workbench.desktop.main.ts`, and web-only dependencies in `workbench.web.main.ts`.

Service assembly rules: [Dependency Injection](typescript-services.instructions.md#dependency-injection).
