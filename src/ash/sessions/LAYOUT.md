# Agents Window layout

> **Specification change gate:** Do not update this document for layout bug fixes, styling, dimensions, or action placement. Update it only when part ownership, workbench topology, or a cross-part contract intentionally changes.

## Scope

The Agents Window uses a Sessions-owned workbench layout optimized for agent work. This specification defines stable part ownership, composition, and presentation modes. Per-session capture and restoration are owned by [LAYOUT_CONTROLLER.md](LAYOUT_CONTROLLER.md).

Exact dimensions, styling, action placement, and regression behavior belong in code, design tokens, component fixtures, and focused tests.

## Shared Parts and mode content

Desktop modes select view content in the shared `SidebarPart`; pages without a dedicated container retain the current workspace's conversation sidebar. Cold restoration and workspace changes use the registered default container; Desktop's ChatGPT contribution supplies the Chat default. Projects keeps project navigation inside its EditorPane alongside the window sidebar. Each mode supplies content to the shared window Parts; a product-page name does not justify a new Part or another window grid.

Chat and Code are workspace shells selected by the titlebar switcher. Entry descriptors declare their workspace; `ISessionsLayoutService` derives the active workspace from the selected entry and publishes its context for navigation. Code has its own Activity Bar menu and a navigation-only sidebar container; it does not reuse Chat's session list or contribute a sidebar entry for switching to Code. New creates a conversation in the current workspace. Collab, Agent Teams, Automations and Symphony belong to Code. A Custom View can declare the entry command that supplies its underlying workspace; opening and restoring that view preserves the overlay while applying the declared entry. Custom Views retain the workspace sidebar's current expansion state, including Code navigation beside Automations. Navigation order is independent per workspace in the existing profile UI state store; the selected workspace is reconstructed from the restored entry rather than persisted separately.

| Surface                           | Shared host        | Mode-owned content                                                                       |
| --------------------------------- | ------------------ | ---------------------------------------------------------------------------------------- |
| Workspace and connection status   | Title bar actions  | Sessions workspace contribution projects the existing permission and connection services |
| Left navigation and tools         | `SidebarPart`      | Registered `ViewContainer`, its `ViewPaneContainer` and `ViewPane` contributions         |
| Agent conversations               | `SessionsPart`     | Retained session views and their independent conversation grid                           |
| Editing and central product pages | `EditorPart`       | `EditorInput` and `EditorPane` opened through `IEditorService`                           |
| Right properties and detail views | `AuxiliaryBarPart` | Registered view containers and views for the current mode or editor                      |
| Optional tools                    | `PanelPart`        | Registered tool view containers and views                                                |

The Agents Window has no Banner Part or reserved notice row. The Sessions workspace contribution presents restricted directory permissions only in the Code workspace, naming the window workspace and opening its existing Workspace Trust editor. Connection recovery remains available through a title bar action in every workspace. These controls read the owning services and do not own another permission or connection model. A terminal connection failure offers a sticky global notification with the existing Reload Window action; startup failures retain the host's recovery surface. Status changes do not move the content or enter saved session layouts. The regular IDE retains its Banner Part and notice producers.

`ViewContainer` is the sidebar, auxiliary-bar and panel registration mechanism. Central editor pages use the editor input/pane mechanism rather than a separate mode container. An `EditorPane` can render a canvas, a browsing page or another rich interface; it is not limited to a text editor. Mode implementations own their documents, commands and content while the shared Parts own placement, resizing, focus and hosting lifecycle. Mode changes retain the same Sessions service and selection ownership.

ChatGPT contributes a conversation ViewPane to SidebarPart and a chat EditorPane to EditorPart. Both consume the same window-scoped ChatGPTService in the ChatGPT contribution; that service owns selection, messages, drafts, models and in-flight operations. Projects, Artifacts and Customize retain the same sidebar instance, including selection, scroll position and collapsed groups. Opening a conversation from any of these pages reveals the ChatGPT editor before selecting it. The sidebar initializes its own catalogue when a product page is restored before the chat editor exists. Views own only presentation and focus. The contribution's Electron adapter keeps local credentials, HTTP streaming and the hidden verification runtime in Main. No BrowserView page or navigation snapshots participate in this entry. Part visibility and entry switches preserve the shared service.

