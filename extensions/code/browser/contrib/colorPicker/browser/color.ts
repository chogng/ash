import { onActivate } from '../../../registration.js';
import { onUnexpectedExternalError } from '../../../../../../src/ash/base/common/errors.js';
import { URI } from '../../../../../../src/ash/base/common/uri.js';
import { CommandsRegistry } from '../../../../../../src/ash/platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../src/ash/platform/configuration/common/configuration.js';
import type { ServicesAccessor } from '../../../registration.js';
import { Range } from '../../../../../../src/ash/editor/common/core/range.js';
import { TextModel } from '../../../../../../src/ash/editor/common/model/textModel.js';
import { IModelService } from '../../../../../../src/ash/editor/common/services/model.js';
import { ILanguageFeaturesService } from '../../../../../../src/ash/editor/common/services/languageFeatures.js';
import { ColorService, type DefaultColorDecoratorsEnablement } from '../common/languageColors.js';

function setupColorCommand(accessor: ServicesAccessor, resource: unknown): { model: TextModel; service: ColorService; enablement: DefaultColorDecoratorsEnablement; } {
	if (!(resource instanceof URI)) { throw new TypeError('Color provider command requires a URI'); }
	const model = accessor.get(IModelService).getModel(resource);
	if (!(model instanceof TextModel)) { throw new TypeError('Color provider command requires a loaded text model'); }
	const enablement = accessor.get(IConfigurationService).getValue<DefaultColorDecoratorsEnablement>('editor.defaultColorDecorators', { resource, overrideIdentifier: model.getLanguageId() });
	const service = new ColorService(model, accessor.get(ILanguageFeaturesService).colorProvider, resource, onUnexpectedExternalError);
	return { model, service, enablement };
}

onActivate(() => CommandsRegistry.register('_executeDocumentColorProvider', async (accessor, resource: unknown) => {
	const { model, service, enablement } = setupColorCommand(accessor, resource);
	const values = await service.provideDocumentColors(model.getLanguageId(), enablement, new AbortController().signal);
	return values.map(({ information: { range, color } }) => ({ range, color: [color.red, color.green, color.blue, color.alpha] }));
}));

onActivate(() => CommandsRegistry.register('_executeColorPresentationProvider', async (accessor, color: unknown, context: unknown) => {
	if (!context) { return undefined; }
	if (typeof context !== 'object' || !('uri' in context) || !('range' in context) || !Range.isIRange(context.range)) { throw new TypeError('Color presentation command requires a URI and range'); }
	if (!Array.isArray(color) || color.length !== 4 || color.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) { throw new TypeError('Color presentation command requires four color components in [0, 1]'); }
	const { model, service, enablement } = setupColorCommand(accessor, context.uri);
	const range = Range.lift(context.range);
	model.offsetAt(range.getStartPosition());
	model.offsetAt(range.getEndPosition());
	return service.provideColorPresentationsFromProviders(model.getLanguageId(), range, { red: color[0], green: color[1], blue: color[2], alpha: color[3] }, enablement, new AbortController().signal);
}));
