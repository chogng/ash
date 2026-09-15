import { EditorOption } from '../../../common/config/editorOptions.js';
import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { type View } from "../../../browser/view.js";
import { type IVersionedEditorWorkerClient } from "../../../browser/services/editorWorkerService.js";
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { type LanguageFormattingOptions, type LanguageFormattingProvider } from '../../../common/languages.js';
import { type LanguageFeatureRegistry } from '../../../common/languageFeatureRegistry.js';
import { type TextModel } from '../../../common/model/textModel.js';
import { type URI } from '../../../../base/common/uri.js';
import { getDocumentFormattingEditsUntilResult } from './format.js';
import { CodeEditorStateFlag, EditorStateCancellationTokenSource } from '../../editorState/browser/editorState.js';
import { FormattingEdit } from './formattingEdit.js';

export interface FormatControllerOptions {
	readonly formattingOptions?: LanguageFormattingOptions;
	readonly resource?: URI;
	readonly onError?: (error: unknown) => void;
}

/** Owns the editor formatting request and applies its result through FormattingEdit. */
export class FormatController extends Disposable {
	private readonly request = this._register(new MutableDisposable<DisposableStore>());
	private readonly options: LanguageFormattingOptions;
	private readonly onError: (error: unknown) => void;
	private readonly resource: URI | undefined;
	private readonly model: TextModel;

	constructor(
		private readonly editor: ICodeEditor,
		viewport: View,
		private readonly providers: LanguageFeatureRegistry<LanguageFormattingProvider>,
		private readonly editorWorker: IVersionedEditorWorkerClient,
		private readonly languageId: string,
		options: FormatControllerOptions = {},
	) {
		super();
		if (viewport.textModel !== editor.getModel()) throw new TypeError("Stanza format dependencies must share one text model");
		this.model = viewport.textModel;
		this.options = options.formattingOptions ?? { tabSize: 4, insertSpaces: true };
		this.resource = options.resource;
		this.onError = options.onError ?? (error => console.error("Stanza formatting failed", error));
		this._register(editor.onKeyDown(event => {
			if (event.browserEvent.defaultPrevented || event.isComposing || event.altKey || (!event.ctrlKey && !event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== 'i') return;
			event.stop();
			void this.formatDocument();
		}));
	}

	async formatDocument(onError = this.onError): Promise<void> {
		if (this.isDisposed || this.editor.getModel() !== this.model || this.editor.getOption(EditorOption.readOnly)) return;
		const resources = new DisposableStore();
		this.request.value = resources;
		const source = new EditorStateCancellationTokenSource(this.editor, CodeEditorStateFlag.Value | CodeEditorStateFlag.Position);
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
			const edits = await getDocumentFormattingEditsUntilResult(this.providers, this.model, this.languageId, this.options, abort.signal, this.resource);
			if (this.isDisposed || abort.signal.aborted || edits.length === 0) {
				return;
			}
			const minimalEdits = await this.editorWorker.computeMoreMinimalEdits(edits, abort.signal);
			if (this.isDisposed || abort.signal.aborted || !minimalEdits) {
				return;
			}
			const result = [...minimalEdits];
			const eolEdit = [...edits].reverse().find(edit => edit.eol !== undefined);
			if (eolEdit) {
				if (result.length > 0) {
					result[result.length - 1] = { ...result[result.length - 1], eol: eolEdit.eol };
				} else {
					result.push({
						range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
						text: '',
						eol: eolEdit.eol,
					});
				}
			}
			FormattingEdit.execute(this.editor, result, true);
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
		context.languageFeaturesService.documentFormattingEditProvider,
		context.editorWorker,
		context.languageId,
		{
			formattingOptions: { tabSize: context.options.indentation?.tabSize ?? 4, insertSpaces: context.options.indentation?.kind !== "tabs" },
			resource: context.options.input.resource,
			onError: context.onLanguageError,
		},
	));
	if (context.options.formatOnSave && context.registerBeforeSave) context.register(context.registerBeforeSave(() => controller.formatDocument()));
	return controller;
} });
