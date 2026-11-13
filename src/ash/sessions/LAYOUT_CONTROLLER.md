# Layout Controller — Per-Session Layout State

> **Specification change gate:** A bug fix that restores an existing rule belongs in a regression test, not this document. Update this specification only when the intended layout state machine or persistence contract changes.

This document specifies the intended controller boundaries and session-switch behavior.

BaseLayoutController owns per-session document working sets and panel view selection. DesktopLayoutController coordinates session document restoration and the desktop Editor/Details states. Feature contributions own entry commands; the Sessions entry service applies their container IDs and central content without branching on product names. Artifacts aggregates contributed creation tools, while Projects presents the durable project catalog with materials inside each project. Chat, Code and Collaboration keep the same selection, conversation views and input drafts.

SessionsPart permanently owns Agent conversation content and its grid. Projects and Artifacts use retained EditorPanes in the Sessions EditorPart product-page group. Applying a session working set excludes and preserves that group, including its live panes, workspaces and documents.

The last entry's owning command is stored at `sessions.layout.activeEntry` in workspace storage; entry content visibility preferences use `sessions.layout.entryVisibility` in profile storage. Sidebar visibility and width belong only to the Workbench layout and persist across entries; legacy per-entry sidebar preferences are discarded. Artifacts workspace selection remains at `sessions.artifacts.activeMode` and is interpreted by Artifacts. Project selection and browsing state remain with the feature's window-local service and never become layout entries. Existing activeMode, modeState and older page keys migrate once to the entry state.

Code tools use retained EditorParts with one tab group per tool in the active working set. Files navigation belongs to its tool. Changes, Browser and Terminal are ordinary editor inputs. Hiding a tool or switching entries retains its panes, terminal processes, browser pages and dirty working copies. Actual close and shutdown use the input-specific confirmation lifecycle.

Mobile presentation, separate desktop lifecycle strategy classes, and the controller-selection contribution below remain intended contracts. Current behavior tests live in `contrib/layout/test/browser/desktopLayoutController.test.ts`, `test/browser/sessions-layout.test.ts`, and `test/smoke/areas/sessions/sessions-code.spec.ts`.

