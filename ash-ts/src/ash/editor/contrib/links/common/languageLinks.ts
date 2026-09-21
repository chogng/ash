import { Disposable } from "../../../../base/common/lifecycle.js";
import { type URI } from "../../../../base/common/uri.js";
import { Range } from "../../../common/core/range.js";
import { createLanguageFeatureRequest, isLanguageFeatureRequestCurrent, type LanguageLink, type LanguageLinkRequest, type LanguageLinkProvider } from "../../../common/languages.js";
import { computeLinks } from '../../../common/languages/linkComputer.js';
import { LanguageFeatureRegistry } from "../../../common/languageFeatureRegistry.js";
import { type TextModel } from "../../../common/model/textModel.js";

/** Provides link candidates; opening a target remains a host-owned operation. */
export class LinkService extends Disposable {
	constructor(private readonly model: TextModel, private readonly providers: LanguageFeatureRegistry<LanguageLinkProvider>, private readonly resource?: URI) {
		super();
	}

	async provideLinks(languageId: string, signal: AbortSignal = new AbortController().signal): Promise<readonly LanguageLink[]> {
		this.assertNotDisposed();
		const request: LanguageLinkRequest = Object.freeze({ ...createLanguageFeatureRequest(this.model, languageId, signal), ...(this.resource ? { resource: this.resource } : {}) });
		const links: LanguageLink[] = [];
		const seen = new Set<string>();
		for (const provider of this.providers.ordered(this.model)) {
			if (!isLanguageFeatureRequestCurrent(request)) return Object.freeze([]);
			const result = await provider.provideLinks(request, signal);
			if (!isLanguageFeatureRequestCurrent(request)) return Object.freeze([]);
			for (const link of result) {
				if (typeof link.target !== "string" || link.target.length === 0) continue;
				const key = `${this.model.offsetAt(link.range.getStartPosition())}:${this.model.offsetAt(link.range.getEndPosition())}:${link.target}`;
				if (seen.has(key)) continue;
				seen.add(key);
				links.push(Object.freeze({ range: link.range, target: link.target, ...(link.tooltip !== undefined ? { tooltip: link.tooltip } : {}) }));
			}
		}
		if (!isLanguageFeatureRequestCurrent(request) || this.isDisposed) return Object.freeze([]);
		const providerRanges = links.map(link => link.range);
		for (const link of computeLinks(this.model)) {
			const range = Range.lift(link.range);
			if (providerRanges.some(existing => Range.areIntersecting(existing, range))) continue;
			links.push(Object.freeze({ range, target: String(link.url) }));
		}
		return Object.freeze(links);
	}
}
