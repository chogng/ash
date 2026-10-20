import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { type LanguageFeatureRegistry } from '../../../common/languageFeatureRegistry.js';
import { isLanguageFeatureRequestCurrent, type LanguageParameterHints, type LanguageParameterHintsProvider, type LanguageParameterHintsRequest, type LanguageParameterInformation } from '../../../common/languages.js';

export const Context = {
	Visible: new RawContextKey<boolean>('parameterHintsVisible', false),
	MultipleSignatures: new RawContextKey<boolean>('parameterHintsMultipleSignatures', false),
};

/** Tries matching providers in priority order using one versioned editor request. */
export async function provideSignatureHelp(
	registry: LanguageFeatureRegistry<LanguageParameterHintsProvider>,
	request: LanguageParameterHintsRequest,
	onError: (error: unknown) => void,
): Promise<LanguageParameterHints | undefined> {
	for (const provider of registry.ordered(request.model)) {
		if (!isLanguageFeatureRequestCurrent(request)) return undefined;
		if (request.context.kind === 'triggerCharacter'
			&& !provider.signatureHelpTriggerCharacters?.includes(request.context.triggerCharacter)
			&& !(request.context.isRetrigger && provider.signatureHelpRetriggerCharacters?.includes(request.context.triggerCharacter))) {
			continue;
		}
		try {
			const value = await provider.provideParameterHints(request, request.signal);
			if (!isLanguageFeatureRequestCurrent(request)) return undefined;
			if (value) {
				const hints = normalizeParameterHints(value);
				if (hints.signatures.length > 0) return hints;
			}
		} catch (error) {
			if (isLanguageFeatureRequestCurrent(request)) onError(error);
		}
	}
	return undefined;
}

function normalizeParameterHints(value: LanguageParameterHints): LanguageParameterHints {
	if (!value || typeof value !== 'object' || !Array.isArray(value.signatures)) {
		throw new TypeError('Parameter hints signatures must be an array');
	}
	validateActiveIndex(value.activeSignature, value.signatures.length);
	const signatures = value.signatures.map(signature => {
		if (!signature || typeof signature.label !== 'string' || !Array.isArray(signature.parameters)
			|| (signature.documentation !== undefined && typeof signature.documentation !== 'string')) {
			throw new TypeError('Parameter hints must contain a label, parameters and optional text documentation');
		}
		validateActiveIndex(signature.activeParameter, signature.parameters.length);
		const parameters = signature.parameters.map((parameter: LanguageParameterInformation) => {
			if (!parameter || typeof parameter.label !== 'string'
				|| (parameter.documentation !== undefined && typeof parameter.documentation !== 'string')) {
				throw new TypeError('Parameter labels and documentation must be text');
			}
			return Object.freeze({ label: parameter.label, documentation: parameter.documentation });
		});
		return Object.freeze({
			label: signature.label,
			documentation: signature.documentation,
			parameters: Object.freeze(parameters),
			activeParameter: signature.activeParameter,
		});
	});
	return Object.freeze({ signatures: Object.freeze(signatures), activeSignature: value.activeSignature });
}

function validateActiveIndex(index: number | undefined, length: number): void {
	if (index !== undefined && (!Number.isInteger(index) || index < 0 || index >= Math.max(1, length))) {
		throw new TypeError('Parameter hints active index is outside the returned signatures or parameters');
	}
}
