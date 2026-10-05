# Code Sessions

`sessions/` owns Ash Code's dedicated agent Workbench beside the regular
`workbench/`. Its product and build boundary is canonical in
[`docs/workbench-modes.md`](../../../../docs/workbench-modes.md); this README
is canonical for the renderer implementation and extension points.

Creator's Sites mode, contribution boundaries, implementation order and acceptance
requirements are described in [Creator Sites](CREATOR_SITES.md).

## Ownership

| Area | Owner | Current implementation |
| --- | --- | --- |
| Window host | `browser/web.main.ts`, `sessions.desktop.main.ts`, and `electron-browser/sessions.main.ts` | start the browser or Electron Sessions renderer and register desktop actions |
| Desktop window host | `platform/windows/electron-main/windowImpl.ts` and `windowsMainService.ts` | the first owns each Electron window and its resources; the second owns live Workbench and Sessions windows; `code/electron-main/app.ts` supplies Sessions workspace context and connections |
| Main-process close | `platform/lifecycle/electron-main/lifecycleMainService.ts` | waits for either renderer to finish shutdown before closing its window |
| Workbench window selection | `platform/windows/electron-main/windowsFinder.ts` and `platform/windows/electron-main/windowsMainService.ts` | match folder or workspace files to live windows, reuse a matching Workbench, and keep active-window order; Sessions owns the return action and its IPC contract |
| Browser window navigation | `code/browser/workbench/workbench.ts` and `sessions/browser/web.main.ts` | navigate to their sibling renderer page; the Sessions profile validates its return path |
| Browser renderer lifecycle | `workbench/services/lifecycle/browser/lifecycleService.ts` | joins shutdown work when the browser page closes |
| Electron renderer close | `workbench/services/lifecycle/electron-browser/lifecycleService.ts` | checks shutdown vetoes and joins save work before either Electron window closes |
| Code profile | `code/common/codeSessionsProfile.ts` | defines the Code window identity and page route used by both browser and Electron entries |
| Product composition | `browser/workbench.ts` | uses shared window identity and lifecycle services; owns the fixed titlebar/activitybar/sidebar/sessions/editor/auxiliarybar/panel Part set |
| Code Files and Changes | `contrib/files/browser/`, `contrib/changes/browser/`, and `common/views.ts` | register only in the Sessions view catalog; Files reuses Explorer, Changes reads the selected conversation's Turn ledger, and both open the shared Workbench Editor Part |
| Session file access | `services/workspace/browser/workspaceContextService.ts` and `contrib/providers/appServer/browser/sessionFileService.ts` | Explorer follows the selected Session directory; resource identities retain previously opened directories, while the transport adapter selects the Session directory protocol |
| Layout | `browser/workbench.ts`, `browser/dockedAuxiliaryBarController.ts`, and `contrib/layout/browser/` | Workbench owns topology, geometry and persisted Part sizes/visibility. Code docks Details below the shared editor tabs and hosts its bottom Panel. The base controller restores session editors and panel views; the desktop controller owns the four Editor/Details states and managed Files/Changes tabs |
| Appearance | `common/configuration.ts` and `contrib/modernUI/browser/` | own the independent Sessions layout, Activity Bar position, and size preferences |
| Accounts and settings | `contrib/accounts/browser/` and `contrib/preferences/browser/` | the account icon opens a Sessions-owned menu with Settings and Return to Workbench; Settings opens a Sessions-owned page that reuses the Workbench setting widgets |
| Window Sessions state | `services/sessions/browser/sessionsService.ts` | owns one active/visible selection model and Back/Forward history for the window |
| Frontend Session model | `services/sessions/common/session.ts` | owns `ISession`, `IChat`, workspace summary, and untitled identity types |
| Shared Chat contract | `workbench/services/chat/common/chatService.ts` | owns Thread and Turn operations plus shared Session/Thread IDs, model references, and approval modes used by both renderers |
| Provider and management | `contrib/providers/appServer/browser/workbenchSessionsService.contribution.ts`, `services/sessions/common/sessionsManagement.ts`, and `services/sessions/browser/sessionsManagementService.ts` | the App Server provider adapts transport data; management owns catalog, drafts, and operations; the contribution registers and starts it in the regular Workbench |
| Regular Workbench Chat | `browser/workbenchChat.contribution.ts`, `browser/chatViewPane.ts`, and `browser/chatWidgetModel.ts` | registers the Session-backed Chat view, actions, and navigation service; one model owns selection, draft materialization, and Thread subscriptions for each shared `ChatWidget` |
| Main conversation | `browser/parts/sessionsChatView.ts` | renders visible durable and untitled Sessions as retained full `ChatWidget` Grid leaves |
| Sessions composer | `contrib/chat/browser/newChatInput.ts`, `newChatContextAttachments.ts`, and `media/chatInput.css` | owns the welcome layout, embedded-editor sizing, file acquisition, paste/drop entry points, and per-composer permission menu; shared input operations and attachment state remain in Workbench |
| Composer persistence | `contrib/chat/common/newChatDraftState.ts` | owns workspace-scoped drafts keyed by untitled identity or Thread; migrates older Chat/Code keys without discarding conflicting drafts |
| Welcome tips | `workbench/contrib/chat/browser/chatTipService.ts` and `widget/input/chatInputTipPresenter.ts` | the service owns profile-scoped dismissal; the presenter renders only while the Sessions composer is empty and ready, and yields to approval or error state |
| Turn review | `browser/turnMultiDiffSource.ts` and `browser/turnMultiDiffSource.contribution.ts` | compose Turn changes and register their source resolver and commit action with `workbench/contrib/multiDiffEditor/browser/multiDiffSourceResolverService.ts` |
| Parts | `browser/parts/` | owns product chrome, window navigation, list, primary surface, and typed active context |
| Activity Bar | `browser/parts/activitybar/` | renders menu commands, persists their order, and owns account entry, DOM, and presentation; reuses shared Parts, controls, configuration, and menu services without importing Workbench Activity Bar styles |
| View containers | `workbench/services/panecomposite/browser/panecomposite.ts` and `workbench/browser/parts/paneCompositePartService.ts` | both windows use the same service to open, hide and focus containers; Parts retain their instances |
| Library and Creator | `contrib/library/browser/library.contribution.ts` and `contrib/creator/browser/creator.contribution.ts` | contribute Activity Bar menu commands; their modules retain their pages independently of Code editor groups |
| Creator | [`contrib/creator/`](contrib/creator/README.md) | owns seven independently registered creation workspaces and their shared canvas document, editing and file lifecycle; loads through `sessions.common.main.ts`. Sessions Settings exposes its profile-scoped cursor and accessibility preferences in Design. |
| Application menu and titlebar actions | `browser/menus.ts`, `browser/parts/menubar.contribution.ts`, and `browser/layoutActions.ts` | Sessions owns its menu root, File menu, and layout action menu; common sections are explicitly shared. The Workbench BrowserMenubarControl owns menu interaction; the layout and Sessions service own sidebar visibility and history |
| Session chat commands | `browser/actions/sessionsChatActions.ts` | maps the reused ChatWidget New Chat and History commands to the Sessions window's draft and active-chat selection |
| Open Agents Window | `code/browser/workbench/workbench.ts`, `workbench/contrib/chat/electron-browser/`, `contrib/openAgentsWindow/electron-browser/`, and `workbench/browser/parts/titlebar/` | the browser product entry owns page navigation; the Chat desktop contribution owns the titlebar action, hover label, and window command; the Sessions desktop contribution owns system-wide shortcut synchronization; the Workbench titlebar owns the shared mark and motion. Shared shortcut selection lives in `workbench/contrib/keybindings/`, while `platform/globalKeybindings/` owns operating-system registrations |

