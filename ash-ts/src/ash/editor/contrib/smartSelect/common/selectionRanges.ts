import { Disposable } from '../../../../base/common/lifecycle.js';
import { type URI } from '../../../../base/common/uri.js';
import { type Range } from '../../../common/core/range.js';
import { createLanguageFeatureRequest, isLanguageFeatureRequestCurrent, type LanguageSelectionRangeRequest, type LanguageSelectionRangeProvider } from '../../../common/languages.js';
import { LanguageFeatureRegistry } from '../../../common/languageFeatureRegistry.js';
import { type TextModel } from '../../../common/model/textModel.js';

/** Collects versioned structural selection candidates from registered language providers. */
export class SelectionRangeService extends Disposable {
	constructor(private readonly model: TextModel, private readonly providers: LanguageFeatureRegistry<LanguageSelectionRangeProvider>, private readonly resource?: URI) {
		super();
	}

	async provideSelectionRanges(languageId: string, ranges: readonly Range[], signal: AbortSignal = new AbortController().signal): Promise<readonly Range[]> {
		const request: LanguageSelectionRangeRequest = Object.freeze({ ...createLanguageFeatureRequest(this.model, languageId, signal), ranges: Object.freeze([...ranges]), ...(this.resource ? { resource: this.resource } : {}) });
		const result: Range[] = [];
		for (const provider of this.providers.ordered(this.model)) {
			if (!isLanguageFeatureRequestCurrent(request)) return Object.freeze([]);
			result.push(...await provider.provideSelectionRanges(request, signal));
			if (!isLanguageFeatureRequestCurrent(request)) return Object.freeze([]);
		}
		return Object.freeze(result);
	}
}
