import { Disposable } from "../../../../base/common/lifecycle.js";
import { type Position } from "../../../common/core/position.js";
import { type Range } from "../../../common/core/range.js";
import { createLanguageFeatureRequest, isLanguageFeatureRequestCurrent, type LanguageFeatureRequest } from "../../../common/languages.js";
import { LanguageFeatureRegistry } from "../../../common/languageFeatureRegistry.js";
import { type TextModel } from "../../../common/model/textModel.js";
import { type URI } from "../../../../base/common/uri.js";

export type LanguageInlayHintKind = "type" | "parameter" | "other";
export type LanguageInlayHintLabel = string | readonly { readonly value: string; readonly location?: Range }[];

export interface LanguageInlayHint {
	readonly position: Position;
	readonly label: LanguageInlayHintLabel;
	readonly kind?: LanguageInlayHintKind;
	readonly tooltip?: string;
	readonly paddingLeft?: boolean;
	readonly paddingRight?: boolean;
}

export interface LanguageInlayHintsRequest extends LanguageFeatureRequest {
	readonly resource?: URI;
	readonly range: Range;
}

export interface LanguageInlayHintsProvider {
	provideInlayHints(request: LanguageInlayHintsRequest, signal: AbortSignal): readonly LanguageInlayHint[] | Promise<readonly LanguageInlayHint[]>;
}

/** Computes versioned inlay hints; browser rendering owns only the visual projection. */
export class InlayHintsService extends Disposable {
	constructor(private readonly model: TextModel, private readonly providers: LanguageFeatureRegistry<LanguageInlayHintsProvider>, private readonly resource?: URI) {
		super();
	}

	async provideInlayHints(languageId: string, range: Range, signal: AbortSignal = new AbortController().signal): Promise<readonly LanguageInlayHint[]> {
		const request = { ...createLanguageFeatureRequest(this.model, languageId, signal), ...(this.resource ? { resource: this.resource } : {}), range };
		const result: LanguageInlayHint[] = [];
		for (const provider of this.providers.ordered(this.model)) {
			if (!isLanguageFeatureRequestCurrent(request)) return Object.freeze([]);
			const hints = await provider.provideInlayHints(request, signal);
			if (!isLanguageFeatureRequestCurrent(request)) return Object.freeze([]);
			result.push(...hints.map(normalizeLanguageInlayHint));
		}
		return Object.freeze(result);
	}
}

function normalizeLanguageInlayHint(hint: LanguageInlayHint): LanguageInlayHint {
	if (!hint || typeof hint !== "object" || typeof hint.position?.lineNumber !== "number") throw new TypeError("Inlay hint has invalid position");
	return Object.freeze({
		position: hint.position,
		label: typeof hint.label === "string" ? hint.label : Object.freeze(hint.label.map(part => Object.freeze({ value: part.value, ...(part.location ? { location: part.location } : {}) }))),
		...(hint.kind ? { kind: hint.kind } : {}),
		...(hint.tooltip !== undefined ? { tooltip: hint.tooltip } : {}),
		...(hint.paddingLeft !== undefined ? { paddingLeft: hint.paddingLeft } : {}),
		...(hint.paddingRight !== undefined ? { paddingRight: hint.paddingRight } : {}),
	});
}
