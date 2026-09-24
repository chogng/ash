# Browser foundation

> 状态：Current。本文是 Desktop Renderer 浏览器基座的职责与依赖方向说明。

`src/ash/base/browser` contains browser-runtime capabilities shared by UI,
platform, and workbench code. It intentionally does not provide a universal
DOM component base class.

## 快速理解

Ash 采用与 VS Code 相同的两层 DOM 思路，但所有创建、观察和调度都绑定到元素所属的
`Document` 或 `Window`，不依赖隐式全局对象。静态结构使用 `h()`，由可观察状态直接驱动的
结构使用 `createReactiveDom()` 返回的 `n.div()`、`n.elem()`、`n.svg()` 和
`n.svgElem()`。

| 场景 | 当前入口 | 生命周期 | 是否应该直接调用原生创建 API |
| --- | --- | --- | --- |
| 一次性静态结构 | `h()`、`svg()` 或 `createDom()` | DOM owner 管理节点 | ❌ |
| 可观察状态驱动的 class、属性、样式或 children | `n.div()`、`n.elem()` | `LiveElement` 或 owner 的 `DisposableStore` | ❌ |
| DOM 基座实现自身 | `dom.ts`、`reactiveDom.ts` | 基座实现负责 | ✅ |
| 不可信 HTML | `domSanitize.ts` | 调用方拥有返回的 fragment | ❌，必须先清洗 |

## Dependency direction

```text
base/common
    -> base/browser
    -> base/browser/ui
    -> platform/browser
    -> workbench/browser
```

Browser foundation modules may depend on `base/common`, but must not import
from UI, platform, or workbench modules.

## Lifecycle ownership

Browser helpers return or own an `IDisposable`. Composite browser objects extend
`Disposable` and register listeners, observers, timers, and child resources
through `_register()`. A reusable clear-and-rebuild scope uses
`DisposableStore.clear()`; a single replaceable resource uses
`MutableDisposable.value`. Callback cleanup is adapted with `toDisposable()` so
the owner retains both explicit and `using` disposal semantics.

## Modules

| Module | Responsibility |
| --- | --- |
| `dom.ts` | Disposable listeners, cross-realm guards, static HTML/SVG construction, text, and fragments |
| `../common/observable.ts` | Transactions, settable/derived/event-backed observables, and owned reactions |
| `window.ts` | Main/auxiliary window identity, registration, and lookup |
| `focus.ts` | Active-element lookup, tracking, restoration, Tab order, and focus containment |
| `geometry.ts` | DOM dimensions and viewport/page coordinate measurement |
| `../common/layout.ts` | Pure, DOM-independent anchored layout calculation |
| `observer.ts` | Disposable, owner-window-aware Resize, Mutation, and Intersection observers |
| `scheduler.ts` | Window-scoped timeouts/intervals, idle work, animation-frame coalescing, and measure/modify order |
| `keyboardEvent.ts` | Stable keyboard-event representation |
| `../common/keybindings.ts` | Logical/physical chords, sequences, and OS resolution |
| `../common/keybindingParser.ts` | External keybinding string parsing |
| `../common/keybindingLabels.ts` | UI, ARIA, and user-settings labels |
| `../common/ime.ts` | IME enablement coordination during chord dispatch |
| `mouseEvent.ts` | Stable mouse and pointer coordinates across windows |
| `dnd.ts` | Drag depth and DataTransfer helpers |
| `fileAccess.ts` | Browser file picking, object URLs, and downloads |
| `fullscreen.ts` | Fullscreen state and lifecycle |
| `reactiveDom.ts` | Document-bound `n.*` projection over the canonical observable graph |
| `domStylesheets.ts` | Disposable and multi-window dynamic stylesheets |
| `aria.ts` | Per-document ARIA live announcements |

## DOM construction model

`h()` and `n.*` are both long-term APIs; neither is a compatibility stage for the other.

| API | Use when | Returns | Update model |
| --- | --- | --- | --- |
| `h(ownerDocument, tag, ...)` | Structure is created once and later changes are imperative component behavior | The typed native element | No reaction |
| `createDom(ownerDocument)` | One construction scope creates many nodes in the same document | A document-bound callable factory | No reaction |
| `createReactiveDom(ownerDocument)` | Class, attributes, primitive properties, dataset, style, or children are `IObservable` values | A lazy `ReactiveElement` | One owned reaction for the tree |

Static `h()` returns the element directly and uses a typed `ref` callback when a nested element must be
captured. Ash deliberately does not copy VS Code's string selector plus `@name` result-map protocol:
direct typed elements and callbacks are easier to refactor, and invalid attribute/property categories stay
visible to TypeScript. Children may be nested arrays and may contain nodes, strings, numbers, or empty
sentinels. Style values are CSS text; both camel-case and CSS property names are accepted, and numeric
lengths require explicit units.

