import type { Event } from '../../../../base/common/event.js';
import type { EditorInput } from './editorService.js';

export type EditorGroupId = string;
export type EditorInstanceId = string;

/** One concrete editor instance hosted by one Workbench editor group. */
export interface EditorIdentifier {
	readonly groupId: EditorGroupId;
	readonly instanceId: EditorInstanceId;
	readonly paneId: string;
	readonly input: EditorInput;
}

/** Observable state of one editor instance without exposing its browser pane. */
export interface EditorInstanceState extends EditorIdentifier {
	readonly index: number;
	readonly isActive: boolean;
	readonly isPreview: boolean;
	readonly isDirty: boolean;
	readonly canRevert: boolean;
	readonly hasExternalChange: boolean;
}

/** Ordered editor state owned by one Workbench editor group. */
export interface EditorGroupState {
	readonly id: EditorGroupId;
	readonly editors: readonly EditorInstanceState[];
	readonly activeEditorInstanceId: EditorInstanceId | undefined;
}

/** Current state of the window's central editor region. */
export interface EditorPartState {
	readonly groups: readonly EditorGroupState[];
	readonly activeGroupId: EditorGroupId;
	readonly activeEditor: EditorIdentifier | undefined;
	readonly isModalEditorVisible: boolean;
}

export type EditorCloseReason = 'close' | 'move' | 'replace' | 'previewReplace' | 'reset';

export type EditorGroupChangeEvent =
	| { readonly kind: 'editorOpened'; readonly editor: EditorInstanceState }
	| { readonly kind: 'editorClosed'; readonly editor: EditorInstanceState; readonly reason: EditorCloseReason }
	| { readonly kind: 'activeEditorChanged'; readonly editor: EditorInstanceState | undefined }
	| { readonly kind: 'editorMoved'; readonly editor: EditorInstanceState; readonly previousIndex: number }
	| { readonly kind: 'editorStateChanged'; readonly editor: EditorInstanceState };

export type EditorPartChangeEvent =
	| { readonly kind: 'groupAdded'; readonly group: EditorGroupState }
	| { readonly kind: 'groupRemoved'; readonly groupId: EditorGroupId }
	| { readonly kind: 'activeGroupChanged'; readonly groupId: EditorGroupId }
	| { readonly kind: 'modalEditorChanged'; readonly visible: boolean }
	| { readonly kind: 'groupChanged'; readonly groupId: EditorGroupId; readonly event: EditorGroupChangeEvent };

/** Read-only state surface shared by editor services and browser hosts. */
export interface IEditorStateSource {
	readonly onDidChangeEditors: Event<EditorPartChangeEvent>;
	getEditorState(): EditorPartState;
}
