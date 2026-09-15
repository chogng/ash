import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { GotoSymbolController } from "./gotoSymbolController.js";
import { DocumentSymbolService } from '../../documentSymbols/common/languageDocumentSymbols.js';
import { GotoSymbolService } from '../common/languageDocumentSymbolSearch.js';

registerEditorContribution({ id: "editor.contrib.gotoSymbol", install: context => {
	if (context.kind !== "text") return;
	const symbols = new DocumentSymbolService(context.model, context.languageFeaturesService.documentSymbolProvider, { resource: context.options.input.resource });
	const service = context.register(new GotoSymbolService(symbols));
	context.register(new GotoSymbolController(
		context.controller.element,
		context.view,
		context.viewModel,
		service,
		context.languageId,
		context.onLanguageError,
	));
} });
