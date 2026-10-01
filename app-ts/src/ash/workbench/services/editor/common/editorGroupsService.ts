import type { Event } from '../../../../base/common/event.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { EditorCloseReason, EditorGroupChangeEvent, EditorGroupId, EditorGroupState, EditorInstanceState } from './editorState.js';
import type { EditorInput } from './editorService.js';

/** Editor operations and canonical state shared by commands and group hosts. */
export interface IEditorGroup {
	readonly id: EditorGroupId;
	readonly onDidChangeEditors: Event<EditorGroupChangeEvent>;
	readonly inputs: readonly EditorInput[];
	readonly selectedInputs: readonly EditorInput[];
	readonly editors: readonly EditorInstanceState[];
	readonly activeInput: EditorInput | undefined;
	readonly isLocked: boolean;
	setLocked(locked: boolean): void;
	getEditorState(): EditorGroupState;
	isPreview(input: EditorInput): boolean;
	isSticky(input: EditorInput): boolean;
	/** Keeps a preview open. The model calls this pinned; the UI thumbtack is sticky. */
	pinEditor(input?: EditorInput): void;
	/** Makes the editor sticky; repeated calls retain the same state. */
	stickEditor(input?: EditorInput): void;
	/** Removes sticky placement while keeping the editor open. */
	unstickEditor(input?: EditorInput): void;
	closeEditor(input: EditorInput, options?: EditorCloseOptions): Promise<boolean>;
	focus(): void;
}

/** Internal lifecycle controls used when an editor is moved instead of closed. */
export interface EditorCloseOptions {
	readonly skipConfirmation?: boolean;
	readonly reason?: EditorCloseReason;
}

/** Observable editor groups and their operations, independent of browser presentation. */
export interface IEditorGroupsService {
	readonly whenReady: Promise<void>;
	readonly onDidChangeGroups: Event<void>;
	readonly onDidAddGroup: Event<EditorGroupState>;
	readonly onDidRemoveGroup: Event<EditorGroupId>;
	readonly onDidActivateGroup: Event<EditorGroupState>;
	readonly groups: readonly IEditorGroup[];
	readonly activeGroup: IEditorGroup;
	readonly count: number;
	getGroup(id: EditorGroupId): IEditorGroup | undefined;
}

export const IEditorGroupsService = createServiceIdentifier<IEditorGroupsService>('editorGroupsService');
