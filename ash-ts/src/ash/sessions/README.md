# Code Sessions

`sessions/` owns Ash Code's dedicated agent Workbench beside the regular
`workbench/`. Its product and build boundary is canonical in
[`docs/workbench-modes.md`](../../../../docs/workbench-modes.md); this README
is canonical for the renderer implementation and extension points.

## Ownership

| Area | Owner | Current implementation |
| --- | --- | --- |
| Window host | `browser/sessionsWorkbench.ts` | validates the Code profile, binds theme tokens, and creates one Sessions runtime |
| Product composition | `browser/code/codeSessionsWorkbench.ts` | composes the fixed titlebar/sidebar/sessions/auxiliarybar Part set |
| Layout | `browser/layout/` and `services/layout/` | owns Sessions-only topology, geometry, optional auxiliary visibility, and persisted sizes |
| Window Sessions state | `services/view/` | owns active/visible selections, focus, and Back/Forward history |
| Frontend Session model | `services/sessions/common/session.ts` | owns `ISession`, `IChat`, workspace summary, and untitled identity types |
| Provider and management | `services/sessions/` | provider adapts App Server DTOs; management owns catalog, drafts, and operations |
| Main conversation | `browser/common/sessionsChatView.ts` | renders visible durable and untitled Sessions as retained full `ChatPane` Grid leaves |
| Parts | `browser/parts/` | owns product chrome, list, primary surface, and typed active context |

The canonical Session domain and management services are independent of
Workbench contributions. Workbench Chat may consume those frontend contracts,
while the dedicated Sessions renderer may reuse backend-neutral Workbench
mechanisms and Chat contributions. Regular Workbench layout/runtime code must
not import Sessions product UI or add Sessions-specific layout branches.

## Execution path

1. The Code browser or Electron entry calls `startSessionsWorkbench`.
2. `SessionsRuntime` creates one App Server Session provider, one
   `ISessionsManagementService`, one window `ISessionsService`, and one
   `ChatService`, then registers their frontend
   contracts in a window-local `ServiceCollection`.
3. `CodeSessionsWorkbench` creates `BrowserLayoutService` and the shared
   `WorkbenchInteractionServices`, so Chat uses the same commands, context
   keys, menus, keybindings, overlays, quick input, settings, and hover
   mechanisms as the regular Workbench.
4. `SessionsWorkbenchLayout` deserializes the fixed Part grid. Titlebar,
   sidebar, and sessions Parts are required; only the auxiliary Part may hide.
5. The window Sessions service initializes the catalog. If none is
   active, the runtime opens a window-local untitled Session; it becomes
   durable only when the first message is sent.
6. `SessionsChatView` reconciles every visible selection with a retained
   `ChatPane` leaf in an internal, resizable `Grid`. Focus projects the leaf
   back to the active selection; closing a leaf does not archive its durable
   Session, and draft materialization preserves the leaf in place.
   The product composition owns the single view-service subscription and
   pushes `(visible, active)` into the passive `SessionsPart`.

After `session/catalog/subscribe`, App Server sends `session/changed` and
`session/deleted` to that connection as catalog invalidations. The provider
refreshes list metadata from `session/list`; management loads full Session
details only for an opened Session. It never compares a Session sequence because
no such sequence exists.
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
- `services/sessions/test/browser/sessionsManagementService.test.ts` protects
  catalog refresh, provider invalidation, drafts, and operations without
  inventing Session sequence state.
- `test/smoke/areas/sessions/sessions-window.spec.ts` verifies the dedicated
  Electron window, all four Parts, multiple Grid leaves, close, and return flow.

Changes to topology belong in `browser/layout/`; changes to window selection
belong in `services/view/`; changes to provider adaptation and Session catalog
operations belong in `services/sessions/`. Adding a second layout or
Session model inside a Part would be architectural drift.

## Current limitations and staged evolution

The Sessions Part currently arranges visible Session leaves in one horizontal
Grid row. Two-dimensional placement persistence, provider grouping,
search/filtering, archived history, and cross-window view-state persistence are
future work. They should extend the Sessions view/layout owners without moving
product policy into base modules or the regular Workbench layout.
