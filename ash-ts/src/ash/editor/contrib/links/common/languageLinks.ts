import { Disposable } from "../../../../base/common/lifecycle.js";
import { type URI } from "../../../../base/common/uri.js";
import { type Range } from "../../../common/core/range.js";
import { createLanguageFeatureRequest, isLanguageFeatureRequestCurrent, type LanguageFeatureRequest } from "../../../common/languages.js";
import { LanguageFeatureRegistry } from "../../../common/languageFeatureRegistry.js";
import { type TextModel } from "../../../common/model/textModel.js";

export interface LanguageLink {
	readonly range: Range;
	readonly target: string;
	readonly tooltip?: string;
}

export interface LanguageLinkRequest extends LanguageFeatureRequest {
	readonly resource?: URI;
}

export interface LanguageLinkProvider {
	provideLinks(request: LanguageLinkRequest, signal: AbortSignal): readonly LanguageLink[] | Promise<readonly LanguageLink[]>;
}

/** Provides link candidates; opening a target remains a host-owned operation. */
export class LinkService extends Disposable {
	constructor(private readonly model: TextModel, private readonly providers: LanguageFeatureRegistry<LanguageLinkProvider>, private readonly resource?: URI) {
		super();
	}

	async provideLinks(languageId: string, signal: AbortSignal = new AbortController().signal): Promise<readonly LanguageLink[]> {
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
		return Object.freeze(links);
	}
}
