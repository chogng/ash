import type { IResourceEditorInput } from '../../../common/editor.js';
import type { Event } from '../../../../base/common/event.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { EditorCloseReason, EditorGroupChangeEvent, EditorGroupId, EditorGroupState, EditorInstanceState } from './editorState.js';

/** Editor operations and canonical state shared by commands and group hosts. */
export interface IEditorGroup {
	readonly id: EditorGroupId;
	readonly onDidChangeEditors: Event<EditorGroupChangeEvent>;
	readonly inputs: readonly IResourceEditorInput[];
	readonly selectedInputs: readonly IResourceEditorInput[];
	readonly editors: readonly EditorInstanceState[];
	readonly activeInput: IResourceEditorInput | undefined;
	readonly isLocked: boolean;
	setLocked(locked: boolean): void;
	getEditorState(): EditorGroupState;
	isPreview(input: IResourceEditorInput): boolean;
	isSticky(input: IResourceEditorInput): boolean;
	/** Keeps a preview open. The model calls this pinned; the UI thumbtack is sticky. */
	pinEditor(input?: IResourceEditorInput): void;
	/** Makes the editor sticky; repeated calls retain the same state. */
	stickEditor(input?: IResourceEditorInput): void;
	/** Removes sticky placement while keeping the editor open. */
	unstickEditor(input?: IResourceEditorInput): void;
	closeEditor(input: IResourceEditorInput, options?: EditorCloseOptions): Promise<boolean>;
	focus(): void;
}

/** Window-local group selection consumed by window chrome. Group state remains owned by EditorPart. */
export interface IEditorGroupsContainer {
	readonly activeGroup: IEditorGroup;
	readonly onDidChangeActiveGroup: Event<IEditorGroup>;
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