The dedicated Sessions renderer reuses Workbench Chat presentation, editor, and
service contracts. Workbench production code does not import Sessions modules;
the browser and Electron product entries load the Sessions contribution that registers
their Session-backed Chat view and actions. The shared `ChatWidget` renders a
model supplied by Sessions and does not create or select Sessions itself.
The dedicated window supplies one `NewChatInputWidget` per retained pane
through the shared widget's input factory. Sessions owns its composer layout,
file acquisition, and storage policy while reusing the embedded editor and
shared Chat input operations.

`ISessionsService` owns one active selection, visible arrangement and Back/Forward
history. `SessionsPart` retains one `SessionsChatView`. Each visible Session owns
its `ChatWidgetModel`, editor, unsent text, attachments and pending submission.
Chat, Code and Collaboration commands change the surrounding Parts while keeping
that selection and those live inputs. Code reveals editor tools; Collaboration
selects the Teams sidebar. Library and Design open retained product pages through
`LibraryPart` and `CreatorPart`. `DesktopLayoutController` coordinates their Parts, and Activity
Bar selection follows the actual editor, sidebar and layout.
See [input and conversation state ownership](../../../docs/input-state-ownership.md)
for the boundary with regular Workbench Chat and SCM.

The shared `ChatAttachmentModel` owns each composer's attachment collection.
Sessions file acquisition resolves UTF-8 text or supported image data before
adding it. `ChatService` converts resolved images to image input items and omits
empty text when sending attachments alone. Approval choice remains in the Chat
model and is applied to a new Turn through the existing backend contract.
Changing it does not change the approval mode of a running Turn.

