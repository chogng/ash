import type { Event } from '../../../../base/common/event.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { EditorGroupId, EditorGroupState } from './editorState.js';

/** Observable editor-group topology without exposing browser group implementations. */
export interface IEditorGroupsService {
	readonly whenReady: Promise<void>;
	readonly onDidChangeGroups: Event<void>;
	readonly onDidAddGroup: Event<EditorGroupState>;
	readonly onDidRemoveGroup: Event<EditorGroupId>;
	readonly onDidActivateGroup: Event<EditorGroupState>;
	readonly groups: readonly EditorGroupState[];
	readonly activeGroup: EditorGroupState;
	readonly count: number;
}

export const IEditorGroupsService = createServiceIdentifier<IEditorGroupsService>('editorGroupsService');
