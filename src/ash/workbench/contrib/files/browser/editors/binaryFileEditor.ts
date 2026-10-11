import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { SUPPORTED_ENCODINGS, getEncodingLabel } from '../../../../services/textfile/common/encoding.js';
import './media/binaryFileEditor.css';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import type { IEditorPaneDescriptor } from '../../../../browser/editor.js';
import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { type URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { DialogSeverity, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { BINARY_EDITOR_ID, BaseBinaryResourceEditor, binaryEditorDescriptor } from '../../../../browser/parts/editor/binaryEditor.js';
import { CODE_EDITOR_ID } from '../../../../common/editor/codeEditorId.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';

const MAX_TEXT_PREVIEW_BYTES = 64 * 1024;

/** Binary file viewer with a deliberate, read-only text preview action. */
export class BinaryFileEditor extends BaseBinaryResourceEditor {
	private resource: URI | undefined;
	private readonly encodingPicker = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		@IFileService files: IFileService,
		@IEditorService private readonly editors: IEditorService,
		@IDialogService private readonly dialogs: IDialogService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(files, instantiationService, themeService, storageService);
	}

	override create(parent: HTMLElement): void {
		super.create(parent);
		const button = h(parent.ownerDocument, 'button');
		button.type = 'button';
		button.className = 'ash-button ash-button-secondary ash-binary-open-as-text';
		const updateLabel = () => { button.textContent = localize('files.openBinaryAsText', 'Open as Read-Only Text'); };
		updateLabel();
		this.container?.prepend(button);
		this._register(addDisposableListener(button, 'click', () => { void this.openAsText(); }));
		const encodingButton = h(parent.ownerDocument, 'button');
		encodingButton.type = 'button';
		encodingButton.className = 'ash-button ash-button-secondary ash-binary-open-with-encoding';
		encodingButton.textContent = localize('files.openWithEncoding', 'Open with Encoding');
		this.container?.prepend(encodingButton);
		this._register(addDisposableListener(encodingButton, 'click', () => { void this.openWithEncoding(); }));
	}

	override async setInput(input: { readonly resource: URI; }, signal: AbortSignal): Promise<void> {
		await super.setInput(input, signal);
		this.resource = input.resource;
	}

	override clearInput(): void {
		super.clearInput();
		this.encodingPicker.clear();
		this.resource = undefined;
	}

	private async openWithEncoding(): Promise<void> {
		const resource = this.resource;
		if (!resource) return;
		const resources = new DisposableStore();
		this.encodingPicker.value = resources;
		try {
			const picker = resources.add(this.quickInput.createQuickPick<{ label: string; id: string }>());
			picker.items = Object.keys(SUPPORTED_ENCODINGS).filter(id => !SUPPORTED_ENCODINGS[id].hidden && !SUPPORTED_ENCODINGS[id].encodeOnly).map(id => ({ label: getEncodingLabel(id), id, description: id }));
			picker.sortByLabel = false;
			picker.placeholder = picker.ariaLabel = localize('status.editor.selectEncoding', 'Select File Encoding');
			const selected = await new Promise<{ id: string } | undefined>(resolve => {
				resources.add(toDisposable(() => resolve(undefined)));
				resources.add(picker.onDidAccept(item => { resolve(item); picker.hide(); }));
				resources.add(picker.onDidHide(() => resolve(undefined)));
				picker.show();
			});
			if (!selected || this.isDisposed || this.resource !== resource) return;
			await this.editors.openEditor({ resource, encoding: selected.id }, { preferredEditorId: CODE_EDITOR_ID });
		} catch (error) {
			if (this.isDisposed || this.resource !== resource) return;
			await this.dialogs.showMessage({ severity: DialogSeverity.Error, title: localize('files.openWithEncoding', 'Open with Encoding'), message: localize('files.openWithEncodingFailed', 'Could not open this file with the selected encoding: {0}', error instanceof Error ? error.message : String(error)) });
		} finally {
			if (this.encodingPicker.value === resources) this.encodingPicker.clear();
		}
	}

	private async openAsText(): Promise<void> {
		const resource = this.resource;
		if (!resource) return;
		try {
			const content = await this.files.readFileBytes(resource);
			const text = new TextDecoder('utf-8').decode(content.bytes.subarray(0, MAX_TEXT_PREVIEW_BYTES));
			await this.editors.openEditor(
				{ resource, languageId: 'plaintext', contentType: 'text/plain', initialText: text, readOnly: true },
				{ preferredEditorId: CODE_EDITOR_ID },
			);
		} catch (error) {
			await this.dialogs.showMessage({
				severity: DialogSeverity.Error,
				title: localize('files.binaryTextPreviewFailedTitle', 'Could not open text preview'),
				message: localize(
					'files.binaryTextPreviewFailed',
					'Could not open a text preview of this file: {0}',
					error instanceof Error ? error.message : String(error),
				),
			});
		}
	}
}

export function binaryFileEditorDescriptor(): IEditorPaneDescriptor {
	const base = binaryEditorDescriptor();
	return {
		...base,
		id: BINARY_EDITOR_ID,
		create: options => {
			if (!options.instantiationService) throw new Error('Binary file editor requires Workbench instantiation services');
			return options.instantiationService.createInstance(BinaryFileEditor);
		},
	};
}