| File                                                                                                | Responsibility                                                                  | Rules                                                                                                  |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `contrib/layout/browser/baseSessionLayoutController.ts` (`BaseLayoutController`)                    | Shared panel, editor working-set, persistence, and multi-session mechanics      | [baseSessionLayoutController.md](contrib/layout/browser/baseSessionLayoutController.md), `B1`–`B6`     |
| `contrib/layout/common/sessionEditorWorkingSet.ts`                                                  | Observable restoration state and retained editor registrations                  | Shared by the controller and features such as Canvas                                                   |
| `contrib/layout/browser/desktopLayoutController.ts` (`DesktopLayoutController`)                     | Non-phone Editor/Details composition and lifecycle strategies                   | [DESKTOP.md](DESKTOP.md)                                                                               |
| `services/layout/common/sessionsEntryService.ts` / `contrib/layout/browser/sessionsEntryService.ts` | Feature entry contract, shared host activation and entry visibility persistence | [LAYOUT.md](LAYOUT.md#activity-bar-entry-switching)                                                    |
| `contrib/layout/browser/mobileSessionLayoutController.ts` (`MobileLayoutController`)                | Phone adaptation without auxiliary-bar automation                               | [mobileSessionLayoutController.md](contrib/layout/browser/mobileSessionLayoutController.md), `M1`–`M2` |

Current non-phone Agents windows use `DesktopWorkbench`. The Sessions entry service creates the DesktopLayoutController; `sessions.layout.contribution.ts` registers the service and built-in Chat, Code and Collaboration commands. Workbench restores the saved entry through the owning command before declaring restoration complete. Phone presentation remains planned with MobileWorkbench and MobileLayoutController.

`DesktopLayoutController` extends `BaseLayoutController` and preserves retained product editors while restoring session document groups. Shared tab and detail mechanics live in coordinators. Feature contributions pass their entry descriptors to the Sessions entry service; they do not move resource browsing or workspace selection into the desktop controller. Editor-part construction must not acquire `ISessionsService`, because the Sessions service graph already depends on editor parts.

It is the detailed companion to the [layout-controller boundary](LAYOUT.md#layout-controller-boundary).

---

## 1. State ownership

The Agents window keeps a single active selection but lets the user move between many. `sessions.experimental.layoutScope` defaults to `session-shared`: each Session owns its document working set and panel view, with shared visibility. `chat-shared` scopes those documents and views to a Session/Thread pair while sharing Editor/Details visibility. `chat` additionally remembers Editor/Details visibility for that pair. BaseLayoutController remains the only owner of these maps and the restore queue. A newly selected scope adopts current documents until it has its own saved working set.

| State                          | Storage                             | Scope                                                          |
| ------------------------------ | ----------------------------------- | -------------------------------------------------------------- |
| Editor working set             | `sessions.singlePane.layoutState`   | Session or Session/Thread, by layout scope                     |
| Tool topology and dimensions   | Editor working-set group layout     | Same Session or Session/Thread owner as the editor working set |
| Entry content visibility       | `sessions.layout.entryVisibility`   | Profile, per entry                                             |
| Active entry's restore command | `sessions.layout.activeEntry`       | Workspace                                                      |
| Artifacts workspace selection  | `sessions.artifacts.activeMode`     | Workspace, owned by Artifacts                                  |
| Files navigation visibility    | `sessions.code.filesVisible`        | Profile; does not close its group or documents                 |
| Last open Code side pane       | `sessions.layout.sidePane.lastOpen` | Profile                                                        |
| Side-pane and panel visibility | Workbench part visibility           | Window; Editor/Details also restore per Chat in `chat` scope   |

Session changes restore document working sets without selecting another product mode. Shared scopes preserve visibility; `chat` restores the pair's saved Editor/Details visibility. A Code composition with only managed inputs initially shows Details-only; opening an ordinary document reveals its content. Persistence retains existing `session:<id>` keys and adds `chat:[sessionId,threadId]` entries with optional validated `partVisibility`. Draft materialization transfers all three maps to the durable scope key.

All state flows from the `activeSession` observable. The controller derives session and visibility state and reacts with observables; events remain notifications for part and editor changes rather than a second state model.

## 2. Session switches

Editor working-set application waits until the active workspace folders match the incoming session. Saves and restores are serialized so a later switch cannot be overwritten by an earlier asynchronous apply.

When more than one session is visible, per-session layout synchronization is suppressed because the shared workbench parts do not belong to one active session. Editor working sets remain persisted.

The controller suppresses editor auto-visibility while restoring a working set. After entry restoration, Workbench also holds a suppression lease while attaching retained tool editors. `DesktopWorkbenchLayout` counts these leases, including those held by Canvas. The restored workbench part visibility remains authoritative, so loading editors does not reveal a side pane the user had closed.

## 3. Desktop tools

DesktopWorkbenchLayout owns outer Workbench Parts. DesktopEditorArea arranges tool cards, and each EditorPart hosts its tool's tabs for the active working set. Tool visibility commands hide the retained tabs and panes while keeping their processes and pages alive. Restoring a legacy working set consolidates its tabs by tool.

DesktopLayoutController retains live group identities for session working sets. The base controller remains the single owner of serialized working-set state and restoration sequencing. Switching to an already retained set restores its group geometry and visibility without closing its panes; loading a cold set preserves other live groups and the product-page group. Entry changes hide Code groups while remembering which were already hidden. Default opens target the current set rather than inactive session groups.

DesktopMainEditorPart selects the group for its registered Files Details. The Files contribution owns the retained Explorer View and its attachment; the tree moves with that group, keeps its expansion and selection state, and reserves space beside the group’s document content. The shared group Header remains visible without creating an EditorInput; document tabs appear only when files are opened. Closing the last document retains the group's Details. AuxiliaryBarPart is reserved for independently contributed product properties.

SessionInfoRail reads the active Code chat model and workspace/SCM services. It remains part of the retained conversation presentation, with existing docked and floating behavior; it does not introduce a tool Grid or another conversation model.

## 4. Panel

Agent Window does not register a Panel view host. It creates neither a PanelPart nor a panel Grid leaf. Saved panel visibility is discarded, and Output channel/view reveal requests cannot enable it. Terminals use Editor Groups. The shared IDE retains its normal Panel host and diagnostic views.

The mobile controller retains the base per-session panel-visibility behavior described by `B1`.

## 5. Editor working sets

Editor working sets are always active, including when `workbench.editor.useModal` is configured, because browser editors still use the shared grid editor part.

On switch:

- the outgoing created session snapshots its open editors;
- the incoming session restores its saved working set, or an empty set after the initial load;
- retained Changes inputs follow the selected session without moving into another EditorPart;
- programmatic restoration does not implicitly change side-pane visibility.

The session-header Changes action and Add Tab actions are explicit opens, so they may reveal Editor content. Layout-driven managed-tab operations run under editor-auto-visibility suppression.

Closing or archiving a session removes its working set and panel-view state. Replacing an active draft with its committed session resource transfers applicable state before the first restore.

## 6. Persistence

`BaseLayoutController` persists session entries with `StorageTarget.MACHINE` in workspace storage. Session working sets and panel views use `sessions.singlePane.layoutState`. The layout service owns entry visibility and the restore command. It imports `sessions.layout.modeState` and `sessions.singlePane.sidePaneVisibility` once, then removes those old keys. Old active-mode, page and activity keys are read only for migration and removed after successful restoration; Artifacts interprets legacy Design entry restoration.

Persisted state is validated by its owner before use. Legacy page resources are removed from session working sets; feature-editor restoration belongs to the feature's command.

Window navigation geometry and part visibility are restored before the layout controller starts. Applying a Session's tool geometry preserves that navigation and the window's desired tool visibility.

The retired browser working set is attached to the Browser EditorPart before its legacy key is removed. Existing panel terminal instances move into TerminalEditor without creating new processes. The current writer persists editor working sets, Part membership, tool geometry and group geometry.

## 7. Key invariants

- Observables drive session-switch state.
- Only one controller manages the active presentation.
- Editor inputs open through `IEditorService`.
- Session working-set capture and application preserve the retained product-page group.
- Conversation focus inside Code does not change its explicit mode.
- Programmatic working-set operations suppress automatic editor visibility.
- Side-pane visibility is workbench-level in desktop mode.
- Legacy panel-view metadata is discarded; no panel view is restored.
- Multi-session presentation does not overwrite per-session state.
- Phone presentation never automates the Auxiliary Bar.

## Test ownership

- Shared rules: `contrib/layout/test/browser/baseSessionLayoutController.test.ts`
- Desktop controller transitions: `contrib/layout/test/browser/desktopLayoutController.test.ts`
- Desktop lifecycle strategies: `contrib/layout/test/browser/desktopStrategies.test.ts`
- Mobile rules: `contrib/layout/test/browser/mobileSessionLayoutController.test.ts`
