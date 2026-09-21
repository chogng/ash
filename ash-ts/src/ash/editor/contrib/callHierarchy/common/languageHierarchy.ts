import { Disposable } from "../../../../base/common/lifecycle.js";
import { type URI } from "../../../../base/common/uri.js";
import { type Position } from "../../../common/core/position.js";
import { Range } from "../../../common/core/range.js";
import { createLanguageFeatureRequest, isLanguageFeatureRequestCurrent, type LanguageHierarchyItem, type LanguageCallHierarchyEntry, type LanguageHierarchyRequest, type LanguageCallHierarchyProvider, type LanguageTypeHierarchyProvider } from '../../../common/languages.js';
import { LanguageFeatureRegistry } from "../../../common/languageFeatureRegistry.js";
import { type TextModel } from "../../../common/model/textModel.js";

export interface PreparedCallHierarchy {
	readonly roots: readonly LanguageHierarchyItem[];
	incoming(item: LanguageHierarchyItem): Promise<readonly LanguageCallHierarchyEntry[]>;
	outgoing(item: LanguageHierarchyItem): Promise<readonly LanguageCallHierarchyEntry[]>;
}

export interface PreparedTypeHierarchy {
	readonly roots: readonly LanguageHierarchyItem[];
	supertypes(item: LanguageHierarchyItem): Promise<readonly LanguageHierarchyItem[]>;
	subtypes(item: LanguageHierarchyItem): Promise<readonly LanguageHierarchyItem[]>;
}

/** Coordinates prepare/follow-up hierarchy requests while preserving provider identity and revision freshness. */
export class LanguageHierarchyService extends Disposable {
	constructor(private readonly model: TextModel, private readonly resource: URI, private readonly callProviders: LanguageFeatureRegistry<LanguageCallHierarchyProvider>, private readonly typeProviders: LanguageFeatureRegistry<LanguageTypeHierarchyProvider>) { super(); }

	async prepareCallHierarchy(languageId: string, position: Position, signal: AbortSignal = new AbortController().signal): Promise<readonly PreparedCallHierarchy[]> {
		const request = { ...createLanguageFeatureRequest(this.model, languageId, signal), resource: this.resource, position };
		const prepared: PreparedCallHierarchy[] = [];
		for (const provider of this.callProviders.ordered(this.model)) {
			const roots = normalizeItems(await provider.prepareCallHierarchy(request, signal));
			if (!isLanguageFeatureRequestCurrent(request)) return Object.freeze([]);
			if (roots.length === 0) continue;
			prepared.push(Object.freeze({
				roots,
				incoming: (item: LanguageHierarchyItem) => this.followCall(provider, request, item, "incoming"),
				outgoing: (item: LanguageHierarchyItem) => this.followCall(provider, request, item, "outgoing"),
			}));
		}
		return Object.freeze(prepared);
	}

	async prepareTypeHierarchy(languageId: string, position: Position, signal: AbortSignal = new AbortController().signal): Promise<readonly PreparedTypeHierarchy[]> {
		const request = { ...createLanguageFeatureRequest(this.model, languageId, signal), resource: this.resource, position };
		const prepared: PreparedTypeHierarchy[] = [];
		for (const provider of this.typeProviders.ordered(this.model)) {
			const roots = normalizeItems(await provider.prepareTypeHierarchy(request, signal));
			if (!isLanguageFeatureRequestCurrent(request)) return Object.freeze([]);
			if (roots.length === 0) continue;
			prepared.push(Object.freeze({
				roots,
				supertypes: (item: LanguageHierarchyItem) => this.followType(provider, request, item, "supertypes"),
				subtypes: (item: LanguageHierarchyItem) => this.followType(provider, request, item, "subtypes"),
			}));
		}
		return Object.freeze(prepared);
	}

	private async followCall(provider: LanguageCallHierarchyProvider, prepared: LanguageHierarchyRequest, item: LanguageHierarchyItem, direction: "incoming" | "outgoing"): Promise<readonly LanguageCallHierarchyEntry[]> {
		if (this.isDisposed || !isLanguageFeatureRequestCurrent(prepared)) return Object.freeze([]);
		const request = { ...prepared, item };
		const signal = request.signal;
		const entries = direction === "incoming" ? await provider.provideIncomingCalls(request, signal) : await provider.provideOutgoingCalls(request, signal);
		if (!isLanguageFeatureRequestCurrent(request)) return Object.freeze([]);
		return Object.freeze(entries.map(entry => Object.freeze({ item: normalizeItem(entry.item), ...(entry.fromResource ? { fromResource: entry.fromResource } : {}), fromRanges: Object.freeze(entry.fromRanges.map(normalizeRange)) })));
	}

	private async followType(provider: LanguageTypeHierarchyProvider, prepared: LanguageHierarchyRequest, item: LanguageHierarchyItem, direction: "supertypes" | "subtypes"): Promise<readonly LanguageHierarchyItem[]> {
		if (this.isDisposed || !isLanguageFeatureRequestCurrent(prepared)) return Object.freeze([]);
		const request = { ...prepared, item };
		const signal = request.signal;
		const items = direction === "supertypes" ? await provider.provideSupertypes(request, signal) : await provider.provideSubtypes(request, signal);
		return isLanguageFeatureRequestCurrent(request) ? normalizeItems(items) : Object.freeze([]);
	}
}

function normalizeItems(items: readonly LanguageHierarchyItem[]): readonly LanguageHierarchyItem[] { return Object.freeze(items.map(normalizeItem)); }
function normalizeRange(range: Range): Range { return Range.fromPositions(range.getStartPosition(), range.getEndPosition()); }
function normalizeItem(item: LanguageHierarchyItem): LanguageHierarchyItem {
	const range = normalizeRange(item.range);
	const selectionRange = normalizeRange(item.selectionRange);
	if (!range.containsRange(selectionRange)) throw new RangeError("Hierarchy selection range must be contained by its symbol range");
	return Object.freeze({ name: item.name, symbolKind: item.symbolKind, ...(item.detail ? { detail: item.detail } : {}), resource: item.resource, range, selectionRange, ...(item.data === undefined ? {} : { data: item.data }) });
}
