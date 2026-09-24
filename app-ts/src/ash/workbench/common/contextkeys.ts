import { RawContextKey } from '../../platform/contextkey/common/contextkey.js';
import type { WorkbenchStateValue } from '../../platform/workspace/common/workspace.js';

/** Kind of workspace currently hosted by the window. */
export const WorkbenchStateContext = new RawContextKey<WorkbenchStateValue>('workbenchState', 'empty');

/** Number of root folders in the current workspace. */
export const WorkspaceFolderCountContext = new RawContextKey<number>('workspaceFolderCount', 0);

/** Whether any registered working copy has unsaved changes. */
export const DirtyWorkingCopiesContext = new RawContextKey<boolean>('dirtyWorkingCopies', false);

/** Whether the primary side bar is currently visible. */
export const SideBarVisibleContext = new RawContextKey<boolean>('sideBarVisible', true);

/** Identifier of the active primary side bar container. */
export const ActiveViewletContext = new RawContextKey<string>('activeViewlet', '');

/** Whether the auxiliary side bar is currently visible. */
export const AuxiliaryBarVisibleContext = new RawContextKey<boolean>('auxiliaryBarVisible', true);

/** Identifier of the active auxiliary bar container. */
export const ActiveAuxiliaryContext = new RawContextKey<string>('activeAuxiliary', '');

/** Whether the Workbench Agent Sidebar is currently visible. */
export const AgentSidebarVisibleContext = new RawContextKey<boolean>('agentSidebarVisible', false);

/** Identifier of the active Agent Sidebar container. */
export const ActiveAgentSidebarContext = new RawContextKey<string>('activeAgentSidebar', '');

/** Whether the bottom panel is currently visible. */
export const PanelVisibleContext = new RawContextKey<boolean>('panelVisible', true);

/** Whether the bottom panel currently occupies the central editor region. */
export const PanelMaximizedContext = new RawContextKey<boolean>('panelMaximized', false);

/** Identifier of the active bottom panel container. */
export const ActivePanelContext = new RawContextKey<string>('activePanel', '');

/** Whether the main editor area is currently visible. */
export const EditorAreaVisibleContext = new RawContextKey<boolean>('editorAreaVisible', true);

/** Identifier of the editor pane active in the current Workbench context. */
export const ActiveEditorContext = new RawContextKey<string>('activeEditor', '');

/** Whether the active editor has unsaved changes. */
export const ActiveEditorDirtyContext = new RawContextKey<boolean>('activeEditorIsDirty', false);

/** Whether the active editor is pinned instead of previewed. */
export const ActiveEditorPinnedContext = new RawContextKey<boolean>('activeEditorIsNotPreview', false);

/** Whether the active editor is first in its group. */
export const ActiveEditorFirstInGroupContext = new RawContextKey<boolean>('activeEditorIsFirstInGroup', false);

/** Whether the active editor is last in its group. */
export const ActiveEditorLastInGroupContext = new RawContextKey<boolean>('activeEditorIsLastInGroup', false);

/** Whether the active editor input is read-only. */
export const ActiveEditorReadonlyContext = new RawContextKey<boolean>('activeEditorIsReadonly', false);

/** Whether the active editor owns a working copy that can be reverted. */
export const ActiveEditorCanRevertContext = new RawContextKey<boolean>('activeEditorCanRevert', false);

/** Comma-separated editor pane identifiers that can open the active input. */
export const ActiveEditorAvailableEditorIdsContext = new RawContextKey<string>('activeEditorAvailableEditorIds', '');

/** Number of editors in the active editor group. */
export const EditorGroupEditorsCountContext = new RawContextKey<number>('groupEditorsCount', 0);

/** Whether the active editor group contains no editors. */
export const ActiveEditorGroupEmptyContext = new RawContextKey<boolean>('activeEditorGroupEmpty', false);

/** One-based index of the active editor group, or zero when unavailable. */
export const ActiveEditorGroupIndexContext = new RawContextKey<number>('activeEditorGroupIndex', 0);

/** Whether the active editor group is the last group. */
export const ActiveEditorGroupLastContext = new RawContextKey<boolean>('activeEditorGroupLast', false);

/** Whether more than one editor group is open. */
export const MultipleEditorGroupsContext = new RawContextKey<boolean>('multipleEditorGroups', false);

/** Whether any Workbench editor is open. */
export const EditorsVisibleContext = new RawContextKey<boolean>('editorIsOpen', false);

/** Whether the modal editor host is visible. */
export const EditorPartModalVisibleContext = new RawContextKey<boolean>('editorPartModalVisible', false);

/** Identifier of the view that currently owns keyboard focus. */
export const FocusedViewContext = new RawContextKey<string>('focusedView', '');

/** Full URI of the active editor resource. */
export const ResourceContext = new RawContextKey<string | undefined>('resource', undefined);

/** URI scheme of the active editor resource. */
export const ResourceSchemeContext = new RawContextKey<string | undefined>('resourceScheme', undefined);

/** File name of the active editor resource. */
export const ResourceFilenameContext = new RawContextKey<string | undefined>('resourceFilename', undefined);

/** Parent path of the active editor resource. */
export const ResourceDirnameContext = new RawContextKey<string | undefined>('resourceDirname', undefined);

/** Path of the active editor resource. */
export const ResourcePathContext = new RawContextKey<string | undefined>('resourcePath', undefined);

/** Language identifier resolved for the active editor resource. */
export const ResourceLanguageIdContext = new RawContextKey<string | undefined>('resourceLangId', undefined);

/** File extension of the active editor resource. */
export const ResourceExtensionContext = new RawContextKey<string | undefined>('resourceExtname', undefined);

/** Whether an active editor resource is present. */
export const ResourceSetContext = new RawContextKey<boolean | undefined>('resourceSet', undefined);

/** Returns the context key used to expose one view's visibility. */
export function getVisibleViewContextKey(viewId: string): string {
	if (!viewId.trim()) {
		throw new TypeError('View ID must not be empty');
	}
	return `view.${viewId}.visible`;
}
