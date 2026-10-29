import { VSBuffer } from '../../../../base/common/buffer.js';
import type { IFileService } from '../../../../platform/files/common/files.js';
import type { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import type { IView } from '../../../common/views.js';
import type { LanguageWorkspaceSymbol, LanguageWorkspaceSymbolProvider } from '../../../../editor/common/languages.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

export enum SearchUIState {
	Idle,
	Searching,
	SlowSearch,
}

export const SearchStateKey = new RawContextKey<SearchUIState>('searchState', SearchUIState.Idle);

/** The Search view owns results; consumers may capture a completed, retained result. */
export interface ISearchView extends IView {
	getSearchResultSnapshot():
		{ readonly query: string; readonly content: string; readonly matchCount: number } | undefined;
}

export async function getWorkspaceSymbols(
	providers: readonly LanguageWorkspaceSymbolProvider[],
	query: string,
	signal: AbortSignal = new AbortController().signal,
	onDidUpdate?: (symbols: readonly LanguageWorkspaceSymbol[]) => void,
): Promise<readonly LanguageWorkspaceSymbol[]> {
	const completed = new Array<readonly LanguageWorkspaceSymbol[] | undefined>(providers.length);
	await Promise.all(
		providers.map(async (provider, index) => {
			try {
				const symbols = await provider.provideWorkspaceSymbols(query, signal);
				completed[index] = Object.freeze(symbols.map(normalizeWorkspaceSymbol));
			} catch {
				completed[index] = Object.freeze([]);
			}
			if (!signal.aborted) onDidUpdate?.(mergeWorkspaceSymbols(completed));
		}),
	);
	return signal.aborted ? Object.freeze([]) : mergeWorkspaceSymbols(completed);
}

function mergeWorkspaceSymbols(
	providerResults: readonly (readonly LanguageWorkspaceSymbol[] | undefined)[],
): readonly LanguageWorkspaceSymbol[] {
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
	if (
		!symbol ||
		typeof symbol !== 'object' ||
		typeof symbol.name !== 'string' ||
		symbol.name.trim().length === 0 ||
		!symbol.resource
	)
		throw new TypeError('Workspace symbol requires a name and resource');
	return Object.freeze({
		name: symbol.name,
		kind: symbol.kind,
		resource: symbol.resource,
		range: symbol.range,
		...(symbol.containerName !== undefined ? { containerName: symbol.containerName } : {}),
		...(symbol.data !== undefined ? { data: symbol.data } : {}),
	});
}

/** Captures symbol text only while its local index revision still matches the source. */
export async function readWorkspaceSymbolSource(
	symbol: LanguageWorkspaceSymbol,
	files: IFileService,
	workingCopies: IWorkingCopyService,
): Promise<string | undefined> {
	const revision = getWorkspaceSymbolRevision(symbol);
	const contents = workingCopies
		.get(symbol.resource)
		.filter(workingCopy => workingCopy.backupKind === 'text')
		.map(workingCopy => workingCopy.backup());
	if (contents.length > 0) {
		const content = contents[0] as string;
		if (contents.some(candidate => candidate !== content)) return undefined;
		const digest = await globalThis.crypto.subtle.digest('SHA-256', VSBuffer.fromString(content).buffer);
		const currentRevision = `sha256:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
		return !revision || revision === currentRevision ? content : undefined;
	}
	const current = await files.readFile(symbol.resource);
	return !revision || revision === `sha256:${current.revision}` ? current.content : undefined;
}

export function getWorkspaceSymbolRevision(symbol: LanguageWorkspaceSymbol): string | undefined {
	if (!symbol.data || typeof symbol.data !== 'object') return undefined;
	const data = symbol.data as { source?: unknown; sourceRevision?: unknown };
	return data.source === 'codebaseSymbols' &&
		typeof data.sourceRevision === 'string' &&
		data.sourceRevision.startsWith('sha256:')
		? data.sourceRevision
		: undefined;
}
