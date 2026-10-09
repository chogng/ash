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

| 场景                                          | 当前入口                        | 生命周期                                    | 是否应该直接调用原生创建 API |
| --------------------------------------------- | ------------------------------- | ------------------------------------------- | ---------------------------- |
| 一次性静态结构                                | `h()`、`svg()` 或 `createDom()` | DOM owner 管理节点                          | ❌                           |
| 可观察状态驱动的 class、属性、样式或 children | `n.div()`、`n.elem()`           | `LiveElement` 或 owner 的 `DisposableStore` | ❌                           |
| DOM 基座实现自身                              | `dom.ts`、`reactiveDom.ts`      | 基座实现负责                                | ✅                           |
| 不可信 HTML                                   | `domSanitize.ts`                | 调用方拥有返回的 fragment                   | ❌，必须先清洗               |

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

| Module                          | Responsibility                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `dom.ts`                        | Disposable listeners, cross-realm guards, static HTML/SVG construction, text, and fragments       |
| `../common/observable.ts`       | Transactions, settable/derived/event-backed observables, and owned reactions                      |
| `window.ts`                     | Main/auxiliary window identity, registration, and lookup                                          |
| `focus.ts`                      | Active-element lookup, tracking, restoration, Tab order, and focus containment                    |
| `geometry.ts`                   | DOM dimensions and viewport/page coordinate measurement                                           |
| `../common/layout.ts`           | Pure, DOM-independent anchored layout calculation                                                 |
| `observer.ts`                   | Disposable, owner-window-aware Resize, Mutation, and Intersection observers                       |
| `scheduler.ts`                  | Window-scoped timeouts/intervals, idle work, animation-frame coalescing, and measure/modify order |
| `keyboardEvent.ts`              | Stable keyboard-event representation                                                              |
| `../common/keybindings.ts`      | Logical/physical chords, sequences, and OS resolution                                             |
| `../common/keybindingParser.ts` | External keybinding string parsing                                                                |
| `../common/keybindingLabels.ts` | UI, ARIA, and user-settings labels                                                                |
| `../common/ime.ts`              | IME enablement coordination during chord dispatch                                                 |
| `mouseEvent.ts`                 | Stable mouse and pointer coordinates across windows                                               |
| `dnd.ts`                        | Drag depth and DataTransfer helpers                                                               |
| `fileAccess.ts`                 | Browser file picking, object URLs, and downloads                                                  |
| `fullscreen.ts`                 | Fullscreen state and lifecycle                                                                    |
| `reactiveDom.ts`                | Document-bound `n.*` projection over the canonical observable graph                               |
| `domStylesheets.ts`             | Disposable and multi-window dynamic stylesheets                                                   |
| `aria.ts`                       | Per-document ARIA live announcements                                                              |

## DOM construction model

`h()` and `n.*` are both long-term APIs; neither is a compatibility stage for the other.

| API                                | Use when                                                                                      | Returns                           | Update model                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------- |
| `h(ownerDocument, tag, ...)`       | Structure is created once and later changes are imperative component behavior                 | The typed native element          | No reaction                     |
| `createDom(ownerDocument)`         | One construction scope creates many nodes in the same document                                | A document-bound callable factory | No reaction                     |
| `createReactiveDom(ownerDocument)` | Class, attributes, primitive properties, dataset, style, or children are `IObservable` values | A lazy `ReactiveElement`          | One owned reaction for the tree |

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
The cross-product grammar and the boundary between Ash, App, and Ash Code are defined in [`docs/keybindings.md`](keybindings.md).

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
  stable physical-code fallback. Both desktop entries supply the Main keyboard
  layout provider and profile layout API to this same service; desktop Agents
  must not fall back to the browser-only service assembly.
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
  configuration. `IUserDataProfileService` supplies the active file URI;
  `WorkbenchKeybindingService` validates and installs its ordered user rules.
  `KeybindingsEditingService` edits the same JSONC text model and saves through
  the generic file service, preserving comments and detecting stale revisions.
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

- `platform/contextview` defines the context-view and context-menu services,
  resolves menu contributions, and owns reusable HTML menu presentation.
- `base/parts/contextmenu` owns serialized Electron menu requests, renderer
  communication, and the window-local Electron menu. The desktop entry binds
  its operations to the trusted IPC router and owns each window's registration.
- `workbench/services/contextmenu` owns Electron menu action serialization and
  execution, menu-style configuration, and selection of the HTML or system menu.
