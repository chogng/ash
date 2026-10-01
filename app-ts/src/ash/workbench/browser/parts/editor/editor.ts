import type { IDimension } from '../../../../base/browser/dom.js';
import type { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import type { EditorInput, EditorOpenOptions } from '../../../services/editor/common/editorService.js';
import type { EditorInstanceId } from '../../../services/editor/common/editorState.js';
import type { SerializedEditorViewState } from '../../../services/editor/common/editorWorkingSet.js';
import type { IEditorPane } from './editorPane.js';

/** Shared presentation marker for editor tabs connected to their pane. */
export const CONNECTED_EDITOR_TABS_CLASS = "ash-connected-editor-tabs";
export const CONNECTED_EDITOR_TABS_SELECTOR = `.${CONNECTED_EDITOR_TABS_CLASS}`;

/** Browser host capabilities used by editor parts, separate from command operations. */
export interface IEditorGroupView extends IEditorGroup {
	readonly domNode: HTMLElement;
	readonly activePane: IEditorPane | undefined;
	saveEditorViewState(input: EditorInput): SerializedEditorViewState | undefined;
	restoreEditorViewState(input: EditorInput, state: SerializedEditorViewState | undefined): boolean;
	openEditor(input: EditorInput, options?: EditorOpenOptions, instanceId?: EditorInstanceId): Promise<IEditorPane>;
	activateEditor(input: EditorInput): IEditorPane;
	confirmCloseEditor(input: EditorInput): Promise<boolean>;
	replaceEditor(input: EditorInput, replacement: EditorInput): Promise<void>;
	moveEditorTo(input: EditorInput, target: IEditorGroupView, targetIndex: number): Promise<void>;
	setContent(content: Element): Promise<boolean>;
	layout(dimension: IDimension): void;
}
