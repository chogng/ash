import { URI } from '../../../../base/common/uri.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { registerEditorPane } from '../../../browser/editor.js';
import { DockedEditorInput } from '../../../browser/parts/editor/dockedEditorInput.js';
import { EditorPane, EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import { EditorInputSerializers, requireRecord } from '../../../services/editor/common/editorInputSerializer.js';

/** Selects the editor part's Files view without opening a document. */
export class EmptyFileEditorInput extends DockedEditorInput {
	static readonly ID = 'sessions.editorInput.files';
	public readonly resource = URI.from({ scheme: 'ash-sessions-files', path: '/files' });
	public get label(): string { return localize('sessions.files.title', 'Files'); }
	public getIcon(): typeof Lxicon.folder { return Lxicon.folder; }
}

// The editor part provides the existing Files view while this input is active.
class EmptyFileEditor extends EditorPane {
	static readonly ID = 'ash.sessions.emptyFileEditor';
	readonly id = EmptyFileEditor.ID;

	constructor(@IThemeService theme: IThemeService, @IStorageService storage: IStorageService) {
		super(EmptyFileEditor.ID, theme, storage);
	}

	public async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		if (!(input instanceof EmptyFileEditorInput)) { throw new TypeError('Invalid Files editor input'); }
	}
	public clearInput(): void { }
	public layout(): void { }
	public focus(): void { }
}

registerEditorPane({
	id: EmptyFileEditor.ID,
	name: 'Files',
	canOpen: input => input instanceof EmptyFileEditorInput ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => options.instantiationService!.createInstance(EmptyFileEditor),
});

EditorInputSerializers.registerStatic({
	typeId: EmptyFileEditorInput.ID,
	canSerialize: input => input instanceof EmptyFileEditorInput,
	serialize: () => ({}),
	deserialize: value => {
		requireRecord(value, 'Files input');
		return new EmptyFileEditorInput();
	},
});
