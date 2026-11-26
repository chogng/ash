import { h } from '../../../../base/browser/dom.js';
import type { URI } from '../../../../base/common/uri.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { EmptyFileEditorInput } from '../../../../workbench/contrib/sessions/browser/emptyFileEditorInput.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { EditorFilePicker, EditorFilePickerFocusedContext } from './editorFilePicker.js';

/** Files tab shown before a document is opened. */
export class EmptyFileEditor extends EditorPane {
	static readonly ID = EmptyFileEditorInput.EDITOR_ID;
	readonly id = EmptyFileEditor.ID;
	private search: EditorFilePicker | undefined;

	constructor(
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IEditorService private readonly editors: IEditorService,
	) {
		super(EmptyFileEditor.ID, theme, storage);
	}

	override create(parent: HTMLElement): void {
		super.create(parent);
		const document = parent.ownerDocument;
		const surface = h(document, 'div', { className: 'ash-empty-file-editor' });
		const content = h(document, 'div', { className: 'ash-empty-file-editor-content' });
		surface.append(content);
		parent.append(surface);
		const contextKeys = this._register(this.contextKeys.createScoped(surface));
		EditorFilePickerFocusedContext.bindTo(contextKeys).set(true);
		this.search = this._register(this.instantiation.createInstance(EditorFilePicker, content, {
			isVisible: () => this.isVisible(),
			openFile: (resource: URI) => this.group
				? this.editors.openEditor({ resource }, { pinned: true }, { groupId: this.group.id })
				: Promise.resolve(),
		}));
	}

	openFile(): void { this.search?.show(); }
	override focus(): void { this.search?.focus(); }
	override clearInput(): void { this.search?.clear(); }
	override layout(): void { }

	override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		if (!(input instanceof EmptyFileEditorInput)) { throw new TypeError('Invalid Files editor input'); }
	}
}
