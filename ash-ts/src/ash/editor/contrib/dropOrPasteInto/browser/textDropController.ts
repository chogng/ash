import { addDisposableListener, stopEvent } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { createReadableClipboardData, readEditorClipboardText } from '../../../browser/controller/editContext/clipboardUtils.js';
import { registerEditorContribution } from '../../../browser/editorExtensions.js';
import { type View } from '../../../browser/view.js';
import { type CursorsController } from '../../../common/cursor/cursor.js';
import { TypeOperations } from '../../../common/cursor/cursorTypeOperations.js';
import { Selection } from '../../../common/core/selection.js';
import { type Position } from '../../../common/core/position.js';
import { InlineProgressManager } from '../../inlineProgress/browser/inlineProgress.js';
import { TEXT_FILE_TRANSFER_MAX_BYTES, selectTextFileTransfer } from './textFileTransfer.js';

/** Owns text and text-file drop operations for one editor. */
export class TextDropController extends Disposable {
	private asynchronousDropRequest = 0;

	constructor(
		private readonly viewport: View,
		private readonly selections: CursorsController,
		private readonly progress: Pick<InlineProgressManager, 'showWhile'>,
	) {
		super();
		if (viewport.textModel !== selections.context.model) {
			this.dispose();
			throw new TypeError('Text drop dependencies must share one text model');
		}
		this._register(addDisposableListener<DragEvent>(viewport.domNode.domNode, 'dragover', event => this.handleDragOver(event)));
		this._register(addDisposableListener<DragEvent>(viewport.domNode.domNode, 'drop', event => this.handleDrop(event)));
		this._register(toDisposable(() => {
			this.asynchronousDropRequest += 1;
		}));
	}

	private handleDragOver(event: DragEvent): void {
		if (this.selections.readOnly || event.defaultPrevented) return;
		if (!containsText(event.dataTransfer) && !selectTextFileTransfer(event.dataTransfer?.files ?? [])) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
	}

	private handleDrop(event: DragEvent): void {
		if (this.selections.readOnly || event.defaultPrevented) return;
		const text = readDropText(event.dataTransfer, this.viewport.domNode.domNode.ownerDocument);
		const target = this.viewport.getNearestTargetAtClientPoint(event);
		if (!target) return;
		if (text.length === 0) {
			this.dropTextFile(event, target.position);
			return;
		}
		stopEvent(event);
		this.viewport.domNode.domNode.focus({ preventScroll: true });
		this.pasteAt(target.position, text);
		this.viewport.revealPosition(this.selections.getSelections()[0]!.getPosition());
	}

	private dropTextFile(event: DragEvent, position: Position): void {
		const file = selectTextFileTransfer(event.dataTransfer?.files ?? []);
		if (!file) return;
		const model = this.viewport.textModel;
		const expectedVersion = model.version;
		const request = ++this.asynchronousDropRequest;
		stopEvent(event);
		this.viewport.domNode.domNode.focus({ preventScroll: true });
		const text = this.progress.showWhile(position, 'Reading dropped file', file.text(), {
			cancel: () => {
				if (request === this.asynchronousDropRequest) this.asynchronousDropRequest += 1;
			},
		});
		void text.then(text => {
			if (this.isDisposed || request !== this.asynchronousDropRequest || text.length > TEXT_FILE_TRANSFER_MAX_BYTES || model.version !== expectedVersion) return;
			this.pasteAt(position, text);
			this.viewport.revealPosition(this.selections.getSelections()[0]!.getPosition());
		}).catch(() => {
			// The supplied file could not be decoded as text.
		});
	}

	private pasteAt(position: Position, text: string): void {
		this.selections.setSelections([Selection.fromPositions(position)]);
		const operation = TypeOperations.paste(this.viewport.cursorConfig, this.viewport.textModel, this.selections.getSelections(), text, false, []);
		if (operation.shouldPushStackElementBefore) this.selections.pushUndoStop();
		this.selections.executeCommands(operation.commands, 'drop');
		this.selections.setPrevEditOperationType(operation.type);
		if (operation.shouldPushStackElementAfter) this.selections.pushUndoStop();
	}
}

registerEditorContribution({
	id: 'editor.contrib.dropOrPasteInto',
	install: context => {
		if (context.kind !== 'text') return;
		const progress = context.register(new InlineProgressManager('dropIntoEditor', context.editor, context.instantiationService));
		context.register(new TextDropController(context.view, context.selectionController, progress));
	},
});

function containsText(dataTransfer: DataTransfer | null): boolean {
	if (!dataTransfer) return false;
	const types = Array.from(dataTransfer.types);
	return types.includes('text/plain') || types.includes('text/html');
}

function readDropText(dataTransfer: DataTransfer | null, ownerDocument: Document): string {
	return readEditorClipboardText(createReadableClipboardData(dataTransfer), ownerDocument);
}
