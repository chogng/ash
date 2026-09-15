---
description: Ash editor ownership, projection, input, layout, and rendering rules.
applyTo: "**/src/ash/editor/**/*.ts,**/test/integration/browser/**"
---

# Editor Implementation Guidelines

See [`src/ash/editor/README.md`](../../ash-ts/src/ash/editor/README.md), [`text-engine.md`](../../ash-ts/src/ash/editor/text-engine.md), and [`document-engine.md`](../../ash-ts/src/ash/editor/document-engine.md).

## Ownership

- Give each editor state one canonical owner. Browser code retains only DOM and measurement state needed for projection.
- Keep `TextModel` as the single text, ordered logical-line, stable `LineId`, version, and mutation authority. Persistent rich semantics attach through its mark, atom, facet, region, and relation stores; schema-backed transactions must not create a parallel document model. Concrete buffers such as PieceTree remain behind the `TextBuffer` contract.
- Contributions depend on engine contracts; they do not introduce product IDs, duplicate model state, or import product bundles.

## View parts and DOM

- The object that creates stable DOM owns its lifecycle.
- The view host mounts Part root nodes and owns their sibling order. A Part owns its root and internal nodes, but does not choose its host container.
- Retain stable nodes when reuse is cheap. Repeated rendering must not leak nodes, listeners, canvases, or disposables.
- A Part writes only its own DOM and consumes host layout; it does not become another viewport owner.

## Context and dependencies

- Keep long-lived view context limited to canonical view-model, layout, scheduling, measurement, and projection access.
- Create one version-bound rendering context per render pass. Do not make each Part reconstruct the same frame snapshot.
- Centralize overlay snapshot creation and version validation at the rendering-context boundary.
- Keep feature state with its owner; decoration consumers depend directly on `DecorationsOverlay` rather than accessing it through the context.
- Pass feature dependencies directly. Do not turn context into a service locator.

## Update, layout, and rendering

- Layout owns geometry and must not mutate editor model state.
- Render projects owned state into DOM or canvas. It is synchronous and does not mutate models or register listeners.
- Add `prepareRender` only when the scheduler separates measurement and mutation phases.
- Avoid layout-forcing DOM reads after writes in the same render phase.
- Keep short render algorithms together. Extract only complex, shared, or independently invalidated work.

## Projection and hit testing

- Projection converts authoritative state into geometry or presentation; it does not own DOM lifecycle.
- Hit tests return semantic targets. Controllers decide selection, scrolling, and commands.
- Use one version check and one coordinate conversion per operation. Share logical-line and visual-line hit-test flow after normalization.

## Controllers and events

- An input controller rejects unhandled events, resolves one intent, and invokes the owning state transition.
- Do not combine key mapping, selection algorithms, cleanup, announcements, and command execution in one event method.
- Events report state changes; direct calls drive synchronous control flow.

## Public API and performance

- Keep common editor contracts independent of browser, contribution-owned modules, and Workbench services, including type-only dependencies. Language provider contracts belong to `editor/common/languages.ts`; shared registries consume those contracts and contributions consume the registries.
- Keep feature request selection, cancellation, and result application with the corresponding contribution owner. A helper without DOM access may remain in that feature's `browser` directory; do not create a contribution `common` service solely to make it independently testable.
- Require explicit invalidation for every cache or retained projection.
- Measure before adding per-Part DOM write caches.

## Learnings

- 对齐 VS Code 编辑器文件时，先把上游 imports 当作能力清单，逐项核对其公共契约、事件、坐标转换、布局、生命周期和调用方；不得先创建 VS Code 中不存在的本地中间文件来简化目标实现。

- 排查编辑器问题时，先做语义搜索，再搜索精确字符串；随后沿 import 反向检查所有调用方，并阅读相关测试确认实际用法和预期行为。
- 对齐或迁移 VS Code 编辑器文件时，同时检查它导入的 base/platform 能力及其调用方依赖的事件、生命周期和调度契约；禁止在目标文件内复制、删减或伪造已有基础能力。
- 不要创建重复 import；已有 import 或公共能力可以满足需求时，必须直接复用。
- Editor 生产文件暂时没有调用方时，先检查标准 bundle、注册入口、上游同路径职责和现有行为测试；这可能表示功能尚未接线。不能仅为通过架构测试删除文件、移除必需文件断言或伪造测试调用；先沿真实入口完成装配和验证，未闭合的职责保留并报告。
