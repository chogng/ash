# Desktop Layout Scenarios

> **Specification change gate:** A bug fix that restores an existing scenario belongs in a regression test, not this document. Update it only when the intended state or transition matrix changes.

The Agents window uses retained Workbench Parts. Session state and working-set restoration remain governed by [LAYOUT_CONTROLLER.md](LAYOUT_CONTROLLER.md).

## Code composition

The window composes Sidebar, Conversation and one EditorPart. Files navigation belongs to an Editor Group beside its documents. Changes, Browser and Terminal are editor inputs in the same EditorPart. Groups own tab combinations, splits, dragging, resizing and maximization. Agent Window does not host Workbench Panel views, including Output and the legacy terminal panel. Product pages keep their independent Auxiliary Bar properties.

| Surface                   | Owner                                     | Visibility behavior                                                                                            |
| ------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Document tabs and content | EditorPart / Editor Group                 | Opening a document reveals its group. Closing a tab uses the existing working-copy lifecycle.                  |
| Terminal                  | TerminalEditor / terminal service         | Hiding its group retains the process. Closing the terminal tab keeps the terminal service's process semantics. |
| Files group Details       | DesktopMainEditorPart / FilesGroupDetails | A retained Explorer View follows its group. Hiding Details retains open documents and tree state.              |
| Changes and Browser       | Existing EditorInput / EditorPane         | Tool toggles retain their panes and browser pages. They share the document group Grid and working sets.        |
| Environment / Context     | SessionInfoRail                           | Reads the active Code chat and workspace services. Its conversation owns the retained rail.                    |

## Controls and transitions

Toolbar selected states derive from the owning editor group, navigation or information rail. Terminal uses the registered terminal-session icon. Files can be shown before a document is open. The existing combined side-pane command remains available through menus and the command palette for compatibility.

| Action                               | Result                                                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Toggle Terminal / Browser            | Hide retained tool-only groups, or select another tab in a mixed group. Reopening reuses the retained input and pane.                     |
| Toggle Files                         | Hide or restore the file editor groups and their attached navigation together, retaining documents and leaving other tool groups visible. |
| Toggle details                       | Show or hide the navigation attached to a file editor group.                                                                              |
| Open a file                          | Reveal its editor through IEditorService in the current session's groups.                                                                 |
| Hide editor / Show editor            | Hide or restore document content beside Files while retaining its navigation.                                                             |
| Drag a group title                   | Move the complete group to an edge, or combine its tabs with another group at the center.                                                 |
| Drag a tab                           | Move one editor or split at a group edge through the shared editor transfer lifecycle.                                                    |
| Alt+Shift+Arrow on a header action   | Move the group beside its spatial neighbor.                                                                                               |
| Resize group separators              | Update the editor Grid through pointer or keyboard input.                                                                                 |
| Maximize / restore a group           | Expand within EditorPart and restore the original geometry and hidden groups.                                                             |
| Switch Chat / Code or a product page | Retain group panes, unsaved documents, terminal processes and browser pages; restore Code geometry on return.                             |
| Change panel position                | No PanelPart or Grid leaf exists; legacy commands cannot create one.                                                                      |
| Toggle session information           | Show or hide the conversation's retained information rail.                                                                                |
| Collapse Environment / Context       | Retain section preference; Context's available percentage remains in its summary.                                                         |

Environment shows the selected execution directory and available repository reference. Context uses the existing input-budget estimate; unavailable usage is an explicit empty state. Neither surface invents backend data or creates another business-state owner.

## Session lifecycle

The layout controller captures the outgoing session's editor working set and reuses its live group identities when selected again. Other sessions' cached groups stay hidden and do not receive current-session file opens. Session identity materialization rekeys the existing binding. Removing a session releases its layout binding without discarding dirty documents or live processes.

Workspace selection changes Files content without replacing its Explorer View or group. No workspace displays an accessible empty message. A new draft follows the existing policy of adopting the current composition until it owns a saved working set. Multiple visible conversations continue to use SessionsPart's independent conversation grid.

Legacy Card trees are migration input only. Migration writes the owning editor working set before removing a consumed legacy entry. Unvisited session layouts remain pending migration. Browser models initialize before their old working set is imported into the same EditorPart; restored panel terminal instances move into TerminalEditor without creating new processes.

## Validation and implementation

Layout and editor tests cover group transfer, maximization, cached session restoration, visibility and focus. Desktop scenarios exercise real shell retention, browser page identity, unsaved documents, native browser drop targets, keyboard resizing and mode restoration through Ash itself.

DesktopWorkbenchLayout owns outer Workbench Parts. DesktopLayoutController owns session working sets and temporary entry visibility. DesktopMainEditorPart supplies session scope and group-local Files navigation; EditorPart owns the group Grid and shared drag lifecycle. Existing TerminalEditor and Browser editor services keep ownership of their live models. Lower Workbench layers do not import Sessions.
