# Code Sessions

`sessions/` owns Ash Code's dedicated agent Workbench beside the regular
`workbench/`. Its product and build boundary is canonical in
[`docs/workbench-modes.md`](../../../../docs/workbench-modes.md); this README
is canonical for the renderer implementation and extension points.

## Ownership

| Area | Owner | Current implementation |
| --- | --- | --- |
| Window host | `browser/web.main.ts` and `electron-browser/electronSessions.ts` | start the browser or Electron Sessions renderer |
| Dedicated window host | `platform/windows/` | owns the parent-child window lifecycle, parent-only open IPC, child-only return IPC, and child resources; `code/electron-main/app.ts` supplies the Sessions entry and connections |
| Browser window navigation | `platform/windows/browser/dedicatedWindowNavigation.ts` | resolves and navigates between sibling renderer pages |
| Code profile | `code/common/codeSessionsProfile.ts` | defines the Code window identity and page route used by both browser and Electron entries |
| Product composition | `browser/workbench.ts` | uses shared window identity and lifecycle services; owns the fixed titlebar/sidebar/sessions/auxiliarybar Part set |
| Layout | `browser/layoutPolicy.ts` | owns Sessions topology, geometry, optional auxiliary visibility, and persisted sizes |
| Window Sessions state | `services/sessions/browser/sessionsService.ts` | owns active/visible selections, focus, and Back/Forward history |
| Frontend Session model | `services/sessions/common/session.ts` | owns `ISession`, `IChat`, workspace summary, and untitled identity types |
| Provider and management | `contrib/providers/appServer/`, `services/sessions/common/sessionsManagement.ts`, and `services/sessions/browser/sessionsManagementService.ts` | the App Server provider adapts transport data; management owns catalog, drafts, and operations |
| Main conversation | `browser/parts/sessionsChatView.ts` | renders visible durable and untitled Sessions as retained full `ChatPane` Grid leaves |
| Parts | `browser/parts/` | owns product chrome, list, primary surface, and typed active context |
| Session chat commands | `browser/actions/sessionsChatActions.ts` | maps the reused ChatPane New Chat and History commands to the Sessions window's draft and active-chat selection |
| Open Agents Window | `code/browser/workbench/modes/code.ts`, `workbench/contrib/chat/electron-browser/`, `contrib/openAgentsWindow/electron-browser/`, and `workbench/browser/parts/titlebar/` | the Code browser mode owns page navigation; the Chat desktop contribution owns the titlebar action, hover label, and window command; the Sessions desktop contribution owns system-wide shortcut synchronization; the Workbench titlebar owns the shared mark and motion. Shared shortcut selection lives in `workbench/contrib/keybindings/`, while `platform/globalKeybindings/` owns operating-system registrations |

The dedicated Sessions renderer may reuse backend-neutral Workbench mechanisms
and Chat contributions. Platform and regular Workbench code still import
Sessions contracts and implementations; those reverse dependencies remain a
separate ownership migration. Regular Workbench layout/runtime code must not
import Sessions product UI or add Sessions-specific layout branches.

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
   `BrowserLifecycleService` joins storage flush before disposal.
4. `SessionsWorkbenchLayout` deserializes the fixed Part grid. Titlebar,
   sidebar, and sessions Parts are required; only the auxiliary Part may hide.
5. The window Sessions service initializes the catalog. If none is
   active, the Workbench opens a window-local untitled Session; it becomes
   durable only when the first message is sent.
6. `SessionsChatView` reconciles every visible selection with a retained
   `ChatPane` leaf in an internal, resizable `Grid`. Focus projects the leaf
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

`session.ts` is the frontend product boundary. Transport DTO mapping
stays private to the App Server provider; Workbench Chat and the
dedicated Sessions renderer consume `ISessionsManagementService` plus the
frontend-owned domain types, never generated App Server DTOs.

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
- Returning to Workbench closes the Electron Sessions window or navigates the
  browser page to its sibling Workbench entry.
- Academic currently has no dedicated Sessions renderer or profile.

## Tests and modification impact

- `test/browser/sessions-layout.test.ts` protects fixed topology, required
  Parts, and optional auxiliary visibility.
- `test/browser/sessions-view-service.test.ts` protects selection ownership,
  multi-session visibility, history, stale references, close behavior, and
  draft materialization.
- `test/browser/sessions-part.test.ts` verifies the Sessions-owned primary Part
  passively renders multiple full Chat surfaces and reports focus/close intent.
- `test/browser/sessions-list.test.ts` verifies that list refresh retains buttons,
  focus, and click behavior for unchanged Sessions.
- `services/sessions/test/browser/sessionsManagementService.test.ts` protects
  catalog refresh, provider invalidation, drafts, and operations without
  inventing Session sequence state.
- `test/smoke/areas/sessions/sessions-window.spec.ts` verifies the dedicated
  Electron window, all four Parts, multiple Grid leaves, close, return flow,
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