Mounted reusable UI takes its host element first and derives the document from `host.ownerDocument`; normal
option bags do not repeat `ownerDocument`. A document-level service or detached parsing and fragment boundary,
such as `h()`, `createDom()`, `createReactiveDom()`, or HTML sanitization, receives an explicit `Document`.
Neither form may fall back to the process-global `document`, because that silently creates nodes in the wrong
realm for auxiliary windows and makes isolated DOM tests unreliable. Only page bootstrap code selects a
page-level host from the global document.

Reactive trees are inert descriptions until `keepUpdated(store)` or `toLiveElement()` is called. The owner
must dispose that lifetime. Nested reactive elements share the root reaction, and `IObservable` remains the
only reactive state protocol. The deleted `domBuilder.ts` and the old `ReadableValue` binding helpers must
not be reintroduced as parallel construction or state systems.

`observer.ts` groups resize targets by owner window, so an auxiliary-window element is observed with that
window's constructor. `scheduler.ts` likewise accepts an explicit window, coalesces work per window, orders
layout reads before writes, and falls back to a window timer when animation frames are unavailable.

## Overlay boundaries

- `common/layout.ts` calculates placement without importing browser APIs.
- `ui/contextview` owns overlay attachment, dismissal, focus restoration, and
  applying the calculated coordinates.
- `ui/hover`, `ui/dropdown`, and `ui/selectbox` own their interaction and ARIA
  semantics; they do not add component-specific policy to `geometry.ts`.

## Drag-and-drop boundaries

- `base/browser/dnd.ts` owns native listener normalization and browser
  `DataTransfer` helpers. It does not coordinate collection state or product
  payloads.
- `base/browser/ui/dnd` defines domain-neutral drag origins and shared visual
  state. `base/browser/ui/list/listView.ts` owns flat rows, sizing, scrolling,
  the canonical drag session, cross-list transfer, target sectors, and
  feedback. `listWidget.ts` owns selection, focus, keyboard, and pointer
  semantics over that View.
- Tree controls adapt that List contract to model nodes. Tree alone owns
  hierarchical bubbling, subtree feedback, and delayed expansion.
- `platform/dnd` retains typed same-renderer payload identity. Workbench
  consumers own Editor, View, file, and other product mutation semantics.
- Action bars and tabs may keep their collection-specific insertion geometry;
  they are not forced through the vertical List controller. Do not introduce a
  global DnD manager that takes semantic drop policy away from components.

## Focus architecture

The long-term focus model is **window-level coordination, scope-level
execution, and component-level decisions**.

- Window-level coordination determines which registered window or external
  surface currently owns application focus. It does not navigate widgets.
- `focus.ts` provides mechanisms: active-element lookup across open shadow
  roots, focus-within tracking, tabbable order, safe restoration, and reusable
  focus movement.
- A local focus scope, such as a dialog or context view, executes declared
  initial-focus, containment, and restoration policies for its own lifetime.
- Components retain semantic decisions. Action bars interpret horizontal
  arrows, menus interpret vertical arrows, select boxes own their active
  option, and tooltips do not receive focus.

Do not introduce a global focus manager that assigns focus inside arbitrary
components. Extract a reusable roving-focus controller only after multiple
components share the same navigation contract.

## Keyboard event boundaries

Keyboard events support focus policy but do not belong to the focus model.
The cross-product grammar and the boundary between Ash, App, and Ash Code are defined in [`docs/keybindings.md`](../../docs/keybindings.md).

- Local widget behavior uses the native `KeyboardEvent`. Tab, Escape, Enter,
  Home/End, and arrow navigation are semantic keys and should be compared
  through `event.key`.
- `keyboardEvent.ts` normalizes a native event at the document-level dispatch
  boundary. It preserves both the layout-aware `key` and physical `code`.
- `common/keybindings.ts` owns the DOM-independent model. Logical chords match
  `event.key`; physical chords match `event.code`; `primaryKey` resolves to
  Command on macOS and Control elsewhere.
- `platform/keybinding/common` owns contribution registration, conflict
  priority, multi-chord resolution, and ContextKey conditions.
- `platform/keyboardLayout/common` defines the active layout and mapper
  contract without importing browser APIs.
- `workbench/services/keybinding/browser/keyboardLayoutService.ts` uses the
  browser Keyboard Map capability when available and otherwise preserves a
  stable physical-code fallback.
- `workbench/services/keybinding/browser/keybindingService.ts` is the concrete
  product service. It owns document listeners, chooses the nearest DOM
  ContextKey scope, reports chord state, prevents handled native events, and
  invokes commands.
- `Action2` may contribute a primary and secondary keybinding, but remains
  independent of its final menu, toolbar, or keyboard presentation.
- `keybindingParser.ts` is an input boundary for user or extension strings.
  Built-in contributions use typed `Keybinding` objects and do not parse
  strings during registration.
- `keybindingLabels.ts` formats resolved bindings. The browser
  `KeybindingLabel` only renders those results and does not resolve shortcuts.
- A component is not required to construct `StandardKeyboardEvent` merely to
  inspect one local semantic key.
- Ignore shortcut and type-ahead activation while `event.isComposing` is true,
  so IME composition receives the first opportunity to handle the event.
