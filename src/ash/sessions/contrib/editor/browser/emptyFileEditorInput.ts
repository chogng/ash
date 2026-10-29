import { URI } from '../../../../base/common/uri.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';

import { DockedEditorInput } from '../../../common/dockedEditorInput.js';
import { EditorInputSerializers } from '../../../../workbench/services/editor/common/editorInputSerializer.js';

/** The Files landing tab has no document or working copy of its own. */
export class EmptyFileEditorInput extends DockedEditorInput {
	public readonly resource = URI.parse('ash-sessions-files:/');
	public readonly contentType = 'application/vnd.ash.sessions-files';
	public get label(): string { return localize('sessions.files.title', 'Files'); }
	public getIcon(): typeof Lxicon.files { return Lxicon.files; }
}

EditorInputSerializers.registerStatic({
	typeId: 'sessions.editorInput.files',
	canSerialize: input => input.resource.scheme === 'ash-sessions-files',
	serialize: () => ({}),
	deserialize: () => new EmptyFileEditorInput(),
});
