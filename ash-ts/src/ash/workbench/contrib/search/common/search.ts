import type { LanguageWorkspaceSymbol, LanguageWorkspaceSymbolProvider } from '../../../../editor/common/languages.js';

export async function getWorkspaceSymbols(providers: readonly LanguageWorkspaceSymbolProvider[], query: string, signal: AbortSignal = new AbortController().signal, onDidUpdate?: (symbols: readonly LanguageWorkspaceSymbol[]) => void): Promise<readonly LanguageWorkspaceSymbol[]> {
	const completed = new Array<readonly LanguageWorkspaceSymbol[] | undefined>(providers.length);
	await Promise.all(providers.map(async (provider, index) => {
		try {
			const symbols = await provider.provideWorkspaceSymbols(query, signal);
			completed[index] = Object.freeze(symbols.map(normalizeWorkspaceSymbol));
		} catch {
			completed[index] = Object.freeze([]);
		}
		if (!signal.aborted) onDidUpdate?.(mergeWorkspaceSymbols(completed));
	}));
	return signal.aborted ? Object.freeze([]) : mergeWorkspaceSymbols(completed);
}

function mergeWorkspaceSymbols(providerResults: readonly (readonly LanguageWorkspaceSymbol[] | undefined)[]): readonly LanguageWorkspaceSymbol[] {
	const seen = new Set<string>();
	const merged: LanguageWorkspaceSymbol[] = [];
	for (const symbols of providerResults) {
		for (const symbol of symbols ?? []) {
			const key = `${symbol.resource.toString()}\0${symbol.name}\0${symbol.range.getStartPosition().lineNumber}:${symbol.range.getStartPosition().column}`;
			if (seen.has(key)) continue;
			seen.add(key);
			merged.push(symbol);
		}
	}
	return Object.freeze(merged);
}

function normalizeWorkspaceSymbol(symbol: LanguageWorkspaceSymbol): LanguageWorkspaceSymbol {
	if (!symbol || typeof symbol !== "object" || typeof symbol.name !== "string" || symbol.name.trim().length === 0 || !symbol.resource) throw new TypeError("Workspace symbol requires a name and resource");
	return Object.freeze({
		name: symbol.name,
		kind: symbol.kind,
		resource: symbol.resource,
		range: symbol.range,
		...(symbol.containerName !== undefined ? { containerName: symbol.containerName } : {}),
		...(symbol.data !== undefined ? { data: symbol.data } : {}),
	});
}
