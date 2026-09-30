# Code Sessions

`sessions/` owns Ash Code's dedicated agent Workbench beside the regular
`workbench/`. Its product and build boundary is canonical in
[`docs/workbench-modes.md`](../../../../docs/workbench-modes.md); this README
is canonical for the renderer implementation and extension points.

## Ownership

| Area | Owner | Current implementation |
| --- | --- | --- |
| Window host | `browser/web.main.ts`, `sessions.desktop.main.ts`, and `electron-browser/sessions.main.ts` | start the browser or Electron Sessions renderer and register desktop actions |
| Desktop window host | `platform/windows/electron-main/windowImpl.ts` and `windowsMainService.ts` | the first owns each Electron window and its resources; the second owns live Workbench and Sessions windows; `code/electron-main/app.ts` supplies Sessions workspace context and connections |
| Main-process close | `platform/lifecycle/electron-main/lifecycleMainService.ts` | waits for either renderer to finish shutdown before closing its window |
| Workbench window selection | `platform/windows/electron-main/windowsFinder.ts` and `code/electron-main/workbenchWindowRegistry.ts` | match folder or workspace files to live windows, reuse a matching Workbench, and keep active-window order; Sessions owns the return action and its IPC contract |
| Browser window navigation | `code/browser/workbench/modes/code.ts` and `sessions/browser/web.main.ts` | navigate to their sibling renderer page; the Sessions profile validates its return path |
| Browser renderer lifecycle | `workbench/services/lifecycle/browser/lifecycleService.ts` | joins shutdown work when the browser page closes |
| Electron renderer close | `workbench/services/lifecycle/electron-browser/lifecycleService.ts` | checks shutdown vetoes and joins save work before either Electron window closes |
| Code profile | `code/common/codeSessionsProfile.ts` | defines the Code window identity and page route used by both browser and Electron entries |
| Product composition | `browser/workbench.ts` | uses shared window identity and lifecycle services; owns the fixed titlebar/activitybar/sidebar/sessions/auxiliarybar Part set |
| Layout | `browser/layoutPolicy.ts` | owns Sessions topology, geometry, Activity Bar position, sidebar and auxiliary visibility, and persisted sizes |
| Appearance | `common/configuration.ts` and `contrib/modernUI/browser/` | own the independent Sessions layout, Activity Bar position, and size preferences |
| Accounts and settings | `contrib/accounts/browser/` and `contrib/preferences/browser/` | the account icon opens a Sessions-owned menu with Settings and Return to Workbench; Settings opens a Sessions-owned page that reuses the Workbench setting widgets |
| Window Sessions state | `services/sessions/browser/sessionsService.ts` | owns active/visible selections, focus, and Back/Forward history |
| Frontend Session model | `services/sessions/common/session.ts` | owns `ISession`, `IChat`, workspace summary, and untitled identity types |
| Shared Chat contract | `workbench/services/chat/common/chatService.ts` | owns Thread and Turn operations plus shared Session/Thread IDs, model references, and approval modes used by both renderers |
| Provider and management | `contrib/providers/appServer/browser/workbenchSessionsService.contribution.ts`, `services/sessions/common/sessionsManagement.ts`, and `services/sessions/browser/sessionsManagementService.ts` | the App Server provider adapts transport data; management owns catalog, drafts, and operations; the contribution registers and starts it in the regular Workbench |
| Regular Workbench Chat | `browser/workbenchChat.contribution.ts`, `browser/chatViewPane.ts`, and `browser/chatWidgetModel.ts` | registers the Session-backed Chat view, actions, and navigation service; one model owns selection, draft materialization, and Thread subscriptions for each shared `ChatWidget` |
| Main conversation | `browser/parts/sessionsChatView.ts` | renders visible durable and untitled Sessions as retained full `ChatWidget` Grid leaves |
| Sessions composer | `contrib/chat/browser/newChatInput.ts`, `newChatContextAttachments.ts`, and `media/chatInput.css` | owns the welcome layout, embedded-editor sizing, file acquisition, paste/drop entry points, and per-composer permission menu; shared input operations and attachment state remain in Workbench |
| Composer persistence | `contrib/chat/common/newChatDraftState.ts` | owns workspace-scoped serialized drafts; new sessions restore the most recently visible draft, while durable Threads use separate keys |
| Welcome tips | `workbench/contrib/chat/browser/chatTipService.ts` and `widget/input/chatInputTipPresenter.ts` | the service owns profile-scoped dismissal; the presenter renders only while the Sessions composer is empty and ready, and yields to approval or error state |
| Turn review | `browser/turnMultiDiffSource.ts` and `browser/turnMultiDiffSource.contribution.ts` | compose Turn changes and register their source resolver and commit action with `workbench/contrib/multiDiffEditor/browser/multiDiffSourceResolverService.ts` |
| Parts | `browser/parts/` | owns product chrome, window navigation, list, primary surface, and typed active context |
| Activity Bar | `browser/parts/activitybar/` | owns Sessions page navigation, account entry, DOM, and presentation; reuses shared Parts, controls, configuration, and menu services without importing Workbench Activity Bar styles |
| Application menu and titlebar actions | `browser/menus.ts`, `browser/parts/menubar.contribution.ts`, and `browser/layoutActions.ts` | Sessions owns its menu root, File menu, and layout action menu; common sections are explicitly shared. The Workbench BrowserMenubarControl owns menu interaction; the layout and Sessions service own sidebar visibility and history |
| Session chat commands | `browser/actions/sessionsChatActions.ts` | maps the reused ChatWidget New Chat and History commands to the Sessions window's draft and active-chat selection |
| Open Agents Window | `code/browser/workbench/modes/code.ts`, `workbench/contrib/chat/electron-browser/`, `contrib/openAgentsWindow/electron-browser/`, and `workbench/browser/parts/titlebar/` | the Code browser mode owns page navigation; the Chat desktop contribution owns the titlebar action, hover label, and window command; the Sessions desktop contribution owns system-wide shortcut synchronization; the Workbench titlebar owns the shared mark and motion. Shared shortcut selection lives in `workbench/contrib/keybindings/`, while `platform/globalKeybindings/` owns operating-system registrations |