Unsent composer content is window/workspace UI state. Each untitled identity and
Thread has its own `sessions.inputDraft` entry. All untitled identities and the
visible arrangement are restored from `sessions.viewState`; navigation history
starts from the restored selection. Legacy Chat/Code arrangements are merged,
and conflicting drafts become separate untitled Sessions. Renderer shutdown
joins pending attachment resolution before flushing storage.

## Execution path

1. The Code browser or Electron entry creates one Sessions `Workbench`.
2. `browser/workbench.ts` creates one App Server Session provider, one
   `ISessionsManagementService`, one window `ISessionsService`, and one
   `ChatService`, then registers their frontend contracts in a window-local
   `InstantiationService`.
   Shared service descriptions are loaded by `sessions.common.main.ts` and
   collected before consumers are created. The container owns their instances;
   Sessions supplies its window-specific services in that same scope.
3. The Sessions `Workbench` creates `BrowserLayoutService` and registers
   commands, context keys, menus, keybindings, overlays, quick input, settings,
   and hover services for its own window, using the same service implementations
   as the regular Workbench.
   Sessions creates the same `WorkbenchThemeService` as the regular Workbench
   against its own document. On desktop, both renderers read the shared
   `workbench.colorTheme` setting, so changes apply to both windows.
   Both windows use the same profile `settings.json` (JSONC). The Sessions
   configuration service resolves registered `agentsWindow.default` values;
   user values override them unless `agentsWindow.readOnly` is set. Read-only
   settings ignore shared-file and language values and reject setting updates,
   while raw file edits remain shared with the regular Workbench. Settings
   inspection and reset use the active window's default. Resource revisions
   still advance for ignored edits without announcing an effective setting change.
   `WorkbenchWindow` registers the renderer window and its document styles;
   Desktop initializes its window storage through the Main `storage` channel
   before creating Parts. Main merges key updates into `workbench-state.json`
   and broadcasts revisions; the browser page uses its scoped `localStorage`
   adapter. Storage identity contains only scope and profile/workspace id;
   the product entry supplies no storage namespace. Main archives the original
   v1 document before writing v2; both adapters retire the old Code/Academic
   browser namespaces before opening scopes. Migration archives never participate
   in runtime reads. The old Desktop document is removed only after a validated,
   non-conflicting import has reached disk. Sessions retains its own profile
   and `sessions` workspace identity. The renderer lifecycle service joins
   storage and Desktop log flush before disposal; Main owns log retention.
   Pane membership and split widths are saved when their owners commit a
   change, so an immediate reload does not wait for the periodic flush.
   A hidden Sessions Part retains its saved split widths until it is visible and the
   surrounding Parts have completed their layout.