Layout variants arrange these shared hosts differently. Desktop-specific editor/detail docking and phone navigation may require separate layout implementations; they do not justify `ProjectsPart`, `CreatorPart` or another Part for each page. Conversation-grid ownership remains governed by the Sessions model and its own composition contract, independently of document editing.

Projects and Creator contribute EditorPanes to the retained Sessions EditorPart. Their navigation and details use shared editor and view-container hosts. Projects owns its project list, breadcrumb and materials inside one editor; the window-scoped navigation service owns disposable browsing state while the Project backend owns the durable catalog and material references. SessionsPart remains the permanent conversation host. A product page may show it alongside EditorPart when its contributed composition includes Agent work; a page without conversation content hides it. Design implements this composition with an optional shared conversation.

### Creator entries and the project catalog

Creator aggregates independently contributed creation tools. Contributions register their Views against a shared Creator container ID; `ViewPaneContainer` owns their arrangement, expansion, sizing and focus. Creator owns workspace selection and retained workspace documents. A contribution entry registers capabilities rather than running a window-wide product-mode state machine.

Projects presents the shared Project catalog through `IProjectService`. The backend owns durable project metadata and file or folder references; `ProjectsService` retains only window-local search, sorting and selected-project state. Material types remain inside a project and do not register separate product entries or view containers.

### Creator conversation and editor composition

This is the cross-Part contract. Design implements the editor-primary composition with an optional conversation; the other workspace compositions remain targets. Make prepares an unsent Code draft rather than keeping the conversation beside its preview. These implementation limits remain documented in [Creator README](contrib/creator/README.md); they do not define the target composition.

