import { UriList } from '../../../../base/common/dataTransfer.js';
import { raceCancellation } from '../../../../base/common/async.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { type IClipboardPasteEvent } from '../../../browser/controller/editContext/clipboardUtils.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { Handler, type IEditorContribution } from '../../../common/editorCommon.js';
import { CodeEditorStateFlag, EditorStateCancellationTokenSource } from '../../editorState/browser/editorState.js';
import { TEXT_FILE_TRANSFER_MAX_BYTES, selectTextFileTransfer, type TextFileTransfer } from './textFileTransfer.js';

export class CopyPasteController extends Disposable implements IEditorContribution {
	public static readonly ID = 'editor.contrib.copyPasteActionController';

	public static get(editor: ICodeEditor): CopyPasteController | null {
		return editor.getContribution<CopyPasteController>(CopyPasteController.ID);
	}

	private readonly pendingPaste = this._register(new MutableDisposable<DisposableStore>());
	private currentPasteOperation: Promise<void> | undefined;

	constructor(private readonly editor: ICodeEditor) {
		super();
		this._register(editor.onDidPaste(event => this.handlePaste(event)));
	}

	public async finishedPaste(): Promise<void> {
		await this.currentPasteOperation;
	}

	private handlePaste(event: IClipboardPasteEvent): void {
		this.pendingPaste.clear();
		if (event.isHandled || this.editor.inComposition || this.editor.getOption(EditorOption.readOnly) || !this.editor.hasModel()) return;
		const file = selectTextFileTransfer(event.clipboardData.files);
		if (file) {
			event.setHandled();
			this.currentPasteOperation = this.readTextFile(file);
			return;
		}
		if (event.clipboardData.getData('text/plain').length > 0) return;
		const uriList = UriList.parse(event.clipboardData.getData('text/uri-list'));
		if (uriList.length === 0) return;
		event.setHandled();
		this.editor.trigger('paste', Handler.Paste, {
			text: uriList.join('\n'),
			pasteOnNewLine: false,
			multicursorText: null,
			mode: null,
		});
	}

	private async readTextFile(file: TextFileTransfer): Promise<void> {
		const resources = new DisposableStore();
		this.pendingPaste.value = resources;
		const request = new EditorStateCancellationTokenSource(this.editor, CodeEditorStateFlag.Value | CodeEditorStateFlag.Selection);
		resources.add(toDisposable(() => request.dispose(true)));
		resources.add(this.editor.onDidCompositionStart(() => request.cancel()));
		resources.add(this.editor.onDidChangeConfiguration(event => {
			if (event.hasChanged(EditorOption.readOnly) && this.editor.getOption(EditorOption.readOnly)) {
				request.cancel();
			}
		}));
		try {
			const text = await raceCancellation(file.text(), request.token);
			if (request.token.isCancellationRequested || text === undefined || text.length > TEXT_FILE_TRANSFER_MAX_BYTES) {
				return;
			}
			this.editor.trigger('paste', Handler.Paste, {
				text,
				pasteOnNewLine: false,
				multicursorText: null,
				mode: null,
			});
		} catch {
			// A supplied text file that cannot be decoded leaves the model unchanged.
		} finally {
			if (this.pendingPaste.value === resources) {
				this.pendingPaste.clear();
			}
		}
	}
}
