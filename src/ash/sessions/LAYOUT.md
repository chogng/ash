# Agents Window layout

> **Specification change gate:** Do not update this document for layout bug fixes, styling, dimensions, or action placement. Update it only when part ownership, workbench topology, or a cross-part contract intentionally changes.

## Scope

The Agents Window uses a Sessions-owned workbench layout optimized for agent work. This specification defines stable part ownership, composition, and presentation modes. Per-session capture and restoration are owned by [LAYOUT_CONTROLLER.md](LAYOUT_CONTROLLER.md).

Exact dimensions, styling, action placement, and regression behavior belong in code, design tokens, component fixtures, and focused tests.

## Shared Parts and mode content

Desktop modes select view content in the shared `SidebarPart`; pages without a dedicated container retain the current workspace's conversation sidebar. Cold restoration and workspace changes use the registered default container; Desktop's ChatGPT contribution supplies the Chat default. Projects opens its retained EditorPane for the project list and project conversations. Each mode supplies content to the shared window Parts; a product-page name does not justify a new Part or another window grid.

Chat and Code are workspace shells selected by the titlebar switcher. Entry descriptors declare their workspace; `ISessionsEntryService` derives the active workspace from the selected entry and publishes its context for navigation. The Activity Bar evaluates each contributed entry in the active workspace context. Navigation order and pins use shared profile preferences. Desktop Chat and Code select separate retained conversation sidebar views in the same SidebarPart. New opens a draft in the selected mode. Shared pages and overlays retain that mode. A Custom View can declare the entry command that supplies its underlying workspace; opening and restoring that view preserves the overlay while applying the declared entry. Custom Views retain the workspace sidebar's current expansion state. Navigation order is saved in the profile UI state store. The selected workspace is reconstructed from the restored entry.

| Surface                           | Shared host        | Mode-owned content                                                                       |
| --------------------------------- | ------------------ | ---------------------------------------------------------------------------------------- |
| Workspace and connection status   | Title bar actions  | Sessions workspace contribution projects the existing permission and connection services |
| Left navigation and tools         | `SidebarPart`      | Registered `ViewContainer`, its `ViewPaneContainer` and `ViewPane` contributions         |
| Agent conversations               | `SessionsPart`     | One conversation grid with retained session views                                        |
| Editing and central product pages | `EditorPart`       | `EditorInput` and `EditorPane` opened through `IEditorService`                           |
| Right properties and detail views | `AuxiliaryBarPart` | Registered view containers and views for the current mode or editor                      |

The Agents Window has no Banner Part or reserved notice row. Restricted Mode and its Workspace Trust editor belong to the regular IDE. Agents restores a folder only if it has development permissions and otherwise starts with an empty workspace. Explicit folder selection can ask for development permissions. The Sessions workspace contribution shows authorization retries for explicit selections and connection recovery through title bar actions. These controls read the owning services and do not own another permission or connection model. A terminal connection failure offers a sticky global notification with the existing Reload Window action; startup failures retain the host's recovery surface. Status changes do not move the content or enter saved session layouts. The regular IDE retains its Banner Part and notice producers.

`ViewContainer` is the sidebar, auxiliary-bar and panel registration mechanism. Central editor pages use the editor input/pane mechanism rather than a separate mode container. An `EditorPane` can render a canvas, a browsing page or another rich interface; it is not limited to a text editor. Mode implementations own their documents, commands and content while the shared Parts own placement, resizing, focus and hosting lifecycle. Mode changes retain the same Sessions service and selection ownership.

Desktop Chat and Code use the same `SessionsPart`, session grid, `SessionView` and `ChatView`. The entry selects the model source. The factory binds that source to the shared `ChatWidget` with the available composer and transcript capabilities. Desktop Chat uses one slot, and the grid preserves the geometry of the Agent session arrangement while Chat is active. ChatGPT's window-scoped service owns selection, messages, drafts, models and in-flight operations, and its Electron adapter keeps credentials, HTTP streaming and verification in Main. Projects, Artifacts and Customize retain the Chat sidebar and its collapsed groups. Opening a conversation from those pages reveals `SessionsPart` and focuses the Chat view. The sidebar can initialize its catalog independently of the Chat view.

Layout variants arrange these shared hosts differently. Desktop-specific editor/detail docking and phone navigation may require separate layout implementations; they do not justify `ProjectsPart`, `CreatorPart` or another Part for each page. Conversation-grid ownership remains governed by the Sessions model and its own composition contract, independently of document editing.

