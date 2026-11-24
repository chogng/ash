import type { LineDiff } from '../../../../editor/common/diff/lineDiff.js';
import type { LanguageDocumentSymbol } from '../../../../editor/common/languages.js';

export interface ReviewSymbolChange {
	readonly kind: 'added' | 'removed' | 'moved';
	readonly name: string;
}

const declarationKinds = new Set<LanguageDocumentSymbol['kind']>(['class', 'struct', 'method', 'function', 'test', 4, 5, 11, 22]);

/** Compares declaration identities without treating ordinary line offsets as moves. */
export function compareReviewSymbols(original: readonly LanguageDocumentSymbol[], modified: readonly LanguageDocumentSymbol[], diff?: LineDiff): readonly ReviewSymbolChange[] {
	const before = indexSymbols(original);
	const after = indexSymbols(modified);
	const changes: ReviewSymbolChange[] = [];
	for (const [key, symbol] of after) {
		if (!symbol) continue; // Ambiguous overloads have no reliable identity.
		const previous = before.get(key);
		if (!before.has(key)) changes.push({ kind: 'added', name: symbol.name });
		else if (previous && diff && wasMoved(previous, symbol, diff)) changes.push({ kind: 'moved', name: symbol.name });
	}
	for (const [key, symbol] of before) {
		if (symbol && !after.has(key)) changes.push({ kind: 'removed', name: symbol.name });
	}
	return changes;
}

function indexSymbols(symbols: readonly LanguageDocumentSymbol[]): Map<string, LanguageDocumentSymbol | undefined> {
	const result = new Map<string, LanguageDocumentSymbol | undefined>();
	const pending = [{ symbols, parents: [] as readonly string[] }];
	while (pending.length) {
		const entry = pending.pop()!;
		for (const symbol of entry.symbols) {
			const parents = [...entry.parents, symbol.name];
			if (declarationKinds.has(symbol.kind)) {
				const key = JSON.stringify([symbol.kind, ...parents]);
				result.set(key, result.has(key) ? undefined : { ...symbol, name: parents.join('.') });
			}
			if (symbol.children?.length) pending.push({ symbols: symbol.children, parents });
		}
	}
	return result;
}

function wasMoved(before: LanguageDocumentSymbol, after: LanguageDocumentSymbol, diff: LineDiff): boolean {
	const covers = (symbol: LanguageDocumentSymbol, start: number, count: number): boolean => {
		const end = symbol.range.endLineNumber - Number(symbol.range.endColumn === 1 && symbol.range.endLineNumber > symbol.range.startLineNumber);
		return start <= symbol.range.startLineNumber && end < start + count;
	};
	if (diff.moves.some(({ lineRangeMapping: move }) => covers(before, move.original.startLineNumber, move.original.length)
		&& covers(after, move.modified.startLineNumber, move.modified.length))) return true;
	return diff.hunks.some(hunk => hunk.modifiedLineCount === 0 && covers(before, hunk.originalStartLineIndex + 1, hunk.originalLineCount))
		&& diff.hunks.some(hunk => hunk.originalLineCount === 0 && covers(after, hunk.modifiedStartLineIndex + 1, hunk.modifiedLineCount));
}
