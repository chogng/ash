import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { raceCancellationError } from '../../../../../base/common/async.js';
import { canceled, isCancellationError } from '../../../../../base/common/errors.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import type { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import type { TextEdit } from '../../../../../editor/common/languages.js';
import { EditSuggestionId } from '../../../../../editor/common/textModelEditSource.js';
import { localize } from '../../../../../nls.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IChatEditingService } from '../../common/editing/chatEditingService.js';
import { IChatWidgetService } from '../chat.js';

/** Streams into the original working copy while the existing review service owns its baseline. */
export async function reviewEdits(
	accessor: ServicesAccessor,
	editor: ICodeEditor,
	stream: AsyncIterable<TextEdit[]>,
	token: CancellationToken,
	applyCodeBlockSuggestionId: EditSuggestionId | undefined,
): Promise<boolean> {
	const response = accessor.get(IChatWidgetService).lastFocusedWidget?.getFocus();
	const model = editor.getModel();
	if (!model || !response?.feedbackSource || response.transient) return false;
	const reviews = accessor.get(IChatEditingService);
	const identity = applyCodeBlockSuggestionId ?? EditSuggestionId.newId();
	const source = {
		...response.feedbackSource,
		codeBlockSuggestionId: identity,
		languageId: model.getLanguageId(),
	};
	using lifetime = new DisposableStore();
	const abort = new AbortController();
	const stop = () => abort.abort();
	lifetime.add(token.onCancellationRequested(stop));
	lifetime.add(editor.onDidDispose(stop));
	lifetime.add(editor.onDidChangeModel(stop));
	lifetime.add(model.onWillDispose(stop));
	let version = model.getVersionId();
	let conflicted = false;
	lifetime.add(model.onDidChangeContent(event => {
		if (event.detailedReasons.length && event.detailedReasons.every(reason => reason.metadata.source === 'Chat.applyEdits' && reason.metadata.$$codeBlockSuggestionId === identity)) {
			version = event.version;
		} else {
			conflicted = true;
		}
	}));
	let applied = false;
	let outcome: 'completed' | 'failed' | 'interrupted' = 'failed';
	const iterator = stream[Symbol.asyncIterator]();
	try {
		for (; ;) {
			if (token.isCancellationRequested || abort.signal.aborted) throw canceled();
			const batch = await raceCancellationError(iterator.next(), abort.signal);
			if (conflicted || model.isDisposed() || model.getVersionId() !== version || editor.getModel() !== model) {
				throw new Error(localize('chat.code.reviewChanged', 'The file changed while code was being applied. Review the changes already received and try again.'));
			}
			if (batch.done) { outcome = 'completed'; break; }
			if (!batch.value.length) continue;
			const result = await reviews.applyEdits({ entries: [{ kind: 'textDocument', resource: model.uri, version, edits: batch.value }] }, abort.signal, source);
			if (!result.isApplied) throw new Error(localize('chat.code.reviewFailed', 'The code edits could not be applied.'));
			applied = true;
		}
		return applied;
	} catch (error) {
		if (isCancellationError(error) || abort.signal.aborted || token.isCancellationRequested) outcome = 'interrupted';
		throw error;
	} finally {
		abort.abort();
		// Cancelling the producer is owned by the caller; do not wait on an uncooperative iterator.
		void iterator.return?.().catch(() => { });
		if (applied) await reviews.finishTurn(source, outcome);
	}
}