Creator retains the workspace conversation sidebar when opening its home, documents or canvas modes. Registered sidebar tool views, including layers, require an explicit view-opening action rather than activation by page navigation. Creator reuses EditorPart for the retained creation EditorPane; AuxiliaryBarPart for properties and detail Views; and SessionsPart for full Agent conversations. The [Creator Part mapping](contrib/creator/DESIGN.md#七项工作区的-part-分工) owns the seven workspaces' content and task-specific display requirements. Single-purpose AI controls belong with the affected content; they do not introduce another conversation host or selection model.

Make keeps SidebarPart, SessionsPart and EditorPart visible by default, with navigation, Agent conversation and preview/code arranged from left to right. AuxiliaryBarPart appears when element properties are needed. Other creation workspaces make EditorPart their primary surface and show SessionsPart when the user opens the associated conversation. Creator home retains SidebarPart and its central entry page. Sidebar and property visibility otherwise follow the workspace's task, existing visibility preferences and narrow-window behavior; the contract does not require every host to remain expanded.

Feature entry descriptors must express the retained product editor and conversation visibility independently. ISessionsLayoutService applies that composition without switches over Creator workspace names; the concrete desktop layout owns placement, resizing and focus geometry. Showing or focusing the conversation keeps Creator selected in the Activity Bar and keeps its EditorPane active. This is a composition of the existing Parts, not another window Grid or a new Part per workspace.

Sessions services and SessionsPart retain conversation identity, selection, live widgets, drafts, attachments and execution state. Creator's editor and working copy retain document identity, edits, history and save state. Features associate document and conversation identities through their owning contracts; a side View borrows the same editor content and selection. Showing, hiding or switching these hosts does not duplicate either model, discard unsent work, cancel a running Turn, archive a conversation or close a dirty document. Actual close and shutdown retain the existing save/discard/cancel lifecycle.

PanelPart hosts optional tools such as terminal and build output. Presenter notes, bulk content tables, CMS editing and running previews remain content of the relevant EditorPane. ActivityBar owns the Creator product entry; Creator navigation selects its seven workspaces. TitlebarPart keeps window navigation and window-scoped actions.

Implementation must verify the composed entry path, independent host visibility, Creator selected state, retained editor and conversation state, focus and size restoration, and narrow-window behavior using Playwright in Browser, Electron UI and Electron. This specification records the target contract, not completed behavior tests.

### Activity Bar entry switching

Sessions uses the same view-container activation mechanism as the regular VS Code Activity Bar. VS Code's ordinary container icons select sidebar content while retaining the active editor. A Sessions feature command can also select its central editor and details container through a shared entry descriptor.

```text
Activity Bar icon
  -> feature entry command
  -> ISessionsLayoutService.openEntry(descriptor)
     -> IViewsService: open registered sidebar and details container IDs
     -> IEditorService: open the feature's EditorInput / EditorPane
     -> Workbench layout: apply shared host visibility
```

The sidebar activation unit is a `ViewContainer`, which may contain several `ViewPane` instances. Central editors continue to use `IEditorService`. A feature supplies its container IDs and central content to `ISessionsLayoutService`, which opens registered containers through `IViewsService` and preserves the existing hosts. The shared layout service does not know Creator workspaces or project selection; generic container activation must not acquire product behavior.

Activity Bar owns its icons, activation commands and selected-state display. It does not own editor inputs, documents, Part geometry or another selection store. The layout service publishes the feature's contributed context key after opening its entry. Ordinary View focus or Project selection changes do not select another window entry.

Entry switching reuses the existing Parts, container instances and editor lifecycle. Their existing owners preserve document edits, feature state, editor working sets and the active conversation. Multiple Views in one container and multiple feature editors do not require more window Parts. The layout service retains only the active host descriptor and layout preferences.

### Implementation decisions

SessionsPart owns one conversation grid and one retained SessionView per visible
Session. Code uses the Chat widget; Chat, Collaboration and conversations beside
product editors use Cowork. Entry navigation selects the renderer through
`ISessionsConversationService` before revealing or focusing the Part. SessionView
retains both renderers' DOM and attaches the active renderer inside the same slot.
Entry changes transfer unsent text, mode and attachments, then clear the inactive
composer. They preserve the grid, Session views, window selection and navigation
history.

Feature commands own entry selection. The shared layout service stores the active entry's layout descriptor and applies its contributed Activity Bar context key. It has no enum or switch over product names. Focusing SessionsPart keeps the composing entry selected, including Code and Creator; focusing a View or changing the selected project does not select a different window entry.

SessionsPart remains the shared Agent conversation host, including its multi-session grid. Code and Creator compositions can show SessionsPart beside EditorPart; chat surfaces do not become document editor groups. Creator and Projects enter the shared EditorPart lifecycle. Switching a mode activates retained content without closing other tabs, discarding edits, recreating chat widgets or replacing document models. Actual close and window shutdown continue to use the existing save/discard/cancel checks.

Feature commands supply central content and optional sidebar and auxiliary ViewContainers together. An omitted sidebar container uses shared Sessions navigation; every entry retains the window sidebar. Views consume the active document and selection; they do not maintain another document model. Creator home and Make keep their sidebar content. Project navigation and materials belong to the retained central editor; Projects uses shared Sessions navigation and contributes no auxiliary container.

Part widths, editor-group geometry and user visibility preferences belong to their layout owners and survive mode changes. Session working-set restoration applies only to session document groups; retained product-page tabs and SessionsPart must remain alive. Editor group capability stays available rather than being disabled to enforce the former window split.

The implementation uses the existing `browser/workbench.ts`, `browser/desktopWorkbench.ts`, `browser/parts/sidebarPart.ts`, the retained Parts under `browser/parts/`, Creator and Projects page modules, and the layout controller. Shared editor-group hosting changes belong to the existing Workbench editor and editor-service modules. Contribution registries own mode content; shared Parts must not import Sessions or product contributions. SessionsPart is a permanent base Part because Agent conversations have a distinct identity and lifecycle from document editors. Behavior tests cover mode commands, tab activation, retained drafts/documents, containers, default side widths and resizing in Web and Electron.

## Layout implementation boundary

Sessions supports multiple intended layout families over the shared Parts. Shared services, retained Parts and disposal belong to `Workbench`; each concrete layout owns their arrangement, grid topology, geometry, visibility mapping and size restoration. A concrete layout belongs in its own implementation file when those responsibilities differ. Desktop-specific rules stay in `desktopWorkbench.ts` rather than accumulating in the shared `workbench.ts`.

| Owner                             | Responsibility                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `browser/workbench.ts`            | Shared window lifecycle, service assembly, Part creation and initialization order                      |
| `browser/workbenchFactory.ts`     | Prepare window resources and select a supported concrete workbench at startup                          |
| Concrete workbench and layout     | Own the selected layout's Part containment, grid geometry, visibility mapping and persisted dimensions |
| `browser/layoutPolicy.ts`         | Supply shared appearance metrics and initial sizes                                                     |
| `ISessionsLayoutService`          | Apply feature-supplied entry descriptors and remember host visibility                                  |
| Layout controllers and strategies | Restore session document working sets and coordinate Code Editor/Details behavior                      |
| Sessions services and Parts       | Own conversation identity, selection and content independently of the selected window layout           |

In the Code composition, each tool card is one leaf of the shared SerializableGrid. Files hosts the retained AuxiliaryBarPart explorer and EditorPart document groups inside that leaf; Terminal hosts PanelPart. SplitView sashes own sizes, and moving a card changes its position in the same serialized Grid tree. Product-editor compositions keep independent properties beside their editor. DesktopWorkbenchLayout owns this composition while preserving Part instances, focus and saved geometry.

Layout family and runtime are separate choices. Browser and Electron windows can use the same desktop layout. Chat, Code, Collaboration, Projects and Creator are compositions within that layout; changing pages does not by itself require another Workbench subclass. A separate implementation is justified by different Part containment, geometry or lifecycle, not by a page name or file length. Common mechanisms remain shared, and layout variants consume the same Sessions services without creating another conversation or selection model.

VS Code's Sessions `DesktopWorkbench` and `MobileWorkbench` split provides a reference for this responsibility boundary. Its regular Workbench also separates layout into `layout.ts`. Ash should preserve clear ownership for its own layouts; matching the upstream class hierarchy is not itself a design requirement.

## Workbench topology

The window retains one instance of each Part. Mode commands select the content and visibility of those hosts.

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
    ├── Sessions Part | Editor | Auxiliary Bar | Custom View Grid
    └── Panel
```

The workbench omits the standard Activity Bar, Status Bar and Banner. Its Sessions Activity Bar runs registered product commands. Part positions are fixed by the Agents Window rather than user settings.

Contributions register localized titles, icons and commands in `Menus.ActivityBar`.
`ActivityBar` owns profile-scoped command order and presentation. Selected
items follow the entry context published by the Sessions layout service. Focusing a conversation inside Code keeps Code selected.
Account actions remain outside the sortable group, and placement changes retain
the same actions and order. At the default location, SidebarPart hosts labeled
navigation above its active view and Accounts below it. Navigation is a disposable
component rather than a separate window Part; closing or suppressing the sidebar hides its
navigation and Accounts together without reserving an icon rail. The titlebar
workspace mode control follows the same sidebar visibility. The sidebar toggle
remains available to restore navigation in the current page. ActivityBar retains
action ownership as its presentation moves between the configured hosts.

Both workbenches open, hide and focus view containers through
`IPaneCompositePartService`. Sidebar, Panel and Auxiliary Bar retain their
`PaneComposite` instances. Feature contributions supply the surrounding Part composition to the Sessions layout service. `DesktopLayoutController` restores session documents and coordinates Editor/Details behavior.
The Sessions EditorPart retains a product-page group independently of the session document groups. `ISessionsService` owns a
single conversation selection, visible arrangement and navigation history;
changing the surrounding layout never creates a second conversation or composer.

| Part             | Ownership                                                        |
| ---------------- | ---------------------------------------------------------------- |
| Title bar        | Window navigation and window-scoped actions                      |
| Sidebar          | Sessions list and Sessions-owned sidebar views                   |
| Sessions Part    | One or more visible session surfaces                             |
| Editor           | Code document groups and retained Projects / Creator EditorPanes |
| Auxiliary Bar    | Code files and changes or the active canvas editor's properties  |
| Panel            | Terminal and other panel views                                   |
| Custom View Grid | Full-surface contributed views that replace session content      |

Creator canvas modes use `SidebarPart | EditorPart | AuxiliaryBarPart`: the workspace conversation list, the retained CreatorEditorPane and Shape properties. Design can additionally show SessionsPart while retaining its editor and independent properties. Entry descriptors declare `conversation: 'optional'`; ISessionsLayoutService owns its visibility preference and conversation focus, while DesktopWorkbenchLayout independently selects the primary Part and remembers supporting conversation width. Creator home and Make retain the conversation sidebar and hide the canvas properties. Other workspaces still need their task-specific [Creator composition](#creator-conversation-and-editor-composition). Projects uses its retained EditorPane for the project list and project details, alongside the same conversation sidebar and without an auxiliary sidebar. Switching content keeps workspaces alive; the existing working-copy and shutdown services still check save/discard/cancel for hidden dirty documents. Product-page groups are excluded from per-session Code working sets.

The Sessions Part hosts an independent instance of the shared EditorPart. Its editor groups each contain one live conversation view, independently of document groups and the chats inside an individual session.

## Grid behavior

The main workbench grid is non-proportional. The composition's primary surface absorbs container resize and part-visibility deltas: SessionsPart for conversation-led entries and EditorPart for Creator workspaces. Supporting Parts preserve user-established sizes within their constraints.

The shared EditorPart used by Sessions retains user-established proportions even when a narrower composition temporarily clamps leaves to their minimum widths. The preferred widths are restored when the available area grows again.

The primary surface absorbs general window resize: SessionsPart for conversations, or EditorPart for product editing, including a Creator composition with a supporting Agent conversation. Creator preserves supporting conversation and side-panel widths as the editor expands and shrinks. The owning layout remembers user-established sizes when a host is hidden and restores them when it reappears.

The desktop presentation may place the Auxiliary Bar inside the Editor's grid node. Consumers must distinguish the actual Editor content area from the shared grid node when interpreting visibility or size.

## Sessions Part

Each visible session has one Sessions-owned view. The view presents the active chat for that session and scopes commands, menus, and context keys to the represented session.

The Code Auxiliary Bar shows one current conversation title and a history switcher instead of conversation tabs. History includes untitled drafts and active session threads. Switching retains their live widgets and composers; Session services own selection and lifetime. Document tabs continue to use WorkbenchTabsControl. Both surfaces consume the shared theme and Part geometry.

SessionsPart consistently hosts conversations in SessionView, including restored chats and chats opened through navigation or external entry points. The sidebar selects the session; the conversation has no document editor group, EditorInput, EditorPane or tab title control.

The Close Session command closes the active visible session through ISessionsService. Closing an untitled session also clears its saved input draft; closing a durable session does not archive it. The command is available from the Sessions window's Command Palette without a tab close control.

In the side-by-side presentation, ordinary opens replace the active group's conversation and retain its siblings. Explicit side-by-side opens add a group. Ash intentionally uses this policy instead of VS Code Agents' transient and pinned slot search.

`ISessionsService` owns:

- visible-session identity and order;
- the active visible session;
- which chat is active in each session;
- restoration of the visible arrangement.

The Sessions Part renders that model. It does not create a second active-session store. Stable slot identities belong to the visible-session model; ordinary replacement transfers the slot to the new session. Retained sessions keep their views and live chat widgets across movement, reordering, and arrangement changes.

Opening and closing operate through `ISessionsService`. SessionsPart reconciles its visible selections into SessionViews, while SessionGridLayout owns a SerializableGrid of those live views, split geometry and user sash sizes. This follows the VS Code Agents separation between session views and document editors. Ordinary opens replace the active slot; opening an already visible Session focuses its existing view. Ash retains its replacement policy rather than introducing VS Code's transient and pinned slot search. Structural edits preserve unaffected branches, live inputs and focus. Explicit reordering lays out the requested order horizontally. Document tabs and document drops remain owned by the separate EditorPart.

Ash persists Session bindings, all untitled identities and the active selection in
`sessions.viewState` version 2. `SessionGridLayout` stores its split tree with
Session identities directly in `sessions.gridState` version 3. It migrates older
horizontal-width records and version 2 editor-group bindings into this tree.
Restoration reuses live views and keeps the complete saved tree while providers
resolve pending Sessions; explicit navigation can supersede that restoration.
Maximization remains an intended extension described by this specification;
current implementation limits are listed in the README.

Session geometry does not determine Editor, Details, or other side-pane visibility policy. That policy remains with the layout controllers.

## Editor presentation

All non-phone Agents windows use the desktop detail layout. Phone viewports use the dedicated mobile presentation.

Files and Terminal have independent card visibility. Files combines the retained explorer, document tabs and shared EditorPart inside one movable, resizable leaf. Opening a document reveals its editor inside Files; closing the last document hides that editor while retaining the tree. Closing Files hides both hosts without closing documents or working copies. The explorer toolbar is lent to the Files header and returns to its Part when a product page uses the original composition. The internal split adapts to the available Files width independently of the outer card tree.

Card controls consume presentations supplied by their content owners: a title, header, retained root and layout callback. They do not infer card identity from Workbench Part IDs or create content models. Header dragging and keyboard arrangement both call the same outer Grid operations; separators resize its branches. Normal topology and dimensions are persistent. GridView owns maximization and its normal geometry; DesktopWorkbenchLayout derives the expanded card from Grid and excludes the titlebar and navigation from maximization. Auxiliary-window detachment retains its normal tree in DesktopWorkbenchLayout. Both operations retain the same content and restore its arrangement. Session information is another Sessions-owned Grid leaf. Changes currently retains its shared editor input and pane; this Files composition does not introduce an independent Changes card.

The Sessions EditorPart reuses the shared editor-group capabilities. It retains a locked product-page group and separate session document groups. Mode changes select their visibility; restoring session document groups keeps the product group, panes and documents alive. The independent conversation grid remains in SessionsPart.

The durable state and transition catalog lives in [DESKTOP.md](DESKTOP.md). Implementation behavior is covered by the layout-controller and desktop strategy tests.

Code documents must be opened through `IEditorService`. Sessions-specific presentation must not bypass editor service behavior by opening directly on an editor group.

Chat input status-pill composition is owned by the shared workbench `ChatInputPills` and `StandardChatInputPillSources` components. The Agents Window and Agent Host editor/panel surfaces supply observable data adapters and their allowed pill kinds only; ordering, per-kind presentation, visibility, context menus, keyboard behavior, compact layout, and lifecycle rendering must not be reimplemented per surface. Per-kind visibility preferences belong to `ISessionChatPillVisibilityService`; data adapters apply them before supplying pill data and option actions to the shared renderer.

Session providers register internal per-session directories as resource label homes. URI labels render as `<home label>/<relative path>`, and breadcrumbs render the same home label as their root segment. Without a matching home formatter, existing URI-label and breadcrumb behavior is unchanged.

## Custom views

`ICustomViewService` owns the active contributed full-surface view.
`CustomViewGridPart` is a passive retained Part; Workbench drives its descriptor,
visibility and explicit-open focus. The desktop Grid keeps a hidden `customview`
leaf alongside its normal content. Custom-view visibility is transient and does
not overwrite the underlying entry's desired visibility or saved dimensions.

A custom view is an independent page, mutually exclusive with Sessions Part, grid Editor, Auxiliary Bar, and Panel. The title bar and window sidebar retain their normal visibility and navigation behavior. Covered content parts retain desired visibility separately from effective grid visibility so their state can be restored when the custom view closes.

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

Phone layouts are planned to replace selected parts and pickers with mobile subclasses while preserving the same service and provider contracts. The phone workbench, composition and navigation remain unimplemented; the Creator composition above defines the non-phone window contract.

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
