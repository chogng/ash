import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { SymbolIconsController } from "./symbolIcons.js";
import { TextEditorCapability } from "../../textEditorCapabilities.js";
import { DocumentSymbolService } from '../../documentSymbols/common/languageDocumentSymbols.js';

registerEditorContribution({
	id: "editor.contrib.symbolIcons",
	configure: context => {
		if (context.options.showSymbolIcons === false || context.model.largeFile.tooLargeForTokenization) return;
		const service = context.register(new DocumentSymbolService(context.model, context.languageFeaturesService.documentSymbolProvider, { resource: context.options.input.resource }));
		context.register(new SymbolIconsController(
			context.model,
			service,
			context.languageId,
			context.onLanguageError,
		));
	},
});
