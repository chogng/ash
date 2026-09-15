import { raceCancellationError } from '../../../../base/common/async.js';
import { type CancellationToken } from '../../../../base/common/cancellation.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { type IVersionedEditorWorkerClient } from '../../../browser/services/editorWorkerService.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { Range } from '../../../common/core/range.js';
import { type ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { CodeEditorStateFlag, EditorStateCancellationTokenSource } from '../../editorState/browser/editorState.js';
import { FormattingEdit } from './formattingEdit.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { type LanguageFeatureRegistry } from '../../../common/languageFeatureRegistry.js';
import { type DocumentFormattingEditProvider, type DocumentRangeFormattingEditProvider, type FormattingOptions, type TextEdit } from '../../../common/languages.js';
import { type ITextModel } from '../../../common/model.js';

export function getRealAndSyntheticDocumentFormattersOrdered(
	documentFormattingEditProvider: LanguageFeatureRegistry<DocumentFormattingEditProvider>,
	documentRangeFormattingEditProvider: LanguageFeatureRegistry<DocumentRangeFormattingEditProvider>,
	model: ITextModel,
): DocumentFormattingEditProvider[] {
	const providers = documentFormattingEditProvider.ordered(model);
	const extensions = new Set(providers.flatMap(provider => provider.extensionId ? [ExtensionIdentifier.toKey(provider.extensionId)] : []));
	for (const provider of documentRangeFormattingEditProvider.ordered(model)) {
		if (provider.extensionId) {
			const key = ExtensionIdentifier.toKey(provider.extensionId);
			if (extensions.has(key)) {
				continue;
			}
			extensions.add(key);
		}
		providers.push({
			extensionId: provider.extensionId,
			displayName: provider.displayName,
			provideDocumentFormattingEdits: (model, options, token) => provider.provideDocumentRangeFormattingEdits(model, model.getFullModelRange(), options, token),
		});
	}
	return providers;
}

export const enum FormattingKind {
	File = 1,
	Selection = 2,
}

export const enum FormattingMode {
	Explicit = 1,
	Silent = 2,
}

export interface IFormattingEditProviderSelector {
	<T extends DocumentFormattingEditProvider | DocumentRangeFormattingEditProvider>(formatters: T[], document: ITextModel, mode: FormattingMode, kind: FormattingKind): Promise<T | undefined>;
}

export abstract class FormattingConflicts {
	private static readonly selectors: { select: IFormattingEditProviderSelector }[] = [];

	public static setFormatterSelector(selector: IFormattingEditProviderSelector): IDisposable {
		const registration = { select: selector };
		this.selectors.push(registration);
		return toDisposable(() => {
			const index = this.selectors.indexOf(registration);
			if (index !== -1) {
				this.selectors.splice(index, 1);
			}
		});
	}

	public static async select<T extends DocumentFormattingEditProvider | DocumentRangeFormattingEditProvider>(formatters: T[], document: ITextModel, mode: FormattingMode, kind: FormattingKind): Promise<T | undefined> {
		if (formatters.length === 0) {
			return undefined;
		}
		return this.selectors.at(-1)?.select(formatters, document, mode, kind);
	}
}

const requests = new WeakMap<ICodeEditor, EditorStateCancellationTokenSource>();

/** Runs formatting with the model-bound worker owned by this editor's scope. */
export async function formatEditor(
	editor: ICodeEditor,
	features: ILanguageFeaturesService,
	worker: IVersionedEditorWorkerClient,
	kind: FormattingKind,
	mode = FormattingMode.Explicit,
): Promise<void> {
	const model = editor.getModel();
	if (!model || editor.getOption(EditorOption.readOnly)) {
		return;
	}
	requests.get(editor)?.cancel();
	const source = new EditorStateCancellationTokenSource(editor, CodeEditorStateFlag.Value | CodeEditorStateFlag.Position | CodeEditorStateFlag.Selection);
	requests.set(editor, source);
	using resources = new DisposableStore();
	const abort = new AbortController();
	resources.add(toDisposable(() => {
		abort.abort();
		source.dispose(true);
	}));
	resources.add(source.token.onCancellationRequested(() => abort.abort()));
	resources.add(model.onDidChangeLanguage(() => source.cancel()));
	resources.add(editor.onDidChangeConfiguration(() => {
		if (editor.getOption(EditorOption.readOnly)) source.cancel();
	}));
	try {
		const edits = await raceCancellationError(provideEdits(editor, model, features, kind, mode, model.getFormattingOptions(), source.token), source.token);
		if (abort.signal.aborted || !edits?.length) {
			return;
		}
		const minimalEdits = await worker.computeMoreMinimalEdits(edits, abort.signal);
		if (!abort.signal.aborted && minimalEdits) {
			FormattingEdit.execute(editor, [...minimalEdits], true);
		}
	} catch (error) {
		if (!abort.signal.aborted) {
			throw error;
		}
	} finally {
		if (requests.get(editor) === source) {
			requests.delete(editor);
		}
	}
}

async function provideEdits(
	editor: ICodeEditor,
	model: ITextModel,
	features: ILanguageFeaturesService,
	kind: FormattingKind,
	mode: FormattingMode,
	options: FormattingOptions,
	token: CancellationToken,
): Promise<TextEdit[] | null | undefined> {
	if (kind === FormattingKind.File) {
		const providers = getRealAndSyntheticDocumentFormattersOrdered(
			features.documentFormattingEditProvider,
			features.documentRangeFormattingEditProvider,
			model,
		);
		const provider = await raceCancellationError(FormattingConflicts.select(providers, model, mode, FormattingKind.File), token);
		if (!provider || token.isCancellationRequested) {
			return undefined;
		}
		return provider.provideDocumentFormattingEdits(model, options, token);
	}
	const ranges: Range[] = [];
	const selections = (editor.getSelections() ?? []).map(selection => selection.isEmpty()
		? new Range(selection.startLineNumber, 1, selection.startLineNumber, model.getLineMaxColumn(selection.startLineNumber))
		: Range.lift(selection));
	for (const range of selections.sort(Range.compareRangesUsingStarts)) {
		const previous = ranges[ranges.length - 1];
		if (previous && Range.areIntersectingOrTouching(previous, range)) {
			ranges[ranges.length - 1] = previous.plusRange(range);
		} else {
			ranges.push(range);
		}
	}
	if (ranges.length === 0) {
		return;
	}
	const providers = features.documentRangeFormattingEditProvider.ordered(model);
	const provider = await raceCancellationError(FormattingConflicts.select(providers, model, FormattingMode.Explicit, FormattingKind.Selection), token);
	if (!provider || token.isCancellationRequested) {
		return undefined;
	}
	if (provider.provideDocumentRangesFormattingEdits) {
		return provider.provideDocumentRangesFormattingEdits(model, ranges, options, token);
	}
	const pending = [...ranges];
	const completed: { range: Range; edits: TextEdit[] }[] = [];
	while (pending.length > 0) {
		if (token.isCancellationRequested) {
			return undefined;
		}
		let range = pending.shift()!;
		const edits = await raceCancellationError(Promise.resolve(
			provider.provideDocumentRangeFormattingEdits(model, range, options, token),
		), token) ?? [];
		let merged = false;
		for (let index = completed.length - 1; index >= 0; index--) {
			const previous = completed[index];
			if (edits.some(edit => previous.edits.some(other => Range.areIntersectingOrTouching(edit.range, other.range)))) {
				range = range.plusRange(previous.range);
				completed.splice(index, 1);
				merged = true;
			}
		}
		if (merged) {
			// Query the union; conflicting results must never reach the model.
			pending.unshift(range);
		} else {
			completed.push({ range, edits });
		}
	}
	return completed.sort((left, right) => Range.compareRangesUsingStarts(left.range, right.range)).flatMap(result => result.edits);
}
