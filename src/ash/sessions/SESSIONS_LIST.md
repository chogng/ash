# Sessions list

> **Specification change gate:** Do not update this document for row rendering, styling, actions, picker flows, or bug fixes. Update it only when placement precedence, state ownership, or a cross-surface list contract changes.

## Scope

The Sessions list is the primary navigation surface in the Agents Window. It aggregates provider-neutral sessions into a grouped, filterable tree and owns user presentation state such as pins, custom groups, ordering, and collapsed sections.

This specification defines stable placement and state-ownership rules. Row styling, labels, icons, action placement, animation, picker workflows, and implementation algorithms belong in code and focused tests.

## Ownership

| Concern                                       | Owner                                            |
| --------------------------------------------- | ------------------------------------------------ |
| Session catalog and lifecycle                 | `ISessionsManagementService`                     |
| Pins, manual row order, and automation filter | `ISessionsListModelService`                      |
| Sidebar collapse state                        | `WorkbenchObjectTree`, persisted by each sidebar |
| Custom groups and membership                  | `ISessionGroupsService`                          |
| Top-level group/workspace order               | `ISessionSectionOrderService`                    |
| Tree composition and presentation             | `SessionsView` and `SessionsList`                |

Chat and Code consume the same session selection and pins. Chat presents flat conversation rows in top-level custom groups and a remaining conversation section beside pinned conversations and project entries. Code lists project entries separately from Recents, which includes unpinned conversations across workspaces and projects. Explicit custom groups remain inside Recents. Each mode owns separate section expansion state. Project records and membership remain owned by `IProjectService`; the sidebar holds only a disposable projection.

The native Sessions list and ChatGPT history use the same row and section renderers. Each projects its own data and grouping into a separate tree instance and persists collapse state in its existing profile keys.

List-owned state is local presentation state. It is not synchronized back to a provider and must not mutate provider timestamps or metadata.

## Inputs

The list consumes sessions from `ISessionsManagementService`. Providers expose workspace, quick-chat, and archived state through provider-neutral fields. The Session catalog exposes durable automation creation provenance. The sidebar uses that metadata for its automation filter, including after the automation plan has been deleted.

Sessions created by automation runs are hidden by default, with an exception for the active session. Chat and Code share the automation visibility preference and per-session overrides. The reply-based mode lists an automation session after the first accepted user submission. Runs that continue an existing conversation leave its classification intact. Automations retains its own run history. Surfaces that need session-row presentation without sectioning use `SessionsFlatList`.

## Placement precedence

A session appears in exactly one primary section. Higher-precedence states win:

```text
Archived
    > Pinned
    > Project (Code)
    > Custom group
    > External (when dedicated sectioning is enabled)
    > Quick chat
    > Workspace or date group
```

- Archived sessions appear only in the final archived section.
- Pinned sessions appear in the pinned section, retaining their project and custom-group membership. Unpinning derives placement from that membership again.
- Chat project entries open the project page; unpinned conversations remain flat within their custom group or the conversation section.
- A valid custom-group membership places an unpinned, unarchived session in that group, including a quick chat.
- When dedicated external sectioning is enabled, remaining external sessions appear together before the archived section. Pinning and custom-group membership retain their precedence; disabling sectioning returns external sessions to the ordinary grouping rules without changing that presentation state.
- Remaining unpinned quick chats appear in the dedicated chats section.
- Remaining sessions follow the selected workspace or date grouping.
- A regular session created by another regular session is initially placed
  immediately after its creator. While it has neither custom-group membership
  nor an explicit ungrouped preference, it inherits the creator's custom group
  when one becomes available. Subsequent user grouping, ungrouping, and
  reordering are ordinary persisted list state.

The active session remains visible even when a filter would otherwise exclude it.

A caller can acquire a disposable reveal of a session row or its archive action for onboarding. The list temporarily includes that session despite filters and presentation caps, expands its section, and exposes the requested spotlight target. An archive-action reveal also keeps the action visible without hover or focus. Releasing the reveal restores normal filtering and action visibility without changing the user's saved filters.

