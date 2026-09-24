import type { URI } from '../../../../base/common/uri.js';
import { Position } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import type { LanguageFeatureRegistry } from '../../../common/languageFeatureRegistry.js';
import {
	createLanguageFeatureRequest,
	isLanguageFeatureRequestCurrent,
	type LanguageDocumentSymbol,
	type LanguageDocumentSymbolProvider,
	type LanguageDocumentSymbolRequest,
} from '../../../common/languages.js';
import type { TextModel } from '../../../common/model/textModel.js';

// Sticky Scroll keeps its chosen provider across requests without retaining a disposed registration.
const providerIds = new WeakMap<LanguageDocumentSymbolProvider, number>();
let nextProviderId = 0;

export abstract class TreeElement {
	abstract readonly id: string;
	abstract readonly parent: TreeElement | undefined;
	abstract readonly children: ReadonlyMap<string, TreeElement>;
}

export class OutlineElement extends TreeElement {
	public readonly children = new Map<string, OutlineElement>();

	constructor(
		public readonly id: string,
		public readonly parent: OutlineGroup | OutlineElement,
		public readonly symbol: LanguageDocumentSymbol,
	) {
		super();
	}
}

export class OutlineGroup extends TreeElement {
	public readonly children = new Map<string, OutlineElement>();

	constructor(
		public readonly id: string,
		public readonly parent: OutlineModel,
		public readonly order: number,
	) {
		super();
	}
}

/** A version-bound tree of document symbols grouped by their provider. */
export class OutlineModel extends TreeElement {
	public readonly id = 'root';
	public readonly parent = undefined;
	public readonly children = new Map<string, OutlineGroup>();

	private constructor(public readonly uri: URI, public readonly version: number) {
		super();
	}

	public static async create(
		registry: LanguageFeatureRegistry<LanguageDocumentSymbolProvider>,
		model: TextModel,
		signal: AbortSignal,
		onError: (error: unknown) => void,
	): Promise<OutlineModel | null> {
		const request: LanguageDocumentSymbolRequest = Object.freeze({
			...createLanguageFeatureRequest(model, model.getLanguageId(), signal),
			resource: model.uri,
		});
		if (!isLanguageFeatureRequestCurrent(request)) return null;

		const providers = registry.ordered(model);
		const results = await Promise.all(providers.map(async (provider, order) => {
			try {
				const symbols = await provider.provideDocumentSymbols(request, signal);
				return { provider, order, symbols: normalizeSymbols(symbols, model) };
			} catch (error) {
				if (isLanguageFeatureRequestCurrent(request)) onError(error);
				return undefined;
			}
		}));
		if (!isLanguageFeatureRequestCurrent(request)) return null;
		if (!sameProviders(providers, registry.ordered(model))) return null;

		const outline = new OutlineModel(model.uri, request.snapshot.version);
		const occurrences = new Map<LanguageDocumentSymbolProvider, number>();
		for (const result of results) {
			if (!result) continue;
			const occurrence = occurrences.get(result.provider) ?? 0;
			occurrences.set(result.provider, occurrence + 1);
			if (result.symbols.length === 0) continue;
			const id = `root/provider_${idForProvider(result.provider)}_${occurrence}`;
			const group = new OutlineGroup(id, outline, result.order);
			for (const symbol of result.symbols) appendSymbol(group, symbol);
			outline.children.set(id, group);
		}
		return outline;
	}

	public getTopLevelSymbols(): readonly LanguageDocumentSymbol[] {
		const symbols = [...this.children.values()].flatMap(group => [...group.children.values()].map(element => element.symbol));
		return symbols.sort((left, right) => Range.compareRangesUsingStarts(left.range, right.range));
	}

	public asListOfDocumentSymbols(): readonly LanguageDocumentSymbol[] {
		const symbols: LanguageDocumentSymbol[] = [];
		const visit = (symbol: LanguageDocumentSymbol): void => {
			symbols.push(symbol);
			for (const child of symbol.children ?? []) visit(child);
		};
		for (const symbol of this.getTopLevelSymbols()) visit(symbol);
		return symbols.sort((left, right) => Position.compare(left.selectionRange.getStartPosition(), right.selectionRange.getStartPosition()));
	}
}

function appendSymbol(parent: OutlineGroup | OutlineElement, symbol: LanguageDocumentSymbol): void {
	const base = `${parent.id}/${encodeURIComponent(symbol.name)}`;
	let id = base;
	for (let suffix = 1; parent.children.has(id); suffix++) id = `${base}_${suffix}`;
	const element = new OutlineElement(id, parent, symbol);
	parent.children.set(id, element);
	for (const child of symbol.children ?? []) appendSymbol(element, child);
}

function normalizeSymbols(symbols: readonly LanguageDocumentSymbol[], model: TextModel): readonly LanguageDocumentSymbol[] {
	if (!Array.isArray(symbols)) throw new TypeError('Document symbols must be an array');
	return Object.freeze(symbols.map(symbol => {
		if (!symbol || typeof symbol.name !== 'string' || (typeof symbol.kind !== 'string' && typeof symbol.kind !== 'number')) {
			throw new TypeError('Document symbol has invalid identity');
		}
		const range = new Range(
			symbol.range.startLineNumber, symbol.range.startColumn,
			symbol.range.endLineNumber, symbol.range.endColumn,
		);
		const selectionRange = new Range(
			symbol.selectionRange.startLineNumber, symbol.selectionRange.startColumn,
			symbol.selectionRange.endLineNumber, symbol.selectionRange.endColumn,
		);
		if (!model.isValidRange(range) || !model.isValidRange(selectionRange) || !range.containsRange(selectionRange)) {
			throw new RangeError('Document symbol range is outside its document scope');
		}
		return Object.freeze({
			name: symbol.name,
			kind: symbol.kind,
			...(symbol.detail !== undefined ? { detail: symbol.detail } : {}),
			range,
			selectionRange,
			...(symbol.children ? { children: normalizeSymbols(symbol.children, model) } : {}),
		});
	}));
}

function idForProvider(provider: LanguageDocumentSymbolProvider): number {
	let id = providerIds.get(provider);
	if (id === undefined) {
		id = nextProviderId++;
		providerIds.set(provider, id);
	}
	return id;
}

function sameProviders(left: readonly LanguageDocumentSymbolProvider[], right: readonly LanguageDocumentSymbolProvider[]): boolean {
	return left.length === right.length && left.every((provider, index) => provider === right[index]);
}