4. `SessionsWorkbenchLayout` deserializes the fixed Part grid. Titlebar,
   activitybar, sidebar, sessions, editor, and auxiliary Parts are registered; the sidebar and auxiliary Parts can be toggled,
   and Activity Bar visibility follows `sessions.activityBar.location`.
   The Activity Bar runs Chat, Collaboration, Library, Code, and Design commands; Collaboration opens the Teams sidebar; Library opens in LibraryPart and browses the shared asset catalog with image import, search, favorites, collections, grid/list views and previews. Its retained page owns browsing state and releases preview URLs while hidden. Library can attach an exact image version to the current Chat draft or place it in Design; the window composition owns navigation between these surfaces.
   [Creator](contrib/creator/README.md) provides retained editing workspaces hosted by CreatorPart. Its editors use the independent [Canvas contribution](contrib/canvas/README.md) for spatial surfaces, viewport state and pointer capture. In Design, SidebarPart hosts Layers, CreatorPart hosts the editor, and AuxiliaryBarPart hosts Shape properties; SessionsPart is hidden. CreatorPart provides a seven-mode home and retains each workspace, viewport and selection. The editor service owns one document per mode and checks all dirty documents during window shutdown. Home and Make hide the outer canvas panels. The panel views borrow the active editor's document and selection through the window-scoped Design editor service. Creator and Canvas own no Session state. Document, command, widget and file lifecycle responsibilities, geometry and persistence contracts, supported tools and validation entry points are documented in their owning directories.
   Chat hides the auxiliary bar. Code exposes Files and Changes; opening a file or comparison reveals the retained Workbench editor beside the conversation. Changing the composition hides and restores that editor without closing its files. Session details has been removed.
   Mobile devices remains unavailable. Its right-click menu moves the
   controls to the sidebar top or bottom, hides them, or selects the side rail size through
   `sessions.activityBar.compact`. The Sessions titlebar composes the shared BrowserMenubarControl with Sessions menu IDs and visual tokens. Layout actions derive menu context keys from the layout and window Sessions service; the titlebar keeps no separate sidebar or history state. Code uses the same retained conversations with a centered new-session composer; after the first message, the input stays below the conversation. The sidebar owns the new-session control.
   Its spacing follows `sessions.layoutStyle`, independently of the IDE's
   `workbench.layoutStyle`. Both preferences use the same profile settings
   resource; changing either one updates its own window without changing
   the other window's layout. Sessions sizes, sidebar visibility, and auxiliary visibility remain
   in Sessions-owned layout storage.
   The account menu uses the shared context menu service. Its Settings action
   opens the Sessions settings page, which uses the shared setting widgets and
   configuration service. Its Return to Workbench action returns to the sibling
   Workbench window or page. Sessions configuration keys are registered for parsing
   and persistence, while the Sessions page owns their visible setting metadata;
   the regular Workbench Settings page lists only Workbench settings.
5. The window Sessions service initializes the catalog. If none is
   active, the Workbench opens one untitled Session shared by Chat and Code. Each draft becomes
   durable only when the first message is sent.
   After the model catalog loads, an untitled Chat uses `chat.defaultModel`
   when it names an available model, then the user's last manual model choice.
   `auto` selects the App Server's default. A manual choice, including Auto,
   stays with that Chat; existing Threads keep their own model. The last manual
   choice is stored in the TypeScript UI profile state, while
   `chat.defaultModel` is a registered setting.
6. `SessionsChatView` reconciles every visible selection with a retained
   `ChatWidget` leaf in an internal, resizable `Grid`. Focus projects the leaf
   back to the active selection; closing a leaf does not archive its durable
   Session, and draft materialization preserves the leaf in place.
   The product composition owns the single view-service subscription and
   pushes the window's `(visible, active)` into the passive `SessionsPart`.

After `session/catalog/subscribe`, App Server sends `session/changed` and
`session/deleted` to that connection as catalog invalidations. The provider
reads the affected Session through `session/catalog/read`, which reads only its
indexed SQLite catalog rows. The backend marks Agent tree changes in the
notification; management loads full Session details when opened or when that
tree changes. It never compares a Session
sequence because no such sequence exists.
Durable sequence and gap handling belong to the Thread-backed Chat runtime and
`session/thread/update`.

`session.ts` is the frontend Session product boundary and re-exports the shared
Chat identity and model-reference types. Transport DTO mapping stays private to
the App Server provider. Sessions views consume `ISessionsManagementService`
and frontend-owned domain types; Workbench Chat presentation consumes its model
through a view contract and never imports the Sessions product layer.

An untitled Session captures the frontend Workspace when it opens. A single
folder supplies its execution target; a multi-root Workspace asks the user to
choose a folder when the draft becomes durable. An empty Workspace sends no
target. `session/create` carries `executionTarget` (local or SSH), never the
editor Workspace. App Server stores the execution target with the root Thread
and Session catalog. Existing Sessions keep their own target when another
Workbench hands off a chat. Local targets select a directory runtime; SSH
targets select the configured remote App Server. The frontend workspace summary
displays the stored root and does not grant access.

## Failure and lifecycle semantics