- Web and Electron product entries select the implementation. Workbench and
  Sessions create it through their service container; platform services do not
  define product assembly factories or carry another implementation's services.
- Browser hosts use HTML menus. Electron hosts use HTML menus on Windows and
  Linux; macOS follows the menu-style setting and uses HTML for anchors that
  require right-edge alignment.
- Consumers depend only on `IContextMenuService`; they do not choose a
  renderer or access the Electron bridge.
- The service identifier remains in `platform/contextview`. A workbench
  service is a concrete product implementation, not a second contract.

## Desktop dialog boundary

`base/parts/sandbox/common/electronTypes.ts` owns the Electron dialog option and
result types shared by Renderer and Main. Workbench dialog handlers convert
domain requests to those options and interpret button indices or selected paths.
The Host transport validates requests and results without replacing the shared
types with a second set of picker parameters or path-only responses.

Main's `DialogMainService` owns window attachment, system dialog ordering,
platform button ordering, and cancellation. `AbortSignal` stays in its originating
process; the transport sends cancellation by request ID, and Main creates and
releases its own controller. Browser hosts retain their browser dialog handlers.

Workbench and Agents register the complete Host route set against their own
window. Common platform operations share one Main implementation; workspace
and window navigation retain the policy of each window kind. Desktop Renderer
entries also select the Electron accessibility service, which reads initial
system support and subscribes to changes for that window's lifetime. Web entries
keep the browser accessibility service.

Accessibility signals use the window-scoped `platform/accessibilitySignal/browser`
service for audio and polite announcements. Existing feature owners emit signals
after real state changes: task progress and outcomes, terminal command outcomes,
bell and clear, successful saves and explicit formatting, debugger stops, cursor
errors/warnings and breakpoints, collapsed regions, inline suggestions, diff
navigation, Chat requests/responses and required actions, recording start/stop,
Chat file edits and review decisions, and code action invocation/application.
Code action application preserves the bulk-edit result, so dismissing a preview
cannot announce success. Agents shares the Chat, recording and save contributions.

TaskService remains the execution-state owner. Its contribution starts one shared
cue after five seconds while any tasks are running, then repeats every five
seconds. Completion, failure, cancellation, and window disposal stop the cue.
Task terminals emit task outcomes without duplicating terminal command signals.
Interactive command outcomes follow shell integration markers from Bash, Zsh,
and PowerShell. Input newlines never imply command boundaries. Command Prompt
uses its standard startup without command outcome detection. PowerShell without
its console input hook and older Bash with a user DEBUG trap remain quiet.
Bell and clear signals work independently of that capability.
Restoring history and repeated streaming updates do not replay Chat cues.
Window disposal releases listeners, timers and cached playback. Eleven bundled
sounds are Ash-generated assets, loaded only when enabled playback is requested.

Each `accessibility.signals.*` setting defaults to sound `auto` and, where
supported, announcement `off`. Sound accepts `auto`, `on`, and `off`; announcement
accepts `auto` and `off`. Sound-only signals expose only the sound modality.
`auto` follows the existing screen-reader optimization policy.
`accessibility.signalOptions.volume` defaults to 70 percent. These settings use
the existing UI settings document and reload path; changes apply immediately,
including during active playback. Embedded standalone editors remain quiet when
their host has not registered signal preferences. Signal kinds for capabilities
without a current Ash producer are not registered.

## Configuration architecture

Configuration, application state, and Rust product intent have separate owners.
The current TypeScript settings path is:

- `platform/configuration/common/configurationRegistry.ts` owns registered keys,
  defaults, parsers, serializers, schemas, and declared scopes.
- `workbench/services/configuration/browser/configurationService.ts` resolves
  registered values and supported language overrides, validates editor writes,
  and publishes configuration and resource changes. Persisted writes currently
  support only `USER` and `USER_LOCAL`; the other configuration layers are not
  implemented merely because they appear in the shared contract.
- Electron Main owns `<profile>/settings.json`, writes the JSONC source
  atomically, watches external edits, and enforces compare-and-swap revisions.
  Renderer access uses the typed read/update/change preload capability.
- Browser product entries supply `IndexedDbConfigurationApi`. It stores the
  settings source and revision in the `ash-configuration` database and uses
  `BroadcastChannel` to reload changes in Workbench and Sessions pages on the
  same origin. The service's optional in-memory mode is not the product's
  persistence path.
- The editable `ash-settings:/user/settings.json` resource is a view of that
  same source. `SettingsFileSystemProvider` connects the ordinary text-file save
  path to `IConfigurationResourceService`; it does not own a second document.
