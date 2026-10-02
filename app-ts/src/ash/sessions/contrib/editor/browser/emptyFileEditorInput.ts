import { URI } from '../../../../base/common/uri.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import type { EditorInput } from '../../../../workbench/services/editor/common/editorService.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInputSerializers } from '../../../../workbench/services/editor/common/editorInputSerializer.js';

/** The Files landing tab has no document or working copy of its own. */
export class EmptyFileEditorInput implements EditorInput {
	public capabilities = EditorInputCapabilities.None;
	public readonly resource = URI.parse('ash-sessions-files:/');
	public readonly contentType = 'application/vnd.ash.sessions-files';
	public readonly readOnly = true;
	public readonly showBreadcrumbs = false;
	public get label(): string { return localize('sessions.files.title', 'Files'); }
	public getIcon(): typeof Lxicon.files { return Lxicon.files; }
}

EditorInputSerializers.registerStatic({
	typeId: 'sessions.editorInput.files',
	canSerialize: input => input.resource.scheme === 'ash-sessions-files',
	serialize: () => ({}),
	deserialize: () => new EmptyFileEditorInput(),
});
