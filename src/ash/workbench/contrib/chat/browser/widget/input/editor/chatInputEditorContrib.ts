import { addDisposableListener, stopEvent } from '../../../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { registerEditorContribution, EditorContributionInstantiation } from '../../../../../../../editor/browser/editorFeatureRegistration.js';
import type { ICodeEditor } from '../../../../../../../editor/browser/editorBrowser.js';
import { EditorOption } from '../../../../../../../editor/common/config/editorOptions.js';
import { Range } from '../../../../../../../editor/common/core/range.js';
import { Selection } from '../../../../../../../editor/common/core/selection.js';

/** Keeps immediate command removal in the input's existing edit and undo lifecycle. */
class ChatTokenDeleter extends Disposable {
	private pending: { readonly range: Range; readonly version: number; } | undefined;

	constructor(editor: ICodeEditor) {
		super();
		this._register(editor.onDidChangeModel(() => { this.pending = undefined; }));
		this._register(editor.onDidBlurEditorText(() => { this.pending = undefined; }));
		this._register(editor.onMouseDown(() => { this.pending = undefined; }));
		this._register(editor.onDidChangeModelContent(event => {
			this.pending = undefined;
			if (event.isUndoing || event.isRedoing || event.changes.length !== 1
				|| !event.detailedReasons.some(reason => reason.metadata.source === 'cursor' && reason.metadata.detailedSource === 'suggest.accept')) {
				return;
			}
			const change = event.changes[0]!;
			// Only accepting over the bare slash creates an atomic token. A typed prefix
			// keeps ordinary character deletion, as do arguments and resource completions.
			if (change.rangeLength !== 1 || !/^\/[^\s]+[ \t]?$/u.test(change.text)) {
				return;
			}
			this.pending = {
				range: new Range(change.range.startLineNumber, change.range.startColumn,
					change.range.startLineNumber, change.range.startColumn + change.text.length),
				version: event.versionId,
			};
		}));
		this._register(addDisposableListener(editor.getDomNode()!, 'keydown', event => {
			const pending = this.pending;
			this.pending = undefined;
			if (!pending || !editor.hasTextFocus() || event.defaultPrevented || event.isComposing || event.key !== 'Backspace'
				|| event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || editor.getOption(EditorOption.readOnly)) {
				return;
			}
			const selections = editor.getSelections();
			if (editor.getModel()?.getVersionId() !== pending.version || selections?.length !== 1
				|| !selections[0]!.isEmpty() || !pending.range.getEndPosition().equals(selections[0]!.getPosition())) {
				return;
			}
			stopEvent(event);
			editor.pushUndoStop();
			editor.executeEdits('chatTokenDeleter', [{ range: pending.range, text: '' }], [Selection.fromPositions(pending.range.getStartPosition())]);
			editor.pushUndoStop();
		}, true));
	}
}

registerEditorContribution('chatTokenDeleter', ChatTokenDeleter, EditorContributionInstantiation.Eager);