- The renderer never creates a durable Session merely because the window or a
  draft opens.
- A catalog load failure still permits a window-local draft; the first send
  reports any backend failure when durable Session materialization is needed.
- Session and Thread mutations remain App Server-owned; management routes
  operations to the provider; the window Sessions service owns only local
  visibility, active selection, focus, and navigation history.
- Each runtime, Part, retained Chat pane, App Server event subscription, and
  interaction service is disposed with the Sessions window.
- An Electron process has one Sessions window. Opening it from another
  Workbench focuses the existing window and updates its workspace context
  before handing off a chat. Its profile App Server connection remains open;
  Session requests route to their stored local or SSH roots. Closing a Workbench
  leaves the Sessions window open with its most recently selected workspace.
- Returning to Workbench closes the Electron Sessions window and focuses or
  reopens the same workspace, or navigates the browser page to its sibling
  Workbench entry.
- Academic currently has no dedicated Sessions renderer or profile.

## Tests and modification impact

- `test/browser/sessions-layout.test.ts` protects fixed topology, required
  Parts, docked Details geometry, and independent editor/detail visibility.
- `contrib/layout/test/browser/desktopLayoutController.test.ts` covers common session editor and panel state, restoration ordering, draft materialization and shutdown.
- `contrib/changes/test/browser/sessionChangesEditor.test.ts` verifies that hidden Changes editors ignore late results and reload content when shown.
- `test/browser/sessionFileService.test.ts` protects Session directory routing across
  selection changes, directory moves, and archive. `changesView.test.ts` covers stale
  responses, keyboard Diff opening, combined review, and truncated content errors.
- `test/browser/sessions-view-service.test.ts` protects selection ownership,
  multi-session visibility, history, stale references, close behavior, and
  draft materialization.
- `test/browser/sessions-part.test.ts` verifies the Sessions-owned primary Part
  passively renders multiple full Chat surfaces and reports focus/close intent.
- `test/browser/chatViewPane.test.ts` and `chatViewPane.startup.test.ts`
  protect the Session-backed regular Workbench Chat and its Agent Sessions list.
- `test/browser/workbenchSessions.contribution.test.ts` verifies the regular
  Workbench's separate Sessions service, Chat navigation, and Turn review registrations.
- `test/browser/sessions-list.test.ts` verifies that list refresh retains buttons,
  focus, and click behavior for unchanged Sessions.
- `test/browser/sessionsAccountMenu.test.ts` verifies account menu actions and
  focus state. The Sessions window smoke test checks that its Settings action
  opens the Sessions page and that its setting controls can be used.
- `services/sessions/test/browser/sessionsManagementService.test.ts` protects
  catalog refresh, provider invalidation, drafts, and operations without
  inventing Session sequence state.
- `test/browser/workspaceSelection.test.ts` protects the frontend mapping from
  empty, single-folder, and multi-root Workspaces to execution targets.
- `test/smoke/areas/sessions/sessions-window.spec.ts` verifies the dedicated
  Electron window, all six Parts, Activity Bar actions, list search, multiple Grid leaves, close, return flow,
  and system-wide shortcut registration and release.
- `test/smoke/areas/sessions/sessions-code.spec.ts` verifies Files/Changes in Web and
  Electron, all four Editor/Details states, shared session Panel commands, protected managed tabs, file save through the real backend, and state restoration across layout changes and reload.
- `platform/windows/test/electron-main/` verifies reuse,
  close and reopen ordering, resource release, initialization failure, and IPC commands.
- `workbench/contrib/keybindings/test/electron-browser/` verifies shortcut
  selection; `platform/globalKeybindings/test/electron-main/` verifies
  active-window routing, conflict reporting, and release.

Changes to topology belong in `browser/layoutPolicy.ts`; changes to window selection
belong in `services/sessions/browser/sessionsService.ts`; changes to provider
adaptation and Session catalog operations belong in `services/sessions/`. Adding a second layout or
Session model inside a Part would be architectural drift.

## Current limitations and staged evolution

The Sessions Part currently arranges visible Session leaves in one horizontal
Grid row. Two-dimensional placement persistence, provider grouping,
search/filtering, archived history, and cross-window view-state persistence are
future work. They should extend the Sessions view/layout owners without moving
product policy into base modules or the regular Workbench layout.