## Grouping

### Sidebar grouping

The sidebar may group otherwise ungrouped conversations under Chats or Recents by project membership, repository, management status or execution environment. Pins and explicit group membership take precedence. Hiding comparison groups displays their attempts as ordinary conversations and preserves the saved comparison membership. Repository grouping reads metadata through the session's authorized host. Environment grouping uses the saved session execution authority and runtime workspace.

### Workspace grouping

User-created groups and workspace sections share a user-managed order below the fixed sections. Workspace capping may initially hide inactive workspaces; search and explicit user promotion reveal them.

### Date grouping

User-created groups remain a contiguous user-managed block. Ungrouped sessions follow in fixed date sections.

### Quick chats

Quick chats are identified through `ISession.isQuickChat`, not by checking for an absent workspace. They remain session rows; the list never exposes `IChat` objects as top-level rows.

### Archived sessions

Archiving removes custom-group membership. Restoring a session does not restore its former membership, except when undoing a bulk archive from the list: that operation restores the captured membership if the group still exists. User-facing archive terminology may vary, but the underlying archived state and placement rule do not.

## Durable user intent

Pin, group, and ordering state survives temporary provider-catalog removal. Providers may transiently publish incomplete catalogs while reconnecting or hydrating, so `onDidChangeSessions.removed` is not proof of deletion.

List-owned state is removed only when:

- the management service reports definitive deletion;
- archiving invalidates group membership;
- the user explicitly changes or removes the state.

Stale entries that match no current session are inert and may be compacted by their owning service.

## Sorting and filtering

Manual row order is scoped to the sidebar mode, section, and timestamp sort mode. It applies to durable session rows and leaves nested chats in provider order. Unordered rows follow their default list order. Custom section order is scoped to the sidebar mode and preserves fixed sections.

Filters compose across session type, status, archive/read state, and provider. The archived filter governs both archived sessions and archived nested chats; there is no per-session archive-visibility override. The agent host filter scopes to every provider the selected host entry covers, which is more than one when that entry groups several hosts and none while such a group is empty. The find widget matches session and section labels and bypasses presentation capping while a search is active.

## Drag and drop

The target determines which service handles the drop.

- sessions may reorder within valid sections;
- sessions may move into user-created groups;
- non-archived sessions may move into the pinned section;
- user groups and workspace sections may reorder where the grouping mode allows;
- dropping sessions on the Sessions grid opens them through `ISessionsService`.
- dropping a conversation on another composer on the same host attaches a transcript snapshot through that composer's context acquisition.

Archived and fixed sections are not reorder targets. Multi-selection preserves relative order.

## Reactive presentation

Rows derive title, status, workspace, changes, capabilities, and quick-chat identity from session observables. Renderers must support tree virtualization: reusing a row template for another session must not retain stale state, animations, hovers, or disposables.

Row renderers use tree-supported row classes and APIs rather than traversing tree-owned DOM structure.

Session facades may expose catalog-backed peer-chat identities, titles, and interactivity before detailed chat state is loaded. Rendering a virtualized peer-chat row requests provider-neutral chat hydration through `ISessionsManagementService`; collapsed and offscreen sessions therefore do not require eager per-session state loading.

## Persistence

List presentation state is profile-scoped user state. This includes grouping, sorting, filtering, section and nested-session collapse, pins, custom groups, manual sort keys, and section order. A nested session starts expanded, and the user's later collapse or expansion choice persists across list and window recreation. Storage keys are private implementation details; other components change list state through the owning service API.

## Change policy

Update this specification only when placement precedence, state ownership, or a cross-surface list invariant changes. Express concrete row behavior, menu enablement, picker flows, and regressions in focused tests instead.

## Related specifications

- [Sessions architecture](SESSIONS.md)
- [Layout](LAYOUT.md)
- [Mobile](MOBILE.md)
