import { Disposable } from '../../../../base/common/lifecycle.js';
import { type URI } from '../../../../base/common/uri.js';
import { type Range } from '../../../common/core/range.js';
import { createLanguageFeatureRequest, isLanguageFeatureRequestCurrent, type LanguageFeatureRequest } from '../../../common/languages.js';
import { LanguageFeatureRegistry } from '../../../common/languageFeatureRegistry.js';
import { type TextModel } from '../../../common/model/textModel.js';

export interface LanguageSelectionRangeRequest extends LanguageFeatureRequest {
	readonly resource?: URI;
	readonly ranges: readonly Range[];
}

export interface LanguageSelectionRangeProvider {
	provideSelectionRanges(request: LanguageSelectionRangeRequest, signal: AbortSignal): readonly Range[] | Promise<readonly Range[]>;
}

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
