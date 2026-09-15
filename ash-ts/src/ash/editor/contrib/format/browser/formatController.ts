import { raceCancellationError } from '../../../../base/common/async.js';
import { type CancellationToken } from '../../../../base/common/cancellation.js';
import { Range } from '../../../common/core/range.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { type View } from "../../../browser/view.js";
import { type IVersionedEditorWorkerClient } from "../../../browser/services/editorWorkerService.js";
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { type LanguageFormattingOptions, type TextEdit } from '../../../common/languages.js';
import { type ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { type TextModel } from '../../../common/model/textModel.js';
import { getDocumentFormattingEditsUntilResult } from './format.js';
import { CodeEditorStateFlag, EditorStateCancellationTokenSource } from '../../editorState/browser/editorState.js';
import { FormattingEdit } from './formattingEdit.js';

export interface FormatControllerOptions {
	readonly formattingOptions?: LanguageFormattingOptions;
	readonly onError?: (error: unknown) => void;
}

/** Owns the editor formatting request and applies its result through FormattingEdit. */
export class FormatController extends Disposable {
	private readonly request = this._register(new MutableDisposable<DisposableStore>());
	private readonly options: LanguageFormattingOptions;
	private readonly onError: (error: unknown) => void;
	private readonly model: TextModel;

	constructor(
		private readonly editor: ICodeEditor,
		viewport: View,
		private readonly languageFeaturesService: ILanguageFeaturesService,
		private readonly editorWorker: IVersionedEditorWorkerClient,
		options: FormatControllerOptions = {},
	) {
		super();
		if (viewport.textModel !== editor.getModel()) throw new TypeError("Stanza format dependencies must share one text model");
		this.model = viewport.textModel;
		this.options = options.formattingOptions ?? { tabSize: 4, insertSpaces: true };
		this.onError = options.onError ?? (error => console.error("Stanza formatting failed", error));
		this._register(editor.onKeyDown(event => {
			if (event.browserEvent.defaultPrevented || event.isComposing || event.altKey || (!event.ctrlKey && !event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== 'i') return;
			event.stop();
			void this.formatDocument();
		}));
	}

	async formatDocument(onError = this.onError): Promise<void> {
		await this.format(token => getDocumentFormattingEditsUntilResult(this.languageFeaturesService, this.model, this.options, token), onError);
	}

	async formatSelection(): Promise<void> {
		if (this.isDisposed || this.editor.getModel() !== this.model || this.editor.getOption(EditorOption.readOnly)) {
			return;
		}
		const provider = this.languageFeaturesService.documentRangeFormattingEditProvider.ordered(this.model)[0];
		if (!provider) {
			return;
		}
		const ranges: Range[] = [];
		const selections = (this.editor.getSelections() ?? []).map(selection => selection.isEmpty()
			? new Range(selection.startLineNumber, 1, selection.startLineNumber, this.model.getLineMaxColumn(selection.startLineNumber))
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
		await this.format(async token => {
			if (provider.provideDocumentRangesFormattingEdits) {
				return provider.provideDocumentRangesFormattingEdits(this.model, ranges, this.options, token);
			}
			const edits: TextEdit[] = [];
			for (const range of ranges) {
				if (token.isCancellationRequested) {
					return undefined;
				}
				const result = await raceCancellationError(Promise.resolve(
					provider.provideDocumentRangeFormattingEdits(this.model, range, this.options, token),
				), token);
				if (result) {
					edits.push(...result);
				}
			}
			return edits;
		}, this.onError);
	}

	private async format(
		provide: (token: CancellationToken) => Promise<TextEdit[] | null | undefined>,
		onError: (error: unknown) => void,
	): Promise<void> {
		if (this.isDisposed || this.editor.getModel() !== this.model || this.editor.getOption(EditorOption.readOnly)) return;
		const resources = new DisposableStore();
		this.request.value = resources;
		const source = new EditorStateCancellationTokenSource(this.editor, CodeEditorStateFlag.Value | CodeEditorStateFlag.Position | CodeEditorStateFlag.Selection);
		const abort = new AbortController();
		resources.add(toDisposable(() => {
			abort.abort();
			source.dispose(true);
		}));
		resources.add(source.token.onCancellationRequested(() => abort.abort()));
		resources.add(this.editor.onDidChangeConfiguration(() => {
			if (this.editor.getOption(EditorOption.readOnly)) source.cancel();
		}));
		try {
			const edits = await raceCancellationError(provide(source.token), source.token);
			if (this.isDisposed || abort.signal.aborted || !edits || edits.length === 0) {
				return;
			}
			const minimalEdits = await this.editorWorker.computeMoreMinimalEdits(edits, abort.signal);
			if (this.isDisposed || abort.signal.aborted || !minimalEdits) {
				return;
			}
			FormattingEdit.execute(this.editor, [...minimalEdits], true);
		} catch (error) {
			if (!abort.signal.aborted) onError(error);
		} finally {
			if (this.request.value === resources) this.request.clear();
		}
	}
}

registerEditorContribution({ id: "editor.contrib.format", install: context => {
	if (context.kind !== "text") return;
	const controller = context.register(new FormatController(
		context.editor,
		context.view,
		context.languageFeaturesService,
		context.editorWorker,
		{
			formattingOptions: { tabSize: context.options.indentation?.tabSize ?? 4, insertSpaces: context.options.indentation?.kind !== "tabs" },
			onError: context.onLanguageError,
		},
	));
	if (context.options.formatOnSave && context.registerBeforeSave) context.register(context.registerBeforeSave(() => controller.formatDocument()));
	return controller;
} });
