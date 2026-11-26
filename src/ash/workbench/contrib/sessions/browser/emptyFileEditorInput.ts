import { URI } from '../../../../base/common/uri.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { DockedEditorInput } from '../../../browser/parts/editor/dockedEditorInput.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import { requireRecord, type EditorInputSerializer } from '../../../services/editor/common/editorInputSerializer.js';

export class EmptyFileEditorInput extends DockedEditorInput {
	static readonly ID = 'sessions.editorInput.files';
	static readonly EDITOR_ID = 'ash.sessions.emptyFileEditor';
	static readonly SCHEME = 'ash-sessions-files';
	static readonly ICON = Lxicon.folder;

	public readonly resource = URI.from({ scheme: EmptyFileEditorInput.SCHEME, path: '/files' });
	public readonly editorId = EmptyFileEditorInput.EDITOR_ID;
	public get label(): string { return localize('sessions.files.title', 'Files'); }
	public getIcon(): typeof EmptyFileEditorInput.ICON { return EmptyFileEditorInput.ICON; }
}

/** The active session supplies the workspace when the editor is restored. */
export class EmptyFileEditorSerializer implements EditorInputSerializer {
	readonly typeId = EmptyFileEditorInput.ID;

	canSerialize(input: IResourceEditorInput): boolean { return input instanceof EmptyFileEditorInput; }
	serialize(): object { return {}; }
	deserialize(value: unknown): EmptyFileEditorInput {
		requireRecord(value, 'Files editor input');
		return new EmptyFileEditorInput();
	}
}
