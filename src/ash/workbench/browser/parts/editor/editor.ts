import type { IResourceEditorInput, IEditorPane } from '../../../common/editor.js';
import type { IDimension } from '../../../../base/browser/dom.js';
import type { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import type { EditorOpenOptions } from '../../../services/editor/common/editorService.js';
import type { EditorGroupId, EditorInstanceId } from '../../../services/editor/common/editorState.js';
import type { SerializedEditorViewState } from '../../../services/editor/common/editorWorkingSet.js';
import type { ISaveEditorsOptions } from '../../../services/editor/common/editorService.js';

/** Shared presentation marker for editor tabs connected to their pane. */
export const CONNECTED_EDITOR_TABS_CLASS = "ash-connected-editor-tabs";
export const CONNECTED_EDITOR_TABS_SELECTOR = `.${CONNECTED_EDITOR_TABS_CLASS}`;

/** Browser host capabilities used by editor parts, separate from command operations. */
export interface IEditorGroupView extends IEditorGroup {
	readonly domNode: HTMLElement;
	readonly activePane: IEditorPane | undefined;
	saveEditor(input: IResourceEditorInput, options?: ISaveEditorsOptions): Promise<IResourceEditorInput | undefined>;
	saveEditorViewState(input: IResourceEditorInput): SerializedEditorViewState | undefined;
	restoreEditorViewState(input: IResourceEditorInput, state: SerializedEditorViewState | undefined): boolean;
	openEditor(input: IResourceEditorInput, options?: EditorOpenOptions, instanceId?: EditorInstanceId): Promise<IEditorPane>;
	activateEditor(input: IResourceEditorInput): IEditorPane;
	confirmCloseEditor(input: IResourceEditorInput, closingGroups?: readonly EditorGroupId[]): Promise<boolean>;
	replaceEditor(input: IResourceEditorInput, replacement: IResourceEditorInput): Promise<void>;
	moveEditorTo(input: IResourceEditorInput, target: IEditorGroupView, targetIndex: number): Promise<void>;
	setContent(content: Element): Promise<boolean>;
	setTitleVisible(visible: boolean): void;
	layout(dimension: IDimension): void;
}
