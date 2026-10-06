# Agents Window layout

> **Specification change gate:** Do not update this document for layout bug fixes, styling, dimensions, or action placement. Update it only when part ownership, workbench topology, or a cross-part contract intentionally changes.

## Scope

The Agents Window uses a Sessions-owned workbench layout optimized for agent work. This specification defines stable part ownership, composition, and presentation modes. Per-session capture and restoration are owned by [LAYOUT_CONTROLLER.md](LAYOUT_CONTROLLER.md).

Exact dimensions, styling, action placement, and regression behavior belong in code, design tokens, component fixtures, and focused tests.

## Shared Parts and mode content — target contract

All non-phone Sessions product modes use the shared `SidebarPart`. A mode selects its own sidebar view container and views. Library, Creator home and Make must retain the sidebar in their desktop composition. Each mode supplies content to the shared window Parts; a product-page name does not justify a new Part or another window grid.

| Surface | Shared host | Mode-owned content |
| --- | --- | --- |
| Left navigation and tools | `SidebarPart` | Registered `ViewContainer`, its `ViewPaneContainer` and `ViewPane` contributions |
| Editing and central product pages | `EditorPart` | `EditorInput` and `EditorPane` opened through `IEditorService` |
| Right properties and detail views | `AuxiliaryBarPart` | Registered view containers and views for the current mode or editor |
| Bottom tools | `PanelPart` | Registered tool view containers and views |

`ViewContainer` is the sidebar, auxiliary-bar and panel registration mechanism. Central editor pages use the editor input/pane mechanism rather than a separate mode container. An `EditorPane` can render a canvas, a browsing page or another rich interface; it is not limited to a text editor. Mode implementations own their documents, commands and content while the shared Parts own placement, resizing, focus and hosting lifecycle. Mode changes retain the same Sessions service and selection ownership.

Layout variants arrange these shared hosts differently. Desktop-specific editor/detail docking and phone navigation may require separate layout implementations; they do not justify `LibraryPart`, `CreatorPart` or another Part for each page. Conversation-grid ownership remains governed by the Sessions model and its own composition contract, independently of document editing.

This is the target architecture, not a completed migration. The current implementation below still uses `LibraryPart` and `CreatorPart` and hides the sidebar on some pages. Those page Parts must be replaced by contributions to the shared hosts, with their document state, dirty-file checks, focus and restoration behavior preserved.

## Layout implementation boundary

Sessions supports multiple intended layout families over the shared Parts. Shared services, retained Parts and disposal belong to `Workbench`; each concrete layout owns their arrangement, grid topology, geometry, visibility mapping and size restoration. A concrete layout belongs in its own implementation file when those responsibilities differ. Desktop-specific rules stay in `desktopWorkbench.ts` rather than accumulating in the shared `workbench.ts`.

| Owner | Responsibility |
| --- | --- |
| `browser/workbench.ts` | Shared window lifecycle, service assembly, Part creation and initialization order |
| `browser/workbenchFactory.ts` | Prepare window resources and select a supported concrete workbench at startup |
| Concrete workbench and layout | Own the selected layout's Part containment, grid geometry, visibility mapping and persisted dimensions |
| `browser/layoutPolicy.ts` | Supply shared appearance metrics and initial sizes |
| Layout controllers and strategies | Translate session selection and product-page commands into the required Part composition and editor working-set restoration |
| Sessions services and Parts | Own conversation identity, selection and content independently of the selected window layout |

The desktop detail layout illustrates why this boundary matters: Auxiliary Bar content sits inside the Editor's grid node below one shared tab strip. The node can remain visible while editor content is hidden, and its width can include both editor content and Details. The desktop layout must therefore distinguish node visibility and size from editor-content visibility and size. A layout with independently placed Parts must own its own mapping without inheriting these desktop assumptions.

Layout family and runtime are separate choices. Browser and Electron windows can use the same desktop layout. Chat, Code, Collaboration, Library and Creator are compositions within that layout; changing pages does not by itself require another Workbench subclass. A separate implementation is justified by different Part containment, geometry or lifecycle, not by a page name or file length. Common mechanisms remain shared, and layout variants consume the same Sessions services without creating another conversation or selection model.

VS Code's Sessions `DesktopWorkbench` and `MobileWorkbench` split provides a reference for this responsibility boundary. Its regular Workbench also separates layout into `layout.ts`. Ash should preserve clear ownership for its own layouts; matching the upstream class hierarchy is not itself a design requirement.

## Workbench topology

