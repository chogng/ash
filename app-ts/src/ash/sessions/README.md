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
| Layout | `browser/layoutPolicy.ts` | owns Sessions topology, geometry, Activity Bar position, optional auxiliary visibility, persisted sizes, and Modern/Flat spacing |
| Appearance | `common/configuration.ts` and `contrib/modernUI/browser/` | own the independent Sessions layout, Activity Bar position, and size preferences |
| Accounts and settings | `contrib/accounts/browser/` and `contrib/preferences/browser/` | the account icon opens a Sessions-owned menu with Settings and Return to Workbench; Settings opens a Sessions-owned page that reuses the Workbench setting widgets |
| Window Sessions state | `services/sessions/browser/sessionsService.ts` | owns active/visible selections, focus, and Back/Forward history |
| Frontend Session model | `services/sessions/common/session.ts` | owns `ISession`, `IChat`, workspace summary, and untitled identity types |
| Shared Chat contract | `workbench/services/chat/common/chatService.ts` | owns Thread and Turn operations plus shared Session/Thread IDs, model references, and approval modes used by both renderers |
| Provider and management | `contrib/providers/appServer/`, `services/sessions/common/sessionsManagement.ts`, and `services/sessions/browser/sessionsManagementService.ts` | the App Server provider adapts transport data; management owns catalog, drafts, and operations |
| Regular Workbench Chat | `browser/workbenchSessions.contribution.ts`, `browser/chatViewPane.ts`, and `browser/chatWidgetModel.ts` | registers the Session-backed Chat view and actions; one model owns selection, draft materialization, and Thread subscriptions for each shared `ChatWidget` |
| Main conversation | `browser/parts/sessionsChatView.ts` | renders visible durable and untitled Sessions as retained full `ChatWidget` Grid leaves |
| Turn review | `browser/turnMultiDiffSource.ts` and `browser/workbenchSessions.contribution.ts` | compose Turn changes and register their source resolver and commit action with `workbench/contrib/multiDiffEditor/browser/multiDiffSourceResolverService.ts` |
| Parts | `browser/parts/` | owns product chrome, window navigation, list, primary surface, and typed active context |
| Session chat commands | `browser/actions/sessionsChatActions.ts` | maps the reused ChatWidget New Chat and History commands to the Sessions window's draft and active-chat selection |
| Open Agents Window | `code/browser/workbench/modes/code.ts`, `workbench/contrib/chat/electron-browser/`, `contrib/openAgentsWindow/electron-browser/`, and `workbench/browser/parts/titlebar/` | the Code browser mode owns page navigation; the Chat desktop contribution owns the titlebar action, hover label, and window command; the Sessions desktop contribution owns system-wide shortcut synchronization; the Workbench titlebar owns the shared mark and motion. Shared shortcut selection lives in `workbench/contrib/keybindings/`, while `platform/globalKeybindings/` owns operating-system registrations |

The dedicated Sessions renderer reuses Workbench Chat presentation, editor, and
service contracts. Workbench production code does not import Sessions modules;
the Code and Academic mode entries load the Sessions contribution that registers
their Session-backed Chat view and actions. The shared `ChatWidget` renders a
model supplied by Sessions and does not create or select Sessions itself.

## Execution path

1. The Code browser or Electron entry creates one Sessions `Workbench`.
2. `browser/workbench.ts` creates one App Server Session provider, one
   `ISessionsManagementService`, one window `ISessionsService`, and one
   `ChatService`, then registers their frontend contracts in a window-local
   `ServiceContainer`.
3. The Sessions `Workbench` creates `BrowserLayoutService` and the shared
   `WorkbenchInteractionServices`, so Chat uses the same commands, context
   keys, menus, keybindings, overlays, quick input, settings, and hover
   mechanisms as the regular Workbench.
   Sessions creates the same `WorkbenchThemeService` as the regular Workbench
   against its own document. On desktop, both renderers read the shared
   `workbench.colorTheme` setting, so changes apply to both windows.
   `WorkbenchWindow` registers the renderer window and its document styles;
   The renderer lifecycle service joins storage flush before disposal.
4. `SessionsWorkbenchLayout` deserializes the fixed Part grid. Titlebar,
   activitybar, sidebar, and sessions Parts are required; the auxiliary Part can be toggled,
   and Activity Bar visibility follows `sessions.activityBar.location`.
   The Activity Bar selects Chat and opens the account menu; Collaboration and Mobile devices
   are visible but unavailable until those views have product data. Its right-click menu moves the
   controls to the sidebar top or bottom, hides them, or selects the side rail size through
   `sessions.activityBar.compact`. The titlebar owns new-session,
   history, and details controls.
   Its spacing follows `sessions.layoutStyle`, independently of the IDE's
   `workbench.layoutStyle`. Both preferences use the same profile settings
   resource; changing either one updates its own window without changing
   the other window's layout. Sessions sizes and auxiliary visibility remain
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

The Session workspace is a display summary derived from Environment, `cwd`,
and dirs. It does not grant access and is not the editor window Workspace from
`platform/workspace`.

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
- Closing an Electron Workbench window leaves its Sessions window open. The
  Sessions window retains its own workspace context and connection until it closes.
- Returning to Workbench closes the Electron Sessions window and focuses or
  reopens the same workspace, or navigates the browser page to its sibling
  Workbench entry.
- Academic currently has no dedicated Sessions renderer or profile.

## Tests and modification impact

- `test/browser/sessions-layout.test.ts` protects fixed topology, required
  Parts, and optional auxiliary visibility.
- `test/browser/sessions-view-service.test.ts` protects selection ownership,
  multi-session visibility, history, stale references, close behavior, and
  draft materialization.
- `test/browser/sessions-part.test.ts` verifies the Sessions-owned primary Part
  passively renders multiple full Chat surfaces and reports focus/close intent.
- `test/browser/chatViewPane.test.ts`, `chatViewPane.startup.test.ts`, and
  `sessionInspector.test.ts` protect the Session-backed regular Workbench Chat.
- `test/browser/workbenchSessions.contribution.test.ts` verifies service
  registration and Turn review source and commit actions.
- `test/browser/sessions-list.test.ts` verifies that list refresh retains buttons,
  focus, and click behavior for unchanged Sessions.
- `test/browser/sessionsAccountMenu.test.ts` verifies account menu actions and
  focus state. The Sessions window smoke test checks that its Settings action
  opens the Sessions page and that its setting controls can be used.
- `services/sessions/test/browser/sessionsManagementService.test.ts` protects
  catalog refresh, provider invalidation, drafts, and operations without
  inventing Session sequence state.
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
