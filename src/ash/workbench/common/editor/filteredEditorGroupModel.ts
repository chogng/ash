import type { IResourceEditorInput } from '../editor.js';

import type { EditorGroupModel } from './editorGroupModel.js';

/** Reads the current sticky row without caching another copy of group state. */
export class StickyEditorGroupModel {
	constructor(private readonly model: EditorGroupModel) { }

	getEditors(): readonly IResourceEditorInput[] {
		return this.model.entries.filter(editor => editor.sticky).map(editor => editor.input);
	}
}

/** Reads the current ordinary row; moves and unpinning are owned by the group. */
export class UnstickyEditorGroupModel {
	constructor(private readonly model: EditorGroupModel) { }

	getEditors(): readonly IResourceEditorInput[] {
		return this.model.entries.filter(editor => !editor.sticky).map(editor => editor.input);
	}
}