The topology and page-specific Parts in this section describe the current implementation. The [shared-host target contract](#shared-parts-and-mode-content--target-contract) governs their replacement.

The intended startup contract selects one of two concrete workbenches: `DesktopWorkbench` for every
non-phone window, and `MobileWorkbench` for mobile web windows below the phone
breakpoint. `Workbench` owns their shared window assembly and is not instantiated
directly. Currently Ash constructs `DesktopWorkbench` with `DesktopWorkbenchLayout`
for both browser and Electron; the phone workbench remains unimplemented.

```text
Title bar
Content
├── Sidebar
└── Main region
    ├── Sessions Part | Library | Creator | Editor | Auxiliary Bar | Custom View Grid
    └── Panel
```

The workbench omits the standard Activity Bar, Status Bar, and Banner. Its Sessions Activity Bar runs registered product commands. Part positions are fixed by the Agents Window rather than user settings.

Contributions register localized titles, icons and commands in `Menus.ActivityBar`.
`ActivityBarPart` owns profile-scoped command order and presentation. Selected
items are derived from the visible Parts, active editor and Sidebar selection.
Account actions remain outside the sortable group, and placement changes retain
the same buttons and order.

Both workbenches open, hide and focus view containers through
`IPaneCompositePartService`. Sidebar, Panel and Auxiliary Bar retain their
`PaneComposite` instances. `DesktopLayoutController` coordinates the surrounding
Parts for conversation, collaboration, Library and Creator commands.
`LibraryPart` and `CreatorPart` retain their own pages independently of the Code Editor Part. `ISessionsService` owns a
single conversation selection, visible arrangement and navigation history;
changing the surrounding layout never creates a second conversation or composer.

| Part | Ownership |
|------|-----------|
| Title bar | Window navigation and window-scoped actions |
| Sidebar | Sessions list and Sessions-owned sidebar views |
| Sessions Part | One or more visible session surfaces |
| Library / Creator | Each module owns its retained page, selected through the Activity Bar |
| Editor | Code file, browser, diff, and other document inputs |
| Auxiliary Bar | Code files and changes, or the active Design editor's properties |
| Panel | Terminal and other panel views |
| Custom View Grid | Full-surface contributed views that replace session content |

Creator canvas modes use the fixed `SidebarPart | CreatorPart | AuxiliaryBarPart` chain. Layers belongs to SidebarPart, the retained canvas belongs to CreatorPart, and Shape properties belongs to AuxiliaryBarPart. SessionsPart remains the conversation owner and is hidden in Creator. Creator home and Make occupy the primary Part without the outer canvas panels. The two panel views consume the active design editor's state rather than creating a document or selection of their own. Page navigation retains the document, selection and viewport without a close operation. The window editor service checks save/discard/cancel for every mode document through window shutdown, including hidden workspaces. Library occupies LibraryPart without the outer sidebar or properties panel. Product pages never enter Code editor groups or per-session working sets.

The Sessions Part contains its own nested two-dimensional split grid. Its leaves are not workbench editor groups, nor the chat groups inside an individual session.

## Grid behavior

The main workbench grid is non-proportional. The Sessions Part is the flexible surface that absorbs container resize and part-visibility deltas. The Sidebar, Editor, Auxiliary Bar, and Panel preserve user-established sizes within their constraints.

The Sessions grid retains user-established proportions even when a narrower composition temporarily clamps leaves to their minimum widths. The preferred widths are restored when the available area grows again.

The primary surface absorbs general window resize: SessionsPart for conversations, or LibraryPart and CreatorPart while Library or Creator replaces the conversation region. Design preserves both side-panel widths as the editor expands and shrinks. This prevents fixed side parts from absorbing general window resize.

The desktop presentation may place the Auxiliary Bar inside the Editor's grid node. Consumers must distinguish the actual Editor content area from the shared grid node when interpreting visibility or size.

## Sessions Part

Each visible session has one Sessions-owned view. The view presents the active chat for that session and scopes commands, menus, and context keys to the represented session.

Chat-tab presentation is a property of the session view, not of the action that opened a chat. The view observes its configuration directly and consistently applies either tabbed or session-view presentation to every chat, including restored chats and chats opened through navigation or external entry points.

In the side-by-side single-chat presentation, pinning a chat header keeps that chat visible while new chats reuse an unpinned group. If every visible group is pinned, opening another chat creates a group; chat pins persist with the chat-grid layout.

`ISessionsService` owns:

- visible-session identity and order;
- the active visible session;
- which chat is active in each session;
- restoration of the visible arrangement.

The Sessions Part renders that model. It does not create a second active-session store. Stable slot identities belong to the visible-session model; ordinary replacement transfers the slot to the new session. Retained sessions keep their views and live chat widgets across movement, reordering, and arrangement changes.

Opening, closing, and directional insertion or movement operate through `ISessionsService`. The part owns the canonical split geometry and user sash sizes, using the shared grid primitive. Maximization and phone presentation project a single live view without changing that geometry. Ordinary structural edits preserve unaffected branches and sizes. Balanced tiling is an explicit arrangement operation over this grid, not a persistent mode or a comparison-specific layout.

Ash persists Session bindings, all untitled identities and the active selection in
`sessions.viewState` version 2. `SessionGridLayout` separately owns widths in
`sessions.gridState`. Old Chat/Code arrangements are merged without duplicating
identities. Explicit navigation supersedes pending selection restoration. Pins,
maximization and two-dimensional placement remain intended extensions described
by this specification; current implementation limits are listed in the README.

Session geometry does not determine Editor, Details, or other side-pane visibility policy. That policy remains with the layout controllers.

## Editor presentation

All non-phone Agents windows use the desktop detail layout. Phone viewports use the dedicated mobile presentation.

The Editor and Auxiliary Bar compose one side pane next to the active session. Editor tabs choose either editor content or a details view while the layout coordinators preserve one coherent visibility model.

The main Editor supports exactly one editor group. Its shared multiple-group capability is disabled, which removes editor split/grid commands, keybindings, menus, and split drop targets; the part also rejects group creation and multi-group layout requests from open-to-side and programmatic paths. The independent chat grid remains supported.

The durable state and transition catalog lives in [DESKTOP.md](DESKTOP.md). Implementation behavior is covered by the layout-controller and desktop strategy tests.

Code documents must be opened through `IEditorService`. Sessions-specific presentation must not bypass editor service behavior by opening directly on an editor group.

Chat input status-pill composition is owned by the shared workbench `ChatInputPills` and `StandardChatInputPillSources` components. The Agents Window and Agent Host editor/panel surfaces supply observable data adapters and their allowed pill kinds only; ordering, per-kind presentation, visibility, context menus, keyboard behavior, compact layout, and lifecycle rendering must not be reimplemented per surface. Per-kind visibility preferences belong to `ISessionChatPillVisibilityService`; data adapters apply them before supplying pill data and option actions to the shared renderer.

Session providers register internal per-session directories as resource label homes. URI labels render as `<home label>/<relative path>`, and breadcrumbs render the same home label as their root segment. Without a matching home formatter, existing URI-label and breadcrumb behavior is unchanged.

## Custom views

`ICustomViewService` owns the active contributed full-surface view.

A custom view is mutually exclusive with the Sessions Part, grid Editor, Auxiliary Bar, and Panel. The title bar and Sidebar remain available. Covered parts retain desired visibility separately from effective grid visibility so their state can be restored when the custom view closes.

Explicit session and chat open actions dismiss the active custom view. Reactive fallback opens driven by session or chat lifecycle changes preserve the custom view while reconciling the hidden Sessions grid. On phone layouts, custom views participate in mobile navigation so platform back navigation dismisses them.

## Part lifecycle

The workbench:

1. creates the fixed grid and part instances;
2. restores persisted workbench part sizes and visibility;
3. starts the applicable layout controller;
4. reacts to visible-session, editor, and contributed-view state;
5. persists state through the owning services during shutdown.

Part instances and listeners are disposables. Repeatedly created per-session or per-view state is owned by a scoped disposable store.

## Layout-controller boundary

Layout controllers translate session activation into part capture and restoration. They do not own session identity or the visible-session model.

Mobile and desktop presentations intentionally use different strategies where their compositions differ. Shared behavior belongs in the base controller; presentation-specific behavior stays in the relevant controller or strategy.

See [LAYOUT_CONTROLLER.md](LAYOUT_CONTROLLER.md) for rule tags, persistence, and test ownership.

## Mobile boundary

Phone layouts replace selected parts and pickers with mobile subclasses while preserving the same service and provider contracts. Mobile composition and navigation are specified in [MOBILE.md](MOBILE.md).

## Contributions and loading

Layout contributions register through the appropriate `sessions.*.main.ts` entry point. Shared workbench code should change only when the capability is useful outside the Agents Window; Sessions-specific policy stays under `vs/sessions`.

## Change policy

Update this specification only when part ownership, grid topology, presentation families, or a cross-part invariant changes. Do not update it for:

- pixel values, styling, icons, or action placement;
- individual view or editor behavior;
- bug narratives and rejected implementations;
- per-session restoration scenarios already owned by controller rules and tests.

## Related specifications

- [Documentation index](README.md)
- [Sessions architecture](SESSIONS.md)
- [Layout controllers](LAYOUT_CONTROLLER.md)
- [Desktop scenarios](DESKTOP.md)
- [Mobile layout](MOBILE.md)
