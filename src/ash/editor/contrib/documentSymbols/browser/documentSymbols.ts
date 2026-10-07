import { onUnexpectedExternalError } from '../../../../base/common/errors.js';
import { URI } from '../../../../base/common/uri.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { TextModel } from '../../../common/model/textModel.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { ITextModelService } from '../../../common/services/resolverService.js';
import { OutlineModel } from './outlineModel.js';

/** Resolves a resource for the document-symbol command without opening an editor. */
CommandsRegistry.register('_executeDocumentSymbolProvider', async (accessor, resource: unknown) => {
	if (!(resource instanceof URI)) throw new TypeError('Document symbol command requires a URI');
	const modelService = accessor.get(ITextModelService);
	const registry = accessor.get(ILanguageFeaturesService).documentSymbolProvider;
	const reference = await modelService.createModelReference(resource);
	try {
		const model = reference.object.textEditorModel;
		if (!(model instanceof TextModel)) throw new TypeError('Document symbol command requires an Ash text model');
		const outline = await OutlineModel.create(registry, model, new AbortController().signal, onUnexpectedExternalError);
		if (!outline) throw new Error('Document changed during symbol request');
		return outline.getTopLevelSymbols();
	} finally {
		reference.dispose();
	}
});
