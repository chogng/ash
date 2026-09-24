import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { SymbolIconsController } from "./symbolIcons.js";
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

registerEditorContribution({
	id: "editor.contrib.symbolIcons",
	configure: context => {
		if (context.options.showSymbolIcons === false || context.model.largeFile.tooLargeForTokenization) return;
		context.register(context.getService(IInstantiationService).createInstance(SymbolIconsController,
			context.model,
			context.onLanguageError,
		));
	},
});