Projects and Creator contribute EditorPanes to the retained Sessions EditorPart. Their navigation and details use shared editor and view-container hosts. The Projects editor owns the project list and materials. The Projects contribution registers the project title as a menu action view item. The window title bar owns its placement and lifetime, and the title reads the active editor’s project presentation. The window-scoped navigation service owns browsing state and the Project backend owns the durable catalog and material references. SessionsPart remains the permanent conversation host. A product page may show it alongside EditorPart when its contributed composition includes Agent work; a page without conversation content hides it.

### Creator entries and the project catalog

Creator aggregates independently contributed creation tools. Contributions register their Views against a shared Creator container ID; `ViewPaneContainer` owns their arrangement, expansion, sizing and focus. Creator owns workspace selection and retained workspace documents. A contribution entry registers capabilities rather than running a window-wide product-mode state machine.

Projects presents the shared Project catalog through `IProjectService`. The backend owns durable project metadata and file or folder references; `ProjectsService` retains only window-local search, sorting and selected-project state. Material types remain inside a project and do not register separate product entries or view containers.

### Creator conversation and editor composition

Creator retains the workspace conversation sidebar when opening its home, documents or canvas modes. Registered sidebar tool views, including layers, require an explicit view-opening action rather than activation by page navigation. Creator reuses EditorPart for the retained creation EditorPane; AuxiliaryBarPart for properties and detail Views; and SessionsPart for full Agent conversations. The [Creator Part mapping](contrib/artifact/DESIGN.md#七项工作区的-part-分工) owns the seven workspaces' content and task-specific display requirements. Single-purpose AI controls belong with the affected content; they do not introduce another conversation host or selection model.

Customize owns the Sessions catalog for plugins, skills and connections, including the optional Academy paper editor. General Docs are built into the Agent Window. IDE editor extension discovery and management open in the standalone IDE with the requested filters. The originating Sessions window stays open.

Artifact details use the same desktop composition from left to right: SidebarPart for session navigation, SessionsPart for conversation and EditorPart for the artifact. EditorPart is the primary surface. When an entry contributes a details ViewContainer, DesktopMainEditorPart docks the existing AuxiliaryBarPart on the editor's right edge below its tabs, using the same sash as Files details. The window layout owns the requested visibility and width. The editor owns the dock's effective size and temporarily hides it when the editor and details cannot both fit. Creator home retains the sidebar and its entry page. Make's Build with Agent prepares its unsent Code draft alongside the preview.

Feature entry descriptors must express the retained product editor and conversation visibility independently. ISessionsEntryService applies that composition without switches over Creator workspace names; the concrete desktop layout owns placement, resizing and focus geometry. Showing or focusing the conversation keeps Creator selected in the Activity Bar and keeps its EditorPane active. This is a composition of the existing Parts, not another window Grid or a new Part per workspace.

Sessions services and SessionsPart retain conversation identity, selection, live widgets, drafts, attachments and execution state. Creator's editor and working copy retain document identity, edits, history and save state. Features associate document and conversation identities through their owning contracts; a side View borrows the same editor content and selection. Showing, hiding or switching these hosts does not duplicate either model, discard unsent work, cancel a running Turn, archive a conversation or close a dirty document. Actual close and shutdown retain the existing save/discard/cancel lifecycle.

Agent Window does not register a Panel view host; Output and legacy terminal panel views stay unavailable, including restored visibility and diagnostic reveal requests. No PanelPart instance or panel Grid leaf is created. Code terminals use TerminalEditor in the shared EditorPart. Presenter notes, bulk content tables, CMS editing and running previews remain content of the relevant EditorPane. ActivityBar owns the Creator product entry; Creator navigation selects its seven workspaces. TitlebarPart keeps window navigation and window-scoped actions.

Implementation must verify the composed entry path, independent host visibility, Creator selected state, retained editor and conversation state, focus and size restoration, and narrow-window behavior using Playwright in Browser, Electron UI and Electron. This specification records the target contract, not completed behavior tests.

### Activity Bar entry switching

Sessions uses the same view-container activation mechanism as the regular VS Code Activity Bar. VS Code's ordinary container icons select sidebar content while retaining the active editor. A Sessions feature command can also select its central editor and details container through a shared entry descriptor.

```text
Activity Bar icon
  -> feature entry command
  -> ISessionsEntryService.openEntry(descriptor)
     -> IViewsService: open registered sidebar and details container IDs
     -> IEditorService: open the feature's EditorInput / EditorPane
     -> Workbench layout: apply shared host visibility
```

The sidebar activation unit is a `ViewContainer`, which may contain several `ViewPane` instances. Central editors continue to use `IEditorService`. A feature supplies its container IDs and central content to `ISessionsEntryService`, which opens registered containers through `IViewsService` and preserves the existing hosts. The shared layout service does not know Creator workspaces or project selection; generic container activation must not acquire product behavior.

Activity Bar owns its icons, activation commands and selected-state display. It does not own editor inputs, documents, Part geometry or another selection store. The layout service publishes the feature's contributed context key after opening its entry. Ordinary View focus or Project selection changes do not select another window entry.

Entry switching reuses the existing Parts, container instances and editor lifecycle. Their existing owners preserve document edits, feature state, editor working sets and the active conversation. Multiple Views in one container and multiple feature editors do not require more window Parts. The layout service retains only the active host descriptor and layout preferences.

### Implementation decisions

SessionsPart owns one conversation grid. Each Session has one ordinary slot, and
explicit side opens can retain a second Thread of that Session in its own slot.
The visible slots and active Thread persist with the workspace. Code and native Chat
use the shared Chat widget with separate input layouts. Entry navigation selects
the presentation through `ISessionsConversationService` before revealing or
focusing the Part. SessionView retains both panes' DOM and attaches the active
pane inside the same slot.
Entry changes transfer unsent text, mode and attachments, then clear the inactive
composer. They preserve the grid, Session views, window selection and navigation
history.

Feature commands own entry selection. The shared layout service stores the active entry's layout descriptor and applies its contributed Activity Bar context key. It has no enum or switch over product names. Focusing SessionsPart keeps the composing entry selected, including Code and Creator; focusing a View or changing the selected project does not select a different window entry.

SessionsPart remains the shared Agent conversation host, including its multi-session grid. Code and Creator compositions can show SessionsPart beside EditorPart; chat surfaces do not become document editor groups. Creator and Projects enter the shared EditorPart lifecycle. Switching a mode activates retained content without closing other tabs, discarding edits, recreating chat widgets or replacing document models. Actual close and window shutdown continue to use the existing save/discard/cancel checks.

Feature commands supply central content and optional sidebar and auxiliary ViewContainers together. An omitted sidebar container uses shared Sessions navigation; every entry retains the window sidebar. Views consume the active document and selection; they do not maintain another document model. Creator home and Make keep their sidebar content. Project navigation and materials belong to the retained central editor; Projects uses shared conversation navigation and contributes no auxiliary container.

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
| `ISessionsEntryService`           | Apply feature-supplied entry descriptors and remember host visibility                                  |
| Layout controllers and strategies | Restore session document working sets and coordinate Code Editor/Details behavior                      |
| Sessions services and Parts       | Own conversation identity, selection and content independently of the selected window layout           |

Code composes independent tool EditorParts through DesktopEditorArea and EditorParts. The docking and layout ownership contract is described under [Editor presentation](#editor-presentation). Terminal and Browser services retain their runtime models; Sidebar, SessionsPart and product properties keep their existing window roles.

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
Window
├── Primary column
│   ├── Title bar
│   └── Sidebar | Sessions Part | Editor | Custom View Grid
└── Auxiliary Bar column
```

In Chat and Code, `DesktopWorkbenchLayout` locates the dividers from the visible Parts. SidebarPart paints its trailing border, and the Editor Part frame paints its leading border when it sits beside SessionsPart. The title bar continues each visible divider at the same position. Grid sashes handle resizing.

The window Auxiliary Bar shares a full-height divider with the primary column. Its view body starts below the window chrome. The Auxiliary Bar hosts the Entity details title and its projected close action at the same height as the window title bar. The main title bar and its actions follow the primary column width as the Auxiliary Bar opens, closes or resizes. Code tool headers dock within the primary column when the editor is split beside the conversation.

The workbench omits the standard Activity Bar, Status Bar and Banner. Its Sessions Activity Bar runs registered product commands. Part positions are fixed by the Agents Window rather than user settings.

Contributions register localized titles, icons and commands in `Menus.ActivityBar`.
`ActivityBar` owns profile-scoped command order and presentation. Selected
items follow the entry context published by the Sessions entry service. Focusing a conversation inside Code keeps Code selected.
Account actions remain outside the sortable group, and placement changes retain
the same actions and order. At the default location, SidebarPart hosts labeled
navigation above its active view and Accounts below it. Navigation is a disposable
component rather than a separate window Part; closing or suppressing the sidebar hides its
navigation and Accounts together without reserving an icon rail. The titlebar
workspace mode control appears when the sidebar is visible and the current
entry allows it. The sidebar toggle remains available to restore navigation in
the current page. ActivityBar retains
action ownership as its presentation moves between the configured hosts.

Both workbenches open, hide and focus view containers through
`IPaneCompositePartService`. Sidebar and Auxiliary Bar retain their
`PaneComposite` instances. Feature contributions supply the surrounding Part composition to the Sessions entry service. `DesktopLayoutController` restores session documents and coordinates Editor/Details behavior.
The Sessions EditorPart retains a product-page group independently of the session document groups. `ISessionsService` owns a
single conversation selection, visible arrangement and navigation history;
changing the surrounding layout never creates a second conversation or composer.

| Part             | Ownership                                                        |
| ---------------- | ---------------------------------------------------------------- |
| Title bar        | Window navigation and window-scoped actions                      |
| Sidebar          | Sessions list and Sessions-owned sidebar views                   |
| Sessions Part    | One or more visible session surfaces                             |
| Editor           | Code document groups and retained Projects / Creator EditorPanes |
| Auxiliary Bar    | Properties and detail Views for the active product editor        |
| Custom View Grid | Full-surface contributed views that replace session content      |

Artifact detail entries declare `conversation: 'visible'` and provide `detailsContainerId` when they have a details view. ISessionsEntryService applies the [Creator composition](#creator-conversation-and-editor-composition) and DesktopWorkbenchLayout remembers the supporting conversation width. Projects uses its retained EditorPane for the project list and project details, alongside the shared conversation sidebar and without an auxiliary sidebar. Switching content keeps workspaces alive; the existing working-copy and shutdown services still check save/discard/cancel for hidden dirty documents. Product-page groups are excluded from per-session Code working sets.

SessionsPart hosts live conversation views in its own SessionGridLayout. These views are independent of document editor groups and of the chats inside an individual session.

## Grid behavior

The main workbench grid is non-proportional. The composition's primary surface absorbs container resize and part-visibility deltas: SessionsPart for conversation-led entries and EditorPart for Creator workspaces. Supporting Parts preserve user-established sizes within their constraints.

The shared EditorPart used by Sessions retains user-established proportions even when a narrower composition temporarily clamps leaves to their minimum widths. The preferred widths are restored when the available area grows again.

The primary surface absorbs general window resize: SessionsPart for conversations, or EditorPart for product editing, including a Creator composition with a supporting Agent conversation. Creator preserves supporting conversation and side-panel widths as the editor expands and shrinks. The owning layout remembers user-established sizes when a host is hidden and restores them when it reappears.

Files navigation is laid out inside its owning Editor Group. AuxiliaryBarPart remains an independent properties host for product editors; Code file navigation does not move or resize that Part.

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

`DesktopWorkbenchLayout` composes the window's outer Parts. Within its editor region, `DesktopEditorArea` owns the tool Grid for Files, Changes, Browser (Preview), Terminal, Side Chat and Search. The Sessions `EditorParts` creates and registers one independent `EditorPart` per tool card and owns its scoped context. The desktop Agent Window uses one visible `EditorGroup` per tool in the active working set, following the single-group editor policy of the VS Code Agents desktop main window. Each group owns its toolbar and tabs. Opening to the side uses the current tab group. Tool arrangement remains in the outer Grid, and a terminal split creates another Shell pane inside the current terminal Tab. A Side Chat tab renders a `SessionSideChatEditor` in its group. Search uses the shared Search Editor pane, and working sets created before its tool Part move saved search tabs out of Files when restored. In layout discussions, a _tool pane_ means the whole tool card that the tool Grid moves.

In split Code windows, `DesktopWorkbenchLayout` decides whether the split supports docking, and `TitlebarPart` owns the space and mount for tool headers. The conversation title and window tool controls occupy the conversation side. `DesktopEditorArea` mounts the existing title rows of top-edge groups on the other side, in visual tool order and with horizontal scrolling when needed. Groups below another pane keep their title rows at their own top edge. The groups retain their tabs, commands, focus and drag ownership. Breadcrumbs remain with the editor body. When the split is unavailable or too narrow for the title bar controls, the area returns the rows to their groups before the title bar hides the mount.

When Session Activity Bar is enabled and the conversation Part is visible, `SessionsPart` hosts the Files, Changes and Browser commands beside its conversation grid. The grid lays out within the remaining width. The commands use the same layout and editor state in both placements. They appear in the title bar when the conversation Part is hidden or the setting is off.

Changes hides the tab strip while keeping the group's title toolbar. Diff View commands use that group as their context and update the Agents window's shared diff preference. Maximize Tool acts on the whole card in the outer tool Grid.

The Changes header toggles the Workbench changed-files list in both layouts. The editor owns the split and reveals selected files in the current comparison. The independent Changes view in the Auxiliary Bar uses the same Workbench list and list or tree preference. Session Rail follows the conversation pane's lifecycle and hosts branch actions, pull requests, and checks.

The desktop window title bar reserves pointer interaction for editor tabs and controls, and dragging the surrounding title area moves the window. Alt-drag on an inline card header and Alt+Shift+Arrow move the tool card in the outer Grid.

### Tool placement strategy

Claude Desktop opens the first tool beside the main conversation. When the rightmost tool is a single card, the next tool normally stacks below it. An existing stack can be followed by another column. Simulator cards take the horizontal insertion path. On close, the layout records a neighboring branch, the split direction, the side and the relative size. Reopening tries that position against the current tree. If only the main conversation remains and the recovered tree has the same shape as the default, the default supplies the initial weights. Its explicit Move actions target a layout edge and can change the split direction. Fill and Tile control presentation, and eligible tools can open in a separate window.

Opening order also affects size. The first tool sets the initial column weight by tool type, using a saved weight when available. When the next tool stacks below it, the column inherits that weight and the two cards start with equal vertical weights. The layout then fits those weights to the available width and minimum sizes.

Ash inserts cards into the current tool Grid. When a card closes, the Grid remembers its neighboring cards, the split axis, the side and the size relative to its siblings. Closed cards leave the visible split, and the remaining cards take the released space. Reopening restores the split around a surviving neighbor. When a single automatically arranged tool is already visible, the next tool opens below it if both fit vertically, including when that tool was previously above it. If a saved neighbor disappears or a horizontal boundary has changed, the card follows the normal opening rule. An existing stack or insufficient height starts another column. The workbench shares the available width between the conversation and the visible tool columns. The tool working set retains their combined width weight along with the tool Grid's internal proportions.

When the normal layout cannot fit, the workbench first tries a temporary vertical arrangement. If space is still insufficient, it keeps the main conversation and active tool visible where possible, with a return to the conversation when only one surface fits. The temporary arrangement retains the saved splits, tabs and drafts so widening restores the user's layout.

DesktopMainEditorPart owns and lazily creates DesktopAuxiliaryBarPart, its docked rectangle, sash, Details visibility and editor-content visibility. DesktopAuxiliaryBarPart uses a scoped view catalog and context; it hosts ordinary contributed views without a title strip. The Files contribution registers Explorer there and owns no editor layout or docking controller. Files navigation remains one retained view across working-set switches. The window's AuxiliaryBarPart continues to host product-page properties independently.

Session working sets serialize documents once, plus each Part's group membership, the outer tool Grid and the closed cards' relative positions. The tool Grid remembers manual card placement. Older working sets without this record adopt vertical placement when they restore two side-by-side tools and both fit vertically. Session switches retain live groups and panes, and entry switches temporarily hide them. Restoration partitions legacy mixed groups by tool and combines each tool's old groups into one tab group, preserving the selected tab and tool visibility. Group IDs are window-wide so restored groups coexist with retained sessions and the locked product-page group. BrowserView initializes before restoration, and the terminal service owns the terminal models. SessionsPart owns the conversation grid.

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
`CustomViewNode` owns the mounted page, including its header, scrolling body,
focus and the lifetime of the contributed content.

A custom view is an independent page, mutually exclusive with Sessions Part, grid Editor, Auxiliary Bar, and Panel. The title bar and window sidebar retain their normal visibility and navigation behavior. Covered content parts retain desired visibility separately from effective grid visibility so their state can be restored when the custom view closes.

Explicit session and chat open actions dismiss the active custom view. Reactive fallback opens driven by session or chat lifecycle changes preserve the custom view while reconciling the hidden Sessions grid. On phone layouts, custom views participate in mobile navigation so platform back navigation dismisses them.

## Part lifecycle

Web and Electron register `ITitleService` in the Agents Window scope. It owns the main titlebar and tracks each detached conversation titlebar by its window document. Closing the popup releases its titlebar registration. `SessionsPart` retains ownership of the conversation and reattaches it to the main window on close.

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

Shared Chat services and editor contributions load through `chat.shared.contribution.ts`; each renderer host registers its own window actions. Runtime Browser integration starts after the window's editor and view services are registered.

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
