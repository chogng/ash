import { Disposable } from "../../../../base/common/lifecycle.js";
import { type Position } from "../../../common/core/position.js";
import { createLanguageFeatureRequest, isLanguageFeatureRequestCurrent, type LanguageFeatureRequest } from "../../../common/languages.js";
import { LanguageFeatureRegistry } from "../../../common/languageFeatureRegistry.js";
import { type TextModel } from "../../../common/model/textModel.js";
import { type URI } from "../../../../base/common/uri.js";

export interface LanguageParameterInformation {
	readonly label: string;
	readonly documentation?: string;
}

export interface LanguageSignatureInformation {
	readonly label: string;
	readonly documentation?: string;
	readonly parameters: readonly LanguageParameterInformation[];
	readonly activeParameter?: number;
}

export interface LanguageParameterHints {
	readonly signatures: readonly LanguageSignatureInformation[];
	readonly activeSignature?: number;
}

export interface LanguageParameterHintsRequest extends LanguageFeatureRequest {
	readonly resource?: URI;
	readonly position: Position;
	readonly context: LanguageParameterHintsContext;
}

export type LanguageParameterHintsContext = { readonly kind: "invoke" } | { readonly kind: "triggerCharacter"; readonly triggerCharacter: string } | { readonly kind: "contentChange" };

export interface LanguageParameterHintsProvider {
	provideParameterHints(request: LanguageParameterHintsRequest, signal: AbortSignal): LanguageParameterHints | undefined | Promise<LanguageParameterHints | undefined>;
}

/** Queries signature help independently of completion and keeps active indices provider-owned. */
export class ParameterHintsService extends Disposable {
	constructor(private readonly model: TextModel, private readonly providers: LanguageFeatureRegistry<LanguageParameterHintsProvider>, private readonly resource?: URI) {
		super();
	}

	async provideParameterHints(languageId: string, position: Position, context: LanguageParameterHintsContext = { kind: "invoke" }, signal: AbortSignal = new AbortController().signal): Promise<LanguageParameterHints | undefined> {
		const request = { ...createLanguageFeatureRequest(this.model, languageId, signal), ...(this.resource ? { resource: this.resource } : {}), position, context };
		for (const provider of this.providers.ordered(this.model)) {
			const value = await provider.provideParameterHints(request, signal);
			if (!isLanguageFeatureRequestCurrent(request)) return undefined;
			if (value) return normalizeLanguageParameterHints(value);
		}
		return undefined;
	}
}

function normalizeLanguageParameterHints(value: LanguageParameterHints): LanguageParameterHints {
	if (!value || typeof value !== "object" || !Array.isArray(value.signatures)) throw new TypeError("Parameter hints signatures must be an array");
	return Object.freeze({ signatures: Object.freeze(value.signatures.map(signature => Object.freeze({ label: signature.label, ...(signature.documentation !== undefined ? { documentation: signature.documentation } : {}), parameters: Object.freeze(signature.parameters.map((parameter: LanguageParameterInformation) => Object.freeze({ label: parameter.label, ...(parameter.documentation !== undefined ? { documentation: parameter.documentation } : {}) }))), ...(signature.activeParameter !== undefined ? { activeParameter: signature.activeParameter } : {}) }))), ...(value.activeSignature !== undefined ? { activeSignature: value.activeSignature } : {}) });
}
