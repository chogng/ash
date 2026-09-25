import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { type URI } from '../../../../../base/common/uri.js';
import { localize, onDidChangeNls } from '../../../../../nls.js';
import { DialogSeverity, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { type IFileService } from '../../../../../platform/files/common/files.js';
import { type IEditorPaneDescriptor } from '../../../../browser/parts/editor/editorPane.js';
import { BINARY_EDITOR_ID, BaseBinaryResourceEditor, binaryEditorDescriptor } from '../../../../browser/parts/editor/binaryEditor.js';
import { CODE_EDITOR_ID } from '../../../../common/editor/codeEditorId.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';

const MAX_TEXT_PREVIEW_BYTES = 64 * 1024;

/** Binary file viewer with a deliberate, read-only text preview action. */
export class BinaryFileEditor extends BaseBinaryResourceEditor {
	private resource: URI | undefined;

	constructor(files: IFileService, private readonly editors: IEditorService, private readonly dialogs: IDialogService) {
		super(files);
	}

	override create(parent: HTMLElement): void {
		super.create(parent);
		const button = h(parent.ownerDocument, 'button');
		button.type = 'button';
		button.className = 'ash-button ash-button-secondary ash-binary-open-as-text';
		const updateLabel = () => { button.textContent = localize('files.openBinaryAsText', 'Open as Read-Only Text'); };
		updateLabel();
		this._register(onDidChangeNls(updateLabel));
		this.container?.prepend(button);
		this._register(addDisposableListener(button, 'click', () => { void this.openAsText(); }));
	}

	override async setInput(input: { readonly resource: URI }, signal: AbortSignal): Promise<void> {
		await super.setInput(input, signal);
		this.resource = input.resource;
	}

	override clearInput(): void {
		super.clearInput();
		this.resource = undefined;
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
			if (!options.fileService || !options.instantiationService) throw new Error('Binary file editor requires file and editor services');
			return new BinaryFileEditor(
				options.fileService,
				options.instantiationService.get(IEditorService),
				options.instantiationService.get(IDialogService),
			);
		},
	};
}