- Do not interpret AltGraph as a Ctrl+Alt shortcut.
- Call `preventDefault` or stop propagation only after a component has
  actually handled the event.
- Entering a multi-chord wait state temporarily disables the shared IME state.
  Text inputs observe that state and suppress composition until the chord
  resolves, times out, or loses window focus.
- Chord and composition state are published through
  `keybinding.inChordMode` and `keybinding.isComposing`; the status bar exposes
  the pending chord without moving that product policy into platform code.
- Persisted keybindings are an ordered resource independent of ordinary
  configuration. `IKeybindingsResourceService` projects the active
  `keybindings.json` into user-weight resolver rules.
- A user entry requires `{ key, command }` and may define `when`, `args`,
  `mac`, `linux`, and `win`. A platform override set to `null` disables that
  rule on the platform.
- `command: null` installs an explicit blocker at user weight, removing both
  dispatch and displayed shortcut lookup for the lower-priority binding.

## Context key scopes

Context keys connect focus-local state to actions, menus, and keybindings.

- The root service stores window-wide values.
- `createScoped(element)` creates an inheriting context for that DOM subtree.
- Event dispatch resolves the nearest scoped service from the composed target.
- `RawContextKey<T>` provides typed binding and default reset behavior.
- Components decide which semantic values they publish; the context service
  only stores, inherits, and evaluates them.
- Persisted `when` strings are parsed at the user-resource boundary. Built-in
  code continues to compose typed `ContextKeyExpr` values.

## Context menu architecture

- `platform/contextview` defines `IContextMenuService` and owns reusable HTML
  and native rendering mechanisms.
- `workbench/services/contextmenu` is the product boundary. It combines menu
  actions with resolved keybindings, owns the selected implementation, and
  applies browser or Electron host policy.
- Browser hosts select the HTML implementation. Electron hosts use the native
  implementation on macOS and the HTML implementation on Windows and Linux.
- Consumers depend only on `IContextMenuService`; they do not choose a
  renderer or access the Electron bridge.
- The service identifier remains in `platform/contextview`. A workbench
  service is a concrete product implementation, not a second contract.

## Configuration architecture

Configuration, application state, and Rust product intent are separate
authorities:

- `platform/configuration/common` defines typed configuration keys, the
  `IConfigurationService` contract, and the bounded versioned wire document.
- `workbench/services/configuration` validates host snapshots through the
  registered keys and publishes atomic changes to product services.
- Electron Main owns `<profile>/configuration.json`, performs atomic writes, watches for
  external edits, and enforces compare-and-swap revisions. Renderer access is
  restricted to the typed read/update/change preload capability.
- Electron Main independently owns `<profile>/keybindings.json` under the same
  revisioned JSON storage primitive. This preserves ordered shortcut rules
  without turning them into an ordinary configuration value.
- Browser hosts use the same Workbench service with an in-memory document
  until a browser persistence host is supplied.
- `configuration.json` stores frontend/device key/value settings such as menu
  presentation, fonts, accessibility, and product theme selections. Keyboard
  shortcuts belong to `keybindings.json`.
- `state.json` stores reconstructable machine state such as window bounds. It
  must not become a configuration store.
- The Rust ConfigStore remains authoritative for cross-client backend intent
  such as models, providers, MCP servers, Skills, and directory permissions.
  Presentation preferences, keyboard events, and Desktop command IDs do not
  cross that boundary.

The current Desktop document is:

```json
{
  "version": 1,
  "values": {
    "editor.fontSize": 14
  }
}
```

Configuration keys are declared once through `ConfigurationsRegistry`.
Consumers request values with the returned typed key instead of repeating
string addresses or casting untrusted persisted values.

The active `keybindings.json` is a top-level ordered array:

```json
[
  {
    "key": "primary+n",
    "command": "ash.startTurn",
    "when": "windowFocused && !inputFocus",
    "args": {
      "source": "keyboard"
    },
    "mac": "cmd+n",
    "win": "ctrl+n"
  },
  {
    "key": "primary+shift+n",
    "command": null
  }
]
```

The host capability represents the active keybinding resource rather than a
fixed path. A future profile service can switch that resource without changing
the resolver, contribution, or command layers.

## Design rules

- Pass or derive the owning `Document` instead of assuming the global
  `document`.
- Resolve a `Window` from its node or document before registering global
  listeners or timers.
- Every listener, observer, scheduler, and temporary URL returns or owns an
  `IDisposable`.
- Production Renderer code creates HTML, SVG, text nodes, and fragments through `dom.ts`; raw native
  construction is restricted to the DOM foundations themselves.
- Leaf action representations render into a host-owned container. Layout and
  workbench views may expose a structural `element` without sharing a concrete
  DOM base class.
- Use `n.*` only when state is already observable or is canonically projected with
  `observableFromEvent()`. Do not convert ordinary one-shot component behavior into an observable merely
  to avoid a property assignment.
- Keep observers, scheduled work, and long-lived event listeners owned by an `IDisposable`; use the target
  node's window rather than process-global browser constructors or timers.
