import { addDisposableListener, stopEvent } from '../../../../../../src/ash/base/browser/dom.js';
import { Disposable } from '../../../../../../src/ash/base/common/lifecycle.js';
import { type ICodeEditor } from '../../../../../../src/ash/editor/browser/editorBrowser.js';
import { registerEditorContribution } from '../../../registration.js';
import { type IVersionedEditorWorkerClient } from '../../../../../../src/ash/editor/browser/services/editorWorkerService.js';
import { type View } from '../../../../../../src/ash/editor/browser/view.js';
import { Selection } from '../../../../../../src/ash/editor/common/core/selection.js';
import { Range } from '../../../../../../src/ash/editor/common/core/range.js';
import { InPlaceReplaceCommand } from './inPlaceReplaceCommand.js';

class InPlaceReplaceController extends Disposable {
	constructor(
		input: HTMLElement,
		private readonly editor: ICodeEditor,
		private readonly viewport: View,
		private readonly editorWorker: IVersionedEditorWorkerClient,
		private readonly wordDefinition: () => RegExp,
		private readonly onError: (error: unknown) => void,
	) {
		super();
		if (viewport.textModel !== editor.getModel()) throw new TypeError('In-place replace dependencies must share a text model');
		this._register(addDisposableListener(input, 'keydown', event => {
			if (event.defaultPrevented || event.isComposing || !event.shiftKey || (!event.ctrlKey && !event.metaKey) || event.altKey) return;
			const direction = event.key === ',' ? -1 : event.key === '.' ? 1 : undefined;
			if (direction === undefined) return;
			stopEvent(event);
			void this.replace(direction).catch(this.onError);
		}, true));
	}

	private async replace(direction: -1 | 1): Promise<boolean> {
		const model = this.viewport.textModel;
		const selectionState = this.editor.getSelections()!;
		const selection = selectionState[0]!;
		if (selection.startLineNumber !== selection.endLineNumber) return false;
		const result = await this.editorWorker.navigateValueSet(selection, direction > 0, this.wordDefinition());
		if (!result || !Selection.selectionsArrEqual(this.editor.getSelections()!, selectionState)) return false;
		this.editor.pushUndoStop();
		this.editor.executeCommands('editor.action.inPlaceReplace', [
			new InPlaceReplaceCommand(Range.lift(result.range), selectionState[0]!, result.value),
			...selectionState.slice(1).map(() => null),
		]);
		this.editor.pushUndoStop();
		this.viewport.revealPosition(Range.lift(result.range).getStartPosition());
		return true;
	}
}

registerEditorContribution({
	id: 'editor.contrib.inPlaceReplace',
	install: context => {
		if (context.kind !== 'text') return;
		return new InPlaceReplaceController(
			context.controller.element,
			context.editor,
			context.view,
			context.editorWorker,
			() => context.configurations.getLanguageConfiguration(context.model.getLanguageId()).getWordDefinition(),
			context.onLanguageError,
		);
	},
});
