# Desktop Layout Scenarios

> **Specification change gate:** A bug fix that restores an existing scenario belongs in a regression test, not this document. Update it only when the intended state or transition matrix changes.

The Agents window uses retained Workbench Parts. Code's document area, tools and conversation information have independent presentation lifetimes. Session state and working-set restoration remain governed by [LAYOUT_CONTROLLER.md](LAYOUT_CONTROLLER.md).

## Code composition

The default layout is Sidebar | Conversation | optional Editor | tool column. The tool column contains Terminal above Files. Its shared width and vertical split use the Workbench Grid. A single visible tool fills the column; closing both releases its space. Card headers can move Terminal, Files and session information to any edge of another card, conversation or editor; Grid sashes resize the resulting tree. Explicit panel positions continue to support all four edges. Product-editor pages keep their independent Auxiliary Bar properties.

| Surface                   | Owner                                                 | Visibility behavior                                                                                                                                  |
| ------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document tabs and content | EditorPart                                            | Opening a document reveals the editor; closing its last document hides only this Part.                                                               |
| Terminal                  | PanelPart and terminal service                        | The toolbar and close action hide the view without disposing terminal sessions. Terminal-tab close retains the terminal service's process semantics. |
| Files / Changes           | AuxiliaryBarPart and registered view containers       | Explicit opens select the container. Document activation and editor close do not hide it.                                                            |
| Environment / Context     | SessionInfoRail mounted in a Sessions-owned Grid leaf | Reads the active Code chat and workspace services. The toolbar independently shows or hides its retained card.                                       |

## Controls and transitions

Toolbar selected states derive from their owning Part/container or information rail. Terminal uses the registered terminal-session icon. Files can be shown with no document tabs. The existing combined side-pane command remains available through menus and the command palette for compatibility.

| Action                                       | Result                                                                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Toggle Terminal                              | Show/focus the terminal or hide its panel; Files and documents remain visible as chosen.                                                                                              |
| Toggle Files                                 | Select Files, or hide it when already visible; Terminal and editor remain as chosen.                                                                                                  |
| Open a file                                  | Reveal its editor through IEditorService; retain Files and Terminal.                                                                                                                  |
| Hide editor / close last document            | Keep the independently visible tools.                                                                                                                                                 |
| Resize tool sashes                           | Update existing Grid geometry; retain sizes while hidden.                                                                                                                             |
| Expand / restore any card                    | Temporarily cover conversation/editor/other cards; restore the retained tree and split sizes.                                                                                         |
| Change panel position or product composition | Rebuild Grid placement using the same Part instances, preserving focus and live content.                                                                                              |
| Toggle session information                   | Show/hide the information card without changing other cards.                                                                                                                          |
| Drag card header                             | Preview an edge insertion; drop to rearrange the Grid. Escape cancels without changing geometry. The Arrange menu provides keyboard move/resize alternatives.                         |
| Open card in a new window                    | Move the retained content into a native auxiliary window; keep its main-window slot. Return or window close reattaches that content without recreating its model or terminal process. |
| Collapse Environment / Context               | Retain section preference; Context's available percentage remains in its summary.                                                                                                     |

Environment shows the selected execution directory and available repository reference. Context uses the existing input-budget estimate; unavailable usage is an explicit empty state. Neither surface invents backend data or creates another business-state owner.

## Session lifecycle (session lifecycle)

Existing Sessions share an Editor/Details visibility profile. New Sessions do not own lifecycle visibility state; their one-time entry rule hides redundant Editor content only when Empty Files is the sole input. Submitting preserves the current composition and updates the Existing profile.

### Quick chats / no workspace

Workspace selection in a draft changes content, not layout. Switching between a workspace and No workspace preserves Editor and Auxiliary Bar visibility and their sizes, including explicit opens or closes made between selections. A visible Auxiliary Bar shows the Files empty view for No workspace. The draft strategy does not save or restore a separate composition for these transitions, and normal Editor minimum-width constraints remain unchanged.

Quick Chats with saved editors share overall side-pane visibility with Existing Sessions, mapping a visible profile to Editor-only and keeping a hidden profile hidden. Opening a first editor and visibility changes made in an editor-bearing Quick Chat update the shared profile before the chat's first switch. Restoring an editorless Quick Chat on reload preserves the workbench-restored composition. If a saved Quick Chat restores without editors, the side pane hides transiently without overwriting the shared profile.

### Multiple visible sessions

Visibility restoration is reveal-only while multiple sessions are visible. Focusing a workspace session reveals the parts enabled by its matching profile, while focusing a quick chat or another session without side-pane content does not hide Editor. Collapsing back to one Quick Chat keeps Editor visible; collapsing to a workspace session restores that session type's complete shared profile. Tool visibility stays independent of the active document.

---

## Validation and implementation

Layout tests cover independent tools, all panel positions, maximization, hidden-size restoration, product-mode transitions and focus retention. Controller tests cover working sets and explicit visibility. Desktop scenarios exercise toolbar actions, real shell retention, file opening, card drag/resize, expand/restore, native window return, keyboard controls and localization through Ash itself.

DesktopWorkbenchLayout owns topology, geometry, header dragging and layout accessibility help. DesktopLayoutController owns session working sets and document operations. DesktopDetailPanelCoordinator opens explicit tool containers. SessionsPart owns the Code conversation wrapper and information rail; DesktopWorkbenchLayout mounts the active rail and persists its window-level visibility with the view arrangement. The editor contribution owns Files header commands, menu registration and layout context; DesktopMainEditorPart identifies its live group headers. PanelPart and the Changes and information Views own their title toolbars. DesktopWorkbenchLayout retains each detached Grid slot and owns its AuxiliaryView; that host moves the original content into one auxiliary document and returns it before disposing the window. It does not copy content models or own Grid state. The profile stores the validated normal Code tree in sessions.code.cardLayout; expanded and detached geometry never replaces it. Product compositions retain their separate layout. Lower Workbench layers do not import Sessions.
