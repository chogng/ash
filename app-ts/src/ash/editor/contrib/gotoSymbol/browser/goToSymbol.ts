import { type CancellationToken } from '../../../../base/common/cancellation.js';
import { onUnexpectedExternalError } from '../../../../base/common/errors.js';
import { type LanguageFeatureRegistry } from '../../../common/languageFeatureRegistry.js';
import { createLanguageFeatureRequest, isLanguageFeatureRequestCurrent, type LanguageLocation, type LocationLink, type LanguageLocationRequest, type LanguageDefinitionProvider, type LanguageDeclarationProvider, type LanguageImplementationProvider, type LanguageTypeDefinitionProvider, type LanguageReferenceProvider } from '../../../common/languages.js';
import { type TextModel } from '../../../common/model/textModel.js';
import { type Position } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';

async function collect<T>(
	registry: LanguageFeatureRegistry<T>,
	model: TextModel,
	position: Position,
	recursive: boolean,
	cancellation: CancellationToken | AbortSignal,
	provide: (provider: T, request: LanguageLocationRequest) => readonly LanguageLocation[] | Promise<readonly LanguageLocation[]>,
	onError: (error: unknown) => void,
): Promise<LocationLink[]> {
	const controller = new AbortController();
	const abort = () => controller.abort();
	const signal = 'aborted' in cancellation ? cancellation : controller.signal;
	const listener = 'aborted' in cancellation ? undefined : cancellation.onCancellationRequested(abort);
	if (!('aborted' in cancellation) && cancellation.isCancellationRequested) { controller.abort(); }
	const request = { ...createLanguageFeatureRequest(model, model.getLanguageId(), signal), resource: model.uri, position };
	const results: LocationLink[] = [];
	try {
		for (const provider of registry.ordered(model, recursive)) {
			if (!isLanguageFeatureRequestCurrent(request)) { return []; }
			try {
				const locations = await provide(provider, request);
				if (!isLanguageFeatureRequestCurrent(request)) { return []; }
				for (const location of locations) {
					const range = Range.lift(location.range);
					const targetSelectionRange = location.selectionRange && Range.lift(location.selectionRange);
					if (targetSelectionRange && !range.containsRange(targetSelectionRange)) {
						throw new RangeError('Symbol selection must be contained by its target range');
					}
					results.push({ uri: location.resource, range, targetSelectionRange });
				}
			} catch (error) {
				if (!signal.aborted) { onError(error); }
			}
		}
		return results;
	} finally {
		listener?.dispose();
	}
}

export function getDefinitionsAtPosition(
	registry: LanguageFeatureRegistry<LanguageDefinitionProvider>,
	model: TextModel,
	position: Position,
	recursive: boolean,
	token: CancellationToken | AbortSignal,
	onError: (error: unknown) => void = onUnexpectedExternalError,
): Promise<LocationLink[]> {
	return collect(registry, model, position, recursive, token, (provider, request) => provider.provideDefinition(request, request.signal), onError);
}

export function getDeclarationsAtPosition(
	registry: LanguageFeatureRegistry<LanguageDeclarationProvider>,
	model: TextModel,
	position: Position,
	recursive: boolean,
	token: CancellationToken | AbortSignal,
	onError: (error: unknown) => void = onUnexpectedExternalError,
): Promise<LocationLink[]> {
	return collect(registry, model, position, recursive, token, (provider, request) => provider.provideDeclaration(request, request.signal), onError);
}

export function getImplementationsAtPosition(
	registry: LanguageFeatureRegistry<LanguageImplementationProvider>,
	model: TextModel,
	position: Position,
	recursive: boolean,
	token: CancellationToken | AbortSignal,
	onError: (error: unknown) => void = onUnexpectedExternalError,
): Promise<LocationLink[]> {
	return collect(registry, model, position, recursive, token, (provider, request) => provider.provideImplementation(request, request.signal), onError);
}

export function getTypeDefinitionsAtPosition(
	registry: LanguageFeatureRegistry<LanguageTypeDefinitionProvider>,
	model: TextModel,
	position: Position,
	recursive: boolean,
	token: CancellationToken | AbortSignal,
	onError: (error: unknown) => void = onUnexpectedExternalError,
): Promise<LocationLink[]> {
	return collect(registry, model, position, recursive, token, (provider, request) => provider.provideTypeDefinition(request, request.signal), onError);
}

export function getReferencesAtPosition(
	registry: LanguageFeatureRegistry<LanguageReferenceProvider>,
	model: TextModel,
	position: Position,
	compact: boolean,
	recursive: boolean,
	token: CancellationToken | AbortSignal,
	onError: (error: unknown) => void = onUnexpectedExternalError,
): Promise<LocationLink[]> {
	return collect(registry, model, position, recursive, token, (provider, request) => provider.provideReferences({ ...request, includeDeclaration: !compact }, request.signal), onError);
}
