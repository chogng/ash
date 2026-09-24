import { Disposable } from "../../../../base/common/lifecycle.js";
import { type URI } from "../../../../base/common/uri.js";
import { createLanguageFeatureRequest, isLanguageFeatureRequestCurrent, type LanguageFoldingRange, type LanguageFoldingRangeRequest, type LanguageFoldingRangeProvider } from '../../../common/languages.js';
import { LanguageFeatureRegistry } from "../../../common/languageFeatureRegistry.js";
import { type TextModel } from "../../../common/model/textModel.js";

/** Owns versioned language-server folding requests independently of browser projection state. */
export class FoldingRangeService extends Disposable {
	constructor(private readonly model: TextModel, private readonly providers: LanguageFeatureRegistry<LanguageFoldingRangeProvider>, private readonly resource?: URI) {
		super();
	}

	async provideFoldingRanges(languageId: string, signal: AbortSignal = new AbortController().signal): Promise<readonly LanguageFoldingRange[]> {
		const request: LanguageFoldingRangeRequest = Object.freeze({ ...createLanguageFeatureRequest(this.model, languageId, signal), ...(this.resource ? { resource: this.resource } : {}) });
		const result: LanguageFoldingRange[] = [];
		for (const provider of this.providers.ordered(this.model)) {
			if (!isLanguageFeatureRequestCurrent(request)) return Object.freeze([]);
			const ranges = await provider.provideFoldingRanges(request, signal);
			if (!isLanguageFeatureRequestCurrent(request)) return Object.freeze([]);
			result.push(...ranges.map(normalizeLanguageFoldingRange));
		}
		return Object.freeze(result);
	}
}

function normalizeLanguageFoldingRange(range: LanguageFoldingRange): LanguageFoldingRange {
	if (!Number.isSafeInteger(range.startLineIndex) || !Number.isSafeInteger(range.endLineIndex) || range.startLineIndex < 0 || range.endLineIndex <= range.startLineIndex) throw new RangeError("Language folding range is invalid");
	return Object.freeze({ startLineIndex: range.startLineIndex, endLineIndex: range.endLineIndex, ...(range.kind ? { kind: range.kind } : {}), ...(range.collapsedText ? { collapsedText: range.collapsedText } : {}) });
}
