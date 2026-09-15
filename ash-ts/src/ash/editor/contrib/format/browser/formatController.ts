import { addDisposableListener, stopEvent } from "../../../../base/browser/dom.js";
import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { type View } from "../../../browser/view.js";
import { type IVersionedEditorWorkerClient } from "../../../browser/services/editorWorkerService.js";
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { FormatService, type LanguageFormattingOptions } from "../common/formatCommands.js";

export interface FormatControllerOptions {
	readonly formattingOptions?: LanguageFormattingOptions;
	readonly onError?: (error: unknown) => void;
}

/** Routes the editor format shortcut into the Stanza formatting service and command layer. */
export class FormatController extends Disposable {
	private readonly options: LanguageFormattingOptions;
	private readonly onError: (error: unknown) => void;

	constructor(
		private readonly input: HTMLElement,
		private readonly editor: ICodeEditor,
		viewport: View,
		private readonly service: FormatService,
		private readonly editorWorker: IVersionedEditorWorkerClient,
		private readonly languageId: string,
		options: FormatControllerOptions = {},
	) {
		super();
		if (viewport.textModel !== editor.getModel()) throw new TypeError("Stanza format dependencies must share one text model");
		this.options = options.formattingOptions ?? { tabSize: 4, insertSpaces: true };
		this.onError = options.onError ?? (error => console.error("Stanza formatting failed", error));
		this._register(addDisposableListener(input, "keydown", event => {
			if (event.defaultPrevented || event.isComposing || event.altKey || (!event.ctrlKey && !event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== "i") return;
			stopEvent(event);
			void this.formatDocument();
		}));
	}

	async formatDocument(onError = this.onError): Promise<void> {
		try {
			const edits = await this.service.provideDocumentFormattingEdits(this.languageId, this.options);
			const minimalEdits = await this.editorWorker.computeMoreMinimalEdits(edits);
			if (!minimalEdits) return;
			if (minimalEdits.length === 0) return;
			this.editor.pushUndoStop();
			this.editor.executeEdits('editor.action.formatDocument', [...minimalEdits]);
			this.editor.pushUndoStop();
		} catch (error) {
			onError(error);
		}
	}
}

registerEditorContribution({ id: "editor.contrib.format", install: context => {
	if (context.kind !== "text") return;
	const service = context.register(new FormatService(
		context.model,
		context.languageFeaturesService.documentFormattingEditProvider,
		context.languageFeaturesService.documentRangeFormattingEditProvider,
		context.languageFeaturesService.onTypeFormattingEditProvider,
		context.options.input.resource,
	));
	const controller = context.register(new FormatController(
		context.controller.element,
		context.editor,
		context.view,
		service,
		context.editorWorker,
		context.languageId,
		{
			formattingOptions: { tabSize: context.options.indentation?.tabSize ?? 4, insertSpaces: context.options.indentation?.kind !== "tabs" },
			onError: context.onLanguageError,
		},
	));
	if (context.options.formatOnSave && context.registerBeforeSave) context.register(context.registerBeforeSave(() => controller.formatDocument()));
	return controller;
} });