The dedicated Sessions renderer reuses Workbench Chat presentation, editor, and
service contracts. Workbench production code does not import Sessions modules;
the Code and Academic mode entries load the Sessions contribution that registers
their Session-backed Chat view and actions. The shared `ChatWidget` renders a
model supplied by Sessions and does not create or select Sessions itself.
The dedicated window supplies `NewChatInputWidget` through the shared widget's
input factory. Sessions selects its embedded `CodeEditorWidget` adapter per
composer; it does not change the Workbench editor registry. Its CSS styles only
its own root and configures the shared input through component properties.
Sessions-only input behavior and appearance stay in this contribution.

The shared `ChatAttachmentModel` owns each composer's attachment collection.
Sessions file acquisition resolves UTF-8 text or supported image data before
adding it. `ChatService` converts resolved images to image input items and omits
empty text when sending attachments alone. Approval choice remains in the Chat
model and is applied to a new Turn through the existing backend contract.
Changing it does not change the approval mode of a running Turn.

Unsent composer content is window/workspace UI state, separate from the Session
catalog's untitled identities. The first new composer in a window claims the
saved new-session draft; later new composers start empty. Once materialized,
the new-session storage entry is removed. Thread changes save and restore the
corresponding draft, and renderer shutdown joins pending attachment resolution
before flushing storage.

## Execution path

1. The Code browser or Electron entry creates one Sessions `Workbench`.
2. `browser/workbench.ts` creates one App Server Session provider, one
   `ISessionsManagementService`, one window `ISessionsService`, and one
   `ChatService`, then registers their frontend contracts in a window-local
   `ServiceContainer`.
3. The Sessions `Workbench` creates `BrowserLayoutService` and registers
   commands, context keys, menus, keybindings, overlays, quick input, settings,
   and hover services for its own window, using the same service implementations
   as the regular Workbench.
   Sessions creates the same `WorkbenchThemeService` as the regular Workbench
   against its own document. On desktop, both renderers read the shared
   `workbench.colorTheme` setting, so changes apply to both windows.
   `WorkbenchWindow` registers the renderer window and its document styles;
   The renderer lifecycle service joins storage flush before disposal.
4. `SessionsWorkbenchLayout` deserializes the fixed Part grid. Titlebar,
   activitybar, sidebar, and sessions Parts are registered; the sidebar and auxiliary Parts can be toggled,
   and Activity Bar visibility follows `sessions.activityBar.location`.
   The Activity Bar selects Chat, Collaboration, Library, and Code; Collaboration and Library currently show empty pages.
   Mobile devices remains unavailable. Its right-click menu moves the
   controls to the sidebar top or bottom, hides them, or selects the side rail size through
   `sessions.activityBar.compact`. The Sessions titlebar composes the shared BrowserMenubarControl with Sessions menu IDs and visual tokens. Layout actions derive menu context keys from the layout and window Sessions service; the titlebar keeps no separate sidebar or history state. Code shows an empty page in the primary Part; the sidebar owns the new-session control.
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
   active, the Workbench opens a window-local untitled Session; it becomes
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
   pushes `(visible, active)` into the passive `SessionsPart`.

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
  Parts, and sidebar and auxiliary visibility.
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
  Electron window, all five Parts, Activity Bar actions, list search, details visibility, multiple Grid leaves, close, return flow,
  and system-wide shortcut registration and release.
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