- `keybindings.json` is a separate ordered resource supplied by
  `IUserDataProfileService`, validated by the keybinding owner, and edited
  through the shared file model. It is not a settings property.
- `state.json` stores reconstructable machine state such as window bounds.
- Rust domain services retain backend intent, model/provider configuration,
  permissions, and secrets. TypeScript presentation settings do not change
  ownership when a backend connection changes.

The current Electron settings file is a plain JSONC object, for example:

```jsonc
{
  // User preferences, not a versioned persistence envelope.
  "editor.fontSize": 14,
}
```

The configuration API carries a versioned `{ version: 1, source }` document
inside a revisioned snapshot. That transport shape is not the file format.
The older `configuration.json` / `{ version, values }` description does not
represent the current product path. Legacy migration must be verified
separately; changing this description does not migrate existing profiles.

Consumers use registered string keys through `IConfigurationService`. The
current registry is named `ConfigurationRegistry`; it does not provide the
previously documented typed-key return contract.

Preferences entry points, rendering responsibilities, known defects, and
VS Code differences are maintained in
[Preferences and Settings](preferences-and-settings.md). New integration rules
are maintained in the
[Preferences README](../src/ash/workbench/contrib/preferences/README.md).

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

The profile service supplies the active keybinding resource rather than making
consumers hardcode a path. The resolver, contribution, and command layers use
that resource contract.

## External URI opening

`IOpenerService` owns validation, URI resolution and host execution. Links opt
into contributed handlers with `allowContributedOpeners: true`; the ID `default`
explicitly selects the host browser. Resolved URI handles are released after
opening finishes, including failures.

`workbench/contrib/externalUriOpener` registers the selection service during
restoration, after the editor service and before the Workbench is ready.
Providers supply handlers for a target URL. Capability checks receive the
original URI; execution receives the resolved URI and the original URI context.
An explicit ID takes precedence over `workbench.externalUriOpeners`, whose URL
rules are evaluated in insertion order. Configured handlers skip capability
checks. Without a selected ID, a preferred handler opens directly, default
handlers participate in selection, and optional handlers alone do not intercept
an ordinary link. Cancelling the chooser consumes the request without opening
the host browser.

URL patterns use `platform/url/common/urlGlob.ts`. A missing scheme matches
HTTP and HTTPS, `*.example.test` includes the domain and its subdomains, `:*`
includes any port, and a path includes its descendants. Queries and fragments
do not affect matching. Pattern paths are kept literal rather than resolving
dot segments. Settings retain unavailable provider IDs so provider registration
does not rewrite user preferences.

Settings > Application > Links exposes the same rules as editable pattern/opener
rows. Opener suggestions come from the registered JSON schema and show built-in
and ready extension IDs with their names. Arrow keys and Enter select a suggestion;
arbitrary IDs remain editable. Adding, editing, and deleting rows writes the profile's
`settings.json` through the existing configuration service and complete-value validator.

Editor Markdown messages and rich document links use this same service. Rich
links preserve ordinary editing clicks; Ctrl/Command+click and Ctrl/Command+Enter
open the link. A focused link also opens with Enter. Product `window.open`
requests are denied in Main and sent to their owning Workbench for selection;
auxiliary windows use their owning Workbench as well.

The Ash executable Extension Host admits the `externalUriOpener` capability.
Activation registrations carry a non-empty, unique list of `http`/`https`
schemes and a label. `MainThreadUriOpeners` publishes ready process registrations
as providers and settings completions. Stable settings IDs are
`extension:<encoded extension ID>:<encoded registration ID>` using
`encodeURIComponent` for each component. Built-in completions include `default`
and `ash.browser.open`; unavailable IDs remain valid in saved rules.

The existing fenced invocation broker handles `canOpenExternalUri` with
`{ uri }` and a numeric priority (None = 0, Option = 1, Default = 2, Preferred = 3),
and `openExternalUri` with `{ resolvedUri, sourceUri }` and a boolean handled
result. Cancellation uses the broker's existing invocation cancel path.
Registration replacement, extension removal and connection close revoke old
providers and cancel their pending calls; unrelated fleet changes preserve
unchanged registrations. Selection and settings stay in TypeScript, while the
Rust broker transports admitted registration metadata and invokes the existing
extension process. This does not implement VS Code's JavaScript Extension API or
lazy `onOpenExternalUri` activation; packages use the existing Ash activation
events. Completion metadata follows active registrations and is not persisted.

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
