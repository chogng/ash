import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { type Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { type TextModel } from '../../../../editor/common/model/textModel.js';
import { type LanguageFeatureRegistry } from '../../../../editor/common/languageFeatureRegistry.js';
import { createLanguageFeatureRequest, isLanguageFeatureRequestCurrent, type LanguageHierarchyItem, type LanguageHierarchyRequest, type LanguageTypeHierarchyProvider, } from '../../../../editor/common/languages.js';

export const enum TypeHierarchyDirection {
	Subtypes = 'subtypes',
	Supertypes = 'supertypes',
}

/** Retains each item's provider and preparation snapshot through descendant queries. */
export class TypeHierarchyModel extends Disposable {
	private readonly providers = new Map<LanguageHierarchyItem, LanguageTypeHierarchyProvider>();

	private constructor(public readonly roots: readonly LanguageHierarchyItem[], private readonly request: LanguageHierarchyRequest) {
		super();
		this._register(toDisposable(() => this.providers.clear()));
	}

	public static async create(
		model: TextModel, position: Position, signal: AbortSignal,
		registry: LanguageFeatureRegistry<LanguageTypeHierarchyProvider>, onError: (error: unknown) => void,
	): Promise<TypeHierarchyModel | undefined> {
		const request = Object.freeze({ ...createLanguageFeatureRequest(model, model.getLanguageId(), signal), resource: model.uri, position });
		const roots: LanguageHierarchyItem[] = [];
		const result = new TypeHierarchyModel(roots, request);
		for (const provider of registry.ordered(model)) {
			if (!isLanguageFeatureRequestCurrent(request)) {
				result.dispose();
				return undefined;
			}
			try {
				const items = await provider.prepareTypeHierarchy(request, signal);
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

	public async provideSupertypes(item: LanguageHierarchyItem): Promise<readonly LanguageHierarchyItem[]> {
		return this.query(item, 'supertypes');
	}
	public async provideSubtypes(item: LanguageHierarchyItem): Promise<readonly LanguageHierarchyItem[]> {
		return this.query(item, 'subtypes');
	}
	private async query(item: LanguageHierarchyItem, direction: 'supertypes' | 'subtypes'): Promise<readonly LanguageHierarchyItem[]> {
		if (this.isDisposed || !isLanguageFeatureRequestCurrent(this.request)) { return []; }
		const provider = this.providerFor(item);
		const request = { ...this.request, item };
		const items = direction === 'supertypes'
			? await provider.provideSupertypes(request, request.signal)
			: await provider.provideSubtypes(request, request.signal);
		if (this.isDisposed || !isLanguageFeatureRequestCurrent(request)) { return []; }
		return Object.freeze(items.map(item => {
			const child = normalizeItem(item);
			this.providers.set(child, provider);
			return child;
		}));
	}

	private providerFor(item: LanguageHierarchyItem): LanguageTypeHierarchyProvider {
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
