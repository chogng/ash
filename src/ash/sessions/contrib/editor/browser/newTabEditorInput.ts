import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import type { EditorInputSerializer } from '../../../../workbench/services/editor/common/editorInputSerializer.js';

export const NewTabCommandId = 'ash.sessions.openEditorStart';

/** A launcher can be selected and closed like any other tab before a tool is chosen. */
export class NewTabEditorInput implements IResourceEditorInput {
	static readonly ID = 'ash.sessions.editorInput.newTab';
	static readonly EDITOR_ID = 'ash.sessions.editor.newTab';
	readonly typeId = NewTabEditorInput.ID;
	readonly editorId = NewTabEditorInput.EDITOR_ID;
	readonly showBreadcrumbs = false;
	constructor(readonly resource = URI.from({ scheme: 'ash-sessions-new-tab', path: `/${generateUuid()}` })) { }
	get label(): string { return localize('sessions.editorStart.newTab', 'New Tab'); }
}

export const newTabEditorSerializer: EditorInputSerializer = {
	typeId: NewTabEditorInput.ID,
	canSerialize: input => input instanceof NewTabEditorInput,
	serialize: (input: IResourceEditorInput) => input.resource.toString(),
	deserialize: value => {
		if (typeof value !== 'string') throw new TypeError('Invalid New Tab editor state');
		const resource = URI.parse(value);
		if (resource.scheme !== 'ash-sessions-new-tab' || !resource.path) throw new TypeError('Invalid New Tab editor resource');
		return new NewTabEditorInput(resource);
	},
};
