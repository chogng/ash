import { addDisposableListener, stopEvent } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { createReadableClipboardData, readEditorClipboardText } from '../../../browser/controller/editContext/clipboardUtils.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { ReplaceCommand } from '../../../common/commands/replaceCommand.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { Position, type IPosition } from '../../../common/core/position.js';
import { Selection } from '../../../common/core/selection.js';
import { type IEditorContribution } from '../../../common/editorCommon.js';
import { InlineProgressManager } from '../../inlineProgress/browser/inlineProgress.js';
import { TEXT_FILE_TRANSFER_MAX_BYTES, selectTextFileTransfer } from './textFileTransfer.js';

/** Owns text and text-file drops for one code editor. */
export class DropIntoEditorController extends Disposable implements IEditorContribution {
	public static readonly ID = 'editor.contrib.dropIntoEditorController';

	public static get(editor: ICodeEditor): DropIntoEditorController | null {
		return editor.getContribution<DropIntoEditorController>(DropIntoEditorController.ID);
	}

	private readonly progress: InlineProgressManager;
	private asynchronousDropRequest = 0;

	constructor(
		private readonly editor: ICodeEditor,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.progress = this._register(new InlineProgressManager(
			'dropIntoEditor',
			editor,
			instantiationService,
		));
		this._register(editor.onDropIntoEditor(event => this.onDrop(event.position, event.event)));
		const domNode = editor.getDomNode();
		if (domNode) this._register(addDisposableListener<DragEvent>(domNode, 'dragover', event => this.onDragOver(event)));
		this._register(toDisposable(() => { this.asynchronousDropRequest += 1; }));
	}

	private onDragOver(event: DragEvent): void {
		if (this.editor.getOption(EditorOption.readOnly) || event.defaultPrevented) return;
		if (!containsText(event.dataTransfer) && !selectTextFileTransfer(event.dataTransfer?.files ?? [])) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
	}

	private onDrop(rawPosition: IPosition, event: DragEvent): void {
		if (this.editor.getOption(EditorOption.readOnly) || event.defaultPrevented) return;
		const model = this.editor.getModel();
		const domNode = this.editor.getDomNode();
		if (!model || !domNode) return;
		const position = Position.lift(rawPosition);
		const text = readDropText(event.dataTransfer, domNode.ownerDocument);
		if (text.length > 0) {
			stopEvent(event);
			this.insert(position, text);
			return;
		}
		const file = selectTextFileTransfer(event.dataTransfer?.files ?? []);
		if (!file) return;
		stopEvent(event);
		const expectedVersion = model.getVersionId();
		const request = ++this.asynchronousDropRequest;
		const pending = this.progress.showWhile(position, 'Reading dropped file', file.text(), {
			cancel: () => { if (request === this.asynchronousDropRequest) this.asynchronousDropRequest += 1; },
		});
		void pending.then(value => {
			if (this.isDisposed || request !== this.asynchronousDropRequest || value.length > TEXT_FILE_TRANSFER_MAX_BYTES || model.getVersionId() !== expectedVersion) return;
			this.insert(position, value);
		}).catch(() => {
			// File decoding failures leave the editor unchanged.
		});
	}

	private insert(position: Position, text: string): void {
		this.editor.focus();
		this.editor.setPosition(position, 'drop');
		this.editor.pushUndoStop();
		this.editor.executeCommand('drop', new ReplaceCommand(Selection.fromPositions(position), text));
		this.editor.pushUndoStop();
	}
}

function containsText(dataTransfer: DataTransfer | null): boolean {
	if (!dataTransfer) return false;
	const types = Array.from(dataTransfer.types);
	return types.includes('text/plain') || types.includes('text/html');
}

function readDropText(dataTransfer: DataTransfer | null, ownerDocument: Document): string {
	return readEditorClipboardText(createReadableClipboardData(dataTransfer), ownerDocument);
}
