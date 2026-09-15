import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { type ICodeEditorWidgetOptions } from '../../../browser/widget/codeEditor/codeEditorWidget.js';
import { LanguageCompletionService } from "../../../common/languages/completion/languageCompletionService.js";
import { isCompletionsEnabledFromObject } from "../../../common/services/completionsEnablement.js";
import { LanguageCompletionSessionController } from "../common/languageCompletionSessionController.js";
import { SuggestController } from "./suggestController.js";

registerEditorContribution({
	id: "editor.contrib.suggest",
	install: context => {
		if (context.kind !== "text") return;
		if (context.options.suggestions !== undefined && !isCompletionsEnabledFromObject(context.options.suggestions, context.languageId)) return;
		const completions = context.register(new LanguageCompletionService(context.model, context.languageFeaturesService.completionProvider, {
			resource: context.options.input.resource,
			...(context.options.completionWorkerFactory ? { workerFactory: context.options.completionWorkerFactory } : {}),
		}));
		const session = context.register(new LanguageCompletionSessionController(completions.results, context.selectionController, {
			resolver: completions,
			onResolveError: context.onLanguageError,
			onDidAccept: item => completions.executeCompletionCommand(context.languageId, item, new AbortController().signal),
			snippetVariables: createSnippetVariables(context.options.input),
		}));
		return new SuggestController(
			context.controller,
			context.selectionController,
			completions,
			session,
			context.languageId,
			{ onRequestError: context.onLanguageError },
		);
	},
});

function createSnippetVariables(input: ICodeEditorWidgetOptions['input']): { readonly resolveVariable: (name: string) => string | undefined } {
	const filePath = decodeURIComponent(input.resource.path);
	const separator = filePath.lastIndexOf("/");
	const filename = filePath.slice(separator + 1);
	const extension = filename.lastIndexOf(".");
	const filenameBase = extension > 0 ? filename.slice(0, extension) : filename;
	const directory = separator > 0 ? filePath.slice(0, separator) : "/";
	return Object.freeze({
		resolveVariable(name: string): string | undefined {
			switch (name) {
				case "TM_FILENAME": return filename;
				case "TM_FILENAME_BASE": return filenameBase;
				case "TM_DIRECTORY": return directory;
				case "TM_FILEPATH": return filePath;
				default: return undefined;
			}
		},
	});
}
