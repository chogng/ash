import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { type Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { type TextModel } from '../../../../editor/common/model/textModel.js';
import { type LanguageFeatureRegistry } from '../../../../editor/common/languageFeatureRegistry.js';
import { createLanguageFeatureRequest, isLanguageFeatureRequestCurrent, type LanguageHierarchyItem, type LanguageHierarchyRequest, type LanguageCallHierarchyProvider, type LanguageCallHierarchyEntry, } from '../../../../editor/common/languages.js';

export const enum CallHierarchyDirection {
	CallsTo = 'incomingCalls',
	CallsFrom = 'outgoingCalls',
}

/** Retains each item's provider and preparation snapshot through descendant queries. */
export class CallHierarchyModel extends Disposable {
	private readonly providers = new Map<LanguageHierarchyItem, LanguageCallHierarchyProvider>();

	private constructor(public readonly roots: readonly LanguageHierarchyItem[], private readonly request: LanguageHierarchyRequest) {
		super();
		this._register(toDisposable(() => this.providers.clear()));
	}

	public static async create(
		model: TextModel, position: Position, signal: AbortSignal,
		registry: LanguageFeatureRegistry<LanguageCallHierarchyProvider>, onError: (error: unknown) => void,
	): Promise<CallHierarchyModel | undefined> {
		const request = Object.freeze({ ...createLanguageFeatureRequest(model, model.getLanguageId(), signal), resource: model.uri, position });
		const roots: LanguageHierarchyItem[] = [];
		const result = new CallHierarchyModel(roots, request);
		for (const provider of registry.ordered(model)) {
			if (!isLanguageFeatureRequestCurrent(request)) {
				result.dispose();
				return undefined;
			}
			try {
				const items = await provider.prepareCallHierarchy(request, signal);
				if (!isLanguageFeatureRequestCurrent(request)) {
					result.dispose();
					return undefined;
				}
				for (const item of items) {
					const normalized = normalizeItem(item);
					result.providers.set(normalized, provider);
					roots.push(normalized);
				}
			} catch (error) {
				if (!signal.aborted) { onError(error); }
			}
		}
		if (roots.length === 0) {
			result.dispose();
			return undefined;
		}
		Object.freeze(roots);
		return result;
	}

	public async resolveIncomingCalls(item: LanguageHierarchyItem): Promise<readonly LanguageCallHierarchyEntry[]> {
		return this.query(item, 'incoming');
	}
	public async resolveOutgoingCalls(item: LanguageHierarchyItem): Promise<readonly LanguageCallHierarchyEntry[]> {
		return this.query(item, 'outgoing');
	}
	private async query(item: LanguageHierarchyItem, direction: 'incoming' | 'outgoing'): Promise<readonly LanguageCallHierarchyEntry[]> {
		if (this.isDisposed || !isLanguageFeatureRequestCurrent(this.request)) { return []; }
		const provider = this.providerFor(item);
		const request = { ...this.request, item };
		const entries = direction === 'incoming'
			? await provider.provideIncomingCalls(request, request.signal)
			: await provider.provideOutgoingCalls(request, request.signal);
		if (this.isDisposed || !isLanguageFeatureRequestCurrent(request)) { return []; }
		return Object.freeze(entries.map(entry => {
			const child = normalizeItem(entry.item);
			this.providers.set(child, provider);
			return Object.freeze({ ...entry, item: child, fromRanges: Object.freeze(entry.fromRanges.map(range => Range.lift(range))) });
		}));
	}

	private providerFor(item: LanguageHierarchyItem): LanguageCallHierarchyProvider {
		const provider = this.providers.get(item);
		if (!provider) { throw new Error('Hierarchy item does not belong to this session'); }
		return provider;
	}

}

function normalizeItem(item: LanguageHierarchyItem): LanguageHierarchyItem {
	const range = Range.fromPositions(item.range.getStartPosition(), item.range.getEndPosition());
	const selectionRange = Range.fromPositions(item.selectionRange.getStartPosition(), item.selectionRange.getEndPosition());
	if (!range.containsRange(selectionRange)) {
		throw new RangeError('Hierarchy selection range must be contained by its symbol range');
	}
	return Object.freeze({ ...item, range, selectionRange });
}
