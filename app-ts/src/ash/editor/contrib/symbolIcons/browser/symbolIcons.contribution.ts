import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { SymbolIconsController } from "./symbolIcons.js";
import { DocumentSymbolService } from '../../documentSymbols/common/languageDocumentSymbols.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

registerEditorContribution({
	id: "editor.contrib.symbolIcons",
	configure: context => {
		if (context.options.showSymbolIcons === false || context.model.largeFile.tooLargeForTokenization) return;
		const service = context.register(new DocumentSymbolService(context.model, context.languageFeaturesService.documentSymbolProvider, { resource: context.model.uri }));
		context.register(context.getService(IInstantiationService).createInstance(SymbolIconsController,
			context.model,
			service,
			context.onLanguageError,
		));
	},
});
